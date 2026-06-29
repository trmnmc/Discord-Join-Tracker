/**
 * Local, read-only web dashboard. Reuses the existing AnalyticsDB and
 * buildReportData to show join statistics in a browser. It is intentionally
 * minimal and safe:
 *   - Basic Auth (timing-safe) on every route.
 *   - helmet with a strict same-origin CSP (no inline scripts, no CDNs).
 *   - Only aggregate numbers are exposed — never raw user IDs or message text.
 *
 * This phase is read-only: it does not control the bot.
 */
import * as http from "http";
import * as crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { AnalyticsDB } from "./db";
import { AppConfig } from "./config";
import { buildReportData } from "./report";
import { logger } from "./logger";

export interface DashboardHandle {
  close: () => Promise<void>;
}

/** Constant-time string comparison via fixed-length SHA-256 digests. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Basic Auth middleware. Rejects anything without valid credentials. */
function basicAuth(username: string, password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      return sendUnauthorized(res);
    }
    let decoded = "";
    try {
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return sendUnauthorized(res);
    }
    const idx = decoded.indexOf(":");
    if (idx === -1) return sendUnauthorized(res);
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    // Evaluate both comparisons regardless to avoid short-circuit timing leaks.
    const userOk = safeEqual(user, username);
    const passOk = safeEqual(pass, password);
    if (userOk && passOk) return next();
    return sendUnauthorized(res);
  };
}

function sendUnauthorized(res: Response): void {
  res
    .set("WWW-Authenticate", 'Basic realm="Discord Join Tracker Dashboard", charset="UTF-8"')
    .status(401)
    .type("text/plain")
    .send("Authentication required.");
}

/** Clamp days to [1, 30]; non-numeric input falls back to the default. */
function parseDays(raw: unknown, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

export function startDashboardServer(db: AnalyticsDB, config: AppConfig): DashboardHandle {
  const app = express();
  app.disable("x-powered-by");

  // Strict CSP: everything is same-origin; no inline scripts/styles, no CDNs.
  // upgrade-insecure-requests is removed so a local http:// page is not forced
  // to https for its own assets.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );

  // Auth gates every route, including static assets.
  app.use(basicAuth(config.dashboardUsername as string, config.dashboardPassword as string));

  app.get("/", (_req, res) => {
    res.type("text/html").send(HTML_PAGE);
  });

  app.get("/dashboard.css", (_req, res) => {
    res.type("text/css").send(DASHBOARD_CSS);
  });

  app.get("/dashboard.js", (_req, res) => {
    res.type("application/javascript").send(DASHBOARD_JS);
  });

  // JSON stats. Only safe aggregate fields are serialized — no message content,
  // no questions/examples, no raw user IDs.
  app.get("/api/stats", (req, res) => {
    const days = parseDays(req.query.days, config.defaultDays);
    const now = Date.now();
    const sinceIso = new Date(now - days * 86_400_000).toISOString();
    const untilIso = new Date(now).toISOString();

    try {
      const data = buildReportData(db, config.guildId, { sinceIso, untilIso, days });
      res.json({
        days,
        sinceIso,
        untilIso,
        joinCount: data.joinCount,
        leaveCount: data.leaveCount,
        netGrowth: data.netGrowth,
        daily: data.daily.map((d) => ({ date: d.date, joins: d.joins, leaves: d.leaves })),
        dataQuality: data.dataQuality,
      });
    } catch (err) {
      logger.error("Dashboard /api/stats failed", err);
      res.status(500).json({ error: "Failed to build stats." });
    }
  });

  const server: http.Server = app.listen(config.dashboardPort, config.dashboardHost, () => {
    logger.info(
      `Dashboard listening on http://${config.dashboardHost}:${config.dashboardPort} (Basic Auth required)`,
    );
  });

  server.on("error", (err) => {
    logger.error("Dashboard server error", err);
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---- Static assets (served from memory; no build step, no external libs) ----

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Discord Join Tracker Dashboard</title>
  <link rel="stylesheet" href="/dashboard.css" />
</head>
<body>
  <main class="wrap">
    <header>
      <h1>Discord Join Tracker Dashboard</h1>
      <p id="window-label" class="muted">Loading…</p>
    </header>

    <section class="controls">
      <span class="muted">Window:</span>
      <button class="days-btn" data-days="7">7 days</button>
      <button class="days-btn" data-days="14">14 days</button>
      <button class="days-btn" data-days="30">30 days</button>
    </section>

    <section class="cards">
      <div class="card">
        <div class="card-label">Joins</div>
        <div id="joins" class="card-value pos">–</div>
      </div>
      <div class="card">
        <div class="card-label">Leaves</div>
        <div id="leaves" class="card-value neg">–</div>
      </div>
      <div class="card">
        <div class="card-label">Net growth</div>
        <div id="net" class="card-value">–</div>
      </div>
    </section>

    <section>
      <h2>Daily breakdown</h2>
      <table>
        <thead>
          <tr><th>Date (UTC)</th><th>Joins</th><th>Leaves</th></tr>
        </thead>
        <tbody id="daily-body"></tbody>
      </table>
    </section>

    <footer>
      <p id="dq" class="muted small"></p>
      <p id="updated" class="muted small"></p>
      <p class="muted small">Read-only view. Auto-refreshes every 60 seconds.</p>
    </footer>
  </main>
  <script src="/dashboard.js"></script>
</body>
</html>`;

const DASHBOARD_CSS = `:root {
  color-scheme: dark;
  --bg: #1e1f22;
  --panel: #2b2d31;
  --text: #dbdee1;
  --muted: #949ba4;
  --pos: #43b581;
  --neg: #f04747;
  --accent: #5865f2;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }
.controls { display: flex; align-items: center; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
.days-btn {
  background: var(--panel);
  color: var(--text);
  border: 1px solid #3a3c41;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 0.9rem;
}
.days-btn:hover { border-color: var(--accent); }
.days-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 8px 0 8px; }
.card { background: var(--panel); border-radius: 10px; padding: 18px; text-align: center; }
.card-label { color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: .04em; }
.card-value { font-size: 2rem; font-weight: 700; margin-top: 6px; }
.card-value.pos { color: var(--pos); }
.card-value.neg { color: var(--neg); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 10px; overflow: hidden; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #3a3c41; }
th { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: .04em; }
tbody tr:last-child td { border-bottom: none; }
td:nth-child(2) { color: var(--pos); }
td:nth-child(3) { color: var(--neg); }
footer { margin-top: 24px; }
@media (max-width: 520px) { .cards { grid-template-columns: 1fr; } }`;

const DASHBOARD_JS = `(function () {
  "use strict";
  var current = 7;

  function fmtSign(n) { return (n >= 0 ? "+" : "") + n; }

  function setActive(days) {
    var btns = document.querySelectorAll(".days-btn");
    Array.prototype.forEach.call(btns, function (b) {
      b.classList.toggle("active", Number(b.getAttribute("data-days")) === days);
    });
  }

  function render(data) {
    document.getElementById("joins").textContent = data.joinCount;
    document.getElementById("leaves").textContent = data.leaveCount;
    var net = document.getElementById("net");
    net.textContent = fmtSign(data.netGrowth);
    net.className = "card-value " + (data.netGrowth >= 0 ? "pos" : "neg");
    document.getElementById("window-label").textContent = "Last " + data.days + " days";

    var tbody = document.getElementById("daily-body");
    tbody.innerHTML = "";
    data.daily.forEach(function (row) {
      var tr = document.createElement("tr");
      var d = document.createElement("td"); d.textContent = row.date;
      var j = document.createElement("td"); j.textContent = row.joins;
      var l = document.createElement("td"); l.textContent = row.leaves;
      tr.appendChild(d); tr.appendChild(j); tr.appendChild(l);
      tbody.appendChild(tr);
    });

    var dq = data.dataQuality || {};
    document.getElementById("dq").textContent =
      "Data quality — joins backfilled: " + (dq.joinsBackfilled ? "yes" : "no") +
      " | leaves: live-only | message content: " + (dq.messageContentAccessible ? "accessible" : "not accessible") +
      " | messages analyzed: " + (dq.messagesAnalyzed != null ? dq.messagesAnalyzed : 0);
    document.getElementById("updated").textContent = "Last updated: " + new Date().toLocaleString();
  }

  function load(days) {
    current = days;
    setActive(days);
    fetch("/api/stats?days=" + days, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(function (err) {
        document.getElementById("updated").textContent = "Error loading stats: " + err.message;
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btns = document.querySelectorAll(".days-btn");
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener("click", function () { load(Number(b.getAttribute("data-days"))); });
    });
    load(7);
    setInterval(function () { load(current); }, 60000);
  });
})();`;

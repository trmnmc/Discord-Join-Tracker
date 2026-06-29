# Discord Join Tracker & Community Analytics Bot

A self-hosted Discord bot that tracks server **joins** and **leaves**, backfills
recent join data, analyzes community **sentiment**, surfaces the **top
questions**, suggests **server improvements**, and renders a **chart + report**
through slash commands.

Everything runs locally:

- **Node.js 20+ / TypeScript**
- **discord.js v14** for the gateway + slash commands
- **better-sqlite3** for persistence (no external/hosted database)
- **sentiment** for local, heuristic sentiment scoring (no external LLM)
- **sharp** to rasterize a hand-built SVG chart to PNG (no headless browser)
- **dotenv** for configuration

No paid APIs, no hosted database, no external LLM.

---

## What it tracks

| Data | How | Reliability |
| --- | --- | --- |
| Future joins | `guildMemberAdd` gateway event | Reliable while the bot is online |
| Future leaves | `guildMemberRemove` gateway event | Reliable while the bot is online |
| Past-week joins | Backfilled from current members' `joinedTimestamp` | Only for members **still in the server** |
| Admin removals (kick/ban/prune) | Audit log (optional, needs View Audit Log) | Limited to recent audit-log retention |
| Past voluntary leaves | **Not possible** before the bot was installed | Discord does not expose this |
| Messages (sentiment/questions) | `messageCreate` + backfill of readable channels | Requires Message Content intent + read perms |

---

## Slash commands

### `/community-report`
Options:
- `days` — integer, default `7`, min `1`, max `30`
- `channel` — optional channel filter

Produces a report embed plus a PNG chart attachment showing daily joins and
leaves (grouped bars) with cumulative net growth (line). Includes net growth,
join/leave counts, sentiment score + label, top 5 questions, recurring themes,
deterministic suggested improvements, and **data-quality notes** (whether joins
are backfilled, that leaves are live-only, and whether message content was
accessible).

### `/refresh-backfill` (Admin only)
Option:
- `days` — integer, default `7`, min `1`, max `30`

Backfills current members who joined within the window, recent readable
messages, and (optionally) audit-log removals. Reports counts of members
scanned, joins inserted, messages scanned/inserted, audit events inserted,
skipped channels, and permission issues.

### `/analytics-status`
Shows uptime, guild ID, database location, intents enabled in code, counts of
join/leave/message rows, oldest/newest event timestamps, and warnings about
missing privileged intents or permissions.

---

## 1. Create the Discord application / bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → name it → **Create**.
3. Copy the **Application ID** (this is your `CLIENT_ID`).
4. Open the **Bot** tab → **Reset Token** → copy the token (`DISCORD_TOKEN`).
   Keep this secret; never commit it.

## 2. Enable privileged intents

In the **Bot** tab, under **Privileged Gateway Intents**, enable:

- **Server Members Intent** — required for join/leave tracking and member backfill.
- **Message Content Intent** — required to read message text for sentiment/questions.

> Without these, member events and message content will be empty and the bot
> will log warnings.

## 3. Invite the bot with required permissions

Use an OAuth2 URL with the `bot` and `applications.commands` scopes. Required
bot permissions:

- View Channels
- Read Message History
- Send Messages
- Attach Files
- Use Slash Commands (`applications.commands` scope)
- **View Audit Log** — only needed for admin-removal backfill

Example invite URL (replace `CLIENT_ID`). The `permissions` value below
(`372774464`) covers View Channels, Send Messages, Attach Files, Read Message
History, and View Audit Log:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=372774464
```

Get your **Guild (server) ID** by enabling Developer Mode in Discord
(User Settings → Advanced → Developer Mode), then right-click the server →
**Copy Server ID** (`GUILD_ID`).

## 4. Configure `.env`

```bash
cp .env.example .env
```

Fill in:

```dotenv
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-server-id
DATABASE_PATH=./data/analytics.sqlite
DEFAULT_DAYS=7
BACKFILL_AUDIT_LOG=true
MAX_MESSAGES_PER_CHANNEL=1000
DELETE_RAW_MESSAGES_AFTER_DAYS=14
```

## 5. Run locally

```bash
npm install
npm run build
npm start
```

Or for development with on-the-fly TypeScript:

```bash
npm run dev
```

On startup the bot validates the environment, creates/opens the SQLite
database, runs migrations, registers guild slash commands, starts the cleanup
job, and logs in. Then in your server run:

```
/refresh-backfill days:7      # populate recent joins + messages first
/community-report days:7      # generate the report + chart
/analytics-status             # sanity-check intents, perms, and counts
```

---

## Deploy on a VPS

1. Install Node.js 20+ (e.g. via [nvm](https://github.com/nvm-sh/nvm) or your
   distro's packages). `better-sqlite3` and `sharp` ship prebuilt binaries for
   common Linux/x64 and arm64 targets; if a build is needed, install
   `build-essential` and `python3`.
2. Clone the repo and create `.env` as above.
3. Build and run:

   ```bash
   npm ci
   npm run build
   npm start
   ```

4. Keep it alive with a process manager. Example **systemd** unit
   (`/etc/systemd/system/discord-analytics.service`):

   ```ini
   [Unit]
   Description=Discord Analytics Bot
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/discord-join-tracker
   ExecStart=/usr/bin/node dist/index.js
   Restart=always
   RestartSec=5
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now discord-analytics
   sudo journalctl -u discord-analytics -f
   ```

   (Or use `pm2 start dist/index.js --name discord-analytics`.)

The SQLite file lives at `DATABASE_PATH`. Back up that file to retain history.

---

## Privacy

This bot is designed to store the **minimum** useful data:

- **Author IDs are never stored in clear text.** Each message row stores a
  SHA-256 hash of `guildId:userId`, so you cannot recover the original user ID
  from the database, but repeated messages from the same person still cluster
  consistently within a guild.
- **Raw message content is only kept short-term.** A cleanup job runs hourly and
  deletes message rows older than `DELETE_RAW_MESSAGES_AFTER_DAYS` (default 14).
  Member join/leave events are aggregate analytics and are retained.
- **Sentiment is computed on insert**, so even after content is deleted the
  aggregate sentiment of older windows is not retained beyond the raw rows.

### How to disable message storage entirely

If you only want join/leave analytics and no message content:

1. Do **not** enable the Message Content intent (the bot will store no usable
   content), **or**
2. Set `DELETE_RAW_MESSAGES_AFTER_DAYS` very low (e.g. `1`), **or**
3. Comment out the `messageCreate` handler in `src/events.ts` and skip
   message backfill — `/community-report` will then report no sentiment/questions
   but joins/leaves and the chart still work.

To shrink retention to effectively nothing, set
`DELETE_RAW_MESSAGES_AFTER_DAYS=1` and reduce `MAX_MESSAGES_PER_CHANNEL`.

---

## Architecture

```
src/
  index.ts       Startup: config → db → commands → client → cleanup
  config.ts      Env loading + validation
  db.ts          better-sqlite3 connection, migrations, parameterized queries
  events.ts      Live gateway handlers (join/leave/message)
  commands.ts    Slash command definitions, registration, interaction handlers
  backfill.ts    Member/audit-log/message backfill
  report.ts      Aggregation: daily series, sentiment, questions, themes
  chart.ts       Hand-built SVG → PNG via sharp
  sentiment.ts   Local sentiment scoring + theme detection + suggestions
  questions.ts   Question detection, normalization, Jaccard clustering
  cleanup.ts     Retention job for old message rows
  logger.ts      Minimal leveled logger
```

### Database schema

- `member_events(id, guild_id, user_id, event_type, occurred_at, source, metadata_json)`
  with `UNIQUE(guild_id, user_id, event_type, occurred_at, source)` for idempotent inserts.
- `messages(id, guild_id, channel_id, author_id_hash, created_at, content, sentiment_score, has_question)`
  keyed by the Discord message id (idempotent).
- `report_runs(id, guild_id, created_at, days, summary_json)`.

All timestamps are stored as ISO-8601 **UTC** strings.

---

## Known limitations

- **Past voluntary leaves are not available** unless the bot was already running
  when they happened — Discord does not expose historical departures.
- **Past joins are only available for members still in the server.** Anyone who
  joined and then left before a backfill is invisible to join backfill.
- **Sentiment is heuristic** (lexicon-based via the `sentiment` package). It is a
  rough signal, not a precise measure, and can misread sarcasm, slang, or
  non-English text.
- **Message history depends on permissions and the Message Content intent.**
  Channels the bot cannot read are skipped; if the intent is off, content is
  empty and sentiment/questions will be unavailable.
- **Audit-log backfill** is bounded by Discord's audit-log retention and the
  100-entry-per-type fetch used here; very old or very high-volume removals may
  not all be captured.

All analysis is labeled **"based on readable messages in the selected period"**
to avoid overclaiming.

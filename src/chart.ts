/**
 * Chart rendering without a browser/canvas. We build an SVG string by hand and
 * rasterize it to PNG with sharp. The chart shows daily joins and leaves as
 * grouped bars plus a net-growth line overlay.
 */
import sharp from "sharp";

export interface DailyPoint {
  date: string; // YYYY-MM-DD (UTC)
  joins: number;
  leaves: number;
}

const WIDTH = 900;
const HEIGHT = 420;
const PADDING = { top: 50, right: 30, bottom: 70, left: 50 };

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the SVG markup for the grouped bar + net line chart. */
export function buildChartSvg(points: DailyPoint[], title: string): string {
  const plotW = WIDTH - PADDING.left - PADDING.right;
  const plotH = HEIGHT - PADDING.top - PADDING.bottom;
  const x0 = PADDING.left;
  const y0 = PADDING.top;

  // Net growth running cumulative for the line series.
  let cumulative = 0;
  const netSeries = points.map((p) => {
    cumulative += p.joins - p.leaves;
    return cumulative;
  });

  const maxBar = Math.max(1, ...points.map((p) => Math.max(p.joins, p.leaves)));
  const minNet = Math.min(0, ...netSeries);
  const maxNet = Math.max(0, ...netSeries);
  const netRange = Math.max(1, maxNet - minNet);

  const n = Math.max(1, points.length);
  const slotW = plotW / n;
  const barGap = slotW * 0.15;
  const barW = (slotW - barGap * 2) / 2;

  const yForBar = (v: number) => y0 + plotH - (v / maxBar) * plotH;
  const yForNet = (v: number) => y0 + plotH - ((v - minNet) / netRange) * plotH;

  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#1e1f22"/>`,
  );
  parts.push(
    `<text x="${WIDTH / 2}" y="28" fill="#ffffff" font-family="sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${escapeXml(title)}</text>`,
  );

  // Horizontal gridlines + y-axis labels for the bar scale.
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const v = (maxBar / gridLines) * i;
    const y = yForBar(v);
    parts.push(
      `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x0 + plotW}" y2="${y.toFixed(1)}" stroke="#3a3c41" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${x0 - 8}" y="${(y + 4).toFixed(1)}" fill="#b5bac1" font-family="sans-serif" font-size="11" text-anchor="end">${Math.round(v)}</text>`,
    );
  }

  // Bars + x-axis labels.
  points.forEach((p, i) => {
    const slotX = x0 + slotW * i;
    const joinX = slotX + barGap;
    const leaveX = joinX + barW;

    const joinY = yForBar(p.joins);
    const leaveY = yForBar(p.leaves);

    parts.push(
      `<rect x="${joinX.toFixed(1)}" y="${joinY.toFixed(1)}" width="${barW.toFixed(1)}" height="${(y0 + plotH - joinY).toFixed(1)}" fill="#43b581"/>`,
    );
    parts.push(
      `<rect x="${leaveX.toFixed(1)}" y="${leaveY.toFixed(1)}" width="${barW.toFixed(1)}" height="${(y0 + plotH - leaveY).toFixed(1)}" fill="#f04747"/>`,
    );

    // Label every day if few points, otherwise thin out to avoid overlap.
    const showLabel = n <= 10 || i % Math.ceil(n / 10) === 0;
    if (showLabel) {
      const label = p.date.slice(5); // MM-DD
      const lx = slotX + slotW / 2;
      const ly = y0 + plotH + 16;
      parts.push(
        `<text x="${lx.toFixed(1)}" y="${ly}" fill="#b5bac1" font-family="sans-serif" font-size="10" text-anchor="middle" transform="rotate(45 ${lx.toFixed(1)} ${ly})">${escapeXml(label)}</text>`,
      );
    }
  });

  // Net-growth line overlay.
  if (points.length > 0) {
    const linePts = netSeries
      .map((v, i) => {
        const cx = x0 + slotW * i + slotW / 2;
        const cy = yForNet(v);
        return `${cx.toFixed(1)},${cy.toFixed(1)}`;
      })
      .join(" ");
    parts.push(
      `<polyline points="${linePts}" fill="none" stroke="#faa61a" stroke-width="2.5"/>`,
    );
    netSeries.forEach((v, i) => {
      const cx = x0 + slotW * i + slotW / 2;
      const cy = yForNet(v);
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="#faa61a"/>`,
      );
    });
  }

  // Legend.
  const legendY = HEIGHT - 30;
  const legend: [string, string][] = [
    ["#43b581", "Joins"],
    ["#f04747", "Leaves"],
    ["#faa61a", "Net growth (cumulative)"],
  ];
  let lx = x0;
  for (const [color, label] of legend) {
    parts.push(`<rect x="${lx}" y="${legendY - 10}" width="12" height="12" fill="${color}"/>`);
    parts.push(
      `<text x="${lx + 18}" y="${legendY}" fill="#dbdee1" font-family="sans-serif" font-size="12">${escapeXml(label)}</text>`,
    );
    lx += 30 + label.length * 7;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join("")}</svg>`;
}

/** Render the daily series to a PNG buffer via sharp. */
export async function renderChartPng(points: DailyPoint[], title: string): Promise<Buffer> {
  const svg = buildChartSvg(points, title);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

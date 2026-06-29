/**
 * Renders ReportData into a Discord message payload (embed + chart attachment).
 * Shared by the /community-report slash command and the daily scheduler so the
 * report looks identical whether requested manually or posted automatically.
 */
import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import { ReportData } from "./report";
import { renderChartPng } from "./chart";

export interface ReportMessage {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
}

export async function buildReportMessage(data: ReportData): Promise<ReportMessage> {
  const days = data.window.days;
  const channelId = data.window.channelId;

  const png = await renderChartPng(data.daily, `Joins & Leaves — last ${days} day(s)`);
  const attachment = new AttachmentBuilder(png, { name: "community-report.png" });

  const s = data.sentiment;
  const sentimentLine = `${labelEmoji(s.label)} **${s.label}** (avg ${s.averageScore.toFixed(2)}) — 👍 ${s.positiveCount} / 😐 ${s.neutralCount} / 👎 ${s.negativeCount}`;

  const questionsText =
    data.questions.length > 0
      ? data.questions
          .map((q, i) => `${i + 1}. ${truncate(q.example, 120)} _(×${q.count})_`)
          .join("\n")
      : "_No questions detected in readable messages for this period._";

  const themesText =
    data.themes.length > 0
      ? data.themes
          .slice(0, 6)
          .map((t) => `• ${t.label} _(${t.count})_`)
          .join("\n")
      : "_No recurring themes detected._";

  const suggestionsText = data.suggestions.map((x) => `• ${x}`).join("\n");

  const dq = data.dataQuality;
  const dqText = [
    `• Joins: ${dq.joinsBackfilled ? "includes backfilled data" : "live-tracked only"}`,
    `• Leaves: live-tracked only (past voluntary leaves before install are not recoverable)`,
    `• Message content: ${dq.messageContentAccessible ? "accessible" : "NOT accessible (check Message Content intent/permissions)"}`,
    `• Messages analyzed: ${dq.messagesAnalyzed}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle("📊 Community Report")
    .setColor(data.netGrowth >= 0 ? 0x43b581 : 0xf04747)
    .setDescription(
      channelId
        ? `Window: last **${days}** day(s) • Channel: <#${channelId}>`
        : `Window: last **${days}** day(s)`,
    )
    .addFields(
      { name: "Net growth", value: `${data.netGrowth >= 0 ? "+" : ""}${data.netGrowth}`, inline: true },
      { name: "Joins", value: String(data.joinCount), inline: true },
      { name: "Leaves", value: String(data.leaveCount), inline: true },
      { name: "Sentiment", value: sentimentLine, inline: false },
      { name: "Top questions", value: truncate(questionsText, 1024), inline: false },
      { name: "Recurring themes", value: truncate(themesText, 1024), inline: false },
      {
        name: "Suggested improvements",
        value: truncate(`${suggestionsText}\n\n_Based on readable messages in the selected period._`, 1024),
        inline: false,
      },
      { name: "Data quality notes", value: truncate(dqText, 1024), inline: false },
    )
    .setImage("attachment://community-report.png")
    .setTimestamp(new Date());

  return { embeds: [embed], files: [attachment] };
}

function labelEmoji(label: string): string {
  if (label === "positive") return "🟢";
  if (label === "negative") return "🔴";
  return "🟡";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

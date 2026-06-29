/**
 * Daily scheduled job. Fires once per day at a configured UTC time and:
 *   1. Runs the backfill so any joins missed while the bot was offline are
 *      recovered from current members' joinedTimestamp (self-healing), and
 *      recent messages / audit-log removals are refreshed.
 *   2. Optionally posts the community report (embed + chart) to a channel.
 *
 * The bot itself stays online continuously for live tracking; this is the
 * scheduled work layered on top.
 */
import { Client, TextBasedChannel, ChannelType } from "discord.js";
import { AppConfig } from "./config";
import { AnalyticsDB } from "./db";
import { runBackfill } from "./backfill";
import { buildReportData, summaryJson } from "./report";
import { buildReportMessage } from "./reportView";
import { logger } from "./logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `now` until the next occurrence of HH:MM UTC. */
export function msUntilNextRun(timeUtc: string, now: Date): number {
  const [hh, mm] = timeUtc.split(":").map(Number);
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0),
  );
  if (next.getTime() <= now.getTime()) {
    next.setTime(next.getTime() + DAY_MS);
  }
  return next.getTime() - now.getTime();
}

/** Run backfill, then post the daily report if a channel is configured. */
export async function runDailyTasks(
  client: Client,
  db: AnalyticsDB,
  config: AppConfig,
): Promise<void> {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    logger.warn(`Daily job: bot is not in guild ${config.guildId}; skipping.`);
    return;
  }

  const days = config.defaultDays;
  const now = Date.now();
  const cutoffIso = new Date(now - days * 86_400_000).toISOString();

  // 1. Backfill (self-heals join gaps from any downtime).
  try {
    const result = await runBackfill(guild, db, {
      days,
      cutoffIso,
      nowIso: new Date(now).toISOString(),
      backfillAuditLog: config.backfillAuditLog,
      maxMessagesPerChannel: config.maxMessagesPerChannel,
    });
    logger.info("Daily backfill complete", {
      joinsInserted: result.joinsInserted,
      messagesInserted: result.messagesInserted,
      auditEventsInserted: result.auditEventsInserted,
      skippedChannels: result.skippedChannels,
    });
  } catch (err) {
    logger.error("Daily backfill failed", err);
  }

  // 2. Post the report if a destination channel is configured.
  if (!config.reportChannelId) {
    logger.info("Daily job: REPORT_CHANNEL_ID not set; backfill done, no report posted.");
    return;
  }

  try {
    const channel = await client.channels.fetch(config.reportChannelId);
    if (!channel || !isPostable(channel)) {
      logger.warn(
        `Daily job: REPORT_CHANNEL_ID ${config.reportChannelId} is not a postable text channel.`,
      );
      return;
    }

    const data = buildReportData(db, config.guildId, {
      sinceIso: cutoffIso,
      untilIso: new Date(now).toISOString(),
      days,
    });
    try {
      db.insertReportRun(config.guildId, new Date().toISOString(), days, summaryJson(data));
    } catch (err) {
      logger.warn("Daily job: failed to persist report run", err);
    }

    const message = await buildReportMessage(data);
    await channel.send(message);
    logger.info(`Daily report posted to channel ${config.reportChannelId}`);
  } catch (err) {
    logger.error("Daily report post failed", err);
  }
}

function isPostable(channel: { type: ChannelType }): channel is TextBasedChannel & {
  send: (...args: unknown[]) => Promise<unknown>;
} {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread
  );
}

/**
 * Schedule the daily job. Returns a stop() function that cancels the pending
 * timers. Uses a self-rescheduling timeout so it stays aligned to the wall
 * clock even across DST-free UTC (and survives long uptimes without drift).
 */
export function startDailyScheduler(
  client: Client,
  db: AnalyticsDB,
  config: AppConfig,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const delay = msUntilNextRun(config.dailyRunTimeUtc, new Date());
    logger.info(
      `Daily job scheduled for ${config.dailyRunTimeUtc} UTC (in ~${Math.round(delay / 60000)} min).`,
    );
    timer = setTimeout(async () => {
      logger.info("Daily job firing...");
      try {
        await runDailyTasks(client, db, config);
      } catch (err) {
        logger.error("Daily job threw", err);
      } finally {
        scheduleNext();
      }
    }, delay);
    timer.unref();
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

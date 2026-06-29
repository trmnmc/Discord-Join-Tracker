/**
 * Backfill logic for /refresh-backfill. Reconstructs what Discord still makes
 * available within a window:
 *   - joins, from current members' joinedTimestamp
 *   - admin removals (kick/ban/prune), from the audit log (if permitted)
 *   - recent messages, from readable text channels
 * Voluntary leaves before the bot was installed cannot be reconstructed.
 */
import {
  Guild,
  ChannelType,
  PermissionsBitField,
  AuditLogEvent,
  Collection,
  Message,
  GuildBasedChannel,
  TextChannel,
} from "discord.js";
import { AnalyticsDB, EventType } from "./db";
import { scoreText } from "./sentiment";
import { isQuestion } from "./questions";
import { logger } from "./logger";

export interface BackfillResult {
  membersScanned: number;
  joinsInserted: number;
  messagesScanned: number;
  messagesInserted: number;
  auditEventsInserted: number;
  skippedChannels: number;
  permissionIssues: string[];
  messageContentMissing: boolean;
}

export interface BackfillOptions {
  days: number;
  cutoffIso: string; // start of window (UTC ISO)
  nowIso: string; // end of window (UTC ISO)
  backfillAuditLog: boolean;
  maxMessagesPerChannel: number;
}

export async function runBackfill(
  guild: Guild,
  db: AnalyticsDB,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    membersScanned: 0,
    joinsInserted: 0,
    messagesScanned: 0,
    messagesInserted: 0,
    auditEventsInserted: 0,
    skippedChannels: 0,
    permissionIssues: [],
    messageContentMissing: false,
  };

  const cutoffMs = new Date(opts.cutoffIso).getTime();

  await backfillJoins(guild, db, cutoffMs, result);
  if (opts.backfillAuditLog) {
    await backfillAuditLog(guild, db, cutoffMs, result);
  }
  await backfillMessages(guild, db, cutoffMs, opts.maxMessagesPerChannel, result);

  return result;
}

/** Insert join events for current members whose join time is within the window. */
async function backfillJoins(
  guild: Guild,
  db: AnalyticsDB,
  cutoffMs: number,
  result: BackfillResult,
): Promise<void> {
  try {
    const members = await guild.members.fetch();
    result.membersScanned = members.size;
    for (const member of members.values()) {
      const ts = member.joinedTimestamp;
      if (ts === null || ts < cutoffMs) continue;
      const inserted = db.insertMemberEvent({
        guild_id: guild.id,
        user_id: member.id,
        event_type: "join",
        occurred_at: new Date(ts).toISOString(),
        source: "member_backfill",
        metadata_json: JSON.stringify({ bot: member.user.bot ?? false }),
      });
      if (inserted) result.joinsInserted += 1;
    }
  } catch (err) {
    logger.error("Join backfill failed", err);
    result.permissionIssues.push(
      "Could not fetch members (Server Members Intent may be disabled).",
    );
  }
}

const AUDIT_MAP: { event: AuditLogEvent; type: EventType }[] = [
  { event: AuditLogEvent.MemberKick, type: "kick" },
  { event: AuditLogEvent.MemberBanAdd, type: "ban" },
  { event: AuditLogEvent.MemberPrune, type: "prune" },
];

/** Insert kick/ban/prune events from the audit log within the window. */
async function backfillAuditLog(
  guild: Guild,
  db: AnalyticsDB,
  cutoffMs: number,
  result: BackfillResult,
): Promise<void> {
  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
    result.permissionIssues.push("Missing View Audit Log permission; skipped removal backfill.");
    return;
  }

  for (const { event, type } of AUDIT_MAP) {
    try {
      const logs = await guild.fetchAuditLogs({ type: event, limit: 100 });
      for (const entry of logs.entries.values()) {
        if (entry.createdTimestamp < cutoffMs) continue;
        // Prune entries have no single target user; record under guild id.
        const targetId =
          type === "prune"
            ? `prune:${entry.id}`
            : (entry.targetId ?? `${type}:${entry.id}`);
        const inserted = db.insertMemberEvent({
          guild_id: guild.id,
          user_id: targetId,
          event_type: type,
          occurred_at: new Date(entry.createdTimestamp).toISOString(),
          source: "audit_log",
          metadata_json: JSON.stringify({
            executorId: entry.executorId ?? null,
            reason: entry.reason ?? null,
          }),
        });
        if (inserted) result.auditEventsInserted += 1;
      }
    } catch (err) {
      logger.warn(`Audit log fetch failed for ${type}`, err);
      result.permissionIssues.push(`Audit log fetch failed for ${type}.`);
    }
  }
}

/** Iterate readable text channels and backfill recent messages. */
async function backfillMessages(
  guild: Guild,
  db: AnalyticsDB,
  cutoffMs: number,
  maxPerChannel: number,
  result: BackfillResult,
): Promise<void> {
  const me = guild.members.me;
  if (!me) {
    result.permissionIssues.push("Bot member not resolved; skipped message backfill.");
    return;
  }

  const channels = guild.channels.cache.filter((c) => isReadableText(c));
  for (const channel of channels.values()) {
    const text = channel as TextChannel;
    const perms = text.permissionsFor(me);
    if (
      !perms ||
      !perms.has(PermissionsBitField.Flags.ViewChannel) ||
      !perms.has(PermissionsBitField.Flags.ReadMessageHistory)
    ) {
      result.skippedChannels += 1;
      result.permissionIssues.push(`No read access to #${text.name}`);
      continue;
    }

    try {
      await backfillChannelMessages(text, db, guild.id, cutoffMs, maxPerChannel, result);
    } catch (err) {
      logger.warn(`Message backfill failed for #${text.name}`, err);
      result.skippedChannels += 1;
      result.permissionIssues.push(`Failed reading #${text.name}`);
    }
  }
}

function isReadableText(channel: GuildBasedChannel): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  );
}

async function backfillChannelMessages(
  channel: TextChannel,
  db: AnalyticsDB,
  guildId: string,
  cutoffMs: number,
  maxPerChannel: number,
  result: BackfillResult,
): Promise<void> {
  let before: string | undefined = undefined;
  let fetched = 0;

  while (fetched < maxPerChannel) {
    const batch: Collection<string, Message> = await channel.messages.fetch({
      limit: Math.min(100, maxPerChannel - fetched),
      before,
    });
    if (batch.size === 0) break;

    let reachedCutoff = false;
    for (const msg of batch.values()) {
      fetched += 1;
      result.messagesScanned += 1;
      before = msg.id;

      if (msg.createdTimestamp < cutoffMs) {
        reachedCutoff = true;
        continue;
      }
      if (msg.author.bot || msg.system) continue;

      const content = msg.content ?? "";
      if (content.trim() === "") {
        // Empty content during backfill is a strong signal the Message Content
        // intent is off (or it is genuinely attachment-only). Flag once.
        if (!result.messageContentMissing && msg.attachments.size === 0) {
          result.messageContentMissing = true;
        }
        continue;
      }

      const { score } = scoreText(content);
      const inserted = db.insertMessage({
        id: msg.id,
        guild_id: guildId,
        channel_id: channel.id,
        author_id_hash: AnalyticsDB.hashAuthorId(guildId, msg.author.id),
        created_at: new Date(msg.createdTimestamp).toISOString(),
        content,
        sentiment_score: score,
        has_question: isQuestion(content) ? 1 : 0,
      });
      if (inserted) result.messagesInserted += 1;
    }

    // Stop once we've paged past the window or exhausted the channel.
    if (reachedCutoff || batch.size < 100) break;
  }
}

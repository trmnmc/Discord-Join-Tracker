/**
 * Live gateway event handlers: member joins, member leaves, and message
 * creation. These keep the database current without any backfill.
 */
import { Client, Events, GuildMember, Message, PartialGuildMember } from "discord.js";
import { AnalyticsDB } from "./db";
import { scoreText } from "./sentiment";
import { isQuestion } from "./questions";
import { logger } from "./logger";

export function registerEventHandlers(client: Client, db: AnalyticsDB, guildId: string): void {
  // ---- Joins ----
  client.on(Events.GuildMemberAdd, (member: GuildMember) => {
    if (member.guild.id !== guildId) return;
    try {
      const occurredAt = (member.joinedAt ?? new Date()).toISOString();
      db.insertMemberEvent({
        guild_id: member.guild.id,
        user_id: member.id,
        event_type: "join",
        occurred_at: occurredAt,
        source: "gateway",
        metadata_json: JSON.stringify({ bot: member.user.bot ?? false }),
      });
      logger.debug(`join recorded for ${member.id}`);
    } catch (err) {
      logger.error("Failed to record join", err);
    }
  });

  // ---- Leaves ----
  client.on(Events.GuildMemberRemove, (member: GuildMember | PartialGuildMember) => {
    if (member.guild.id !== guildId) return;
    try {
      // We cannot reliably distinguish voluntary leaves from kicks/bans here;
      // record as a generic "leave". Audit-log backfill captures admin removals.
      db.insertMemberEvent({
        guild_id: member.guild.id,
        user_id: member.id,
        event_type: "leave",
        occurred_at: new Date().toISOString(),
        source: "gateway",
        metadata_json: null,
      });
      logger.debug(`leave recorded for ${member.id}`);
    } catch (err) {
      logger.error("Failed to record leave", err);
    }
  });

  // ---- Messages ----
  client.on(Events.MessageCreate, (message: Message) => {
    try {
      if (!message.guild || message.guild.id !== guildId) return;
      if (message.author.bot) return;
      if (message.system) return;
      const content = message.content ?? "";
      if (content.trim() === "") return; // empty/attachment-only/system → skip

      const { score } = scoreText(content);
      db.insertMessage({
        id: message.id,
        guild_id: message.guild.id,
        channel_id: message.channelId,
        author_id_hash: AnalyticsDB.hashAuthorId(message.guild.id, message.author.id),
        created_at: new Date(message.createdTimestamp).toISOString(),
        content,
        sentiment_score: score,
        has_question: isQuestion(content) ? 1 : 0,
      });
    } catch (err) {
      logger.error("Failed to record message", err);
    }
  });
}

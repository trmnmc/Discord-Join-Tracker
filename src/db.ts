/**
 * Database layer. Owns the better-sqlite3 connection, schema migrations, and
 * all prepared-statement access. Every query is parameterized; inserts that
 * could repeat are made idempotent with unique constraints + INSERT OR IGNORE.
 */
import Database from "better-sqlite3";
import * as crypto from "crypto";
import { logger } from "./logger";

export type EventType = "join" | "leave" | "kick" | "ban" | "prune";
export type EventSource = "gateway" | "member_backfill" | "audit_log";

export interface MemberEventRow {
  guild_id: string;
  user_id: string;
  event_type: EventType;
  occurred_at: string; // ISO-8601 UTC
  source: EventSource;
  metadata_json?: string | null;
}

export interface MessageRow {
  id: string;
  guild_id: string;
  channel_id: string;
  author_id_hash: string;
  created_at: string; // ISO-8601 UTC
  content: string | null;
  sentiment_score: number | null;
  has_question: number; // 0 | 1
}

export class AnalyticsDB {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    logger.info(`Database ready at ${databasePath}`);
  }

  /** Create tables/indexes if they do not yet exist. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS member_events (
        id INTEGER PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('join','leave','kick','ban','prune')),
        occurred_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('gateway','member_backfill','audit_log')),
        metadata_json TEXT,
        UNIQUE (guild_id, user_id, event_type, occurred_at, source)
      );

      CREATE INDEX IF NOT EXISTS idx_member_events_guild_time
        ON member_events (guild_id, occurred_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content TEXT,
        sentiment_score REAL,
        has_question INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_messages_guild_time
        ON messages (guild_id, created_at);

      CREATE TABLE IF NOT EXISTS report_runs (
        id INTEGER PRIMARY KEY,
        guild_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        days INTEGER NOT NULL,
        summary_json TEXT NOT NULL
      );
    `);
  }

  /** SHA-256 hash of the author id, salted with the guild id (privacy). */
  static hashAuthorId(guildId: string, userId: string): string {
    return crypto.createHash("sha256").update(`${guildId}:${userId}`).digest("hex");
  }

  /** Insert a member event idempotently. Returns true if a new row was added. */
  insertMemberEvent(row: MemberEventRow): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO member_events
        (guild_id, user_id, event_type, occurred_at, source, metadata_json)
      VALUES (@guild_id, @user_id, @event_type, @occurred_at, @source, @metadata_json)
    `);
    const info = stmt.run({
      guild_id: row.guild_id,
      user_id: row.user_id,
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      source: row.source,
      metadata_json: row.metadata_json ?? null,
    });
    return info.changes > 0;
  }

  /** Insert a message idempotently (primary key = Discord message id). */
  insertMessage(row: MessageRow): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, guild_id, channel_id, author_id_hash, created_at, content, sentiment_score, has_question)
      VALUES (@id, @guild_id, @channel_id, @author_id_hash, @created_at, @content, @sentiment_score, @has_question)
    `);
    const info = stmt.run(row);
    return info.changes > 0;
  }

  /** Member events of given types within [sinceIso, untilIso]. */
  getMemberEvents(
    guildId: string,
    sinceIso: string,
    untilIso: string,
    types: EventType[],
  ): MemberEventRow[] {
    const placeholders = types.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT guild_id, user_id, event_type, occurred_at, source, metadata_json
      FROM member_events
      WHERE guild_id = ?
        AND occurred_at >= ?
        AND occurred_at <= ?
        AND event_type IN (${placeholders})
      ORDER BY occurred_at ASC
    `);
    return stmt.all(guildId, sinceIso, untilIso, ...types) as MemberEventRow[];
  }

  /** Messages within window, optionally restricted to a single channel. */
  getMessages(
    guildId: string,
    sinceIso: string,
    untilIso: string,
    channelId?: string,
  ): MessageRow[] {
    if (channelId) {
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE guild_id = ? AND created_at >= ? AND created_at <= ? AND channel_id = ?
        ORDER BY created_at ASC
      `);
      return stmt.all(guildId, sinceIso, untilIso, channelId) as MessageRow[];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE guild_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY created_at ASC
    `);
    return stmt.all(guildId, sinceIso, untilIso) as MessageRow[];
  }

  insertReportRun(guildId: string, createdAtIso: string, days: number, summaryJson: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO report_runs (guild_id, created_at, days, summary_json)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(guildId, createdAtIso, days, summaryJson);
  }

  /** Delete message rows older than the cutoff. Returns rows removed. */
  deleteMessagesOlderThan(cutoffIso: string): number {
    const stmt = this.db.prepare(`DELETE FROM messages WHERE created_at < ?`);
    return stmt.run(cutoffIso).changes;
  }

  /** Aggregate stats used by /analytics-status. */
  getStatusStats(guildId: string): {
    joinCount: number;
    leaveCount: number;
    messageCount: number;
    oldestEvent: string | null;
    newestEvent: string | null;
  } {
    const joinCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM member_events WHERE guild_id = ? AND event_type = 'join'`,
        )
        .get(guildId) as { c: number }
    ).c;
    const leaveCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM member_events
           WHERE guild_id = ? AND event_type IN ('leave','kick','ban','prune')`,
        )
        .get(guildId) as { c: number }
    ).c;
    const messageCount = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE guild_id = ?`).get(guildId) as {
        c: number;
      }
    ).c;
    const bounds = this.db
      .prepare(
        `SELECT MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest
         FROM member_events WHERE guild_id = ?`,
      )
      .get(guildId) as { oldest: string | null; newest: string | null };
    return {
      joinCount,
      leaveCount,
      messageCount,
      oldestEvent: bounds.oldest,
      newestEvent: bounds.newest,
    };
  }

  /** True if any backfilled join exists (for data-quality notes). */
  hasBackfilledJoins(guildId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM member_events
         WHERE guild_id = ? AND event_type = 'join' AND source = 'member_backfill' LIMIT 1`,
      )
      .get(guildId);
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}

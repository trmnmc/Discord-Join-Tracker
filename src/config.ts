/**
 * Loads and validates environment configuration. Fails fast with a clear
 * message if required variables are missing or malformed.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { logger } from "./logger";

dotenv.config();

export interface AppConfig {
  discordToken: string;
  clientId: string;
  guildId: string;
  databasePath: string;
  defaultDays: number;
  backfillAuditLog: boolean;
  maxMessagesPerChannel: number;
  deleteRawMessagesAfterDays: number;
}

function requireString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    logger.warn(`Env ${name}="${raw}" is not an integer; using default ${fallback}`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    logger.warn(`Env ${name}=${parsed} out of range [${min}, ${max}]; clamping`);
    return Math.min(max, Math.max(min, parsed));
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    discordToken: requireString("DISCORD_TOKEN"),
    clientId: requireString("CLIENT_ID"),
    guildId: requireString("GUILD_ID"),
    databasePath: (process.env.DATABASE_PATH || "./data/analytics.sqlite").trim(),
    defaultDays: optionalInt("DEFAULT_DAYS", 7, 1, 30),
    backfillAuditLog: optionalBool("BACKFILL_AUDIT_LOG", true),
    maxMessagesPerChannel: optionalInt("MAX_MESSAGES_PER_CHANNEL", 1000, 1, 100000),
    deleteRawMessagesAfterDays: optionalInt("DELETE_RAW_MESSAGES_AFTER_DAYS", 14, 1, 365),
  };

  // Ensure the database directory exists so better-sqlite3 can create the file.
  const dir = path.dirname(path.resolve(config.databasePath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created database directory: ${dir}`);
  }

  return config;
}

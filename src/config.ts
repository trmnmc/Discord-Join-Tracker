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
  // Daily scheduled job:
  dailyTasksEnabled: boolean;
  dailyRunTimeUtc: string; // "HH:MM" 24h UTC
  reportChannelId: string | null; // where the daily report is posted (optional)
  // Local web dashboard:
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  dashboardUsername: string | null; // required when dashboardEnabled
  dashboardPassword: string | null; // required when dashboardEnabled
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

function optionalString(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim();
}

/** Parse an "HH:MM" 24-hour UTC time, falling back if malformed. */
function parseTimeUtc(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    logger.warn(`Env ${name}="${raw}" is not HH:MM; using default ${fallback}`);
    return fallback;
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) {
    logger.warn(`Env ${name}="${raw}" out of range; using default ${fallback}`);
    return fallback;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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
    dailyTasksEnabled: optionalBool("DAILY_TASKS_ENABLED", true),
    dailyRunTimeUtc: parseTimeUtc("DAILY_RUN_TIME_UTC", "09:00"),
    reportChannelId: optionalString("REPORT_CHANNEL_ID"),
    dashboardEnabled: optionalBool("DASHBOARD_ENABLED", false),
    dashboardHost: (process.env.DASHBOARD_HOST || "127.0.0.1").trim(),
    dashboardPort: optionalInt("DASHBOARD_PORT", 3000, 1, 65535),
    dashboardUsername: optionalString("DASHBOARD_USERNAME"),
    dashboardPassword: optionalString("DASHBOARD_PASSWORD"),
  };

  // Credentials are mandatory once the dashboard is turned on — never serve it
  // without auth.
  if (config.dashboardEnabled) {
    if (!config.dashboardUsername || !config.dashboardPassword) {
      throw new Error(
        "DASHBOARD_ENABLED=true requires both DASHBOARD_USERNAME and DASHBOARD_PASSWORD to be set.",
      );
    }
  }

  // Ensure the database directory exists so better-sqlite3 can create the file.
  const dir = path.dirname(path.resolve(config.databasePath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created database directory: ${dir}`);
  }

  return config;
}

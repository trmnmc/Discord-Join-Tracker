/**
 * Entry point. Validates config, opens the database, runs migrations, registers
 * guild slash commands, wires gateway + interaction handlers, starts the
 * cleanup job, and logs in the Discord client.
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActivityType,
  PermissionFlagsBits,
} from "discord.js";
import { loadConfig } from "./config";
import { AnalyticsDB } from "./db";
import { registerEventHandlers } from "./events";
import { registerGuildCommands, registerInteractionHandler } from "./commands";
import { startCleanupJob } from "./cleanup";
import { startDailyScheduler } from "./scheduler";
import { logger } from "./logger";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("Configuration loaded", {
    guildId: config.guildId,
    databasePath: config.databasePath,
    defaultDays: config.defaultDays,
    backfillAuditLog: config.backfillAuditLog,
  });

  const db = new AnalyticsDB(config.databasePath);

  // Register guild commands before login so they are ready immediately.
  try {
    await registerGuildCommands(config);
  } catch (err) {
    logger.error("Failed to register slash commands (continuing to start)", err);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // privileged: Server Members Intent
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: Message Content Intent
    ],
    // Partials let us still process events for uncached members/messages.
    partials: [Partials.GuildMember, Partials.Message, Partials.Channel],
  });

  const startedAt = Date.now();

  registerEventHandlers(client, db, config.guildId);
  registerInteractionHandler({ db, config, client, startedAt });

  // Stop handle for the daily scheduler; set on ready, cleared on shutdown.
  let stopScheduler: (() => void) | null = null;

  client.once(Events.ClientReady, (c) => {
    logger.info(`Logged in as ${c.user.tag}`);
    c.user.setActivity("community analytics", { type: ActivityType.Watching });
    logStartupWarnings(c, config.guildId);

    // Start the daily job only after the guild cache is populated.
    if (config.dailyTasksEnabled) {
      stopScheduler = startDailyScheduler(client, db, config);
    } else {
      logger.info("Daily scheduled job disabled (DAILY_TASKS_ENABLED=false).");
    }
  });

  // Surface gateway errors instead of dying silently.
  client.on(Events.Error, (err) => logger.error("Discord client error", err));
  client.on(Events.Warn, (msg) => logger.warn(`Discord warning: ${msg}`));

  const cleanupTimer = startCleanupJob(db, config.deleteRawMessagesAfterDays);

  await client.login(config.discordToken);

  // Graceful shutdown.
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(cleanupTimer);
    if (stopScheduler) stopScheduler();
    client.destroy();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Heuristic warnings about likely-missing privileged intents/permissions. */
function logStartupWarnings(
  client: Client<true>,
  guildId: string,
): void {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    logger.warn(
      `Bot is not in guild ${guildId}. Invite it to that server (see README for invite URL).`,
    );
    return;
  }

  // If GuildMembers intent is enabled but disabled in portal, member fetch will
  // fail later; we cannot directly read portal flags, so we hint proactively.
  logger.info(
    "If member fetch or message content appear empty, enable the Server Members Intent and Message Content Intent in the Discord Developer Portal.",
  );

  const me = guild.members.me;
  if (me) {
    const missing: string[] = [];
    const need: [bigint, string][] = [
      [PermissionFlagsBits.ViewChannel, "View Channels"],
      [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
      [PermissionFlagsBits.SendMessages, "Send Messages"],
      [PermissionFlagsBits.AttachFiles, "Attach Files"],
    ];
    for (const [flag, name] of need) {
      if (!me.permissions.has(flag)) missing.push(name);
    }
    if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      logger.warn("Missing View Audit Log — admin-removal backfill will be skipped.");
    }
    if (missing.length > 0) {
      logger.warn(`Missing recommended permissions: ${missing.join(", ")}`);
    }
  }
}

main().catch((err) => {
  logger.error("Fatal startup error", err);
  process.exit(1);
});

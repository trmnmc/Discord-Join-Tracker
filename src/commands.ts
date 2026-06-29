/**
 * Slash command definitions, registration, and interaction handling for:
 *   /community-report, /refresh-backfill, /analytics-status
 */
import {
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  Client,
  GatewayIntentBits,
  ChannelType,
  MessageFlags,
} from "discord.js";
import { AppConfig } from "./config";
import { AnalyticsDB } from "./db";
import { buildReportData, summaryJson } from "./report";
import { buildReportMessage, truncate } from "./reportView";
import { runBackfill } from "./backfill";
import { logger } from "./logger";

export function buildCommandDefinitions() {
  const report = new SlashCommandBuilder()
    .setName("community-report")
    .setDescription("Generate a community analytics report with a joins/leaves chart.")
    .addIntegerOption((o) =>
      o
        .setName("days")
        .setDescription("Lookback window in days (1-30, default 7)")
        .setMinValue(1)
        .setMaxValue(30),
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Restrict message analysis to a single channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );

  const refresh = new SlashCommandBuilder()
    .setName("refresh-backfill")
    .setDescription("Admin: backfill recent joins, messages, and audit-log removals.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((o) =>
      o
        .setName("days")
        .setDescription("Lookback window in days (1-30, default 7)")
        .setMinValue(1)
        .setMaxValue(30),
    );

  const status = new SlashCommandBuilder()
    .setName("analytics-status")
    .setDescription("Show bot status, data counts, intents, and warnings.");

  return [report.toJSON(), refresh.toJSON(), status.toJSON()];
}

/** Register guild commands for instant availability. */
export async function registerGuildCommands(config: AppConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: buildCommandDefinitions(),
  });
  logger.info("Registered guild slash commands");
}

interface HandlerContext {
  db: AnalyticsDB;
  config: AppConfig;
  client: Client;
  startedAt: number;
}

export function registerInteractionHandler(ctx: HandlerContext): void {
  ctx.client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      switch (interaction.commandName) {
        case "community-report":
          await handleReport(interaction, ctx);
          break;
        case "refresh-backfill":
          await handleRefresh(interaction, ctx);
          break;
        case "analytics-status":
          await handleStatus(interaction, ctx);
          break;
        default:
          break;
      }
    } catch (err) {
      logger.error(`Interaction ${interaction.commandName} failed`, err);
      await safeReply(interaction, "Something went wrong handling that command.");
    }
  });
}

async function safeReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    logger.error("Failed to send error reply", err);
  }
}

function windowFor(days: number): { sinceIso: string; untilIso: string } {
  const now = Date.now();
  return {
    sinceIso: new Date(now - days * 86_400_000).toISOString(),
    untilIso: new Date(now).toISOString(),
  };
}

// ---- /community-report ----
async function handleReport(
  interaction: ChatInputCommandInteraction,
  ctx: HandlerContext,
): Promise<void> {
  await interaction.deferReply();
  const days = interaction.options.getInteger("days") ?? ctx.config.defaultDays;
  const channel = interaction.options.getChannel("channel");
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("This command must be used in a server.");
    return;
  }

  const { sinceIso, untilIso } = windowFor(days);
  const data = buildReportData(ctx.db, guildId, {
    sinceIso,
    untilIso,
    days,
    channelId: channel?.id,
  });

  // Persist the run summary.
  try {
    ctx.db.insertReportRun(guildId, new Date().toISOString(), days, summaryJson(data));
  } catch (err) {
    logger.warn("Failed to persist report run", err);
  }

  const message = await buildReportMessage(data);
  await interaction.editReply(message);
}

// ---- /refresh-backfill ----
async function handleRefresh(
  interaction: ChatInputCommandInteraction,
  ctx: HandlerContext,
): Promise<void> {
  // Defense in depth: setDefaultMemberPermissions already gates this, but
  // re-check in case server overrides loosen it.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "You need Administrator permission to run this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const days = interaction.options.getInteger("days") ?? ctx.config.defaultDays;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply("This command must be used in a server.");
    return;
  }

  const now = Date.now();
  const cutoffIso = new Date(now - days * 86_400_000).toISOString();
  const result = await runBackfill(guild, ctx.db, {
    days,
    cutoffIso,
    nowIso: new Date(now).toISOString(),
    backfillAuditLog: ctx.config.backfillAuditLog,
    maxMessagesPerChannel: ctx.config.maxMessagesPerChannel,
  });

  const permIssues =
    result.permissionIssues.length > 0
      ? truncate(result.permissionIssues.map((p) => `• ${p}`).join("\n"), 1024)
      : "_None_";

  const embed = new EmbedBuilder()
    .setTitle("🔄 Backfill complete")
    .setColor(0x5865f2)
    .setDescription(`Window: last **${days}** day(s)`)
    .addFields(
      { name: "Members scanned", value: String(result.membersScanned), inline: true },
      { name: "Joins inserted", value: String(result.joinsInserted), inline: true },
      { name: "Audit events inserted", value: String(result.auditEventsInserted), inline: true },
      { name: "Messages scanned", value: String(result.messagesScanned), inline: true },
      { name: "Messages inserted", value: String(result.messagesInserted), inline: true },
      { name: "Skipped channels", value: String(result.skippedChannels), inline: true },
      { name: "Permission / access issues", value: permIssues, inline: false },
    );

  if (result.messageContentMissing) {
    embed.addFields({
      name: "⚠️ Message content",
      value:
        "Some readable messages had empty content. The **Message Content** privileged intent is likely disabled.",
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ---- /analytics-status ----
async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: HandlerContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guildId ?? ctx.config.guildId;
  const stats = ctx.db.getStatusStats(guildId);

  const uptimeMs = Date.now() - ctx.startedAt;
  const intents = ctx.client.options.intents;
  const enabledIntents = [
    bitName(intents, GatewayIntentBits.Guilds, "Guilds"),
    bitName(intents, GatewayIntentBits.GuildMembers, "GuildMembers"),
    bitName(intents, GatewayIntentBits.GuildMessages, "GuildMessages"),
    bitName(intents, GatewayIntentBits.MessageContent, "MessageContent"),
  ].filter((x): x is string => x !== null);

  // Warnings: privileged intents and bot-side permissions.
  const warnings: string[] = [];
  const guild = ctx.client.guilds.cache.get(guildId);
  const me = guild?.members.me;
  if (me) {
    const p = me.permissions;
    if (!p.has(PermissionFlagsBits.ViewAuditLog)) {
      warnings.push("Missing View Audit Log — admin-removal backfill will be skipped.");
    }
    if (!p.has(PermissionFlagsBits.ReadMessageHistory)) {
      warnings.push("Missing Read Message History at guild level — message backfill limited.");
    }
    if (!p.has(PermissionFlagsBits.AttachFiles)) {
      warnings.push("Missing Attach Files — report chart cannot be attached.");
    }
  }
  // The gateway will reject MessageContent/GuildMembers if not enabled in the
  // portal; if we have message rows with null content it is a strong hint.
  if (stats.messageCount === 0) {
    warnings.push(
      "No messages stored yet — run /refresh-backfill, or verify Message Content intent is enabled.",
    );
  }

  const embed = new EmbedBuilder()
    .setTitle("🩺 Analytics Status")
    .setColor(0x5865f2)
    .addFields(
      { name: "Uptime", value: formatDuration(uptimeMs), inline: true },
      { name: "Guild ID", value: guildId, inline: true },
      { name: "Database", value: `\`${ctx.config.databasePath}\``, inline: false },
      { name: "Intents (in code)", value: enabledIntents.join(", ") || "_none_", inline: false },
      { name: "Join events", value: String(stats.joinCount), inline: true },
      { name: "Leave events", value: String(stats.leaveCount), inline: true },
      { name: "Message rows", value: String(stats.messageCount), inline: true },
      {
        name: "Oldest event",
        value: stats.oldestEvent ? `\`${stats.oldestEvent}\`` : "_none_",
        inline: true,
      },
      {
        name: "Newest event",
        value: stats.newestEvent ? `\`${stats.newestEvent}\`` : "_none_",
        inline: true,
      },
      {
        name: "Warnings",
        value: warnings.length > 0 ? truncate(warnings.map((w) => `• ${w}`).join("\n"), 1024) : "_None_",
        inline: false,
      },
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

// ---- helpers ----
function bitName(intents: { has(bit: GatewayIntentBits): boolean } | number | readonly GatewayIntentBits[], bit: GatewayIntentBits, name: string): string | null {
  // discord.js stores resolved intents as an IntentsBitField on client.options.
  const value = intents as unknown as { has?: (b: GatewayIntentBits) => boolean };
  if (value && typeof value.has === "function") {
    return value.has(bit) ? name : null;
  }
  // Fallback: numeric bitfield.
  const num = Number(intents);
  return (num & Number(bit)) === Number(bit) ? name : null;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Message-based commands (e.g., add/remove streamers).
 * In the live announcement channel, messages starting with "!stream" are processed.
 */

import {
  rootServer,
  RootApiException,
  MessageType,
  type ChannelGuid,
  ChannelMessageEvent,
  ChannelMessageCreatedEvent,
  ChannelMessageCreateRequest,
} from "@rootsdk/server-bot";
import type { RootBotSettings } from "./types.js";
import { t } from "./i18n/index.js";
import { getRuntimeLanguage, setRuntimeLanguage } from "./locale.js";
import {
  handleAutoModeration,
  setAutoModRule,
  clearAutoModRules,
  getAutoModRulesRaw,
  setMutedUntil,
  unmuteUser,
  tempBanUser,
  tempKickUser,
  sendModerationLog,
  getModerationLogChannelId,
  setModerationLogChannelId,
  clearModerationLogChannelId,
  type AutoModAction,
  type AutoModField,
} from "./automod.js";
import { triggerWelcome, triggerGoodbye, getOverrides } from "./welcome.js";
import {
  checkYouTubeLive,
  checkYouTubeLatestContent,
  checkTwitchLive,
  getTwitchAppToken,
  getStreamOverrides,
  triggerStreamTest,
} from "./streams.js";
import { resolveStreamerInput } from "./streamDiscovery.js";
import {
  hasAdminPermission,
  hasModeratorPermission,
  hasModerationGuardConfigured,
  getAdminRoleId,
  setAdminRoleId,
  clearAdminRole,
  getModRoleId,
  setModRoleId,
  clearModRole,
  getOverrideRoleId,
  setOverrideRoleId,
  clearOverrideRole,
} from "./permissions.js";
import {
  configureAutoRoleRule,
  removeAutoRoleRule,
  startPendingAutoRoleSetup,
} from "./autorole.js";
import {
  getCommunityCatalogEntries,
  migrateLegacyStreamersIfNeeded,
  subscribeCatalogEntry,
  unsubscribeCommunityEntryByIndex,
  upsertCatalogEntry,
} from "./streamRegistry.js";

const KEY_VALUE = rootServer.dataStore.appData;
const YT_QUOTA_BLOCKED_UNTIL_KEY = "youtube:quotaBlockedUntil";
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const DEBUG_COMMANDS_KEY = "config:debugCommands";
const COMMAND_PREFIX_KEY = "config:commandPrefix";
const DEFAULT_COMMAND_PREFIX = "!";
let defaultPrefixFromGlobalSettings = DEFAULT_COMMAND_PREFIX;

type RootCommand = "ping" | "help" | "set" | "stream" | "welcome" | "goodbye" | "automod" | "mod";

const COMMAND_ALIASES: Record<RootCommand, string[]> = {
  ping: ["ping", "p"],
  help: ["help", "h"],
  set: ["set", "s"],
  stream: ["stream", "st"],
  welcome: ["welcome", "wc"],
  goodbye: ["goodbye", "gb"],
  automod: ["automod", "am"],
  mod: ["mod", "md"],
};

export function registerStreamCommands(settings: RootBotSettings): void {
  if (typeof settings.commandPrefix === "string") {
    const normalized = settings.commandPrefix.trim();
    const validation = validateCommandPrefix(normalized);
    if (validation.ok) {
      defaultPrefixFromGlobalSettings = normalized;
      commandPrefixCache = null;
    }
  }

  rootServer.community.channelMessages.on(
    ChannelMessageEvent.ChannelMessageCreated,
    (evt: ChannelMessageCreatedEvent) => onMessage(evt, settings)
  );
}

async function onMessage(
  evt: ChannelMessageCreatedEvent,
  settings: RootBotSettings
): Promise<void> {
  if (evt.messageType === MessageType.System) return;

  const moderated = await handleAutoModeration(evt);
  if (moderated) return;

  const content = (evt.messageContent ?? "").trim();
  const parsed = await parseRootCommand(content);
  if (!parsed) return;

  if (await isDebugCommandsEnabled()) {
    console.log(`[Command] Channel: ${evt.channelId}, User: ${evt.userId}, Raw: "${content}"`);
  }

  const language = await getRuntimeLanguage(settings.language);
  const runtimeSettings: RootBotSettings = { ...settings, language };

  try {
    if (parsed.cmd === "ping") {
      await send(evt.channelId, "Pong!");
      return;
    }

    if (parsed.cmd === "help") {
      await send(evt.channelId, await globalHelpText(runtimeSettings.language, evt.userId));
      return;
    }

    if (parsed.cmd === "set") {
      await handleSet(evt.channelId, evt.userId, runtimeSettings, parsed.args);
      return;
    }

    if (parsed.cmd === "automod") {
      await handleAutoModCommand(evt.channelId, evt.userId, runtimeSettings, parsed.args);
      return;
    }

    if (parsed.cmd === "mod") {
      await handleModCommand(evt.channelId, evt.userId, runtimeSettings, parsed.args);
      return;
    }

    if (parsed.cmd === "stream") {
      await handleStream(evt.channelId, evt.userId, runtimeSettings, parsed.args);
      return;
    }

    if (parsed.cmd === "welcome") {
      await handleConfig(evt.channelId, evt.userId, runtimeSettings, "welcome", parsed.args);
      return;
    }

    if (parsed.cmd === "goodbye") {
      await handleConfig(evt.channelId, evt.userId, runtimeSettings, "goodbye", parsed.args);
      return;
    }
  } catch (err) {
    if (err instanceof RootApiException) {
      console.error("[Command] RootApiException:", err.errorCode);
    } else if (err instanceof Error) {
      console.error("[Command] Error:", err.message);
    } else {
      console.error("[Command] Unknown error:", err);
    }
  }
}
async function handleSet(
  channelId: string,
  userId: string,
  settings: RootBotSettings,
  content: string
): Promise<void> {
  const parts = content.trim().split(/\s+/);
  const subRaw = parts[0]?.toLowerCase();
  const sub = normalizeSetSubcommand(subRaw);
  const val = parts.slice(1).join(" ").trim();
  const locale = settings.language;

  if (!sub || isHelpToken(subRaw)) {
    const isAdmin = await canUseAdminCommands(userId);
    const commands = [
      t(locale, "cmdHelpSet"),
    ];

    if (isAdmin) {
      commands.push(
        t(locale, "cmdHelpSetAdminRole"),
        t(locale, "cmdHelpSetAdminRoleClear"),
        t(locale, "cmdHelpSetLanguage"),
        t(locale, "cmdHelpSetDebug"),
        t(locale, "cmdHelpSetAutoRole"),
        "- `!set prefix <prefix>` - Change command prefix",
      );
    }

    await send(channelId, commands.join("\n"));
    return;
  }

  if (isHelpArg(val)) {
    const specific = setSubcommandHelp(locale, sub);
    if (specific) {
      await send(channelId, specific);
      return;
    }
  }

  // Admin role configuration
  if (sub === "adminrole") {
    const isAdmin = await hasAdminPermission(userId);

    // If no admin role is set, anyone can set it for the first time
    // If admin role is set, only admins can change it
    const currentAdminRole = await getAdminRoleId();
    if (currentAdminRole && !isAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }

    if (!val) {
      // Show current admin role
      if (currentAdminRole) {
        await send(channelId, t(locale, "adminRoleCurrent", { role: `<@&${currentAdminRole}>` }));
      } else {
        await send(channelId, t(locale, "adminRoleNone"));
      }
      return;
    }

    if (val.toLowerCase() === "clear") {
      await clearAdminRole();
      await send(channelId, t(locale, "adminRoleCleared"));
      return;
    }

    // Set admin role
    const found = await resolveRole(val);
    if (found) {
      await setAdminRoleId(found.id);
      await send(channelId, t(locale, "adminRoleSet"));
    } else {
      await send(channelId, `Role "${val}" not found.`);
    }
    return;
  }

  // Language configuration
  if (sub === "language") {
    const isAdmin = await hasAdminPermission(userId);
    if (!isAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }

    if (!val) {
      // Show current language
      const currentLang = settings.language || "en";
      await send(channelId, t(locale, "languageCurrent", { language: currentLang }));
      return;
    }

    const newLang = val.toLowerCase();
    if (newLang !== "pt" && newLang !== "en") {
      await send(channelId, t(locale, "languageInvalid"));
      return;
    }

    await KEY_VALUE.set([{ key: "config:language", value: newLang }]);
    settings.language = newLang;
    setRuntimeLanguage(newLang);
    await send(channelId, t(newLang, "languageSet", { language: newLang }));
    return;
  }

  if (sub === "debug") {
    const isAdmin = await canUseAdminCommands(userId);
    if (!isAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }

    if (!val) {
      const enabled = await isDebugCommandsEnabled();
      await send(channelId, t(locale, enabled ? "cmdDebugEnabled" : "cmdDebugDisabled"));
      return;
    }

    const normalized = val.toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      await send(channelId, t(locale, "cmdDebugUsage"));
      return;
    }

    const next = normalized === "on";

    await KEY_VALUE.set([{ key: DEBUG_COMMANDS_KEY, value: next ? "true" : "false" }]);
    await send(channelId, t(locale, next ? "cmdDebugEnabled" : "cmdDebugDisabled"));
    return;
  }

  if (sub === "prefix") {
    const isAdmin = await canUseAdminCommands(userId);
    if (!isAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }

    if (!val) {
      const current = await getCommandPrefix();
      await send(channelId, `Current prefix: \`${current}\``);
      return;
    }

    const prefix = val.trim();
    const validation = validateCommandPrefix(prefix);
    if (!validation.ok) {
      await send(channelId, validation.error);
      return;
    }

    await KEY_VALUE.set([{ key: COMMAND_PREFIX_KEY, value: prefix }]);
    commandPrefixCache = prefix;
    await send(channelId, `Command prefix set to: \`${prefix}\``);
    return;
  }

  if (sub === "autorole") {
    const isAdmin = await canUseAdminCommands(userId);
    if (!isAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }

    const removeParsed = parseAutoRoleRemoveArgs(val);
    if (removeParsed) {
      const removed = await removeAutoRoleRule({
        messageId: removeParsed.messageId,
        shortcode: removeParsed.emoji,
      });
      if (!removed) {
        await send(channelId, t(locale, "cmdAutoRoleNotFound"));
        return;
      }
      await send(channelId, t(locale, "cmdAutoRoleRemoved", {
        messageId: removeParsed.messageId,
        emoji: removeParsed.emoji,
      }));
      return;
    }

    const parsedDirect = parseAutoRoleArgs(val);
    if (parsedDirect) {
      const role = await resolveRole(parsedDirect.roleRaw);
      if (!role) {
        await send(channelId, t(locale, "cmdRoleNotFound", { role: parsedDirect.roleRaw }));
        return;
      }

      try {
        await configureAutoRoleRule({
          messageId: parsedDirect.messageId,
          shortcode: parsedDirect.emoji,
          roleId: role.id,
          mode: parsedDirect.mode,
        });
        await send(channelId, t(locale, "cmdAutoRoleConfigured", {
          messageId: parsedDirect.messageId,
          emoji: parsedDirect.emoji,
          role: `<@&${role.id}>`,
          mode: parsedDirect.mode,
        }));
      } catch (err) {
        if (err instanceof Error && err.message === "message_not_found") {
          await send(channelId, t(locale, "cmdAutoRoleMessageNotFound", { messageId: parsedDirect.messageId }));
          return;
        }
        if (err instanceof Error && err.message === "emoji_invalid") {
          await send(channelId, t(locale, "cmdAutoRoleInvalidEmoji"));
          return;
        }
        if (err instanceof Error) {
          console.error("[AutoRole] Configure failed:", err.message);
        } else {
          console.error("[AutoRole] Configure failed:", err);
        }
        await send(channelId, t(locale, "cmdAutoRoleConfigFailed"));
        return;
      }
      return;
    }

    const parsedPending = parseAutoRolePendingArgs(val);
    if (!parsedPending) {
      await send(channelId, t(locale, "cmdAutoRoleUsage"));
      return;
    }

    const role = await resolveRole(parsedPending.roleRaw);
    if (!role) {
      await send(channelId, t(locale, "cmdRoleNotFound", { role: parsedPending.roleRaw }));
      return;
    }

    try {
      await startPendingAutoRoleSetup({
        requesterUserId: userId,
        commandChannelId: channelId,
        messageId: parsedPending.messageId,
        roleId: role.id,
        mode: parsedPending.mode,
        locale,
      });
      await send(channelId, t(locale, "cmdAutoRoleAwaitReaction", {
        messageId: parsedPending.messageId,
        role: `<@&${role.id}>`,
        mode: parsedPending.mode,
      }));
    } catch (err) {
      if (err instanceof Error && err.message === "message_not_found") {
        await send(channelId, t(locale, "cmdAutoRoleMessageNotFound", { messageId: parsedPending.messageId }));
        return;
      }
      if (err instanceof Error) {
        console.error("[AutoRole] Pending setup failed:", err.message);
      } else {
        console.error("[AutoRole] Pending setup failed:", err);
      }
      await send(channelId, t(locale, "cmdAutoRoleConfigFailed"));
      return;
    }
    return;
  }

  await send(channelId, t(locale, "cmdInvalidArg", { cmd: "set" }));
}

async function handleSetAutoMod(
  channelId: string,
  locale: string | undefined,
  val: string,
  actorUserId?: string
): Promise<void> {
  const raw = val.trim();
  if (!raw || isHelpArg(raw)) {
    await send(channelId, t(locale, "cmdUsageSetAutoMod"));
    return;
  }

  const parts = raw.split(/\s+/);
  const first = parts[0]?.toLowerCase();
  if (first === "info" || first === "list" || first === "i" || first === "l") {
    const rules = await getAutoModRulesRaw();
    await send(
      channelId,
      t(locale, "cmdAutoModInfo", {
        deleteWords: rules.deleteWords || "---",
        deleteRegex: rules.deleteRegex || "---",
        kickWords: rules.kickWords || "---",
        kickRegex: rules.kickRegex || "---",
        banWords: rules.banWords || "---",
        banRegex: rules.banRegex || "---",
      })
    );
    return;
  }

  const action = normalizeAutoModAction(parts[0]);
  if (!action) {
    await send(channelId, t(locale, "cmdUsageSetAutoMod"));
    return;
  }

  const second = parts[1]?.toLowerCase();
  if (!second) {
    await send(channelId, t(locale, "cmdUsageSetAutoMod"));
    return;
  }

  if (["clear", "reset", "rs"].includes(second)) {
    await clearAutoModRules(action);
    await send(channelId, t(locale, "cmdAutoModCleared", { action }));
    if (actorUserId) {
      await sendModerationLog(`Configuration changed.\nAction: automod clear\nScope: ${action}\nBy: <@${actorUserId}>`);
    }
    return;
  }

  const field = normalizeAutoModField(second);
  if (!field) {
    await send(channelId, t(locale, "cmdUsageSetAutoMod"));
    return;
  }

  const csv = raw.split(/\s+/).slice(2).join(" ").trim();
  if (!csv) {
    await send(channelId, t(locale, "cmdUsageSetAutoMod"));
    return;
  }

  await setAutoModRule(action, field, csv);
  await send(channelId, t(locale, "cmdAutoModSaved", { action, field }));
  if (actorUserId) {
    await sendModerationLog(
      `Configuration changed.\nAction: automod set\nScope: ${action}.${field}\nValue: ${csv}\nBy: <@${actorUserId}>`
    );
  }
}

async function handleAutoModCommand(
  channelId: string,
  userId: string,
  settings: RootBotSettings,
  content: string
): Promise<void> {
  const locale = settings.language;
  if (!(await hasModerationGuardConfigured())) {
    await send(channelId, t(locale, "modGuardMissing"));
    return;
  }
  const canUseMod = await canUseModCommands(userId);
  if (!canUseMod) {
    await send(channelId, t(locale, "permissionDenied"));
    return;
  }
  await handleSetAutoMod(channelId, locale, content, userId);
}

async function handleModCommand(
  channelId: string,
  userId: string,
  settings: RootBotSettings,
  content: string
): Promise<void> {
  const locale = settings.language;
  const parts = content.trim().split(/\s+/);
  const sub = normalizeModSubcommand(parts[0]?.toLowerCase());
  const val = parts.slice(1).join(" ").trim();

  if (!sub || isHelpToken(parts[0]?.toLowerCase())) {
    await send(channelId, t(locale, "cmdUsageMod"));
    return;
  }

  if (isHelpArg(val)) {
    await send(channelId, modSubcommandHelp(locale, sub) ?? t(locale, "cmdUsageMod"));
    return;
  }

  if (sub === "role" || sub === "logs" || sub === "override") {
    const canUseAdmin = await canUseAdminCommands(userId);
    if (!canUseAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }
  } else {
    if (!(await hasModerationGuardConfigured())) {
      await send(channelId, t(locale, "modGuardMissing"));
      return;
    }
    const canUseMod = await canUseModCommands(userId);
    if (!canUseMod) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }
  }

  if (sub === "role") {
    const raw = val.trim();
    if (!raw) {
      const roleId = await getModRoleId();
      await send(channelId, roleId ? t(locale, "modRoleCurrent", { role: `<@&${roleId}>` }) : t(locale, "modRoleNone"));
      return;
    }
    if (raw.toLowerCase() === "clear") {
      await clearModRole();
      await send(channelId, t(locale, "modRoleCleared"));
      await sendModerationLog(`Configuration changed.\nAction: mod role clear\nBy: <@${userId}>`);
      return;
    }
    const role = await resolveRole(raw);
    if (!role) {
      await send(channelId, t(locale, "cmdRoleNotFound", { role: raw }));
      return;
    }
    await setModRoleId(role.id);
    await send(channelId, t(locale, "modRoleSet"));
    await sendModerationLog(`Configuration changed.\nAction: mod role set\nRole: <@&${role.id}>\nBy: <@${userId}>`);
    return;
  }

  if (sub === "logs") {
    const raw = val.trim();
    if (!raw) {
      const current = await getModerationLogChannelId();
      await send(channelId, current ? t(locale, "modLogsCurrent", { channel: `<#${current}>` }) : t(locale, "modLogsNone"));
      return;
    }
    if (raw.toLowerCase() === "clear") {
      await clearModerationLogChannelId();
      await send(channelId, t(locale, "modLogsCleared"));
      return;
    }
    const found = await resolveChannel(raw);
    if (!found) {
      await send(channelId, `Channel "${raw}" not found.`);
      return;
    }
    await setModerationLogChannelId(found.id);
    await send(channelId, t(locale, "modLogsSet", { channel: `<#${found.id}>` }));
    await sendModerationLog(`Configuration changed.\nAction: mod logs set\nChannel: <#${found.id}>\nBy: <@${userId}>`);
    return;
  }

  if (sub === "override") {
    const raw = val.trim();
    if (!raw) {
      const roleId = await getOverrideRoleId();
      await send(channelId, roleId ? t(locale, "overrideRoleCurrent", { role: `<@&${roleId}>` }) : t(locale, "overrideRoleNone"));
      return;
    }
    if (raw.toLowerCase() === "clear") {
      await clearOverrideRole();
      await send(channelId, t(locale, "overrideRoleCleared"));
      await sendModerationLog(`Configuration changed.\nAction: override role clear\nBy: <@${userId}>`);
      return;
    }
    const role = await resolveRole(raw);
    if (!role) {
      await send(channelId, t(locale, "cmdRoleNotFound", { role: raw }));
      return;
    }
    await setOverrideRoleId(role.id);
    await send(channelId, t(locale, "overrideRoleSet"));
    await sendModerationLog(`Configuration changed.\nAction: override role set\nRole: <@&${role.id}>\nBy: <@${userId}>`);
    return;
  }

  if (sub === "mute") {
    const parsed = parseTimedModerationArgs(val);
    if (!parsed) {
      await send(channelId, t(locale, "cmdUsageSetMute"));
      return;
    }
    const target = await resolveUserId(parsed.userRaw);
    if (!target) {
      await send(channelId, t(locale, "cmdUserNotFound"));
      return;
    }
    const targetDisplay = await getUserDisplayName(target);
    const durationMsRaw = parseDurationToMs(parsed.durationRaw);
    if (!durationMsRaw) {
      await send(channelId, t(locale, "cmdDurationInvalid"));
      return;
    }
    const durationMs = clampModerationDurationMs(durationMsRaw);
    await setMutedUntil(target, Date.now() + durationMs);
    await send(channelId, t(locale, "cmdMuteApplied", { user: `**${targetDisplay}**`, duration: formatDuration(durationMs) }));
    await sendModerationLog(
      `Manual moderation.\nAction: mute\nTarget: ${targetDisplay} (${target})\nDuration: ${formatDuration(durationMs)}\nReason: ${parsed.reasonRaw || "-"}\nBy: <@${userId}>`
    );
    return;
  }

  if (sub === "unmute") {
    const target = await resolveUserId(val);
    if (!target) {
      await send(channelId, t(locale, "cmdUserNotFound"));
      return;
    }
    const targetDisplay = await getUserDisplayName(target);
    const removed = await unmuteUser(target);
    await send(channelId, removed ? t(locale, "cmdUnmuteApplied", { user: `**${targetDisplay}**` }) : t(locale, "cmdUnmuteNotMuted"));
    if (removed) {
      await sendModerationLog(`Manual moderation.\nAction: unmute\nTarget: ${targetDisplay} (${target})\nBy: <@${userId}>`);
    }
    return;
  }

  if (sub === "tempban" || sub === "tempkick") {
    const parsed = parseTimedModerationArgs(val);
    if (!parsed) {
      await send(channelId, t(locale, sub === "tempban" ? "cmdUsageSetTempBan" : "cmdUsageSetTempKick"));
      return;
    }
    const target = await resolveUserId(parsed.userRaw);
    if (!target) {
      await send(channelId, t(locale, "cmdUserNotFound"));
      return;
    }
    const targetDisplay = await getUserDisplayName(target);
    const durationMsRaw = parseDurationToMs(parsed.durationRaw);
    if (!durationMsRaw) {
      await send(channelId, t(locale, "cmdDurationInvalid"));
      return;
    }
    const durationMs = clampModerationDurationMs(durationMsRaw);
    const until = Date.now() + durationMs;
    if (sub === "tempban") {
      await tempBanUser(target, until, parsed.reasonRaw);
      await send(channelId, t(locale, "cmdTempBanApplied", { user: `**${targetDisplay}**`, duration: formatDuration(durationMs) }));
    } else {
      await tempKickUser(target, until, parsed.reasonRaw);
      await send(channelId, t(locale, "cmdTempKickApplied", { user: `**${targetDisplay}**`, duration: formatDuration(durationMs) }));
    }
    await sendModerationLog(
      `Manual moderation.\nAction: ${sub}\nTarget: ${targetDisplay} (${target})\nDuration: ${formatDuration(durationMs)}\nReason: ${parsed.reasonRaw || "-"}\nBy: <@${userId}>`
    );
    return;
  }

  await send(channelId, t(locale, "cmdUsageMod"));
}

async function handleStream(
  channelId: string,
  userId: string,
  settings: RootBotSettings,
  content: string
): Promise<void> {
  const parts = content.trim().split(/\s+/);
  const subRaw = parts[0]?.toLowerCase();
  const sub = normalizeStreamSubcommand(subRaw);
  const val = parts.slice(1).join(" ").trim();
  const locale = settings.language;

  if (!sub || isHelpToken(subRaw)) {
    await send(channelId, await streamHelpText(locale, userId));
    return;
  }

  if (isHelpArg(val)) {
    const specific = streamSubcommandHelp(locale, sub);
    if (specific) {
      await send(channelId, specific);
      return;
    }
  }

  if (sub === "live") {
    const canUseAdmin = await canUseAdminCommands(userId);
    if (!canUseAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }
    await showLiveStatus(channelId, locale, val || undefined);
    return;
  }

  if (sub === "list") {
    await listStreamers(channelId, locale);
    return;
  }

  // Admin command - set or clear admin role
  if (sub === "admin") {
    const isAdmin = await hasAdminPermission(userId);

    // If no admin role is set, anyone can set it for the first time
    // If admin role is set, only admins can change it
    const currentAdminRole = await getAdminRoleId();
    if (currentAdminRole && !isAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }

    if (!val) {
      // Show current admin role
      if (currentAdminRole) {
        await send(channelId, t(locale, "adminRoleCurrent", { role: `<@&${currentAdminRole}>` }));
      } else {
        await send(channelId, t(locale, "adminRoleNone"));
      }
      return;
    }

    if (val.toLowerCase() === "clear") {
      await clearAdminRole();
      await send(channelId, t(locale, "adminRoleCleared"));
      return;
    }

    // Set admin role
    const found = await resolveRole(val);
    if (found) {
      await setAdminRoleId(found.id);
      await send(channelId, t(locale, "adminRoleSet"));
    } else {
      await send(channelId, `Role "${val}" not found.`);
    }
    return;
  }

  // Check admin permission for admin-only commands
  const isAdmin = await hasAdminPermission(userId);
  if (!isAdmin) {
    // These commands require admin permission
    const adminCommands = ["test", "info", "reset", "add", "remove", "message", "channel", "role"];
    if (adminCommands.includes(sub)) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }
  }

  if (sub === "test") {
    await send(channelId, t(locale, "cmdConfigTestTriggered", { type: "stream" }));
    await triggerStreamTest(userId, settings);
    return;
  }

  if (sub === "info") {
    const overrides = await getStreamOverrides();
    const activeChannel = overrides.channelId;
    const activeRole = overrides.roleId;
    const activeMessage = overrides.message;

    await send(channelId, t(locale, "cmdConfigInfoStream", {
      channel: activeChannel ? `<#${activeChannel}>` : "---",
      role: activeRole ? `<@&${activeRole}>` : "---",
      message: activeMessage ?? "---",
    }));
    return;
  }

  if (sub === "reset") {
    await KEY_VALUE.delete("config:streamChannelId");
    await KEY_VALUE.delete("config:streamMentionRoleId");
    await KEY_VALUE.delete("config:streamMessage");
    await send(channelId, t(locale, "cmdConfigReset", { type: "stream" }));
    return;
  }

  if (sub === "add" && val) {
    await addStreamer(channelId, locale, val);
  } else if (sub === "remove" && val) {
    const index = parseInt(val, 10);
    if (!Number.isNaN(index)) {
      await removeStreamer(channelId, locale, index);
    }
  } else if (sub === "message" && val) {
    await KEY_VALUE.set([{ key: "config:streamMessage", value: val }]);
    await send(channelId, t(locale, "cmdConfigSaved", { type: "message" }));
  } else if (sub === "channel" && val) {
    const found = await resolveChannel(val);
    if (found) {
      const key = `config:streamChannelId`;
      console.log(`[Stream] Setting AppData: key="${key}", value="${found.id}"`);
      await KEY_VALUE.set([{ key, value: found.id }]);
      // Verify immediately
      const verified = await KEY_VALUE.get(key);
      console.log(`[Stream] Immediate verification for ${key}: "${verified}"`);
      await send(channelId, t(locale, "cmdConfigSaved", { type: "channel" }));
    } else {
      await send(channelId, `Channel "${val}" not found.`);
    }
  } else if (sub === "role" && val) {
    const found = await resolveRole(val);
    if (found) {
      await KEY_VALUE.set([{ key: "config:streamMentionRoleId", value: found.id }]);
      await send(channelId, t(locale, "cmdConfigSaved", { type: "role" }));
    } else {
      await send(channelId, `Role "${val}" not found.`);
    }
  } else {
    await send(channelId, t(locale, "cmdInvalidArg", { cmd: "stream" }));
  }
}

async function globalHelpText(locale: string | undefined, userId: string): Promise<string> {
  const isAdmin = await canUseAdminCommands(userId);
  const isMod = await canUseModCommands(userId);
  const pt = locale?.toLowerCase() === "pt";
  const commands = [
    t(locale, "cmdHelpGlobalTitle"),
    t(locale, "cmdHelpPing"),
  ];

  if (isAdmin) {
    commands.push(
      "",
      t(locale, "adminCommandsHeader"),
      t(locale, "cmdHelpWelcome"),
      t(locale, "cmdHelpGoodbye"),
    );
  }

  if (isMod) {
    commands.push(
      "",
      t(locale, "modCommandsHeader"),
      t(locale, "cmdHelpAutoMod"),
      t(locale, "cmdHelpMod"),
    );
  }

  commands.push(
    "",
    t(locale, "publicCommandsHeader"),
    t(locale, "cmdHelpStreamHint"),
    t(locale, "cmdHelpHelp"),
    "",
    pt
      ? "Atalhos: `!st +` add, `!st l` list, `!wc c` channel, `!wc m` message, `!wc i` info, `!wc t` test, `!wc r` reset, `!s ar` admin role, `!s atr` autorole"
      : "Shortcuts: `!st +` add, `!st l` list, `!wc c` channel, `!wc m` message, `!wc i` info, `!wc t` test, `!wc r` reset, `!s ar` admin role, `!s atr` autorole",
  );

  return commands.join("\n");
}

async function streamHelpText(locale: string | undefined, userId: string): Promise<string> {
  const isAdmin = await canUseAdminCommands(userId);
  const pt = locale?.toLowerCase() === "pt";
  const commands = [
    t(locale, "cmdHelpStreamTitle"),
    "",
    t(locale, "publicCommandsHeader"),
    t(locale, "cmdHelpList"),
    t(locale, "cmdHelpHelpStream"),
    pt
      ? "`!st l` lista, `!st + <nome|uid|url>` adiciona, `!st - <numero>` remove"
      : "`!st l` list, `!st + <name|uid|url>` add, `!st - <number>` remove",
  ];

  if (isAdmin) {
    commands.push(
      "",
      t(locale, "adminCommandsHeader"),
      t(locale, "cmdHelpLive"),
      t(locale, "cmdHelpAddAuto"),
      t(locale, "cmdHelpRemove"),
      t(locale, "cmdHelpStreamChannel"),
      t(locale, "cmdHelpStreamRole"),
      t(locale, "cmdHelpStreamMessage"),
      t(locale, "cmdHelpStreamInfo"),
      t(locale, "cmdHelpStreamTest"),
      t(locale, "cmdHelpStreamReset"),
      t(locale, "cmdHelpAdmin"),
      t(locale, "cmdHelpAdminClear"),
    );
  }

  return commands.join("\n");
}

async function showLiveStatus(
  channelId: string,
  locale: string | undefined,
  containsFilter?: string,
): Promise<void> {
  await migrateLegacyStreamersIfNeeded();
  const all = await getCommunityCatalogEntries();
  const filter = containsFilter?.trim().toLowerCase();
  const streamers = filter
    ? all.filter((s) =>
      s.displayName.toLowerCase().includes(filter) ||
      s.externalId.toLowerCase().includes(filter))
    : all;

  if (streamers.length === 0) {
    await send(channelId, filter ? t(locale, "cmdNoStreamersMatch", { filter }) : t(locale, "cmdNoStreamers"));
    return;
  }

  const youtubeKey = process.env.YOUTUBE_API_KEY;
  const twitchId = process.env.TWITCH_CLIENT_ID;
  const twitchSecret = process.env.TWITCH_CLIENT_SECRET;
  console.log(`[Status] Streamers: ${streamers.length}, YT Key: ${!!youtubeKey}, Twitch: ${!!twitchId}`);

  let twitchToken: string | null = null;
  if (twitchId && twitchSecret) twitchToken = await getTwitchAppToken(twitchId, twitchSecret);
  const twitchAvailable = Boolean(twitchId && twitchSecret && twitchToken);

  const liveOnes: string[] = [];
  const unavailablePlatforms = new Set<string>();
  let checkedCount = 0;
  for (const s of streamers) {
    let live = false;
    let url = "";
    if (s.platform === "youtube") {
      const res = await checkYouTubeLive(youtubeKey ?? "", s.externalId);
      live = res.isLive;
      url = res.url || "";
      checkedCount += 1;
    } else if (s.platform === "twitch" && twitchAvailable) {
      const res = await checkTwitchLive(twitchId!, twitchToken!, s.externalId);
      live = res.isLive;
      url = res.url || "";
      checkedCount += 1;
    } else if (s.platform === "twitch" && !twitchAvailable) {
      unavailablePlatforms.add("Twitch");
    }

    if (live) {
      liveOnes.push(`- **${s.displayName}** (${s.platform}): ${url}`);
    }
  }

  if (liveOnes.length === 0 && checkedCount === 0 && unavailablePlatforms.size > 0) {
    await send(channelId, t(locale, "cmdApiUnavailableNow", {
      platforms: [...unavailablePlatforms].join(", "),
    }));
    return;
  }

  if (liveOnes.length === 0) {
    await send(channelId, t(locale, "cmdLiveNone"));
  } else {
    await send(channelId, t(locale, "cmdLiveHeader") + "\n" + liveOnes.join("\n"));
  }
}

async function handleConfig(
  channelId: string,
  userId: string,
  settings: RootBotSettings,
  type: "welcome" | "goodbye",
  content: string
): Promise<void> {
  const parts = content.trim().split(/\s+/).filter(Boolean);
  const subRaw = parts[0]?.toLowerCase();
  const sub = normalizeConfigSubcommand(subRaw);
  const val = parts.slice(1).join(" ").trim();
  const locale = settings.language;

  const canUseAdmin = await canUseAdminCommands(userId);
  if (!sub || isHelpToken(subRaw)) {
    if (!canUseAdmin) {
      await send(channelId, t(locale, "permissionDenied"));
      return;
    }
    await send(channelId, configHelpText(locale, type));
    return;
  }

  if (isHelpArg(val)) {
    const specific = configSubcommandHelp(locale, type, sub);
    if (specific) {
      await send(channelId, specific);
      return;
    }
  }
  if (parts.length >= 2 && isHelpToken(parts[1]?.toLowerCase())) {
    const specific = configSubcommandHelp(locale, type, sub);
    if (specific) {
      await send(channelId, specific);
      return;
    }
  }

  // Check admin permission for configuration commands
  if (!canUseAdmin) {
    await send(channelId, t(locale, "permissionDenied"));
    return;
  }

  const action = normalizeConfigAction(subRaw);
  if (action === "add" || action === "remove") {
    const targetRaw = parts[1]?.toLowerCase();
    const target = normalizeConfigTarget(targetRaw);
    const payload = parts.slice(2).join(" ").trim();
    if (!target) {
      await send(channelId, t(locale, "cmdInvalidArg", { cmd: type }));
      return;
    }
    const key = `config:${type}${target[0].toUpperCase()}${target.slice(1)}`;

    if (action === "remove") {
      await KEY_VALUE.delete(key);
      await send(channelId, t(locale, "cmdConfigSaved", { type: target }));
      return;
    }

    if (target === "channel") {
      const found = await resolveChannel(payload);
      if (!found) {
        await send(channelId, `Channel "${payload}" not found.`);
        return;
      }
      await KEY_VALUE.set({ key, value: found.id });
      await send(channelId, t(locale, "cmdConfigSaved", { type: "channel" }));
      return;
    }

    if (target === "message") {
      if (!payload) {
        await send(channelId, t(locale, "cmdInvalidArg", { cmd: type }));
        return;
      }
      await KEY_VALUE.set({ key, value: payload });
      await send(channelId, t(locale, "cmdConfigSaved", { type: "message" }));
      return;
    }

    if (target === "image") {
      const normalized = normalizeImageMarkdown(payload);
      if (!normalized) {
        await send(channelId, t(locale, "cmdConfigImageInvalid"));
        return;
      }
      await KEY_VALUE.set({ key, value: normalized });
      await send(channelId, t(locale, "cmdConfigSaved", { type: "image" }));
      return;
    }
  }

  if (sub === "test") {
    await send(channelId, t(locale, "cmdConfigTestTriggered", { type }));
    if (type === "welcome") await triggerWelcome(userId, settings);
    else await triggerGoodbye(userId, settings);
    return;
  }

  if (sub === "info") {
    const overrides = await getOverrides(type);
    const activeChannel = overrides.channelId;
    const activeMessage = overrides.message;
    const activeImage = overrides.image;

    await send(channelId, t(locale, "cmdConfigInfo", {
      type,
      channel: activeChannel ? `<#${activeChannel}>` : "---",
      message: activeMessage ?? "---",
      image: activeImage ?? "---",
    }));
    return;
  }

  if (sub === "reset") {
    await KEY_VALUE.delete(`config:${type}ChannelId`);
    await KEY_VALUE.delete(`config:${type}Message`);
    await KEY_VALUE.delete(`config:${type}Image`);
    await send(channelId, t(locale, "cmdConfigReset", { type }));
    return;
  }

  if (sub === "channel" && val) {
    const found = await resolveChannel(val);
    if (found) {
      const key = `config:${type}ChannelId`;
      await KEY_VALUE.set({ key, value: found.id });
      await send(channelId, t(locale, "cmdConfigSaved", { type: "channel" }));
    } else {
      await send(channelId, `Channel "${val}" not found.`);
    }
  } else if (sub === "image") {
    const key = `config:${type}Image`;
    if (!val || val.toLowerCase() === "clear") {
      await KEY_VALUE.delete(key);
      await send(channelId, t(locale, "cmdConfigSaved", { type: "image" }));
      return;
    }
    const normalized = normalizeImageMarkdown(val);
    if (!normalized) {
      await send(channelId, t(locale, "cmdConfigImageInvalid"));
      return;
    }
    await KEY_VALUE.set({ key, value: normalized });
    await send(channelId, t(locale, "cmdConfigSaved", { type: "image" }));
  } else if (sub === "message" && val) {
    const key = `config:${type}Message`;
    await KEY_VALUE.set({ key, value: val });
    await send(channelId, t(locale, "cmdConfigSaved", { type: "message" }));
  } else {
    await send(channelId, t(locale, "cmdInvalidArg", { cmd: type }));
  }
}

async function addStreamer(
  channelId: string,
  locale: string | undefined,
  rawInput: string
): Promise<void> {
  const parsed = parseAddArgs(rawInput);
  if (!parsed.query) {
    await send(channelId, t(locale, "cmdInvalidArg", { cmd: "stream" }));
    return;
  }

  const resolved = await resolveStreamerInput(parsed.query);
  if (!resolved) {
    const unavailable = await getUnavailableApisForResolve();
    if (unavailable.length > 0) {
      await send(channelId, t(locale, "cmdApiUnavailableNow", {
        platforms: unavailable.join(", "),
      }));
    } else {
      await send(channelId, t(locale, "cmdStreamerResolveFailed"));
    }
    return;
  }

  if (resolved.platform === "youtube") {
    const youtubeKey = process.env.YOUTUBE_API_KEY;
    if (youtubeKey) {
      const latest = await checkYouTubeLatestContent(youtubeKey, resolved.externalId);
      if (
        latest.kind === "premiere" &&
        latest.scheduledStartAt &&
        latest.scheduledStartAt - Date.now() > MAX_SCHEDULE_AHEAD_MS
      ) {
        await send(channelId, t(locale, "cmdScheduleTooFar"));
        return;
      }
    }
  }

  const displayName = parsed.displayName || resolved.displayName;
  const { entry } = await upsertCatalogEntry(
    resolved.platform,
    resolved.externalId,
    displayName
  );

  const subscribed = await subscribeCatalogEntry(entry.id);
  if (!subscribed) {
    await send(channelId, t(locale, "cmdAlreadyInList"));
    return;
  }

  await send(channelId, t(locale, "cmdAdded", { name: entry.displayName, platform: entry.platform }));
}

async function listStreamers(
  channelId: string,
  locale: string | undefined
): Promise<void> {
  await migrateLegacyStreamersIfNeeded();
  const streamers = await getCommunityCatalogEntries();

  if (streamers.length === 0) {
    await send(channelId, t(locale, "cmdNoStreamers"));
    return;
  }

  let text = t(locale, "cmdStreamersHeader") + "\n";
  streamers.forEach((s, i) => {
    text += `${i + 1}. **${s.displayName}** (${s.platform}) - \`${s.externalId}\`\n`;
  });
  await send(channelId, text);
}

async function removeStreamer(
  channelId: string,
  locale: string | undefined,
  index: number
): Promise<void> {
  await migrateLegacyStreamersIfNeeded();
  const removed = await unsubscribeCommunityEntryByIndex(index);
  if (!removed) {
    await send(channelId, t(locale, "cmdInvalidIndex"));
    return;
  }
  await send(
    channelId,
    t(locale, "cmdRemoved", {
      name: removed?.displayName ?? "",
      platform: removed?.platform ?? "",
    })
  );
}

function parseAddArgs(raw: string): { query: string; displayName?: string } {
  const value = raw.trim();
  const split = value.split("|");
  if (split.length >= 2) {
    return {
      query: split[0]?.trim() ?? "",
      displayName: split.slice(1).join("|").trim() || undefined,
    };
  }
  return { query: value };
}

function isHelpArg(v: string): boolean {
  const token = v.trim().toLowerCase().split(/\s+/)[0];
  return isHelpToken(token);
}

function isHelpToken(v: string | undefined): boolean {
  if (!v) return false;
  return v === "help" || v === "h" || v === "?";
}

function normalizeSetSubcommand(sub: string | undefined): string | undefined {
  if (!sub) return undefined;
  if (["adminrole", "admin", "ar", "admr"].includes(sub)) return "adminrole";
  if (["language", "lang", "lg"].includes(sub)) return "language";
  if (["debug", "d"].includes(sub)) return "debug";
  if (["prefix", "pfx", "p"].includes(sub)) return "prefix";
  if (["autorole", "atr", "au", "rr", "reactrole"].includes(sub)) return "autorole";
  return sub;
}

function normalizeStreamSubcommand(sub: string | undefined): string | undefined {
  if (!sub) return undefined;
  if (["add", "+", "a"].includes(sub)) return "add";
  if (["remove", "-", "rm", "del", "d"].includes(sub)) return "remove";
  if (["live", "v"].includes(sub)) return "live";
  if (["list", "l", "ls"].includes(sub)) return "list";
  if (["message", "msg", "m"].includes(sub)) return "message";
  if (["channel", "ch", "c"].includes(sub)) return "channel";
  if (["role", "r"].includes(sub)) return "role";
  if (["info", "i"].includes(sub)) return "info";
  if (["test", "t"].includes(sub)) return "test";
  if (["reset", "rs"].includes(sub)) return "reset";
  if (["admin", "ad"].includes(sub)) return "admin";
  return sub;
}

function normalizeModSubcommand(sub: string | undefined): "role" | "logs" | "override" | "mute" | "unmute" | "tempban" | "tempkick" | undefined {
  if (!sub) return undefined;
  if (["role", "r"].includes(sub)) return "role";
  if (["logs", "log", "lg", "l"].includes(sub)) return "logs";
  if (["override", "ov", "o"].includes(sub)) return "override";
  if (["mute", "m"].includes(sub)) return "mute";
  if (["unmute", "um", "un", "u"].includes(sub)) return "unmute";
  if (["tempban", "tb", "tban", "ban", "b"].includes(sub)) return "tempban";
  if (["tempkick", "tk", "tkick", "kick", "k"].includes(sub)) return "tempkick";
  return undefined;
}

function normalizeConfigSubcommand(sub: string | undefined): string | undefined {
  if (!sub) return undefined;
  if (["add", "a", "+"].includes(sub)) return "add";
  if (["remove", "rm", "r", "-"].includes(sub)) return "remove";
  if (["channel", "ch", "c"].includes(sub)) return "channel";
  if (["message", "msg", "m"].includes(sub)) return "message";
  if (["image", "img", "im"].includes(sub)) return "image";
  if (["info", "i"].includes(sub)) return "info";
  if (["test", "t"].includes(sub)) return "test";
  if (["reset", "r", "rs"].includes(sub)) return "reset";
  return sub;
}

function normalizeConfigAction(sub: string | undefined): "add" | "remove" | null {
  if (!sub) return null;
  if (["add", "a", "+"].includes(sub)) return "add";
  if (["remove", "rm", "r", "-"].includes(sub)) return "remove";
  return null;
}

function normalizeConfigTarget(sub: string | undefined): "channel" | "message" | "image" | null {
  if (!sub) return null;
  if (["channel", "ch", "c"].includes(sub)) return "channel";
  if (["message", "msg", "m"].includes(sub)) return "message";
  if (["image", "img", "im", "i", "pic"].includes(sub)) return "image";
  return null;
}

function streamSubcommandHelp(locale: string | undefined, sub: string): string | null {
  switch (sub) {
    case "add": return t(locale, "cmdUsageStreamAdd");
    case "remove": return t(locale, "cmdUsageStreamRemove");
    case "live": return t(locale, "cmdUsageStreamLive");
    case "list": return t(locale, "cmdUsageStreamList");
    case "message": return t(locale, "cmdUsageStreamMessage");
    case "channel": return t(locale, "cmdUsageStreamChannel");
    case "role": return t(locale, "cmdUsageStreamRole");
    case "info": return t(locale, "cmdUsageStreamInfo");
    case "test": return t(locale, "cmdUsageStreamTest");
    case "reset": return t(locale, "cmdUsageStreamReset");
    case "admin": return t(locale, "cmdUsageStreamAdmin");
    default: return null;
  }
}

function setSubcommandHelp(locale: string | undefined, sub: string): string | null {
  switch (sub) {
    case "adminrole": return t(locale, "cmdUsageSetAdminRole");
    case "language": return t(locale, "cmdUsageSetLanguage");
    case "autorole": return t(locale, "cmdUsageSetAutoRole");
    case "debug": return t(locale, "cmdDebugUsage");
    case "prefix": return "Usage: `!set prefix <prefix>`\nRules: max 3 chars, at least one special char, `#` and `@` are not allowed.";
    default: return null;
  }
}

function modSubcommandHelp(
  locale: string | undefined,
  sub: "role" | "logs" | "override" | "mute" | "unmute" | "tempban" | "tempkick"
): string | null {
  switch (sub) {
    case "role": return t(locale, "cmdUsageModRole");
    case "logs": return t(locale, "cmdUsageModLogs");
    case "override": return t(locale, "cmdUsageModOverride");
    case "mute": return t(locale, "cmdUsageSetMute");
    case "unmute": return t(locale, "cmdUsageSetUnmute");
    case "tempban": return t(locale, "cmdUsageSetTempBan");
    case "tempkick": return t(locale, "cmdUsageSetTempKick");
    default: return null;
  }
}

function configSubcommandHelp(
  locale: string | undefined,
  type: "welcome" | "goodbye",
  sub: string
): string | null {
  if (type === "welcome") {
    switch (sub) {
      case "add": return t(locale, "cmdUsageWelcomeAdd");
      case "remove": return t(locale, "cmdUsageWelcomeRemove");
      case "channel": return t(locale, "cmdUsageWelcomeChannel");
      case "message": return t(locale, "cmdUsageWelcomeMessage");
      case "image": return t(locale, "cmdUsageWelcomeImage");
      case "info": return t(locale, "cmdUsageWelcomeInfo");
      case "test": return t(locale, "cmdUsageWelcomeTest");
      case "reset": return t(locale, "cmdUsageWelcomeReset");
      default: return null;
    }
  }

  switch (sub) {
    case "add": return t(locale, "cmdUsageGoodbyeAdd");
    case "remove": return t(locale, "cmdUsageGoodbyeRemove");
    case "channel": return t(locale, "cmdUsageGoodbyeChannel");
    case "message": return t(locale, "cmdUsageGoodbyeMessage");
    case "image": return t(locale, "cmdUsageGoodbyeImage");
    case "info": return t(locale, "cmdUsageGoodbyeInfo");
    case "test": return t(locale, "cmdUsageGoodbyeTest");
    case "reset": return t(locale, "cmdUsageGoodbyeReset");
    default: return null;
  }
}

function configHelpText(
  locale: string | undefined,
  type: "welcome" | "goodbye"
): string {
  const pt = locale?.toLowerCase() === "pt";
  const base = type === "welcome" ? "!welcome" : "!goodbye";
  const alias = type === "welcome" ? "!wc" : "!gb";
  const header = t(locale, type === "welcome" ? "cmdHelpWelcome" : "cmdHelpGoodbye");
  const lines = [
    header,
    pt
      ? `${base} add (${alias} +) <channel|message|img> <valor>`
      : `${base} add (${alias} +) <channel|message|img> <value>`,
    `${base} remove (${alias} -) <channel|message|img>`,
    `${base} info (${alias} i)`,
    `${base} test (${alias} t)`,
    `${base} reset (${alias} rs)`,
  ];
  return lines.join("\n");
}

function normalizeImageMarkdown(raw: string): string | null {
  const input = raw.trim().replace(/^<|>$/g, "");

  // Root external markdown generated by client: [https://...](root://external/...)
  const mdRootExternal = input.match(/^\[(https?:\/\/[^\]]+)\]\(root:\/\/external\/[^\)]+\)$/i);
  if (mdRootExternal?.[1]) return `[image](${mdRootExternal[1]})`;

  // Accept markdown links generated by clients: [anything](https://...)
  const mdAny = input.match(/^\[[^\]]*\]\((https?:\/\/\S+)\)$/i);
  if (mdAny?.[1]) return `[image](${mdAny[1]})`;

  // Accept explicit image markdown
  const mdImage = input.match(/^\[image\]\((https?:\/\/\S+)\)$/i);
  if (mdImage?.[1]) return `[image](${mdImage[1]})`;

  // Accept plain URL
  if (/^https?:\/\/\S+$/i.test(input)) return `[image](${input})`;

  return null;
}

function parseAutoRoleArgs(raw: string): {
  messageId: string;
  emoji: string;
  roleRaw: string;
  mode: "one" | "many";
} | null {
  const value = raw.trim();
  const match = value.match(/^(\S+)\s+(\S+)\s+(.+?)(?:\s+(one|many))?$/i);
  if (!match) return null;
  const [, messageId, emoji, roleRaw, modeRaw] = match;
  const mode = (modeRaw?.toLowerCase() ?? "many");
  if (mode !== "one" && mode !== "many") return null;
  return {
    messageId,
    emoji,
    roleRaw: roleRaw.trim(),
    mode,
  };
}

function parseAutoRolePendingArgs(raw: string): {
  messageId: string;
  roleRaw: string;
  mode: "one" | "many";
} | null {
  const value = raw.trim();
  const match = value.match(/^(\S+)\s+(.+?)(?:\s+(one|many))?$/i);
  if (!match) return null;
  const [, messageId, roleRaw, modeRaw] = match;
  const mode = (modeRaw?.toLowerCase() ?? "many");
  if (mode !== "one" && mode !== "many") return null;
  return {
    messageId,
    roleRaw: roleRaw.trim(),
    mode,
  };
}

function parseAutoRoleRemoveArgs(raw: string): {
  messageId: string;
  emoji: string;
} | null {
  const value = raw.trim();
  const match = value.match(/^(remove|rm|-|r)\s+(\S+)\s+(\S+)$/i);
  if (!match) return null;
  return {
    messageId: match[2],
    emoji: match[3],
  };
}

function normalizeAutoModAction(v: string | undefined): AutoModAction | null {
  const token = v?.toLowerCase();
  if (!token) return null;
  if (["delete", "del", "d"].includes(token)) return "delete";
  if (["kick", "k"].includes(token)) return "kick";
  if (["ban", "b"].includes(token)) return "ban";
  return null;
}

function normalizeAutoModField(v: string | undefined): AutoModField | null {
  const token = v?.toLowerCase();
  if (!token) return null;
  if (["words", "word", "w"].includes(token)) return "words";
  if (["regex", "rx", "re", "r"].includes(token)) return "regex";
  return null;
}

function parseTimedModerationArgs(raw: string): {
  userRaw: string;
  durationRaw: string;
  reasonRaw?: string;
} | null {
  const match = raw.trim().match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
  if (!match) return null;
  return {
    userRaw: match[1],
    durationRaw: match[2],
    reasonRaw: match[3]?.trim(),
  };
}

function parseDurationToMs(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  const m = value.match(/^(\d+)([smhd]?)$/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2] || "s";
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function clampModerationDurationMs(ms: number): number {
  const max = 7 * 24 * 60 * 60 * 1000;
  return Math.min(ms, max);
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec % 86400 === 0) return `${totalSec / 86400}d`;
  if (totalSec % 3600 === 0) return `${totalSec / 3600}h`;
  if (totalSec % 60 === 0) return `${totalSec / 60}m`;
  return `${totalSec}s`;
}

async function resolveUserId(raw: string): Promise<string | null> {
  const clean = raw.trim();
  const mdUser = clean.match(/\[[^\]]+\]\(root:\/\/(?:user|person)\/([^)]+)\)/i);
  if (mdUser?.[1]) return mdUser[1];

  const mention = clean.match(/^<@!?([^>]+)>$/);
  if (mention?.[1]) return mention[1];

  if (/^[A-Za-z0-9_-]{12,}$/.test(clean)) return clean;
  return null;
}

async function getUserDisplayName(userId: string): Promise<string> {
  try {
    const member = await rootServer.community.communityMembers.get({ userId: userId as any });
    const nickname = member?.nickname?.trim();
    if (nickname) return nickname;
  } catch {
    // ignore
  }
  return userId;
}

async function canUseAdminCommands(userId: string): Promise<boolean> {
  const adminRoleId = await getAdminRoleId();
  if (!adminRoleId) return true;
  return hasAdminPermission(userId);
}

async function canUseModCommands(userId: string): Promise<boolean> {
  if (!(await hasModerationGuardConfigured())) return false;
  return hasModeratorPermission(userId);
}

let commandPrefixCache: string | null = null;

async function parseRootCommand(input: string): Promise<{ cmd: RootCommand; args: string } | null> {
  const prefix = await getCommandPrefix();
  if (!input.startsWith(prefix)) return null;
  const raw = input.slice(prefix.length).trim();
  if (!raw) return null;
  const [keyword, ...rest] = raw.split(/\s+/);
  const lower = keyword.toLowerCase();

  for (const [cmd, aliases] of Object.entries(COMMAND_ALIASES) as Array<[RootCommand, string[]]>) {
    if (aliases.includes(lower)) {
      return { cmd, args: rest.join(" ").trim() };
    }
  }
  return null;
}

async function getCommandPrefix(): Promise<string> {
  if (commandPrefixCache) return commandPrefixCache;
  const raw = (await KEY_VALUE.get<string>(COMMAND_PREFIX_KEY))?.trim();
  if (!raw) {
    commandPrefixCache = defaultPrefixFromGlobalSettings;
    return defaultPrefixFromGlobalSettings;
  }
  const validation = validateCommandPrefix(raw);
  if (!validation.ok) {
    commandPrefixCache = defaultPrefixFromGlobalSettings;
    return defaultPrefixFromGlobalSettings;
  }
  commandPrefixCache = raw;
  return raw;
}

function validateCommandPrefix(prefix: string): { ok: true } | { ok: false; error: string } {
  if (!prefix || prefix.length > 3) {
    return { ok: false, error: "Invalid prefix. It must be 1 to 3 characters." };
  }
  if (/\s/.test(prefix)) {
    return { ok: false, error: "Invalid prefix. Spaces are not allowed." };
  }
  if (prefix.includes("#") || prefix.includes("@")) {
    return { ok: false, error: "Invalid prefix. `#` and `@` are not allowed." };
  }
  const hasSpecial = /[^a-zA-Z0-9]/.test(prefix);
  if (!hasSpecial) {
    return { ok: false, error: "Invalid prefix. At least one character must be special." };
  }
  return { ok: true };
}

async function isDebugCommandsEnabled(): Promise<boolean> {
  const raw = await KEY_VALUE.get<string>(DEBUG_COMMANDS_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return false;
}

async function getUnavailableApisForResolve(): Promise<string[]> {
  const unavailable: string[] = [];

  if (await isYouTubeApiUnavailableForLookup()) {
    unavailable.push("YouTube");
  }

  const twitchId = process.env.TWITCH_CLIENT_ID;
  const twitchSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!twitchId || !twitchSecret) {
    unavailable.push("Twitch");
  } else {
    const token = await getTwitchAppToken(twitchId, twitchSecret);
    if (!token) unavailable.push("Twitch");
  }

  return unavailable;
}

async function isYouTubeApiUnavailableForLookup(): Promise<boolean> {
  if (!process.env.YOUTUBE_API_KEY) return true;
  const raw = await KEY_VALUE.get<string>(YT_QUOTA_BLOCKED_UNTIL_KEY);
  if (!raw) return false;
  const until = Number(raw);
  if (!Number.isFinite(until) || Date.now() >= until) {
    await KEY_VALUE.delete(YT_QUOTA_BLOCKED_UNTIL_KEY);
    return false;
  }
  return true;
}

async function send(channelId: string, content: string): Promise<void> {
  const req: ChannelMessageCreateRequest = {
    channelId: channelId as ChannelGuid,
    content,
  };
  await rootServer.community.channelMessages.create(req);
}

/**
 * Resolve a channel by name, mention or ID.
 */
async function resolveChannel(val: string) {
  const cleanVal = val.trim();
  // Patterns for mentions
  const mdMatch = cleanVal.match(/\[#(.*?)\]\(root:\/\/channel\/(.*?)\)/);
  const angleMatch = cleanVal.match(/<#(.*)>/);

  const label = mdMatch?.[1];
  const nameInput = cleanVal.replace(/^[#]/, "").trim();

  console.log(`[Resolve] Channel: "${val}" (MD Label: ${label}, NameInput: ${nameInput})`);

  const groups = await rootServer.community.channelGroups.list();
  for (const group of groups) {
    const channels = await rootServer.community.channels.list({ channelGroupId: group.id });
    const found = channels.find(ch => {
      const chName = ch.name.toLowerCase().trim();
      const chNameNoHash = chName.replace(/^[#]/, "").trim();
      const inputLower = nameInput.toLowerCase();

      // 1. Exact ID
      if (ch.id === cleanVal || ch.id === nameInput) return true;
      // 2. Label from markdown (e.g. [#Live](...))
      if (label && (chName === label.toLowerCase() || chNameNoHash === label.toLowerCase().replace(/^[#]/, ""))) return true;
      // 3. Name match
      if (chName === inputLower || chNameNoHash === inputLower) return true;
      // 4. Fallback: match full cleaned string
      if (chName === cleanVal.toLowerCase() || chNameNoHash === cleanVal.toLowerCase()) return true;

      return false;
    });
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve a role by name, mention or ID.
 */
async function resolveRole(val: string) {
  const cleanVal = val.trim();
  const mdMatch = cleanVal.match(/\[@(.*?)\]\(root:\/\/role\/(.*?)\)/);
  const angleMatch = cleanVal.match(/<@&(.*)>/);

  const label = mdMatch?.[1];
  const nameInput = cleanVal.replace(/^[@]/, "").trim();

  console.log(`[Resolve] Role: "${val}" (MD Label: ${label}, NameInput: ${nameInput})`);

  const roles = await rootServer.community.communityRoles.list();
  return roles.find(r => {
    const rName = r.name.toLowerCase().trim();
    const rNameNoAt = rName.replace(/^[@]/, "").trim();
    const inputLower = nameInput.toLowerCase();

    if (r.id === cleanVal || r.id === nameInput) return true;
    if (label && (rName === label.toLowerCase() || rNameNoAt === label.toLowerCase().replace(/^[@]/, ""))) return true;
    if (rName === inputLower || rNameNoAt === inputLower) return true;
    if (rName === cleanVal.toLowerCase() || rNameNoAt === cleanVal.toLowerCase()) return true;

    return false;
  });
}




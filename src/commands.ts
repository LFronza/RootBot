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
import { STREAMERS_KEY, type TrackedStreamer } from "./types.js";
import { t } from "./i18n/index.js";
import { triggerWelcome, triggerGoodbye, getOverrides } from "./welcome.js";
import {
  checkYouTubeLive,
  checkTwitchLive,
  getTwitchAppToken,
  getStreamOverrides,
  triggerStreamTest,
} from "./streams.js";
import {
  hasAdminPermission,
  getAdminRoleId,
  setAdminRoleId,
  clearAdminRole,
} from "./permissions.js";

const CMD_PREFIX = "!stream ";
const KEY_VALUE = rootServer.dataStore.appData;

export function registerStreamCommands(settings: RootBotSettings): void {
  rootServer.community.channelMessages.on(
    ChannelMessageEvent.ChannelMessageCreated,
    (evt: ChannelMessageCreatedEvent) => onMessage(evt, settings)
  );
}

async function onMessage(
  evt: ChannelMessageCreatedEvent,
  settings: RootBotSettings
): Promise<void> {
  // Filter out system messages
  if (evt.messageType === MessageType.System) return;

  const content = (evt.messageContent ?? "").trim();
  console.log(`[Message] Channel: ${evt.channelId}, Content: "${content}"`);

  if (content === "!ping") {
    await send(evt.channelId, "Pong! 🏓");
    return;
  }

  try {
    if (content.startsWith("!welcome ") || content === "!welcome") {
      await handleConfig(evt.channelId, evt.userId, settings, "welcome", content.slice("!welcome".length).trim());
      return;
    }

    if (content.startsWith("!goodbye ") || content === "!goodbye") {
      await handleConfig(evt.channelId, evt.userId, settings, "goodbye", content.slice("!goodbye".length).trim());
      return;
    }

    if (content === "!help") {
      await send(evt.channelId, await globalHelpText(settings.language, evt.userId));
      return;
    }

    if (content.startsWith("!set ") || content === "!set") {
      await handleSet(evt.channelId, evt.userId, settings, content.slice("!set".length).trim());
      return;
    }

    if (content.startsWith(CMD_PREFIX) || content === "!stream") {
      await handleStream(evt.channelId, evt.userId, settings, content.slice("!stream".length).trim());
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
  const sub = parts[0]?.toLowerCase();
  const val = parts.slice(1).join(" ").trim();
  const locale = settings.language;

  if (!sub || sub === "help") {
    const isAdmin = await hasAdminPermission(userId);
    const commands = [
      t(locale, "cmdHelpSet"),
    ];

    if (isAdmin) {
      commands.push(
        t(locale, "cmdHelpSetAdminRole"),
        t(locale, "cmdHelpSetAdminRoleClear"),
        t(locale, "cmdHelpSetLanguage"),
      );
    }

    await send(channelId, commands.join("\n"));
    return;
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
      await send(channelId, `❌ Role "${val}" not found.`);
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
      const currentLang = settings.language || "pt";
      await send(channelId, t(locale, "languageCurrent", { language: currentLang }));
      return;
    }

    const newLang = val.toLowerCase();
    if (newLang !== "pt" && newLang !== "en") {
      await send(channelId, t(locale, "languageInvalid"));
      return;
    }

    await KEY_VALUE.set([{ key: "config:language", value: newLang }]);
    await send(channelId, t(newLang, "languageSet", { language: newLang }));
    return;
  }

  await send(channelId, t(locale, "cmdInvalidArg", { cmd: "set" }));
}

async function handleStream(
  channelId: string,
  userId: string,
  settings: RootBotSettings,
  content: string
): Promise<void> {
  const parts = content.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const val = parts.slice(1).join(" ").trim();
  const locale = settings.language;

  if (!sub || sub === "help") {
    await send(channelId, await streamHelpText(locale, userId));
    return;
  }

  if (sub === "live") {
    await showLiveStatus(channelId, locale);
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
      await send(channelId, `❌ Role "${val}" not found.`);
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
    const args = val.split(/\s+/);
    const platform = args[0]?.toLowerCase() as "youtube" | "twitch";
    const externalId = args[1];
    const displayName = args.slice(2).join(" ").trim() || externalId;

    if (platform === "youtube" || platform === "twitch") {
      await addStreamer(channelId, locale, platform, externalId, displayName);
    } else {
      await send(channelId, "❌ Use: `!stream add youtube|twitch <id> [nome]`");
    }
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
      await send(channelId, `❌ Channel "${val}" not found.`);
    }
  } else if (sub === "role" && val) {
    const found = await resolveRole(val);
    if (found) {
      await KEY_VALUE.set([{ key: "config:streamMentionRoleId", value: found.id }]);
      await send(channelId, t(locale, "cmdConfigSaved", { type: "role" }));
    } else {
      await send(channelId, `❌ Role "${val}" not found.`);
    }
  } else {
    await send(channelId, t(locale, "cmdInvalidArg", { cmd: "stream" }));
  }
}

async function globalHelpText(locale: string | undefined, userId: string): Promise<string> {
  const isAdmin = await hasAdminPermission(userId);
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

  commands.push(
    "",
    t(locale, "publicCommandsHeader"),
    t(locale, "cmdHelpStreamHint"),
    t(locale, "cmdHelpHelp"),
  );

  return commands.join("\n");
}

async function streamHelpText(locale: string | undefined, userId: string): Promise<string> {
  const isAdmin = await hasAdminPermission(userId);
  const commands = [
    t(locale, "cmdHelpStreamTitle"),
    "",
    t(locale, "publicCommandsHeader"),
    t(locale, "cmdHelpLive"),
    t(locale, "cmdHelpList"),
    t(locale, "cmdHelpHelpStream"),
  ];

  if (isAdmin) {
    commands.push(
      "",
      t(locale, "adminCommandsHeader"),
      t(locale, "cmdHelpAddYoutube"),
      t(locale, "cmdHelpAddTwitch"),
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
): Promise<void> {
  const dbStreamersJson = await KEY_VALUE.get<string>(STREAMERS_KEY);
  const streamers: TrackedStreamer[] = dbStreamersJson ? JSON.parse(dbStreamersJson) : [];

  if (streamers.length === 0) {
    await send(channelId, t(locale, "cmdNoStreamers"));
    return;
  }

  const youtubeKey = process.env.YOUTUBE_API_KEY;
  const twitchId = process.env.TWITCH_CLIENT_ID;
  const twitchSecret = process.env.TWITCH_CLIENT_SECRET;
  console.log(`[Status] Streamers: ${streamers.length}, YT Key: ${!!youtubeKey}, Twitch: ${!!twitchId}`);

  let twitchToken: string | null = null;
  if (twitchId && twitchSecret) twitchToken = await getTwitchAppToken(twitchId, twitchSecret);

  const liveOnes: string[] = [];
  for (const s of streamers) {
    let live = false;
    let url = "";
    if (s.platform === "youtube" && youtubeKey) {
      const res = await checkYouTubeLive(youtubeKey, s.externalId);
      live = res.isLive;
      url = res.url || "";
    } else if (s.platform === "twitch" && twitchId && twitchToken) {
      const res = await checkTwitchLive(twitchId, twitchToken, s.externalId);
      live = res.isLive;
      url = res.url || "";
    }

    if (live) {
      liveOnes.push(`- **${s.displayName}** (${s.platform}): ${url}`);
    }
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
  const parts = content.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const val = parts.slice(1).join(" ").trim();
  const locale = settings.language;

  if (!sub || sub === "help") {
    await send(channelId, t(locale, type === "welcome" ? "cmdHelpWelcome" : "cmdHelpGoodbye"));
    return;
  }

  // Check admin permission for configuration commands
  const isAdmin = await hasAdminPermission(userId);
  if (!isAdmin) {
    await send(channelId, t(locale, "permissionDenied"));
    return;
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

    await send(channelId, t(locale, "cmdConfigInfo", {
      type,
      channel: activeChannel ? `<#${activeChannel}>` : "---",
      message: activeMessage ?? "---",
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
      await send(channelId, `❌ Channel "${val}" not found.`);
    }
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
  platform: "youtube" | "twitch",
  externalId: string,
  displayName: string
): Promise<void> {
  const dbStreamers = await getStreamers();
  if (dbStreamers.some((s) => s.platform === platform && s.externalId === externalId)) {
    await send(channelId, t(locale, "cmdAlreadyInList"));
    return;
  }

  dbStreamers.push({ platform, externalId, displayName });
  await KEY_VALUE.set([{ key: STREAMERS_KEY, value: JSON.stringify(dbStreamers) }]);
  await send(channelId, t(locale, "cmdAdded", { name: displayName, platform }));
}

async function listStreamers(
  channelId: string,
  locale: string | undefined
): Promise<void> {
  const streamers = await getStreamers();

  if (streamers.length === 0) {
    await send(channelId, t(locale, "cmdNoStreamers"));
    return;
  }

  let text = t(locale, "cmdStreamersHeader") + "\n";
  streamers.forEach((s, i) => {
    text += `${i + 1}. **${s.displayName}** (${s.platform}) – \`${s.externalId}\`\n`;
  });
  await send(channelId, text);
}

async function removeStreamer(
  channelId: string,
  locale: string | undefined,
  index: number
): Promise<void> {
  const streamers = await getStreamers();
  const i = index - 1;
  if (i < 0 || i >= streamers.length) {
    await send(channelId, t(locale, "cmdInvalidIndex"));
    return;
  }
  const removed = streamers.splice(i, 1)[0];
  await KEY_VALUE.set([{ key: STREAMERS_KEY, value: JSON.stringify(streamers) }]);
  await send(
    channelId,
    t(locale, "cmdRemoved", {
      name: removed?.displayName ?? "",
      platform: removed?.platform ?? "",
    })
  );
}

function parseStreamersList(input: string | undefined): TrackedStreamer[] {
  if (!input) return [];
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [platform, externalId, displayName] = line.split("|").map((s) => s.trim());
      if (
        (platform === "youtube" || platform === "twitch") &&
        externalId &&
        displayName
      ) {
        return { platform, externalId, displayName } as TrackedStreamer;
      }
      return null;
    })
    .filter((s): s is TrackedStreamer => s !== null);
}

async function getStreamers(): Promise<TrackedStreamer[]> {
  const raw = await KEY_VALUE.get<string>(STREAMERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TrackedStreamer[];
  } catch {
    return [];
  }
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

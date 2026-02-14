import {
  ChannelType,
  type ChannelMessageCreatedEvent,
  type ChannelGuid,
  RootApiException,
  RootGuidConverter,
  RootGuidType,
  rootServer,
} from "@rootsdk/server-bot";
import { MOD_LOG_CHANNEL_KEY } from "./types.js";
import {
  hasModerationGuardConfigured,
  hasOverridePermission,
} from "./permissions.js";

const KEY_VALUE = rootServer.dataStore.appData;
const MUTES_KEY = "mod:mutes:v1";
const DEBUG_COMMANDS_KEY = "config:debugCommands";

export const AUTOMOD_KEYS = {
  deleteWords: "config:automodDeleteWords",
  deleteRegex: "config:automodDeleteRegex",
  kickWords: "config:automodKickWords",
  kickRegex: "config:automodKickRegex",
  banWords: "config:automodBanWords",
  banRegex: "config:automodBanRegex",
} as const;

export type AutoModAction = "delete" | "kick" | "ban";
export type AutoModField = "words" | "regex";
type ParsedRules = { words: string[]; regex: RegExp[] };
type AutoModRules = { delete: ParsedRules; kick: ParsedRules; ban: ParsedRules };

let cachedRules: AutoModRules | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

export async function handleAutoModeration(evt: ChannelMessageCreatedEvent): Promise<boolean> {
  if (!evt.messageContent?.trim()) return false;
  if (isAppUser(evt.userId)) return false;
  if (!(await hasModerationGuardConfigured())) return false;

  if (await enforceMuteIfNeeded(evt)) return true;
  if (await hasOverridePermission(evt.userId)) return false;

  const rules = await getRules();
  const content = evt.messageContent;
  const contentLower = content.toLowerCase();

  const action = selectAction(rules, content, contentLower);
  if (!action) return false;

  await applyAction(action, evt);
  return true;
}

export async function setAutoModRule(
  action: AutoModAction,
  field: AutoModField,
  value: string
): Promise<void> {
  const key = toRuleKey(action, field);
  const normalized = value.trim();
  if (!normalized) {
    await KEY_VALUE.delete(key);
  } else {
    await KEY_VALUE.set({ key, value: normalized });
  }
  invalidateAutoModCache();
}

export async function clearAutoModRules(action: AutoModAction): Promise<void> {
  await Promise.all([
    KEY_VALUE.delete(toRuleKey(action, "words")),
    KEY_VALUE.delete(toRuleKey(action, "regex")),
  ]);
  invalidateAutoModCache();
}

export async function getAutoModRulesRaw(): Promise<Record<string, string>> {
  const entries = await Promise.all([
    KEY_VALUE.get<string>(AUTOMOD_KEYS.deleteWords),
    KEY_VALUE.get<string>(AUTOMOD_KEYS.deleteRegex),
    KEY_VALUE.get<string>(AUTOMOD_KEYS.kickWords),
    KEY_VALUE.get<string>(AUTOMOD_KEYS.kickRegex),
    KEY_VALUE.get<string>(AUTOMOD_KEYS.banWords),
    KEY_VALUE.get<string>(AUTOMOD_KEYS.banRegex),
  ]);
  return {
    deleteWords: entries[0] ?? "",
    deleteRegex: entries[1] ?? "",
    kickWords: entries[2] ?? "",
    kickRegex: entries[3] ?? "",
    banWords: entries[4] ?? "",
    banRegex: entries[5] ?? "",
  };
}

export async function setMutedUntil(userId: string, untilMs: number): Promise<void> {
  const map = await getMuteMap();
  map[userId] = untilMs;
  await saveMuteMap(map);
  await syncVoiceMuteForUser(userId, true);
  if (await isDebugEnabled()) {
    console.log(`[AutoMod][Debug] mute-set userId=${userId} until=${new Date(untilMs).toISOString()}`);
  }
}

export async function unmuteUser(userId: string): Promise<boolean> {
  const map = await getMuteMap();
  if (!map[userId]) return false;
  delete map[userId];
  await saveMuteMap(map);
  await syncVoiceMuteForUser(userId, false);
  return true;
}

export async function tempBanUser(userId: string, untilMs: number, reason?: string): Promise<void> {
  await rootServer.community.communityMemberBans.create({
    userId: userId as any,
    reason: reason || "Temporary ban",
    expiresAt: new Date(untilMs),
  });
}

export async function tempKickUser(userId: string, untilMs: number, reason?: string): Promise<void> {
  // Root has no timed kick primitive; temporary kick is implemented as timed ban.
  await rootServer.community.communityMemberBans.create({
    userId: userId as any,
    reason: reason || "Temporary kick",
    expiresAt: new Date(untilMs),
  });
}

export async function setModerationLogChannelId(channelId: string): Promise<void> {
  await KEY_VALUE.set({ key: MOD_LOG_CHANNEL_KEY, value: channelId });
}

export async function clearModerationLogChannelId(): Promise<void> {
  await KEY_VALUE.delete(MOD_LOG_CHANNEL_KEY);
}

export async function getModerationLogChannelId(): Promise<string | undefined> {
  return KEY_VALUE.get<string>(MOD_LOG_CHANNEL_KEY);
}

export async function sendModerationLog(content: string): Promise<void> {
  const logChannelId = await getModerationLogChannelId();
  if (!logChannelId) return;
  try {
    await rootServer.community.channelMessages.create({
      channelId: logChannelId as ChannelGuid,
      content,
    });
  } catch (err) {
    logAutoModError("write-log", err);
  }
}

export function invalidateAutoModCache(): void {
  cacheExpiresAt = 0;
}

function toRuleKey(action: AutoModAction, field: AutoModField): string {
  if (action === "delete") return field === "words" ? AUTOMOD_KEYS.deleteWords : AUTOMOD_KEYS.deleteRegex;
  if (action === "kick") return field === "words" ? AUTOMOD_KEYS.kickWords : AUTOMOD_KEYS.kickRegex;
  return field === "words" ? AUTOMOD_KEYS.banWords : AUTOMOD_KEYS.banRegex;
}

function isAppUser(userId: string): boolean {
  try {
    return RootGuidConverter.toRootGuidType(userId) === RootGuidType.App;
  } catch {
    return false;
  }
}

async function enforceMuteIfNeeded(evt: ChannelMessageCreatedEvent): Promise<boolean> {
  const map = await getMuteMap();
  const until = map[evt.userId];
  const debugEnabled = await isDebugEnabled();
  if (debugEnabled && Object.keys(map).length > 0) {
    const sample = Object.keys(map).slice(0, 10).join(",");
    console.log(`[AutoMod][Debug] mute-check evt.userId=${evt.userId} hasMatch=${Boolean(until)} mutedCount=${Object.keys(map).length} keys=${sample}`);
  }
  if (!until) return false;

  if (Date.now() >= until) {
    delete map[evt.userId];
    await saveMuteMap(map);
    await syncVoiceMuteForUser(evt.userId, false);
    return false;
  }

  try {
    await rootServer.community.channelMessages.delete({
      channelId: evt.channelId,
      id: evt.id,
    });
    if (debugEnabled) {
      console.log(`[AutoMod][Debug] mute-delete evt.userId=${evt.userId} messageId=${evt.id} remainingMs=${until - Date.now()}`);
    }
    await tryNotifyMutedUser(evt.userId, until - Date.now());
    await sendModerationLog(
      `AutoMod mute blocked message.\nUser: <@${evt.userId}>\nChannel: <#${evt.channelId}>\nMessageId: \`${evt.id}\`\nContent: ${sanitizeForLog(evt.messageContent)}`
    );
  } catch (err) {
    logAutoModError("mute-delete-message", err);
  }
  return true;
}

async function tryNotifyMutedUser(userId: string, remainingMs: number): Promise<void> {
  const duration = humanizeRemaining(remainingMs);
  const content = `You can't send messages right now. Remaining time: ${duration}.`;
  try {
    const dmApi: any = (rootServer as any)?.directMessages;
    if (!dmApi) return;
    if (typeof dmApi.createWithUserId === "function" && dmApi.messages?.create) {
      const dm = await dmApi.createWithUserId({ userId });
      await dmApi.messages.create({ directMessageId: dm.id, content });
      return;
    }
    if (typeof dmApi.create === "function") {
      await dmApi.create({ userId, content });
      return;
    }
  } catch {
    // Best effort only: DM API may not exist in this SDK runtime.
    if (await isDebugEnabled()) {
      console.log(`[AutoMod][Debug] mute-dm-failed userId=${userId}`);
    }
  }
}

function humanizeRemaining(ms: number): string {
  const totalSec = Math.max(1, Math.floor(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function selectAction(
  rules: AutoModRules,
  content: string,
  contentLower: string
): AutoModAction | null {
  if (matches(rules.ban, content, contentLower)) return "ban";
  if (matches(rules.kick, content, contentLower)) return "kick";
  if (matches(rules.delete, content, contentLower)) return "delete";
  return null;
}

function matches(rule: ParsedRules, content: string, contentLower: string): boolean {
  if (rule.words.some((word) => contentLower.includes(word))) return true;
  if (rule.regex.some((rx) => rx.test(content))) return true;
  return false;
}

async function applyAction(action: AutoModAction, evt: ChannelMessageCreatedEvent): Promise<void> {
  try {
    await rootServer.community.channelMessages.delete({
      channelId: evt.channelId,
      id: evt.id,
    });
    await sendModerationLog(
      `AutoMod action: \`${action}\`\nUser: <@${evt.userId}>\nChannel: <#${evt.channelId}>\nMessageId: \`${evt.id}\`\nContent: ${sanitizeForLog(evt.messageContent)}`
    );
  } catch (err) {
    logAutoModError("delete-message", err);
  }

  if (action === "delete") return;

  if (action === "kick") {
    try {
      await rootServer.community.communityMemberBans.kick({
        userId: evt.userId,
      });
    } catch (err) {
      logAutoModError("kick-user", err);
    }
    return;
  }

  try {
    await rootServer.community.communityMemberBans.create({
      userId: evt.userId,
      reason: "AutoMod rule matched",
    });
  } catch (err) {
    logAutoModError("ban-user", err);
  }
}

function sanitizeForLog(content: string): string {
  const text = (content || "").replace(/\n/g, " ").trim();
  if (!text) return "(empty)";
  if (text.length <= 500) return text;
  return `${text.slice(0, 500)}...`;
}

function logAutoModError(step: string, err: unknown): void {
  if (err instanceof RootApiException) {
    console.error(`[AutoMod] ${step} failed:`, err.errorCode);
    return;
  }
  if (err instanceof Error) {
    console.error(`[AutoMod] ${step} failed:`, err.message);
    return;
  }
  console.error(`[AutoMod] ${step} failed:`, err);
}

async function isDebugEnabled(): Promise<boolean> {
  const raw = await KEY_VALUE.get<string>(DEBUG_COMMANDS_KEY);
  return raw === "true";
}

async function syncVoiceMuteForUser(userId: string, isMuted: boolean): Promise<void> {
  try {
    const groups = await rootServer.community.channelGroups.list();
    for (const group of groups) {
      const channels = await rootServer.community.channels.list({ channelGroupId: group.id });
      for (const channel of channels) {
        if (channel.channelType !== ChannelType.Voice) continue;
        try {
          await rootServer.community.channelWebRtcs.setMuteAndDeafenOther({
            channelId: channel.id,
            userId: userId as any,
            isMuted,
          });
        } catch {
          // Ignore channels where user is not connected or bot lacks target-context permission.
        }
      }
    }
    if (await isDebugEnabled()) {
      console.log(`[AutoMod][Debug] voice-mute-sync userId=${userId} isMuted=${isMuted}`);
    }
  } catch (err) {
    logAutoModError("voice-mute-sync", err);
  }
}

async function getRules(): Promise<AutoModRules> {
  if (cachedRules && Date.now() < cacheExpiresAt) return cachedRules;

  const [deleteWordsRaw, deleteRegexRaw, kickWordsRaw, kickRegexRaw, banWordsRaw, banRegexRaw] =
    await Promise.all([
      KEY_VALUE.get<string>(AUTOMOD_KEYS.deleteWords),
      KEY_VALUE.get<string>(AUTOMOD_KEYS.deleteRegex),
      KEY_VALUE.get<string>(AUTOMOD_KEYS.kickWords),
      KEY_VALUE.get<string>(AUTOMOD_KEYS.kickRegex),
      KEY_VALUE.get<string>(AUTOMOD_KEYS.banWords),
      KEY_VALUE.get<string>(AUTOMOD_KEYS.banRegex),
    ]);

  cachedRules = {
    delete: buildRules(deleteWordsRaw, deleteRegexRaw),
    kick: buildRules(kickWordsRaw, kickRegexRaw),
    ban: buildRules(banWordsRaw, banRegexRaw),
  };
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedRules;
}

async function getMuteMap(): Promise<Record<string, number>> {
  const data = await KEY_VALUE.get<Record<string, number>>(MUTES_KEY);
  if (!data || typeof data !== "object") return {};
  return data;
}

async function saveMuteMap(map: Record<string, number>): Promise<void> {
  if (Object.keys(map).length === 0) {
    await KEY_VALUE.delete(MUTES_KEY);
    return;
  }
  await KEY_VALUE.set({ key: MUTES_KEY, value: map });
}

function buildRules(wordsRaw: string | undefined, regexRaw: string | undefined): ParsedRules {
  return {
    words: splitCsv(wordsRaw).map((x) => x.toLowerCase()),
    regex: splitCsv(regexRaw).flatMap(compileRegexEntry),
  };
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function compileRegexEntry(entry: string): RegExp[] {
  if (!entry) return [];
  const slashMatch = entry.match(/^\/(.+)\/([a-z]*)$/i);
  try {
    if (slashMatch) {
      return [new RegExp(slashMatch[1], slashMatch[2] || "i")];
    }
    return [new RegExp(entry, "i")];
  } catch {
    console.error(`[AutoMod] Invalid regex ignored: ${entry}`);
    return [];
  }
}

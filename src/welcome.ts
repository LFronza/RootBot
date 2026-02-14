/**
 * Welcome and goodbye messages (inspired by FBK).
 * Sends a message when a member joins or leaves the community.
 */

import {
  rootServer,
  RootApiException,
  type ChannelGuid,
  CommunityEvent,
  CommunityJoinedEvent,
  CommunityLeaveEvent,
  ChannelMessageCreateRequest,
  Community,
  CommunityMember,
  CommunityMemberGetRequest,
} from "@rootsdk/server-bot";
import type { RootBotSettings } from "./types.js";
import { t } from "./i18n/index.js";
import { getRuntimeLanguage } from "./locale.js";

const NICKNAME_CACHE_PREFIX = "member_nick:";

export function registerWelcomeGoodbye(settings: RootBotSettings): void {
  rootServer.community.communities.on(
    CommunityEvent.CommunityJoined,
    (evt: CommunityJoinedEvent) => triggerWelcome(evt.userId, settings)
  );
  rootServer.community.communities.on(
    CommunityEvent.CommunityLeave,
    (evt: CommunityLeaveEvent) => triggerGoodbye(evt.userId, settings)
  );
}

export async function triggerWelcome(
  userId: string,
  settings: RootBotSettings
): Promise<void> {
  const runtimeLanguage = await getRuntimeLanguage(settings.language);
  const overrides = await getOverrides("welcome");
  let channelId = overrides.channelId ?? (await getDefaultChannelId());
  const message = overrides.message ?? "Welcome, {nickname}!";
  const image = formatImageMarkdown(overrides.image);

  if (!channelId || !message) {
    return;
  }

  // Self-healing: if channelId is a markdown link, it's invalid. Resolve it to a real GUID.
  if (channelId.includes("root://channel/")) {
    const resolved = await resolveChannelInternal(channelId);
    if (resolved) {
      await rootServer.dataStore.appData.set([{ key: `config:welcomeChannelId`, value: resolved.id }]);
      channelId = resolved.id;
    } else {
      return;
    }
  }

  let nickname = t(runtimeLanguage, "someone");
  try {
    const memberRequest: CommunityMemberGetRequest = { userId: userId as any };
    const member: CommunityMember =
      await rootServer.community.communityMembers.get(memberRequest);
    if (member.nickname) nickname = member.nickname;
  } catch (err) {
    if (err instanceof RootApiException) {
      console.error("[Welcome] RootApiException fetching member info:", err.errorCode);
    } else if (err instanceof Error) {
      console.error("[Welcome] Failed to fetch member info:", err.message);
    } else {
      console.error("[Welcome] Unknown error fetching member info:", err);
    }
  }

  // Update nickname cache
  await rootServer.dataStore.appData.set([{
    key: NICKNAME_CACHE_PREFIX + userId,
    value: nickname,
  }]);

  const content = [message.replace(/\{nickname\}/g, nickname), image]
    .filter((x): x is string => Boolean(x && x.trim().length > 0))
    .join("\n");
  const request: ChannelMessageCreateRequest = {
    channelId: channelId as ChannelGuid,
    content,
  };
  try {
    await rootServer.community.channelMessages.create(request);
  } catch (err) {
    if (err instanceof RootApiException) {
      console.error(`[Welcome] RootApiException sending message to ${channelId}:`, err.errorCode);
    } else if (err instanceof Error) {
      console.error(`[Welcome] Error sending message to ${channelId}:`, err.message);
    } else {
      console.error(`[Welcome] Unknown error sending message to ${channelId}:`, err);
    }
  }
}

export async function triggerGoodbye(
  userId: string,
  settings: RootBotSettings
): Promise<void> {
  const runtimeLanguage = await getRuntimeLanguage(settings.language);
  const overrides = await getOverrides("goodbye");
  let channelId = overrides.channelId;
  const message = overrides.message ?? "{nickname} left the community.";
  const image = formatImageMarkdown(overrides.image);

  if (!channelId || !message) return;

  // Self-healing for goodbye
  if (channelId && channelId.includes("root://channel/")) {
    const resolved = await resolveChannelInternal(channelId);
    if (resolved) {
      await rootServer.dataStore.appData.set([{ key: `config:goodbyeChannelId`, value: resolved.id }]);
      channelId = resolved.id;
    } else {
      return;
    }
  }

  let nickname = t(runtimeLanguage, "someone");
  try {
    const cached = await rootServer.dataStore.appData.get<string>(
      NICKNAME_CACHE_PREFIX + userId
    );
    if (cached) nickname = cached;
  } catch {
    // Ignore if nickname not cached
  }

  const content = [message.replace(/\{nickname\}/g, nickname), image]
    .filter((x): x is string => Boolean(x && x.trim().length > 0))
    .join("\n");
  try {
    await rootServer.community.channelMessages.create({
      channelId: channelId as ChannelGuid,
      content,
    });
  } catch (err) {
    if (err instanceof RootApiException) {
      console.error(`[Goodbye] RootApiException sending message to ${channelId}:`, err.errorCode);
    } else if (err instanceof Error) {
      console.error(`[Goodbye] Error sending message to ${channelId}:`, err.message);
    } else {
      console.error(`[Goodbye] Unknown error sending message to ${channelId}:`, err);
    }
  }
}

export async function getOverrides(type: "welcome" | "goodbye"): Promise<{
  channelId?: string;
  message?: string;
  image?: string;
}> {
  const channelId = await rootServer.dataStore.appData.get<string>(`config:${type}ChannelId`);
  const message = await rootServer.dataStore.appData.get<string>(`config:${type}Message`);
  const image = await rootServer.dataStore.appData.get<string>(`config:${type}Image`);
  return { channelId, message, image };
}

async function getDefaultChannelId(): Promise<string | undefined> {
  const community: Community = await rootServer.community.communities.get();
  return community.defaultChannelId;
}

/**
 * Internal minimal resolver for self-healing.
 */
async function resolveChannelInternal(val: string) {
  const cleanVal = val.trim();
  const mdMatch = cleanVal.match(/\[#(.*?)\]\(root:\/\/channel\/(.*?)\)/);
  const label = mdMatch?.[1];

  const groups = await rootServer.community.channelGroups.list();
  for (const group of groups) {
    const channels = await rootServer.community.channels.list({ channelGroupId: group.id });
    const found = channels.find(ch => {
      const chName = ch.name.toLowerCase().trim();
      if (label && chName === label.toLowerCase().replace(/^[#]/, "")) return true;
      if (chName === cleanVal.replace(/^[#]/, "").toLowerCase()) return true;
      return false;
    });
    if (found) return found;
  }
  return undefined;
}

function formatImageMarkdown(raw?: string): string | undefined {
  if (!raw) return undefined;
  const input = raw.trim().replace(/^<|>$/g, "");
  const mdRootExternal = input.match(/^\[(https?:\/\/[^\]]+)\]\(root:\/\/external\/[^\)]+\)$/i);
  if (mdRootExternal?.[1]) return `[image](${mdRootExternal[1]})`;
  const mdAny = input.match(/^\[[^\]]*\]\((https?:\/\/\S+)\)$/i);
  if (mdAny?.[1]) return `[image](${mdAny[1]})`;
  if (/^https?:\/\/\S+$/i.test(input)) return `[image](${input})`;
  return undefined;
}

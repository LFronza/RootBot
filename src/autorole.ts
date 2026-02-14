import {
  rootServer,
  type ChannelGuid,
  type CommunityRoleGuid,
  type MessageGuid,
  ChannelMessageEvent,
  type ChannelMessageReactionCreatedEvent,
  type ChannelMessageReactionDeletedEvent,
} from "@rootsdk/server-bot";
import { t } from "./i18n/index.js";

const KEY_VALUE = rootServer.dataStore.appData;

type AutoRoleMode = "one" | "many";

interface AutoRoleRule {
  messageId: string;
  channelId: string;
  shortcode: string;
  shortcodeNorm: string;
  roleId: string;
  mode: AutoRoleMode;
}

interface ResolveMessageResult {
  messageId: string;
  channelId: string;
}

let cachedCommunityId: string | null = null;
const pendingAutoRoleByUser = new Map<string, PendingAutoRoleSetup>();
const AUTO_ROLE_PENDING_MS = 60_000;
const suppressedReactionEvents = new Map<string, number>();

interface PendingAutoRoleSetup {
  requesterUserId: string;
  messageId: string;
  channelId: string;
  roleId: string;
  mode: AutoRoleMode;
  commandChannelId: string;
  locale?: string;
  expiresAt: number;
}

function normalizeShortcode(shortcode: string): string {
  return canonicalizeShortcode(shortcode).replace(/^:+|:+$/g, "").toLowerCase();
}

function canonicalizeShortcode(raw: string): string {
  const input = raw.trim();
  const mdEmojiMatch = input.match(/^\[(.+?)\]\(root:\/\/emoji\/(.+?)\)$/i);
  if (mdEmojiMatch) {
    const label = mdEmojiMatch[1]?.trim();
    const uriPart = decodeURIComponent(mdEmojiMatch[2] ?? "").trim();
    if (uriPart) return uriPart.replace(/^:+|:+$/g, "");
    if (label) return label;
  }
  return input.replace(/^:+|:+$/g, "");
}

function emojiCandidates(raw: string): string[] {
  const canonical = canonicalizeShortcode(raw);
  const normalized = normalizeShortcode(raw);
  const direct = raw.trim();
  const candidates = [direct, canonical, normalized, `:${normalized}:`]
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return [...new Set(candidates)];
}

function reactionEventKey(channelId: string, messageId: string, shortcode: string): string {
  return `${channelId}:${messageId}:${normalizeShortcode(shortcode)}`;
}

function suppressReactionEvent(
  type: "created" | "deleted",
  channelId: string,
  messageId: string,
  shortcode: string
): void {
  const key = `${type}:${reactionEventKey(channelId, messageId, shortcode)}`;
  suppressedReactionEvents.set(key, (suppressedReactionEvents.get(key) ?? 0) + 1);
}

function consumeSuppressedReactionEvent(
  type: "created" | "deleted",
  channelId: string,
  messageId: string,
  shortcode: string
): boolean {
  const key = `${type}:${reactionEventKey(channelId, messageId, shortcode)}`;
  const current = suppressedReactionEvents.get(key) ?? 0;
  if (current <= 0) return false;
  if (current === 1) suppressedReactionEvents.delete(key);
  else suppressedReactionEvents.set(key, current - 1);
  return true;
}

async function getCommunityId(): Promise<string> {
  if (cachedCommunityId) return cachedCommunityId;
  const envId = process.env.COMMUNITY_ID?.trim();
  if (envId) {
    cachedCommunityId = envId;
    return envId;
  }
  const community = await rootServer.community.communities.get();
  const id = (community as { id?: string }).id ?? "default";
  cachedCommunityId = id;
  return id;
}

function autoRoleKey(communityId: string): string {
  return `autorole:rules:${communityId}:v1`;
}

async function getRules(): Promise<AutoRoleRule[]> {
  const communityId = await getCommunityId();
  const raw = await KEY_VALUE.get<string>(autoRoleKey(communityId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as AutoRoleRule[];
  } catch {
    return [];
  }
}

async function setRules(rules: AutoRoleRule[]): Promise<void> {
  const communityId = await getCommunityId();
  await KEY_VALUE.set([{ key: autoRoleKey(communityId), value: JSON.stringify(rules) }]);
}

export async function configureAutoRoleRule(input: {
  messageId: string;
  shortcode: string;
  roleId: string;
  mode: AutoRoleMode;
}): Promise<void> {
  const candidates = emojiCandidates(input.shortcode);
  if (candidates.length === 0) {
    throw new Error("emoji_invalid");
  }

  const resolvedMessage = await resolveMessageById(input.messageId);
  if (!resolvedMessage) {
    throw new Error("message_not_found");
  }

  let appliedShortcode: string | null = null;
  for (const candidate of candidates) {
    try {
      suppressReactionEvent("created", resolvedMessage.channelId, resolvedMessage.messageId, candidate);
      await rootServer.community.channelMessages.reactionCreate({
        channelId: resolvedMessage.channelId as ChannelGuid,
        messageId: resolvedMessage.messageId as MessageGuid,
        shortcode: candidate,
      });
      appliedShortcode = candidate;
      break;
    } catch {
      // Try next format.
    }
  }
  if (!appliedShortcode) {
    throw new Error("emoji_invalid");
  }

  await upsertAutoRoleRule({
    messageId: resolvedMessage.messageId,
    channelId: resolvedMessage.channelId,
    shortcode: appliedShortcode,
    roleId: input.roleId,
    mode: input.mode,
  });
}

async function upsertAutoRoleRule(input: {
  messageId: string;
  channelId: string;
  shortcode: string;
  roleId: string;
  mode: AutoRoleMode;
}): Promise<void> {
  const rules = await getRules();
  const norm = normalizeShortcode(input.shortcode);

  for (const rule of rules) {
    if (rule.messageId === input.messageId) {
      rule.mode = input.mode;
    }
  }

  const existing = rules.find(
    (r) =>
      r.messageId === input.messageId &&
      r.channelId === input.channelId &&
      r.shortcodeNorm === norm
  );

  if (existing) {
    existing.roleId = input.roleId;
    existing.shortcode = input.shortcode;
    existing.mode = input.mode;
  } else {
    rules.push({
      messageId: input.messageId,
      channelId: input.channelId,
      shortcode: input.shortcode,
      shortcodeNorm: norm,
      roleId: input.roleId,
      mode: input.mode,
    });
  }

  await setRules(rules);
}

export async function startPendingAutoRoleSetup(input: {
  requesterUserId: string;
  commandChannelId: string;
  messageId: string;
  roleId: string;
  mode: AutoRoleMode;
  locale?: string;
}): Promise<void> {
  const resolvedMessage = await resolveMessageById(input.messageId);
  if (!resolvedMessage) {
    throw new Error("message_not_found");
  }

  pendingAutoRoleByUser.set(input.requesterUserId, {
    requesterUserId: input.requesterUserId,
    messageId: resolvedMessage.messageId,
    channelId: resolvedMessage.channelId,
    roleId: input.roleId,
    mode: input.mode,
    commandChannelId: input.commandChannelId,
    locale: input.locale,
    expiresAt: Date.now() + AUTO_ROLE_PENDING_MS,
  });
}

export function registerAutoRoleReactions(): void {
  rootServer.community.channelMessages.on(
    ChannelMessageEvent.ChannelMessageReactionCreated,
    (evt: ChannelMessageReactionCreatedEvent) => void onReactionCreated(evt)
  );
  rootServer.community.channelMessages.on(
    ChannelMessageEvent.ChannelMessageReactionDeleted,
    (evt: ChannelMessageReactionDeletedEvent) => void onReactionDeleted(evt)
  );
}

export async function removeAutoRoleRule(input: {
  messageId: string;
  shortcode: string;
}): Promise<boolean> {
  const resolvedMessage = await resolveMessageById(input.messageId);
  if (!resolvedMessage) return false;

  const rules = await getRules();
  const norm = normalizeShortcode(input.shortcode);
  const before = rules.length;
  const kept = rules.filter(
    (r) =>
      !(
        r.messageId === resolvedMessage.messageId &&
        r.channelId === resolvedMessage.channelId &&
        r.shortcodeNorm === norm
      )
  );
  if (kept.length === before) return false;
  await setRules(kept);

  const shortcode = canonicalizeShortcode(input.shortcode);
  suppressReactionEvent("deleted", resolvedMessage.channelId, resolvedMessage.messageId, shortcode);
  await rootServer.community.channelMessages.reactionDelete({
    channelId: resolvedMessage.channelId as ChannelGuid,
    messageId: resolvedMessage.messageId as MessageGuid,
    shortcode,
  }).catch(() => undefined);

  return true;
}

async function onReactionCreated(evt: ChannelMessageReactionCreatedEvent): Promise<void> {
  if (consumeSuppressedReactionEvent("created", String(evt.channelId), String(evt.messageId), evt.shortcode)) {
    return;
  }

  const pending = pendingAutoRoleByUser.get(String(evt.userId));
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      pendingAutoRoleByUser.delete(String(evt.userId));
      await rootServer.community.channelMessages.create({
        channelId: pending.commandChannelId as ChannelGuid,
        content: t(pending.locale, "cmdAutoRolePendingExpired"),
      }).catch(() => undefined);
    } else if (
      pending.messageId === String(evt.messageId) &&
      pending.channelId === String(evt.channelId)
    ) {
      await upsertAutoRoleRule({
        messageId: pending.messageId,
        channelId: pending.channelId,
        shortcode: evt.shortcode,
        roleId: pending.roleId,
        mode: pending.mode,
      });
      pendingAutoRoleByUser.delete(String(evt.userId));
      await rootServer.community.channelMessages.create({
        channelId: pending.commandChannelId as ChannelGuid,
        content: t(pending.locale, "cmdAutoRoleConfigured", {
          messageId: pending.messageId,
          emoji: evt.shortcode,
          role: `<@&${pending.roleId}>`,
          mode: pending.mode,
        }),
      }).catch(() => undefined);
      return;
    }
  }

  const rules = await getRules();
  if (rules.length === 0) return;

  const norm = normalizeShortcode(evt.shortcode);
  const rule = rules.find(
    (r) =>
      r.messageId === evt.messageId &&
      r.channelId === evt.channelId &&
      r.shortcodeNorm === norm
  );
  if (!rule) return;

  // Fire-and-forget to avoid slowing down role toggle path.
  // If the reaction disappears from the message, onReactionDeleted will recreate it.
  suppressReactionEvent("deleted", String(evt.channelId), String(evt.messageId), evt.shortcode);
  void rootServer.community.channelMessages.reactionDelete({
    channelId: evt.channelId as ChannelGuid,
    messageId: evt.messageId as MessageGuid,
    shortcode: evt.shortcode,
  }).catch(() => {
    // Non-fatal.
  });

  const member = await rootServer.community.communityMembers.get({ userId: evt.userId as any });
  const roleIds = new Set((member.communityRoleIds ?? []).map((id) => String(id)));
  const hasTargetRole = roleIds.has(rule.roleId);

  if (hasTargetRole) {
    try {
      await rootServer.community.communityMemberRoles.remove({
        communityRoleId: rule.roleId as CommunityRoleGuid,
        userIds: [evt.userId],
      });
    } catch (err) {
      console.error("[AutoRole] Failed removing role:", err);
    }
    return;
  }

  if (rule.mode === "one") {
    const sameMessageRoles = new Set(
      rules
        .filter((r) => r.messageId === rule.messageId)
        .map((r) => r.roleId)
    );
    const toRemove = [...roleIds].filter((roleId) => sameMessageRoles.has(roleId) && roleId !== rule.roleId);
    for (const roleId of toRemove) {
      try {
        await rootServer.community.communityMemberRoles.remove({
          communityRoleId: roleId as CommunityRoleGuid,
          userIds: [evt.userId],
        });
      } catch (err) {
        console.error("[AutoRole] Failed removing role in one-mode:", err);
      }
    }
  }

  try {
    await rootServer.community.communityMemberRoles.add({
      communityRoleId: rule.roleId as CommunityRoleGuid,
      userIds: [evt.userId],
    });
  } catch (err) {
    console.error("[AutoRole] Failed adding role:", err);
  }
}

async function onReactionDeleted(evt: ChannelMessageReactionDeletedEvent): Promise<void> {
  if (consumeSuppressedReactionEvent("deleted", String(evt.channelId), String(evt.messageId), evt.shortcode)) {
    return;
  }

  const rules = await getRules();
  if (rules.length === 0) return;
  const norm = normalizeShortcode(evt.shortcode);
  const matching = rules.filter(
    (r) =>
      r.messageId === evt.messageId &&
      r.channelId === evt.channelId &&
      r.shortcodeNorm === norm
  );
  if (matching.length === 0) return;

  // Self-healing: keep the configured reaction present on the message.
  await Promise.all(
    matching.map((rule) =>
      (async () => {
        suppressReactionEvent("created", rule.channelId, rule.messageId, rule.shortcode);
        await rootServer.community.channelMessages.reactionCreate({
          channelId: rule.channelId as ChannelGuid,
          messageId: rule.messageId as MessageGuid,
          shortcode: rule.shortcode,
        }).catch(() => undefined);
      })()
    )
  );
}

async function resolveMessageById(messageId: string): Promise<ResolveMessageResult | null> {
  const groups = await rootServer.community.channelGroups.list();
  for (const group of groups) {
    const channels = await rootServer.community.channels.list({ channelGroupId: group.id });
    for (const ch of channels) {
      try {
        const msg = await rootServer.community.channelMessages.get({
          channelId: ch.id,
          id: messageId as MessageGuid,
        });
        if (msg?.id) {
          return { messageId: String(msg.id), channelId: String(ch.id) };
        }
      } catch {
        // Continue searching.
      }
    }
  }
  return null;
}

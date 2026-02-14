import { rootServer } from "@rootsdk/server-bot";
import {
  LEGACY_STREAMERS_KEY,
  STREAMER_CATALOG_KEY,
  type StreamerCatalogEntry,
  type TrackedStreamer,
} from "./types.js";

const KEY_VALUE = rootServer.dataStore.appData;
let cachedCommunityId: string | null = null;

function normalizeId(v: string): string {
  return v.trim().toLowerCase();
}

function makeCatalogId(platform: "youtube" | "twitch", externalId: string): string {
  return `${platform}:${normalizeId(externalId)}`;
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

function streamSubscriptionsKey(communityId: string): string {
  return `streamers:subs:${communityId}:v1`;
}

export function streamStateKey(communityId: string): string {
  return `streamers:state:${communityId}:v1`;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await KEY_VALUE.get<string>(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await KEY_VALUE.set([{ key, value: JSON.stringify(value) }]);
}

export async function getCatalog(): Promise<StreamerCatalogEntry[]> {
  return readJson<StreamerCatalogEntry[]>(STREAMER_CATALOG_KEY, []);
}

export async function setCatalog(catalog: StreamerCatalogEntry[]): Promise<void> {
  await writeJson(STREAMER_CATALOG_KEY, catalog);
}

export async function getCommunitySubscriptions(): Promise<string[]> {
  const communityId = await getCommunityId();
  return readJson<string[]>(streamSubscriptionsKey(communityId), []);
}

export async function setCommunitySubscriptions(subscriptions: string[]): Promise<void> {
  const communityId = await getCommunityId();
  await writeJson(streamSubscriptionsKey(communityId), subscriptions);
}

export async function getCommunityCatalogEntries(): Promise<StreamerCatalogEntry[]> {
  await migrateLegacyStreamersIfNeeded();
  const [catalog, subscriptions] = await Promise.all([
    getCatalog(),
    getCommunitySubscriptions(),
  ]);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return subscriptions
    .map((id) => byId.get(id))
    .filter((entry): entry is StreamerCatalogEntry => Boolean(entry));
}

export async function upsertCatalogEntry(
  platform: "youtube" | "twitch",
  externalId: string,
  displayName: string
): Promise<{ entry: StreamerCatalogEntry; isNewCatalogEntry: boolean }> {
  const catalog = await getCatalog();
  const id = makeCatalogId(platform, externalId);
  const existing = catalog.find((x) => x.id === id);
  if (existing) {
    if (displayName && existing.displayName !== displayName) {
      existing.displayName = displayName;
      await setCatalog(catalog);
    }
    return { entry: existing, isNewCatalogEntry: false };
  }

  const entry: StreamerCatalogEntry = {
    id,
    platform,
    externalId,
    displayName,
  };
  catalog.push(entry);
  await setCatalog(catalog);
  return { entry, isNewCatalogEntry: true };
}

export async function subscribeCatalogEntry(entryId: string): Promise<boolean> {
  const subscriptions = await getCommunitySubscriptions();
  if (subscriptions.includes(entryId)) return false;
  subscriptions.push(entryId);
  await setCommunitySubscriptions(subscriptions);
  return true;
}

export async function unsubscribeCommunityEntryByIndex(index: number): Promise<StreamerCatalogEntry | null> {
  const [subscriptions, catalog] = await Promise.all([
    getCommunitySubscriptions(),
    getCatalog(),
  ]);

  const i = index - 1;
  if (i < 0 || i >= subscriptions.length) return null;

  const [removedId] = subscriptions.splice(i, 1);
  await setCommunitySubscriptions(subscriptions);
  return catalog.find((x) => x.id === removedId) ?? null;
}

export async function migrateLegacyStreamersIfNeeded(): Promise<void> {
  const communityId = await getCommunityId();
  const subsKey = streamSubscriptionsKey(communityId);
  const existingSubsRaw = await KEY_VALUE.get<string>(subsKey);
  if (existingSubsRaw) return;

  const legacyRaw = await KEY_VALUE.get<string>(LEGACY_STREAMERS_KEY);
  if (!legacyRaw) {
    await writeJson(subsKey, []);
    return;
  }

  let legacy: TrackedStreamer[] = [];
  try {
    legacy = JSON.parse(legacyRaw) as TrackedStreamer[];
  } catch {
    await writeJson(subsKey, []);
    return;
  }

  const catalog = await getCatalog();
  const ids: string[] = [];

  for (const item of legacy) {
    const id = makeCatalogId(item.platform, item.externalId);
    ids.push(id);
    if (!catalog.some((x) => x.id === id)) {
      catalog.push({
        id,
        platform: item.platform,
        externalId: item.externalId,
        displayName: item.displayName,
      });
    }
  }

  await Promise.all([
    setCatalog(catalog),
    writeJson(subsKey, ids),
  ]);

  // Prevent future accidental re-import if community key strategy changes.
  await KEY_VALUE.delete(LEGACY_STREAMERS_KEY);
}

export async function getCommunityIdForStreams(): Promise<string> {
  return getCommunityId();
}

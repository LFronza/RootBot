/**
 * Live notifications for YouTube and Twitch (inspired by FBK Livestream Tracker).
 * Uses Job Scheduler for periodic checking and KeyValueStore for state.
 */

import {
  rootServer,
  RootApiException,
  type ChannelGuid,
  JobScheduleEvent,
  JobInterval,
} from "@rootsdk/server-bot";
import type { RootBotSettings } from "./types.js";
import { getRuntimeLanguage } from "./locale.js";
import {
  STREAM_JOB_TAG,
  STREAM_JOB_RESOURCE_ID,
} from "./types.js";
import { t } from "./i18n/index.js";
import {
  getCommunityCatalogEntries,
  getCommunityIdForStreams,
  migrateLegacyStreamersIfNeeded,
  streamStateKey,
} from "./streamRegistry.js";

const POLL_INTERVAL_MINUTES = 5;
const CONTENT_CHECK_INTERVAL_MINUTES = 20;
const LIVE_RECHECK_WHEN_LATE_MINUTES = 2;
const LIVE_FALLBACK_CHECK_MINUTES = 30;
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const KEY_VALUE = rootServer.dataStore.appData;
const YT_QUOTA_BLOCKED_UNTIL_KEY = "youtube:quotaBlockedUntil";

export function registerStreamChecker(settings: RootBotSettings): void {
  rootServer.jobScheduler.on(JobScheduleEvent.Job, (data) => {
    if (data.tag === STREAM_JOB_TAG) runStreamCheck(settings);
  });
  rootServer.jobScheduler.on(JobScheduleEvent.JobMissed, () => {
    runStreamCheck(settings);
  });
}

/**
 * Schedule the next stream check execution.
 * JobInterval only offers OneTime, Daily, Weekly... so we use OneTime and reschedule after each run.
 */
export function scheduleNextStreamCheck(): void {
  const start = new Date();
  start.setMinutes(start.getMinutes() + POLL_INTERVAL_MINUTES);

  rootServer.jobScheduler.create({
    resourceId: STREAM_JOB_RESOURCE_ID,
    tag: STREAM_JOB_TAG,
    start,
    jobInterval: JobInterval.OneTime,
  });
}

interface StreamerState {
  lastLive: boolean;
  lastStreamId?: string;
  lastVideoId?: string;
  lastPremiereId?: string;
  lastContentCheckAt?: number;
  pendingScheduledStartAt?: number;
  nextLiveCheckAt?: number;
}

export async function getStreamOverrides(): Promise<{
  channelId?: string;
  roleId?: string;
  message?: string;
}> {
  return {
    channelId: await KEY_VALUE.get<string>("config:streamChannelId"),
    roleId: await KEY_VALUE.get<string>("config:streamMentionRoleId"),
    message: await KEY_VALUE.get<string>("config:streamMessage"),
  };
}

export async function runStreamCheck(settings: RootBotSettings): Promise<void> {
  try {
    const runtimeLanguage = await getRuntimeLanguage(settings.language);
    await migrateLegacyStreamersIfNeeded();

    const overrides = await getStreamOverrides();
    const channelId = overrides.channelId;
    if (!channelId) return;

    const youtubeKey = process.env.YOUTUBE_API_KEY;
    const twitchId = process.env.TWITCH_CLIENT_ID;
    const twitchSecret = process.env.TWITCH_CLIENT_SECRET;

    const hasTwitch = Boolean(twitchId && twitchSecret);
    const hasYoutubeApi = Boolean(youtubeKey);
    let youtubeQuotaBlocked = hasYoutubeApi ? await isYouTubeQuotaBlocked() : true;

    const allStreamers = await getCommunityCatalogEntries();

    if (allStreamers.length === 0) return;
    if (!hasTwitch && !allStreamers.some((s) => s.platform === "youtube")) return;

    const communityId = await getCommunityIdForStreams();
    const stateStorageKey = streamStateKey(communityId);
    const stateJson = await KEY_VALUE.get<string>(stateStorageKey);
    const stateMap: Record<string, StreamerState> = stateJson
      ? JSON.parse(stateJson)
      : {};

    const mention = overrides.roleId ? `<@&${overrides.roleId}>` : "";
    const twitchToken = hasTwitch
      ? await getTwitchAppToken(twitchId!, twitchSecret!)
      : null;

    let stateChanged = false;
    const now = Date.now();

    for (const s of allStreamers) {
      const stateKey = `${s.platform}:${s.externalId}`;
      const state = stateMap[stateKey] ?? { lastLive: false };

      try {
        if (s.platform === "youtube") {
          const shouldCheckLiveNow =
            !state.nextLiveCheckAt || now >= state.nextLiveCheckAt;
          let live: { isLive: boolean; url?: string; title?: string; videoId?: string } | null = null;

          if (shouldCheckLiveNow) {
            live = await checkYouTubeLive("", s.externalId);
            if (live.isLive && !state.lastLive) {
              const text = formatStreamMessage(
                runtimeLanguage,
                "YouTube",
                s.displayName,
                live.url ?? `https://youtube.com/channel/${s.externalId}`,
                live.title,
                mention,
                overrides.message
              );
              await rootServer.community.channelMessages.create({
                channelId: channelId as ChannelGuid,
                content: text,
              });
            }
          }

          const shouldCheckContent =
            !state.lastContentCheckAt ||
            now - state.lastContentCheckAt >= CONTENT_CHECK_INTERVAL_MINUTES * 60 * 1000;

          if (hasYoutubeApi && !youtubeQuotaBlocked && shouldCheckContent) {
            const latest = await checkYouTubeLatestContent(youtubeKey!, s.externalId);
            if (latest.kind === "video" && latest.videoId && state.lastVideoId !== latest.videoId) {
              await rootServer.community.channelMessages.create({
                channelId: channelId as ChannelGuid,
                content: formatYouTubeContentMessage(
                  runtimeLanguage,
                  s.displayName,
                  latest.url ?? `https://youtube.com/channel/${s.externalId}`,
                  latest.title,
                  mention,
                  "video"
                ),
              });
              state.lastVideoId = latest.videoId;
              stateChanged = true;
            }

            if (latest.kind === "premiere" && latest.videoId && state.lastPremiereId !== latest.videoId) {
              await rootServer.community.channelMessages.create({
                channelId: channelId as ChannelGuid,
                content: formatYouTubeContentMessage(
                  runtimeLanguage,
                  s.displayName,
                  latest.url ?? `https://youtube.com/channel/${s.externalId}`,
                  latest.title,
                  mention,
                  "premiere"
                ),
              });
              state.lastPremiereId = latest.videoId;
              stateChanged = true;
            }

            if (latest.kind === "premiere" && latest.scheduledStartAt) {
              const aheadMs = latest.scheduledStartAt - now;
              if (aheadMs > 0 && aheadMs <= MAX_SCHEDULE_AHEAD_MS) {
                if (state.pendingScheduledStartAt !== latest.scheduledStartAt) {
                  state.pendingScheduledStartAt = latest.scheduledStartAt;
                  state.nextLiveCheckAt = latest.scheduledStartAt;
                  stateChanged = true;
                }
              } else if (aheadMs > MAX_SCHEDULE_AHEAD_MS && state.pendingScheduledStartAt) {
                state.pendingScheduledStartAt = undefined;
                stateChanged = true;
              }
            }

            if (!youtubeQuotaBlocked) {
              youtubeQuotaBlocked = await isYouTubeQuotaBlocked();
            }

            state.lastContentCheckAt = now;
            stateChanged = true;
          }

          if (live) {
            if (state.lastLive !== live.isLive || state.lastStreamId !== live.videoId) {
              state.lastLive = live.isLive;
              state.lastStreamId = live.videoId;
              stateChanged = true;
            }

            if (live.isLive) {
              const nextWhileLive = now + POLL_INTERVAL_MINUTES * 60 * 1000;
              if (state.nextLiveCheckAt !== nextWhileLive) {
                state.nextLiveCheckAt = nextWhileLive;
                state.pendingScheduledStartAt = undefined;
                stateChanged = true;
              }
            } else {
              let nextCheck = now + LIVE_FALLBACK_CHECK_MINUTES * 60 * 1000;
              if (state.pendingScheduledStartAt) {
                if (now >= state.pendingScheduledStartAt) {
                  nextCheck = now + LIVE_RECHECK_WHEN_LATE_MINUTES * 60 * 1000;
                } else {
                  nextCheck = state.pendingScheduledStartAt;
                }
              }
              if (state.nextLiveCheckAt !== nextCheck) {
                state.nextLiveCheckAt = nextCheck;
                stateChanged = true;
              }
            }
          }
          stateMap[stateKey] = state;
        }

        if (s.platform === "twitch" && hasTwitch && twitchToken) {
          const live = await checkTwitchLive(twitchId!, twitchToken, s.externalId);
          if (live.isLive && !state.lastLive) {
            const text = formatStreamMessage(
              runtimeLanguage,
              "Twitch",
              s.displayName,
              live.url ?? `https://twitch.tv/${s.externalId}`,
              live.title,
              mention,
              overrides.message
            );
            await rootServer.community.channelMessages.create({
              channelId: channelId as ChannelGuid,
              content: text,
            });
          }
          if (state.lastLive !== live.isLive || state.lastStreamId !== live.streamId) {
            state.lastLive = live.isLive;
            state.lastStreamId = live.streamId;
            stateChanged = true;
          }
          stateMap[stateKey] = state;
        }
      } catch (err) {
        if (err instanceof RootApiException) {
          console.error(`[Stream] RootApiException checking ${s.platform}/${s.externalId}:`, err.errorCode);
        } else if (err instanceof Error) {
          console.error(`[Stream] Error checking ${s.platform}/${s.externalId}:`, err.message);
        } else {
          console.error(`[Stream] Unknown error checking ${s.platform}/${s.externalId}:`, err);
        }
      }
    }

    if (stateChanged) {
      await KEY_VALUE.set({
        key: stateStorageKey,
        value: JSON.stringify(stateMap),
      });
    }
  } finally {
    scheduleNextStreamCheck();
  }
}

function formatStreamMessage(
  locale: string | undefined,
  platform: string,
  name: string,
  url: string,
  title: string | undefined,
  mention: string,
  customTemplate?: string
): string {
  if (customTemplate) {
    let msg = customTemplate
      .replace(/{name}/g, name)
      .replace(/{platform}/g, platform)
      .replace(/{url}/g, url)
      .replace(/{title}/g, title ?? "");
    if (mention) msg = `${mention} ${msg}`;
    return msg;
  }

  const parts = [
    t(locale, "streamAnnounce", { name, platform }),
    url,
  ];
  if (title) parts.push(t(locale, "streamAnnounceTitle", { title }));
  if (mention) parts.push(mention);
  return parts.join("\n");
}

function formatYouTubeContentMessage(
  locale: string | undefined,
  name: string,
  url: string,
  title: string | undefined,
  mention: string,
  kind: "video" | "premiere"
): string {
  const parts = [
    kind === "video"
      ? t(locale, "youtubeVideoAnnounce", { name })
      : t(locale, "youtubePremiereAnnounce", { name }),
    url,
  ];
  if (title) parts.push(t(locale, "streamAnnounceTitle", { title }));
  if (mention) parts.push(mention);
  return parts.join("\n");
}

export async function checkYouTubeLatestContent(
  apiKey: string,
  channelId: string
): Promise<{ kind: "video" | "premiere" | "none"; videoId?: string; url?: string; title?: string; scheduledStartAt?: number }> {
  try {
    const channelsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`
    );
    if (!channelsRes.ok) {
      await handleYouTubeQuotaError(channelId, channelsRes);
      return { kind: "none" };
    }
    const channelsData = (await channelsRes.json()) as {
      items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
    };
    const uploadsPlaylistId = channelsData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return { kind: "none" };

    const itemsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=5&key=${encodeURIComponent(apiKey)}`
    );
    if (!itemsRes.ok) {
      await handleYouTubeQuotaError(channelId, itemsRes);
      return { kind: "none" };
    }
    const itemsData = (await itemsRes.json()) as {
      items?: Array<{ contentDetails?: { videoId?: string } }>;
    };
    const videoIds = (itemsData.items ?? [])
      .map((x) => x.contentDetails?.videoId)
      .filter((x): x is string => Boolean(x));
    if (videoIds.length === 0) return { kind: "none" };

    const videosRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoIds.join(","))}&key=${encodeURIComponent(apiKey)}`
    );
    if (!videosRes.ok) {
      await handleYouTubeQuotaError(channelId, videosRes);
      return { kind: "none" };
    }
    const videosData = (await videosRes.json()) as {
      items?: Array<{
        id?: string;
        snippet?: { title?: string; liveBroadcastContent?: string };
        liveStreamingDetails?: { scheduledStartTime?: string };
      }>;
    };

    const item = videosData.items?.find((x) => x.id && x.snippet?.liveBroadcastContent !== "live");
    if (!item?.id) return { kind: "none" };
    if (item.snippet?.liveBroadcastContent === "upcoming") {
      const scheduledStartAt = item.liveStreamingDetails?.scheduledStartTime
        ? Date.parse(item.liveStreamingDetails.scheduledStartTime)
        : undefined;
      return {
        kind: "premiere",
        videoId: item.id,
        url: `https://youtube.com/watch?v=${item.id}`,
        title: item.snippet?.title,
        scheduledStartAt: Number.isFinite(scheduledStartAt) ? scheduledStartAt : undefined,
      };
    }
    return {
      kind: "video",
      videoId: item.id,
      url: `https://youtube.com/watch?v=${item.id}`,
      title: item.snippet?.title,
    };
  } catch {
    return { kind: "none" };
  }
}

export async function checkYouTubeLive(
  _apiKey: string,
  channelId: string
): Promise<{ isLive: boolean; url?: string; title?: string; videoId?: string }> {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) {
      return { isLive: false };
    }
    const finalUrl = res.url;
    const html = await res.text();
    const videoId =
      finalUrl.match(/[?&]v=([\w-]{11})/)?.[1] ??
      html.match(/"videoId":"([\w-]{11})"/)?.[1];
    const hasLiveNowTrue = /"isLiveNow":true/.test(html);
    const hasLiveNowFalse = /"isLiveNow":false/.test(html);
    const hasLiveBadge = /BADGE_STYLE_TYPE_LIVE_NOW/.test(html);
    const isLiveNow = hasLiveNowTrue || (!hasLiveNowFalse && hasLiveBadge);
    if (!videoId || !isLiveNow) {
      return { isLive: false };
    }
    const title =
      html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
      html.match(/<title>(.*?)<\/title>/)?.[1];
    return {
      isLive: true,
      videoId,
      url: `https://youtube.com/watch?v=${videoId}`,
      title,
    };
  } catch (err) {
    console.error(`[YouTube] Fetch error for ${channelId}:`, err);
    return { isLive: false };
  }
}

async function isYouTubeQuotaBlocked(): Promise<boolean> {
  const raw = await KEY_VALUE.get<string>(YT_QUOTA_BLOCKED_UNTIL_KEY);
  if (!raw) return false;
  const until = Number(raw);
  if (!Number.isFinite(until) || Date.now() >= until) {
    await KEY_VALUE.delete(YT_QUOTA_BLOCKED_UNTIL_KEY);
    return false;
  }
  return true;
}

async function blockYouTubeQuotaUntilNextUtcDay(): Promise<void> {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  await KEY_VALUE.set([{ key: YT_QUOTA_BLOCKED_UNTIL_KEY, value: String(next.getTime()) }]);
}

async function handleYouTubeQuotaError(channelId: string, res: Response): Promise<void> {
  const body = await res.text();
  if (body.includes("quotaExceeded")) {
    const alreadyBlocked = await isYouTubeQuotaBlocked();
    if (!alreadyBlocked) {
      console.error(`[YouTube] Quota exceeded for ${channelId}. Blocking API checks until next UTC day.`);
    }
    await blockYouTubeQuotaUntilNextUtcDay();
    return;
  }
  console.error(`[YouTube] API Error for ${channelId}:`, body);
}

export async function getTwitchAppToken(
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const res = await fetch(
    "https://id.twitch.tv/oauth2/token?grant_type=client_credentials&client_id=" +
    encodeURIComponent(clientId) +
    "&client_secret=" +
    encodeURIComponent(clientSecret),
    { method: "POST" }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

export async function checkTwitchLive(
  clientId: string,
  accessToken: string,
  userId: string
): Promise<{ isLive: boolean; url?: string; title?: string; streamId?: string }> {
  // If numeric, use user_id, otherwise use user_login
  const isNumeric = /^\d+$/.test(userId);
  const param = isNumeric ? `user_id=${userId}` : `user_login=${userId}`;

  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?${param}`,
      {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    if (!res.ok) {
      const error = await res.text();
      console.error(`[Twitch] API Error for ${userId}:`, error);
      return { isLive: false };
    }
    const data = (await res.json()) as {
      data?: Array<{
        id?: string;
        title?: string;
        user_name?: string;
      }>;
    };
    const stream = data.data?.[0];
    if (!stream?.id) {
      console.log(`[Twitch] No live stream found for ${userId} (${param})`);
      return { isLive: false };
    }
    const login = stream.user_name ?? userId;
    return {
      isLive: true,
      streamId: stream.id,
      url: `https://twitch.tv/${login}`,
      title: stream.title,
    };
  } catch (err) {
    console.error(`[Twitch] Fetch error for ${userId}:`, err);
    return { isLive: false };
  }
}

export async function triggerStreamTest(
  userId: string,
  settings: RootBotSettings
): Promise<void> {
  const runtimeLanguage = await getRuntimeLanguage(settings.language);
  const overrides = await getStreamOverrides();
  const channelId = overrides.channelId;
  const mention = overrides.roleId;
  const message = overrides.message;

  if (!channelId) return;

  const text = formatStreamMessage(
    runtimeLanguage,
    "TestPlatform",
    "TestStreamer",
    "https://example.com/live",
    "This is a test stream notification!",
    mention ? `<@&${mention}>` : "",
    message
  );

  await rootServer.community.channelMessages.create({
    channelId: channelId as ChannelGuid,
    content: `[TEST] ${text}`,
  });
}

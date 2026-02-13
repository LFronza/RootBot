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
import {
  STREAMERS_KEY,
  STREAM_JOB_TAG,
  STREAM_JOB_RESOURCE_ID,
  type TrackedStreamer,
} from "./types.js";
import { t } from "./i18n/index.js";

const POLL_INTERVAL_MINUTES = 5;
const KEY_VALUE = rootServer.dataStore.appData;

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

const STATE_KEY = "streamer_states";

interface StreamerState {
  lastLive: boolean;
  lastStreamId?: string;
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
  const overrides = await getStreamOverrides();
  const channelId = overrides.channelId;
  if (!channelId) return;

  const youtubeKey = process.env.YOUTUBE_API_KEY;
  const twitchId = process.env.TWITCH_CLIENT_ID;
  const twitchSecret = process.env.TWITCH_CLIENT_SECRET;

  const hasYoutube = Boolean(youtubeKey);
  const hasTwitch = Boolean(twitchId && twitchSecret);

  if (!hasYoutube && !hasTwitch) return;

  // No more streamers from settings
  const settingStreamers: TrackedStreamer[] = [];

  // Load streamers from DB
  const streamersJson = await KEY_VALUE.get<string>(STREAMERS_KEY);
  const dbStreamers: TrackedStreamer[] = streamersJson
    ? (JSON.parse(streamersJson) as TrackedStreamer[])
    : [];

  // Merge lists (priority to DB or just unique set?)
  // Let's treat them as a set based on platform+externalId
  const allStreamers = [...settingStreamers];
  for (const s of dbStreamers) {
    if (!allStreamers.some(existing => existing.platform === s.platform && existing.externalId === s.externalId)) {
      allStreamers.push(s);
    }
  }

  if (allStreamers.length === 0) return;

  // Load previous state
  const stateJson = await KEY_VALUE.get<string>(STATE_KEY);
  const stateMap: Record<string, StreamerState> = stateJson
    ? JSON.parse(stateJson)
    : {};

  const mention = overrides.roleId ? `<@&${overrides.roleId}>` : "";

  let stateChanged = false;

  for (const s of allStreamers) {
    const state = stateMap[s.externalId] ?? { lastLive: false };

    try {
      if (s.platform === "youtube" && hasYoutube) {
        const live = await checkYouTubeLive(youtubeKey!, s.externalId);
        if (live.isLive && !state.lastLive) {
          const text = formatStreamMessage(
            settings.language,
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
        if (state.lastLive !== live.isLive || state.lastStreamId !== live.videoId) {
          state.lastLive = live.isLive;
          state.lastStreamId = live.videoId;
          stateMap[s.externalId] = state;
          stateChanged = true;
        }
      }

      if (s.platform === "twitch" && hasTwitch) {
        const token = await getTwitchAppToken(twitchId!, twitchSecret!);
        if (!token) continue;
        const live = await checkTwitchLive(twitchId!, token, s.externalId);
        if (live.isLive && !state.lastLive) {
          const text = formatStreamMessage(
            settings.language,
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
          stateMap[s.externalId] = state;
          stateChanged = true;
        }
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
      key: STATE_KEY,
      value: JSON.stringify(stateMap),
    });
  }

  scheduleNextStreamCheck();
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

export async function checkYouTubeLive(
  apiKey: string,
  channelId: string
): Promise<{ isLive: boolean; url?: string; title?: string; videoId?: string }> {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const error = await res.text();
      console.error(`[YouTube] API Error for ${channelId}:`, error);
      return { isLive: false };
    }
    const data = (await res.json()) as {
      items?: Array<{
        id?: { videoId?: string };
        snippet?: { title?: string };
      }>;
    };
    const item = data.items?.[0];
    if (!item?.id?.videoId) {
      console.log(`[YouTube] No live stream found for ${channelId}`);
      return { isLive: false };
    }
    return {
      isLive: true,
      videoId: item.id.videoId,
      url: `https://youtube.com/watch?v=${item.id.videoId}`,
      title: item.snippet?.title,
    };
  } catch (err) {
    console.error(`[YouTube] Fetch error for ${channelId}:`, err);
    return { isLive: false };
  }
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
  const overrides = await getStreamOverrides();
  const channelId = overrides.channelId;
  const mention = overrides.roleId;
  const message = overrides.message;

  if (!channelId) return;

  const text = formatStreamMessage(
    settings.language,
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

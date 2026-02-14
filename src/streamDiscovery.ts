import type { StreamPlatform } from "./types.js";

export interface ResolvedStreamerInput {
  platform: StreamPlatform;
  externalId: string;
  displayName: string;
}

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

function parseHint(raw: string): { hint?: StreamPlatform; query: string } {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("yt:") || lower.startsWith("youtube:")) {
    return {
      hint: "youtube",
      query: value.slice(value.indexOf(":") + 1).trim(),
    };
  }
  if (lower.startsWith("tw:") || lower.startsWith("twitch:")) {
    return {
      hint: "twitch",
      query: value.slice(value.indexOf(":") + 1).trim(),
    };
  }
  return { query: value };
}

function parseKnownUrl(input: string): { platform?: StreamPlatform; value?: string } {
  const clean = input.trim();
  const ytChannel = clean.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
  if (ytChannel?.[1]) return { platform: "youtube", value: ytChannel[1] };

  const twitchLogin = clean.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
  if (twitchLogin?.[1]) return { platform: "twitch", value: twitchLogin[1] };

  return {};
}

function isYouTubeChannelId(input: string): boolean {
  return /^UC[\w-]{22}$/.test(input.trim());
}

async function getTwitchAppToken(
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

async function resolveTwitch(
  query: string
): Promise<ResolvedStreamerInput | null> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const token = await getTwitchAppToken(clientId, clientSecret);
  if (!token) return null;

  const isNumeric = /^\d+$/.test(query);
  const param = isNumeric
    ? `id=${encodeURIComponent(query)}`
    : `login=${encodeURIComponent(query.toLowerCase())}`;

  const res = await fetch(`https://api.twitch.tv/helix/users?${param}`, {
    headers: {
      "Client-Id": clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;

  const body = (await res.json()) as { data?: TwitchUser[] };
  const user = body.data?.[0];
  if (!user?.id) return null;

  return {
    platform: "twitch",
    externalId: user.id,
    displayName: user.display_name || user.login || query,
  };
}

async function resolveYouTube(
  query: string
): Promise<ResolvedStreamerInput | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  if (isYouTubeChannelId(query)) {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string } }>;
    };
    const ch = body.items?.[0];
    if (!ch?.id) return null;
    return {
      platform: "youtube",
      externalId: ch.id,
      displayName: ch.snippet?.title ?? ch.id,
    };
  }

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    items?: Array<{ id?: { channelId?: string }; snippet?: { channelTitle?: string } }>;
  };
  const first = body.items?.[0];
  const channelId = first?.id?.channelId;
  if (!channelId) return null;
  return {
    platform: "youtube",
    externalId: channelId,
    displayName: first?.snippet?.channelTitle ?? query,
  };
}

export async function resolveStreamerInput(rawInput: string): Promise<ResolvedStreamerInput | null> {
  const hinted = parseHint(rawInput);
  const urlParsed = parseKnownUrl(hinted.query);
  const input = urlParsed.value ?? hinted.query;
  const hint = urlParsed.platform ?? hinted.hint;

  if (!input) return null;
  if (hint === "youtube") return resolveYouTube(input);
  if (hint === "twitch") return resolveTwitch(input);

  if (isYouTubeChannelId(input)) return resolveYouTube(input);
  if (/^\d+$/.test(input)) return resolveTwitch(input);

  const [twitch, youtube] = await Promise.all([
    resolveTwitch(input),
    resolveYouTube(input),
  ]);

  if (twitch && !youtube) return twitch;
  if (!twitch && youtube) return youtube;
  if (!twitch && !youtube) return null;

  if (/^[a-zA-Z0-9_]{3,25}$/.test(input)) return twitch;
  return youtube;
}

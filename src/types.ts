/**
 * Types and interfaces used by RootBot.
 * Inspired by FBK (Discord) features.
 */

export interface RootBotSettings {
  /** Language code (pt, en, etc.). Kept optional in case we want to configure via manifest in the future. */
  language?: string;
  /** Default command prefix from global settings. Can be overridden by local !set prefix. */
  commandPrefix?: string;
}

export type StreamPlatform = "youtube" | "twitch";

export interface TrackedStreamer {
  platform: StreamPlatform;
  /** YouTube channel ID or Twitch user ID */
  externalId: string;
  /** Channel/streamer name for display */
  displayName: string;
  /** Last known state: true = live */
  lastLive?: boolean;
  /** Current stream/video ID (to avoid duplicates) */
  lastStreamId?: string;
}

export interface StreamerCatalogEntry {
  id: string;
  platform: StreamPlatform;
  externalId: string;
  displayName: string;
}

export const LEGACY_STREAMERS_KEY = "tracked_streamers";
export const STREAMER_CATALOG_KEY = "streamers:catalog:v1";
export const STREAM_JOB_TAG = "stream-check";
export const STREAM_JOB_RESOURCE_ID = "stream-check-job";
export const ADMIN_ROLE_KEY = "config:adminRoleId";
export const MOD_ROLE_KEY = "config:modRoleId";
export const OVERRIDE_ROLE_KEY = "config:overrideRoleId";
export const MOD_LOG_CHANNEL_KEY = "config:modLogChannelId";

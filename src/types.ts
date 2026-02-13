/**
 * Types and interfaces used by RootBot.
 * Inspired by FBK (Discord) features.
 */

export interface RootBotSettings {
  /** Language code (pt, en, etc.). Kept optional in case we want to configure via manifest in the future. */
  language?: string;
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

export const STREAMERS_KEY = "tracked_streamers";
export const STREAM_JOB_TAG = "stream-check";
export const STREAM_JOB_RESOURCE_ID = "stream-check-job";
export const ADMIN_ROLE_KEY = "config:adminRoleId";

/**
 * APPL-E – Root Bot inspired by FBK (Discord).
 * Features: live notifications (YouTube/Twitch), welcome/goodbye messages, automatic role assignment.
 */

import path from "path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.join(process.cwd(), ".env") });

const hasToken = Boolean(process.env.DEV_TOKEN?.trim());
const hasCommunity = Boolean(process.env.COMMUNITY_ID?.trim());
if (!hasToken || !hasCommunity) {
  console.error(
    "[APPL-E] Missing environment variables. Check the .env file in the project root."
  );
  if (!hasToken) console.error("  - DEV_TOKEN is not defined or is empty.");
  if (!hasCommunity) console.error("  - COMMUNITY_ID is not defined or is empty.");
  console.error("  - Run 'npm start' in the project folder (where .env is located). Current path:", process.cwd());
  process.exit(1);
}

import { rootServer, RootBotStartState } from "@rootsdk/server-bot";
import type { RootBotSettings } from "./types.js";
import { registerWelcomeGoodbye } from "./welcome.js";
import { registerAutoRole } from "./roles.js";
import {
  registerStreamChecker,
  scheduleNextStreamCheck,
} from "./streams.js";
import { registerStreamCommands } from "./commands.js";

function mapGlobalSettingsToBotSettings(
  globalSettings: RootBotStartState["globalSettings"]
): RootBotSettings {
  if (!globalSettings || typeof globalSettings !== "object") {
    return { language: "pt" };
  }
  const g = globalSettings as Record<string, unknown>;
  return {
    language: stringOrUndefined(g.language) || "pt",
  };
}

function stringOrUndefined(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

async function onStarting(state: RootBotStartState): Promise<void> {
  const settings = mapGlobalSettingsToBotSettings(state.globalSettings);

  registerWelcomeGoodbye(settings);
  registerAutoRole(settings);
  registerStreamChecker(settings);
  registerStreamCommands(settings);

  const hasYoutube = Boolean(process.env.YOUTUBE_API_KEY);
  const hasTwitch = Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);

  if (hasYoutube || hasTwitch) {
    scheduleNextStreamCheck();
  }
}

(async () => {
  await rootServer.lifecycle.start(onStarting);
})();

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
import { registerAutoRoleReactions } from "./autorole.js";
import { setRuntimeLanguage } from "./locale.js";

function mapGlobalSettingsToBotSettings(
  globalSettings: RootBotStartState["globalSettings"]
): RootBotSettings {
  if (!globalSettings) {
    return { language: "en" };
  }
  return {
    language: readGlobalStringSetting(globalSettings, "language") || "en",
    commandPrefix: readGlobalStringSetting(globalSettings, "commandPrefix"),
  };
}

function stringOrUndefined(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function readGlobalStringSetting(
  globalSettings: RootBotStartState["globalSettings"],
  key: string
): string | undefined {
  if (!globalSettings || typeof globalSettings !== "object") return undefined;
  const gs = globalSettings as Record<string, unknown>;
  const direct = gs[key];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) && typeof direct[0] === "string") return direct[0];

  for (const groupValue of Object.values(gs)) {
    if (!groupValue || typeof groupValue !== "object") continue;
    const nested = (groupValue as Record<string, unknown>)[key];
    if (typeof nested === "string") return nested;
    if (Array.isArray(nested) && typeof nested[0] === "string") return nested[0];
  }
  return undefined;
}

async function syncGlobalSettingsToAppData(
  globalSettings: RootBotStartState["globalSettings"]
): Promise<void> {
  const language = readGlobalStringSetting(globalSettings, "language")?.toLowerCase();
  const prefix = stringOrUndefined(readGlobalStringSetting(globalSettings, "commandPrefix")?.trim());
  const updates: Array<{ key: string; value: string }> = [];
  if (language === "pt" || language === "en") updates.push({ key: "config:language", value: language });
  if (prefix) updates.push({ key: "config:commandPrefix", value: prefix });

  if (updates.length > 0) {
    await rootServer.dataStore.appData.set(updates);
  }
}

async function onStarting(state: RootBotStartState): Promise<void> {
  const settings = mapGlobalSettingsToBotSettings(state.globalSettings);
  if (settings.language === "pt" || settings.language === "en") {
    setRuntimeLanguage(settings.language);
  }
  await syncGlobalSettingsToAppData(state.globalSettings);

  registerWelcomeGoodbye(settings);
  registerAutoRole(settings);
  registerStreamChecker(settings);
  registerStreamCommands(settings);
  registerAutoRoleReactions();

  rootServer.globalSettings?.on("update", (event) => {
    void syncGlobalSettingsToAppData(event.current).catch((err) => {
      console.error("[Settings] Failed syncing global settings:", err);
    });
  });

  const hasYoutube = Boolean(process.env.YOUTUBE_API_KEY);
  const hasTwitch = Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);

  if (hasYoutube || hasTwitch) {
    scheduleNextStreamCheck();
  }
}

(async () => {
  await rootServer.lifecycle.start(onStarting);
})();

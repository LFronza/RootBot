import { rootServer } from "@rootsdk/server-bot";

const KEY_VALUE = rootServer.dataStore.appData;
const LANGUAGE_KEY = "config:language";
let runtimeLanguageOverride: "pt" | "en" | null = null;

export function setRuntimeLanguage(lang: "pt" | "en"): void {
  runtimeLanguageOverride = lang;
}

export async function getRuntimeLanguage(
  fallback?: string
): Promise<"pt" | "en"> {
  if (runtimeLanguageOverride) return runtimeLanguageOverride;
  const raw = (await KEY_VALUE.get<string>(LANGUAGE_KEY))?.trim().toLowerCase();
  if (raw === "pt" || raw === "en") return raw;
  if (fallback === "pt" || fallback === "en") return fallback;
  return "en";
}

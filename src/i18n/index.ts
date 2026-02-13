/**
 * Internacionalização (i18n).
 *
 * Como adicionar um novo idioma (ex.: espanhol):
 * 1. Em translations.ts: crie export const es = { ... } com as mesmas chaves de pt/en.
 * 2. Abaixo: adicione "es" ao tipo Locale, a SUPPORTED_LOCALES e ao objeto translations.
 * 3. No root-manifest.json, no select "language", adicione { "label": "Español", "value": "es" } em options.
 */

import { pt, en, type TranslationKey } from "./translations.js";

export type Locale = "pt" | "en";

export const DEFAULT_LOCALE: Locale = "en";

/** Lista de idiomas suportados; use para o select no manifest e validação. */
export const SUPPORTED_LOCALES: Locale[] = ["pt", "en"];

type TranslationsMap = { [K in TranslationKey]: string };
const translations: Record<Locale, TranslationsMap> = { pt, en };

/**
 * Retorna a string traduzida para o locale. Placeholders {key} são substituídos por params[key].
 * Se o locale for inválido, usa DEFAULT_LOCALE.
 */
export function t(
  locale: string | undefined,
  key: TranslationKey,
  params?: Record<string, string>
): string {
  const lang: Locale =
    locale && SUPPORTED_LOCALES.includes(locale as Locale)
      ? (locale as Locale)
      : DEFAULT_LOCALE;
  let text: string = translations[lang][key] ?? translations[DEFAULT_LOCALE][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return text;
}

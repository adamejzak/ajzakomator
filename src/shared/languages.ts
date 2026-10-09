export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'pl', name: 'Polski' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'pt', name: 'Português' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

/** Suggest a supported system language; the first-run screen still requires a choice. */
export function detectLanguage(locales: readonly string[] = []): Language {
  for (const locale of locales) {
    const code = locale.toLowerCase().split(/[-_]/)[0];
    if (isLanguage(code)) return code;
  }
  return 'en';
}

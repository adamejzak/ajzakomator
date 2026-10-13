import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../src/shared/i18n';
import { LANGUAGES } from '../src/shared/languages';
import { messages } from '../src/shared/messages';
import { updateMessages } from '../src/shared/updateMessages';

/** The status bar texts of the update states, in every language: a clear action and no talk of restarting. */
const STATES: Array<[MessageKey, Record<string, string | number>]> = [
  ['Dostępna wersja {version} - Aktualizuj', { version: '0.6.6' }],
  ['Pobieranie {version}… {percent}%', { version: '0.6.6', percent: 40 }],
  ['Wersja {version} gotowa - Zainstaluj', { version: '0.6.6' }],
  ['Instalowanie {version}…', { version: '0.6.6' }],
  ['Błąd aktualizacji · ponów', {}],
  ['Aktualizacja potrwa chwilę, rozmowy wznowią się same', {}],
  ['Kliknij, aby otworzyć okno aktualizacji - zainstaluje się po pobraniu', {}],
];
const RESTART = /restart|neu start|reinici|redémarr|reinício|ponown|uruchom\s+ponownie|wymagany/i;

describe('update status texts', () => {
  it('exist in all six languages with the version filled in', () => {
    for (const [key, params] of STATES) {
      for (const { code } of LANGUAGES) {
        const text = translate(code, key, params);
        expect(text.trim().length, `${code}: ${key}`).toBeGreaterThan(0);
        if ('version' in params) expect(text, `${code}: ${key}`).toContain('0.6.6');
      }
    }
  });

  it('never talk about a restart', () => {
    for (const [key, params] of STATES) {
      for (const { code } of LANGUAGES) {
        const text = translate(code, key, params);
        if (key === 'Błąd aktualizacji · ponów') continue; // "retry", not a restart
        expect(text, `${code}: ${key}`).not.toMatch(RESTART);
      }
    }
    for (const key of Object.keys(updateMessages)) {
      expect(key.toLowerCase()).not.toContain('uruchom ponownie');
    }
    expect(Object.keys(messages).some((key) => /\{version\}.*uruchom ponownie/.test(key))).toBe(false);
  });

  it('name the action: Update when available, Install when ready', () => {
    expect(translate('en', 'Dostępna wersja {version} - Aktualizuj', { version: '1.0.0' })).toBe('Version 1.0.0 available - Update');
    expect(translate('en', 'Wersja {version} gotowa - Zainstaluj', { version: '1.0.0' })).toBe('Version 1.0.0 ready - Install');
    expect(translate('pl', 'Wersja {version} gotowa - Zainstaluj', { version: '1.0.0' })).toBe('Wersja 1.0.0 gotowa - Zainstaluj');
  });
});

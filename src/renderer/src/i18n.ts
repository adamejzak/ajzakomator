import { useMemo } from 'react';
import { detectLanguage } from '../../shared/languages';
import { translate, translateError, type MessageKey, type MessageParams } from '../../shared/i18n';
import { getS, useStore } from './store';

const systemLanguage = () => detectLanguage(navigator.languages);

/** For actions and event handlers, read the current preference at the moment of use. */
export const tr = (key: MessageKey, params?: MessageParams) =>
  translate(getS().settings.language ?? systemLanguage(), key, params);

export function useI18n() {
  const language = useStore((st) => st.s.settings.language) ?? systemLanguage();
  return useMemo(() => ({
    language,
    tr: (key: MessageKey, params?: MessageParams) => translate(language, key, params),
    errorText: (message: string) => translateError(language, message),
  }), [language]);
}

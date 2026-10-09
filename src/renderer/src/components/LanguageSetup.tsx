import { useEffect, useState } from 'react';
import { translate } from '../../../shared/i18n';
import { detectLanguage, isLanguage, LANGUAGES } from '../../../shared/languages';
import { updateSettings } from '../../../shared/state';
import { update } from '../store';
import { Logo } from './icons';

export function LanguageSetup() {
  const [language, setLanguage] = useState(() => detectLanguage(navigator.languages));
  const tr = (key: Parameters<typeof translate>[1]) => translate(language, key);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return (
    <div className="app">
      <div className="titlebar first-run-titlebar"><Logo size={18} /><span>ajzakomator</span></div>
      <main className="language-setup">
        <form className="language-card" onSubmit={(event) => {
          event.preventDefault();
          update((state) => updateSettings(state, { language }));
        }}>
          <Logo size={52} />
          <h1>{tr('Witaj w ajzakomatorze')}</h1>
          <p>{tr('Wybierz język aplikacji. Możesz go później zmienić w ustawieniach.')}</p>
          <div className="field">
            <label htmlFor="setup-language">{tr('Wybierz język')}</label>
            <select id="setup-language" className="select" autoFocus value={language} onChange={(event) => {
              if (isLanguage(event.target.value)) setLanguage(event.target.value);
            }}>
              {LANGUAGES.map((option) => <option key={option.code} value={option.code} lang={option.code}>{option.name}</option>)}
            </select>
          </div>
          <button className="btn white lg" type="submit">{tr('Kontynuuj')}</button>
        </form>
      </main>
    </div>
  );
}

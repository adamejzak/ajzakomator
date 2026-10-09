import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { openMenu, openMenuAt } from './ContextMenu';
import { Logo } from './icons';
import { requestUpdateCheck } from './UpdateBadge';
import './updater.css';

const THEMES = ['aurora', 'rainbow', 'ocean', 'sunset', 'violet'];

export function Brand({ collapsed }: { collapsed: boolean }) {
  const { tr } = useI18n();
  const [version, setVersion] = useState('');
  const [effect, setEffect] = useState({ theme: 'aurora', run: 0, active: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    void window.mc.getUpdate().then((u) => { if (mounted) setVersion(u.currentVersion); }).catch(() => {});
    return () => { mounted = false; clearTimeout(timer.current); };
  }, []);
  const animate = () => {
    clearTimeout(timer.current);
    setEffect((previous) => ({ theme: THEMES[(THEMES.indexOf(previous.theme) + 1) % THEMES.length], run: previous.run + 1, active: true }));
    timer.current = setTimeout(() => setEffect((previous) => ({ ...previous, active: false })), 2400);
  };
  const menuItems = () => [
    { header: `ajzakomator${version ? ` · v${version}` : ''}` },
    { label: tr('Sprawdź aktualizacje'), onClick: requestUpdateCheck },
  ];
  return (
    <div className={`brand interactive-brand ${collapsed ? 'collapsed' : ''} ${effect.active ? 'fx' : ''} t-${effect.theme}`}>
      <button className="brand-trigger no-drag" onClick={animate}
        aria-label={`ajzakomator${version ? ` v${version}` : ''}`}
        title={tr('Kliknij nazwę · prawy klik: aktualizacje')}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, menuItems()); }}
        onKeyDown={(e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openMenuAt(e.currentTarget, menuItems()); } }}>
        <span className="brand-mark"><Logo size={20} /></span>
        {!collapsed && <><span className="brand-name"><span className="bn-base">ajzakomator</span><span className="bn-fx" aria-hidden>ajzakomator</span></span>
          {version && <span className="brand-version" title={tr('Wersja {version}', { version })}>v{version}</span>}</>}
        {effect.active && <span key={effect.run} className="brand-burst" aria-hidden />}
      </button>
    </div>
  );
}

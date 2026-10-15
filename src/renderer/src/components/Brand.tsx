import { useEffect, useRef, useState } from 'react';
import { Logo } from './icons';
import './updater.css';

const THEMES = ['aurora', 'rainbow', 'ocean', 'sunset', 'violet'];

export function Brand({ collapsed }: { collapsed: boolean }) {
  const [effect, setEffect] = useState({ theme: 'aurora', run: 0, active: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const animate = () => {
    clearTimeout(timer.current);
    setEffect((previous) => ({ theme: THEMES[(THEMES.indexOf(previous.theme) + 1) % THEMES.length], run: previous.run + 1, active: true }));
    timer.current = setTimeout(() => setEffect((previous) => ({ ...previous, active: false })), 2400);
  };
  return (
    <div className={`brand interactive-brand ${collapsed ? 'collapsed' : ''} ${effect.active ? 'fx' : ''} t-${effect.theme}`}>
      <button className="brand-trigger no-drag" onClick={animate} aria-label="unimux">
        <span className="brand-mark"><Logo size={20} /></span>
        {!collapsed && <><span className="brand-name"><span className="bn-base">unimux</span><span className="bn-fx" aria-hidden>unimux</span></span>
          </>}
        {effect.active && <span key={effect.run} className="brand-burst" aria-hidden />}
      </button>
    </div>
  );
}

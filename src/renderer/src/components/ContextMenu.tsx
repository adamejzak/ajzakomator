import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; hint?: string }
  | { sep: true }
  | { header: string }
  | { colors: string[]; onPick: (color: string) => void };

const useMenu = create<{ menu: { x: number; y: number; items: MenuItem[] } | null }>(() => ({ menu: null }));

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  useMenu.setState({ menu: { x, y, items } });
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

const close = () => useMenu.setState({ menu: null });

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {menu.items.map((item, i) => {
        if ('sep' in item) return <div key={i} className="menu-sep" />;
        if ('header' in item) return <div key={i} className="menu-label">{item.header}</div>;
        if ('colors' in item)
          return (
            <div key={i} className="colors">
              {item.colors.map((c) => (
                <span key={c} style={{ background: c }} onClick={() => { close(); item.onPick(c); }} />
              ))}
            </div>
          );
        return (
          <div key={i} className={`menu-item ${item.danger ? 'danger' : ''}`} onClick={() => { close(); item.onClick(); }}>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.hint && <span className="kbd">{item.hint}</span>}
          </div>
        );
      })}
    </div>
  );
}

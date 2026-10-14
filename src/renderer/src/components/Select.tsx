import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { IChevron } from './icons';
import './select.css';

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & {
  onChange?: (event: { target: { value: string } }) => void;
};
type Option = { value: string; label: ReactNode; disabled?: boolean; title?: string; lang?: string };

/** Shared, keyboard-accessible listbox with the same controlled value API as a select. */
export function Select({ children, value, onChange, className = '', disabled, autoFocus, id, style, title, ...props }: Props) {
  const options: Option[] = [];
  const collect = (nodes: ReactNode) => Children.forEach(nodes, (node) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; title?: string; lang?: string }>(node)) return;
    if (node.type === 'option') options.push({ value: String(node.props.value ?? ''), label: node.props.children, disabled: node.props.disabled, title: node.props.title, lang: node.props.lang });
    else collect(node.props.children);
  });
  collect(children);
  const selected = options.findIndex((option) => option.value === String(value));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 200, maxHeight: 260 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const listId = useId();
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (index: number) => { if (!options[index] || options[index].disabled) return; onChange?.({ target: { value: options[index].value } }); close(); };
  const show = () => { if (!enabled.length) return; setActive(selected >= 0 && !options[selected].disabled ? selected : enabled[0]); setOpen(true); };
  useEffect(() => { if (autoFocus) trigger.current?.focus(); }, [autoFocus]);
  useLayoutEffect(() => {
    if (!open) return;
    const bounds = trigger.current!.getBoundingClientRect();
    const longest = Math.max(0, ...Array.from(popup.current?.querySelectorAll<HTMLElement>('.select-option-label') ?? []).map((label) => label.scrollWidth));
    const width = Math.min(Math.max(bounds.width, 200, longest + 60), window.innerWidth - 16);
    const height = Math.min(260, options.length * 30 + 12);
    const below = window.innerHeight - bounds.bottom - 12;
    const above = below < height && bounds.top > below;
    const maxHeight = Math.min(260, above ? bounds.top - 12 : below);
    setPosition({ left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)), top: above ? Math.max(8, bounds.top - Math.min(height, maxHeight) - 4) : bounds.bottom + 4, width, maxHeight });
    popup.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => { if (open) popup.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    const dismiss = () => setOpen(false);
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) dismiss(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  return <>
    <button ref={trigger} id={id} type="button" className={`${className} styled-select`} style={style} disabled={disabled} title={title ?? (typeof options[selected]?.label === 'string' ? String(options[selected].label) : undefined)}
      aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']} aria-describedby={props['aria-describedby']}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => open ? close() : show()}
      onKeyDown={(event) => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); show(); } }}>
      <span className="select-value">{options[selected]?.label ?? options[0]?.label}</span><IChevron />
    </button>
    {open && createPortal(<div ref={popup} id={listId} role="listbox" tabIndex={-1} className="select-popup" style={position}
      aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby'] ?? id} aria-activedescendant={`${listId}-${active}`}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'Tab') {
          event.preventDefault(); setOpen(false);
          const focusable = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'))
            .filter((element) => !popup.current?.contains(element) && element.getClientRects().length > 0);
          const index = focusable.indexOf(trigger.current!);
          (focusable[index + (event.shiftKey ? -1 : 1)] ?? trigger.current)?.focus();
        }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const index = enabled.indexOf(active);
          setActive(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1] : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now(); const text = (now - search.current.time > 700 ? '' : search.current.text) + event.key.toLowerCase();
          search.current = { text, time: now };
          const index = options.findIndex((option) => !option.disabled && String(option.label).toLowerCase().startsWith(text));
          if (index >= 0) setActive(index);
        }
      }}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option" data-index={index} aria-selected={index === selected} aria-disabled={option.disabled || undefined}
        className={`select-option ${index === active ? 'focused' : ''}`} title={option.title} lang={option.lang}
      onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}>
        <span className="select-option-label">{option.label}</span><span className="select-check" aria-hidden="true">{index === selected ? '✓' : ''}</span>
      </div>)}
    </div>, document.body)}
  </>;
}

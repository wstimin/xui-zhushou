import { Children, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export function AdminTabs<T extends string>({ label, value, items, onChange, children }: { label: string; value: T; items: Array<{ value: T; label: string }>; onChange: (value: T) => void; children: ReactNode }) {
  const id = useId();
  return <div className="admin-workspace"><div className="admin-tabs" role="tablist" aria-label={label} onKeyDown={event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const index = items.findIndex(item => item.value === value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    onChange(items[next].value); (event.currentTarget.children[next] as HTMLButtonElement).focus();
  }}>{items.map(item => <button type="button" role="tab" id={`${id}-${item.value}`} aria-controls={`${id}-panel`} aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} key={item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div><div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`}>{children}</div></div>;
}

/** Portalled to escape table overflow. The actual business buttons remain intact. */
export function MoreActions({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 400 });
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect(), height = menu.current.getBoundingClientRect().height;
    const below = window.innerHeight - rect.bottom - 16, above = rect.top - 16, upward = below < height && above > below;
    const maxHeight = Math.max(80, upward ? above : below);
    setPosition({ left: Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)), top: upward ? Math.max(8, rect.top - Math.min(height, maxHeight) - 6) : rect.bottom + 6, maxHeight });
    menu.current.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const other = (event: Event) => { if (event.target !== trigger.current) close(); };
    const scroll = (event: Event) => { if (!(event.target instanceof window.Node) || !menu.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('panelark-more-open', other); window.addEventListener('resize', scroll); window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('panelark-more-open', other); window.removeEventListener('resize', scroll); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  return <><button ref={trigger} type="button" className="admin-ghost admin-more-trigger" aria-label={`${label}：更多操作`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onKeyDown={event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); trigger.current?.dispatchEvent(new window.Event('panelark-more-open', { bubbles: true })); setOpen(true); }
  }} onClick={() => { if (!open) trigger.current?.dispatchEvent(new window.Event('panelark-more-open', { bubbles: true })); setOpen(current => !current); }}>更多<ChevronDown size={14} aria-hidden="true" /></button>{open && createPortal(<div ref={menu} id={id} role="menu" aria-label={`${label}的更多操作`} className="admin-action-menu" style={position} onKeyDown={event => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')], index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
  }} onClick={event => { if ((event.target as HTMLElement).closest('button:not([disabled]),a[href]')) close(); }}>{Children.toArray(children).filter(isValidElement).map((child, index) => cloneElement(child as ReactElement<{ role?: string; tabIndex?: number }>, { role: 'menuitem', tabIndex: -1, key: index }))}</div>, document.body)}</>;
}

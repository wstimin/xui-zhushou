import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ShieldCheck, X } from 'lucide-react';

type Options = { title?: string; message: string; initialValue?: string; secret?: boolean; minLength?: number; pattern?: string; tone?: 'success' | 'error' };
type Request = Options & { id: number; kind: 'alert' | 'confirm' | 'prompt'; resolve: (value: string | boolean | null) => void };
type DialogApi = { alert: (options: Options) => Promise<void>; confirm: (options: Options) => Promise<boolean>; prompt: (options: Options) => Promise<string | null> };
const Context = createContext<DialogApi | null>(null);

export function CenteredModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const background = [...document.body.children].filter(node => node !== ref.current?.parentElement) as HTMLElement[];
    const inertBefore = background.map(node => node.inert);
    background.forEach(node => { node.inert = true; });
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('input:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],select:not([disabled]),[tabindex="0"]') || [])];
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0] || ref.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[aria-modal="true"]')].at(-1) !== ref.current) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const nodes = focusable(), first = nodes[0], last = nodes.at(-1);
        if (!first) { event.preventDefault(); ref.current?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow; background.forEach((node, index) => { node.inert = inertBefore[index]; }); if (previous?.isConnected) previous.focus(); };
  }, []);
  const modal = <div className="admin-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{title}</h2><button type="button" className="admin-dialog-close" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></button></header>
      {children}
    </div>
  </div>;
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

function DialogContent({ request, settle }: { request: Request; settle: (value: string | boolean | null) => void }) {
  const [value, setValue] = useState(request.initialValue || '');
  const [error, setError] = useState('');
  return <CenteredModal title={request.title || (request.kind === 'prompt' ? '填写信息' : request.kind === 'confirm' ? '确认操作' : request.tone === 'error' ? '操作未完成' : '操作提示')} onClose={() => settle(null)}>
    <form noValidate onSubmit={event => {
      event.preventDefault();
      if (request.kind === 'prompt') {
        if (value.length < (request.minLength || 0)) return setError(`至少输入 ${request.minLength} 位`);
        if (request.pattern && !new RegExp(request.pattern).test(value)) return setError('请输入正确的格式');
      }
      settle(request.kind === 'prompt' ? value : true);
    }}>
      <div className={`admin-dialog-message ${request.tone || ''}`}>{request.kind === 'alert' && (request.tone === 'error' ? <X size={22} /> : <Check size={22} />)}{request.kind === 'confirm' && <ShieldCheck size={22} />}<p>{request.message}</p></div>
      {request.kind === 'prompt' && <label className="admin-field"><span>{request.secret ? '加密密码' : '输入内容'}</span><input data-autofocus type={request.secret ? 'password' : 'text'} autoComplete="off" value={value} onChange={event => { setValue(event.target.value); setError(''); }} aria-invalid={Boolean(error)} aria-describedby={error ? 'admin-dialog-error' : undefined} />{error && <small id="admin-dialog-error" role="alert">{error}</small>}</label>}
      <div className="admin-dialog-actions">{request.kind !== 'alert' && <button type="button" className="admin-ghost" onClick={() => settle(null)}>取消</button>}<button type="submit" className="admin-primary" data-autofocus={request.kind === 'alert' ? true : undefined}>{request.kind === 'alert' ? '知道了' : '确认'}</button></div>
    </form>
  </CenteredModal>;
}

export function AdminDialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);
  const pending = useRef(new Set<Request>());
  const nextId = useRef(0);
  const enqueue = useCallback((kind: Request['kind'], options: Options) => new Promise<string | boolean | null>(resolve => {
    if (kind === 'alert' && [...pending.current].some(item => item.kind === 'alert' && item.message === options.message)) { resolve(null); return; }
    const request = { ...options, kind, resolve, id: ++nextId.current };
    pending.current.add(request); setQueue(current => [...current, request]);
  }), []);
  const api = useMemo<DialogApi>(() => ({ alert: async options => { await enqueue('alert', options); }, confirm: async options => (await enqueue('confirm', options)) === true, prompt: async options => await enqueue('prompt', options) as string | null }), [enqueue]);
  useEffect(() => () => { pending.current.forEach(request => request.resolve(null)); pending.current.clear(); }, []);
  const request = queue[0];
  return <Context.Provider value={api}><div onSubmitCapture={event => {
    const form = event.target as HTMLFormElement;
    if (form.tagName !== 'FORM' || form.checkValidity()) return;
    event.preventDefault(); event.stopPropagation();
    const invalid = form.querySelector<HTMLInputElement>('input:invalid,select:invalid,textarea:invalid');
    void api.alert({ title: '请检查填写信息', message: invalid?.validationMessage || '请填写完整且有效的信息', tone: 'error' }).then(() => invalid?.focus());
  }}>{children}</div>{request && <DialogContent key={request.id} request={request} settle={value => { pending.current.delete(request); request.resolve(value); setQueue(current => current.filter(item => item !== request)); }} />}</Context.Provider>;
}

export function useAdminDialog() { const value = useContext(Context); if (!value) throw new Error('AdminDialogProvider is required'); return value; }

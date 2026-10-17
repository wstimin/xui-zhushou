import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, LoaderCircle, Server, X } from 'lucide-react';
import { acknowledgeDeployment, connectServer, createDeploymentJob, disconnectServer, getCurrentDeployment, inspectRemoteServer, lockCdk, releaseCdk, type CdkGrant, type CurrentDeployment } from './api';
import type { ActiveServer, CatalogItem, ServerDraft } from './types';
import { deploymentGuidance } from './deployment-guidance';

async function copyText(value: string) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } } catch { /* HTTP fallback */ }
  const field = document.createElement('textarea'); field.value = value; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select();
  try { if (!document.execCommand?.('copy')) throw new Error('请选中结果文字手动复制，或下载结果文件'); } finally { field.remove(); }
}

export function AutomaticServerModal({ onClose, onConnected, draft, onDraftChange, grantToken, cdkGrant }: { onClose: () => void; onConnected: (server: ActiveServer) => void; draft: ServerDraft; onDraftChange: (draft: ServerDraft) => void; grantToken: string; cdkGrant?: CdkGrant | null }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const update = (changes: Partial<ServerDraft>) => { onDraftChange({ ...draft, ...changes }); setError(''); };
  const submit = async () => {
    if (busy) return;
    if (!draft.host.trim() || !/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535 || !draft.username.trim() || (draft.authType === 'password' ? !draft.password : !draft.privateKey.trim())) { setError('请完整填写有效的服务器地址、SSH 端口、用户名和登录凭据'); return; }
    setBusy(true); setError(''); let sessionId = '';
    try {
      const connected = await connectServer(grantToken, { ipOrDomain: draft.host, sshPort: Number(draft.port), sshUser: draft.username, authType: draft.authType === 'key' ? 'privateKey' : 'password', sshPassword: draft.authType === 'password' ? draft.password : undefined, sshPrivateKey: draft.authType === 'key' ? draft.privateKey : undefined });
      sessionId = connected.serverSessionId;
      // The user authorizes this host by submitting their SSH details; no second wizard step.
      const { details } = await inspectRemoteServer(grantToken, sessionId, connected.fingerprint);
      if (!details.compatibility.compatible) throw new Error(details.compatibility.reasons.join('；'));
      onConnected({ sessionId, environment: details });
    } catch (error) {
      if (sessionId) await disconnectServer(grantToken, sessionId).catch(() => undefined);
      setError(error instanceof Error ? error.message : '连接失败'); setBusy(false);
    }
  };
  return <div className="modal-backdrop" role="presentation"><section className="modal server-modal" role="dialog" aria-modal="true" aria-labelledby="server-auto-title">
    <div className="modal-head"><div><span className="eyebrow plain">Server connection</span><h2 id="server-auto-title">填写服务器信息</h2></div>{!busy && <button className="icon-button" onClick={onClose} aria-label="关闭服务器信息"><X size={19} /></button>}</div>
    <div className="modal-body"><p className="session-memory-note">连接后选择安装项目。系统自动检测、补齐依赖并安装，无需在安装过程中反复确认；不会覆盖已有项目或停止其他服务。</p>
      {cdkGrant && <p className="cdk-usage" role="status">{cdkGrant.packageName} · 总次数 {cdkGrant.totalUses ?? '—'} · 已用 {cdkGrant.usedCount ?? '—'} · 剩余 {cdkGrant.remaining} 次{Boolean(cdkGrant.lockedCount) && `（使用中 ${cdkGrant.lockedCount} 次使用中）`}</p>}
      <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset className="automatic-fields" disabled={busy}>
        <div className="form-grid"><label className="field field-span-two"><span>服务器 IP 或域名</span><input value={draft.host} onChange={event => update({ host: event.target.value })} autoComplete="off" /></label><label className="field"><span>SSH 端口</span><input value={draft.port} onChange={event => update({ port: event.target.value })} inputMode="numeric" /></label><label className="field"><span>SSH 用户名</span><input value={draft.username} onChange={event => update({ username: event.target.value })} autoComplete="off" /></label></div>
        <div className="segmented"><button type="button" className={draft.authType === 'password' ? 'active' : ''} onClick={() => update({ authType: 'password' })}>密码登录</button><button type="button" className={draft.authType === 'key' ? 'active' : ''} onClick={() => update({ authType: 'key' })}>私钥登录</button></div>
        {draft.authType === 'password' ? <label className="field"><span>SSH 密码</span><input type="password" value={draft.password} onChange={event => update({ password: event.target.value })} autoComplete="new-password" /></label> : <label className="field"><span>SSH 私钥</span><textarea value={draft.privateKey} onChange={event => update({ privateKey: event.target.value })} rows={5} /></label>}
      </fieldset>{error && <div className="form-error-banner" role="alert"><strong>{error}</strong><ul>{deploymentGuidance(error).map(item => <li key={item}>{item}</li>)}</ul></div>}
      <div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>取消</button><button className="button button-primary" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={16} />正在自动连接与检测…</> : '连接并选择面板'}</button></div></form>
    </div></section></div>;
}

const labels: Record<string, string> = { host: '目标服务器', accessUrl: '登录地址', username: '管理员用户名', password: '管理员密码', managementKey: '管理密钥', apiKey: 'API Key', apiToken: 'API Token', port: '端口', panelPort: '面板端口', subscriptionPort: '订阅端口', path: '后台路径', webBasePath: '后台路径', panelPath: '后台路径', installInfo: '完整登录信息', nextStep: '使用说明', networkNotice: '网络说明' };
export function AutomaticDeploymentModal({ item, grantToken = '', server, onConsumed = () => {}, onClose, onToast }: { item?: CatalogItem; grantToken?: string; server?: ActiveServer; onConsumed?: () => void; onClose: () => void; onToast: (message: string) => void }) {
  const [current, setCurrent] = useState<CurrentDeployment | null>(null), [error, setError] = useState(''), [closing, setClosing] = useState(false);
  const [taskKey] = useState(() => globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const initialization = useRef<Promise<void> | null>(null), settled = useRef(false);
  const receipt = useRef(''); // Page memory only; never persist this token.
  const job = current?.job, result = current?.result;
  const terminal = Boolean(job && !['queued', 'running', 'cancelling'].includes(job.status));
  const succeeded = job?.status === 'succeeded';
  const failure = error || (terminal && !succeeded ? job?.errorMessage || '部署未成功' : '');
  const resultEntries = Object.entries(result || {}).filter(([key, value]) => labels[key] && value !== undefined && value !== null && value !== '[redacted]');
  const title = item?.name || String(job?.payload.adapterId || '面板');
  const text = [`${title} 部署结果`, `任务编号：${job?.id || '未创建'}`, ...resultEntries.map(([key, value]) => `${labels[key]}：${typeof value === 'object' ? JSON.stringify(value) : value}`), ...(failure ? [`失败原因：${failure}`, ...deploymentGuidance(failure)] : [])].join('\n');
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    if (!initialization.current) initialization.current = (async () => {
      if (!item || !server) throw new Error('刷新或离开页面后无法重新查看安装结果，请先保存结果');
      await lockCdk(grantToken, taskKey);
      try {
        const created = await createDeploymentJob(grantToken, taskKey, { adapterId: item.adapterId || item.id, operation: 'install', serverKey: `${server.environment.targetHost}:${server.environment.sshPort}`, idempotencyKey: `${taskKey}:${item.id}`, payload: { autoDeploy: true, serverSessionId: server.sessionId, panelId: item.id } });
        if (!created.receipt) throw new Error('交付凭证未返回，请保留页面并联系管理员核对任务');
        receipt.current = created.receipt;
      } catch (error) { await releaseCdk(grantToken, taskKey).catch(() => undefined); await disconnectServer(grantToken, server.sessionId).catch(() => undefined); throw error; }
    })();
    const poll = async () => {
      try {
        const next = await getCurrentDeployment(receipt.current);
        if (!active) return;
        if (!next.job) throw new Error('本次页面交付信息已失效，刷新后不可重新查看，请联系管理员');
        setCurrent(next); setError('');
        if (!['queued', 'running', 'cancelling'].includes(next.job.status)) { if (!settled.current) { settled.current = true; onConsumed(); } timer = setTimeout(() => void poll(), 30000); return; }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : '任务状态读取失败'); }
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    void initialization.current.then(() => { if (active) void poll(); }).catch(error => { if (active) { setError(error instanceof Error ? error.message : '创建部署任务失败'); if (!settled.current) { settled.current = true; onConsumed(); } } });
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, []);
  const copy = async (value: string) => { try { await copyText(value); onToast('已复制'); } catch (error) { onToast(error instanceof Error ? error.message : '复制失败'); } };
  const download = () => { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `panelark-${job?.id || 'result'}.txt`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const close = async () => {
    setClosing(true);
    try { if (job) await acknowledgeDeployment(job.id, receipt.current); receipt.current = ''; onClose(); }
    catch (error) { onToast(error instanceof Error ? error.message : '结果未关闭，请重试'); setClosing(false); }
  };
  return <div className="modal-backdrop" role="presentation"><section className="modal deploy-modal automatic-deploy-modal" role="dialog" aria-modal="true" aria-labelledby="automatic-deploy-title">
    <div className="modal-head"><div><span className="eyebrow plain">Automatic deployment</span><h2 id="automatic-deploy-title">{title} · {succeeded ? '安装完成' : failure ? '部署异常' : '正在自动安装'}</h2></div></div>
    <div className="modal-body">{!terminal && !settled.current && <><div className="running-top"><span><LoaderCircle size={18} className="spin" />系统正在自动处理，请等待</span><strong>{job?.progress || 0}%</strong></div><div className="progress-track large"><div style={{ width: `${job?.progress || 0}%` }} /></div><p className="running-note">自动检查系统、安装依赖、处理端口与本机防火墙，然后安装并验证。无需再次确认；请勿刷新或离开页面，否则无法领取本次结果。</p>{job?.steps.map(step => <div className="automatic-step" key={step.key}>{step.status === 'succeeded' ? <Check size={16} /> : step.status === 'running' ? <LoaderCircle className="spin" size={16} /> : <span className="check-dot" />}<span>{step.title}</span></div>)}</>}
      {current?.usage && <p className="cdk-usage" role="status">CDK 总次数 {current.usage.totalUses} · 已用 {current.usage.usedCount} · 剩余 {current.usage.remaining} 次{Boolean(current.usage.lockedCount) && `（使用中 ${current.usage.lockedCount} 次使用中）`}</p>}
      {succeeded && <div className="success-seal"><Check size={27} /></div>}
      {failure && <div className="form-error-banner" role="alert"><strong><AlertTriangle size={17} />{failure}</strong><h3>处理建议</h3><ul>{deploymentGuidance(failure).map(item => <li key={item}>{item}</li>)}</ul>{job && <small>任务编号：{job.id}</small>}</div>}
      {terminal && resultEntries.length > 0 && <><p className="delivery-retention-note">请立即复制或下载保存登录信息。本结果不会自动关闭，只能由你点击关闭；刷新或离开页面后不可重新查看。</p><div className="result-card">{resultEntries.map(([key, value]) => <div className="result-row result-row-wrap" key={key}><span>{labels[key]}</span><strong>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</strong><button aria-label={`复制${labels[key]}`} onClick={() => void copy(String(value))}><Copy size={15} /></button></div>)}</div></>}
      {(terminal || settled.current) && <div className="modal-actions"><button className="button button-secondary" onClick={() => void copy(text)}><Copy size={16} />复制全部结果</button><button className="button button-secondary" onClick={download}><Download size={16} />下载结果</button><button className="button button-primary" disabled={closing} onClick={() => void close()}>{closing ? '正在关闭…' : result ? '我已保存，关闭结果' : '关闭结果'}</button></div>}
    </div></section></div>;
}

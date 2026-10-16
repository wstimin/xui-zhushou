import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CheckCircle2, Database, Layers3, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import './setup.css';

interface SetupState {
  required: boolean;
  ready: boolean;
  database?: string;
  deploymentMode?: string;
  tokenHint?: string;
  checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
}

export default function SetupApp() {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminPath, setAdminPath] = useState('');
  const [form, setForm] = useState({ siteName: 'PanelArk 面板方舟', siteUrl: window.location.origin, adminPath: '/admin', setupToken: '', username: '', password: '', confirmation: '' });
  const load = useCallback(async () => {
    setError('');
    try {
      const response = await fetch('/api/setup/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('安装服务暂不可用，请检查面板运行日志和反向代理配置。');
      setState(await response.json());
    } catch (reason) { setError(reason instanceof Error ? reason.message : '环境检测失败'); }
  }, []);
  useEffect(() => { document.title = '安装向导 · PanelArk'; void load(); }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (form.password !== form.confirmation) { setError('两次输入的管理员密码不一致'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/admin/bootstrap', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupToken: form.setupToken, username: form.username, password: form.password, installation: { siteName: form.siteName, siteUrl: form.siteUrl, adminPath: form.adminPath } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '初始化未完成');
      setAdminPath(result.adminPath);
      setForm(current => ({ ...current, setupToken: '', password: '', confirmation: '' }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '安装失败，请重试'); }
    finally { setBusy(false); }
  };
  return <main className="setup-shell">
    <div className="setup-brand"><span className="brand-mark"><Layers3 size={22} /></span><strong>PanelArk <span>面板方舟</span></strong></div>
    <section className="setup-card glass-card" aria-labelledby="setup-title">
      <span className="eyebrow plain">Web installation</span>
      <h1 id="setup-title">{adminPath ? '安装完成，可以开始使用了' : state && !state.required ? '此站点已经安装完成' : '欢迎，完成你的站点安装'}</h1>
      <p className="setup-intro">适用于宝塔、1Panel 和容器部署。确认环境、设置站点与管理员，所有信息保存在当前服务的数据目录。</p>
      {adminPath ? <div className="setup-complete"><CheckCircle2 size={48} /><p>数据库已连接，站点配置和管理员已保存，安装入口已锁定。你已自动登录后台。</p><div className="setup-actions"><a className="button button-primary" href={adminPath}>进入管理后台 <ArrowRight size={16} /></a><a className="button button-secondary" href="/">打开用户首页</a></div></div>
        : state && !state.required ? <div className="setup-complete"><ShieldCheck size={40} /><p>安装入口已锁定，不能重复创建管理员或覆盖现有数据。请使用你保存的后台地址登录。</p><a className="button button-primary" href="/">打开用户首页 <ArrowRight size={16} /></a></div>
        : <>
          <div className="setup-heading"><h2>01 · 检查运行环境</h2><button className="text-link" type="button" onClick={() => void load()} disabled={busy}><RefreshCw size={14} />重新检测</button></div>
          <div className="setup-checks" aria-live="polite">{state ? state.checks.map(item => <div className={item.passed ? 'passed' : 'failed'} key={item.id}>{item.passed ? <Check size={17} /> : <X size={17} />}<span><strong>{item.label}</strong><small>{item.detail}</small></span></div>) : <div><LoaderCircle size={17} /><span>正在连接安装服务并检测环境…</span></div>}</div>
          <div className="setup-storage"><Database size={18} /><span>使用内置 SQLite，系统已自动连接数据库。无需填写 MySQL 地址、数据库账号或密码。升级前请备份整个数据目录。</span></div>
          <form onSubmit={event => void submit(event)}>
            <h2>02 · 设置站点信息</h2>
            <div className="form-grid"><label className="field"><span>站点名称</span><input required maxLength={80} value={form.siteName} onChange={event => setForm({ ...form, siteName: event.target.value })} /></label><label className="field"><span>站点域名 / 完整地址</span><input required type="url" value={form.siteUrl} placeholder="https://panel.example.com" onChange={event => setForm({ ...form, siteUrl: event.target.value })} /></label><label className="field field-span-two"><span>管理后台路径</span><input required value={form.adminPath} placeholder="/private-console" onChange={event => setForm({ ...form, adminPath: event.target.value })} /></label></div>
            <p className="setup-help">域名解析、绑定与 HTTPS 证书请在宝塔 / 1Panel 中完成；这里保存站点地址，不会修改你的 DNS 或面板网站。</p>
            <h2>03 · 验证所有权并创建管理员</h2>
            <div className="form-grid"><label className="field field-span-two"><span>安装令牌</span><input required type="password" autoComplete="off" value={form.setupToken} onChange={event => setForm({ ...form, setupToken: event.target.value })} placeholder="PAK-SETUP-…" /></label><label className="field field-span-two"><span>管理员用户名</span><input required minLength={3} maxLength={40} autoComplete="username" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} /></label><label className="field"><span>管理员密码</span><input required type="password" minLength={6} maxLength={128} autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></label><label className="field"><span>确认密码</span><input required type="password" minLength={6} maxLength={128} autoComplete="new-password" value={form.confirmation} onChange={event => setForm({ ...form, confirmation: event.target.value })} /></label></div>
            <p className="setup-help">{state?.tokenHint} 密码至少 6 位，建议使用更长的随机密码。部署向导不需要服务器 root 密码；目标 VPS 的 SSH 信息在安装完成后填写。</p>
            {window.location.protocol !== 'https:' && <p className="server-warning">当前连接为 HTTP。公网填写令牌或密码前，请先在面板启用 HTTPS。</p>}
            {error && <div role="alert" className="form-error-banner">{error}</div>}
            <button className="button button-primary button-block setup-submit" type="submit" disabled={busy || !state?.ready}>{busy ? <><LoaderCircle size={16} />正在连接并保存…</> : <>完成安装并连接站点 <ArrowRight size={16} /></>}</button>
          </form>
        </>}
      {!state && error && <div role="alert" className="form-error-banner">{error}<button className="text-link" type="button" onClick={() => void load()}>重试连接</button></div>}
    </section>
    <p className="setup-footer">PanelArk · 安装成功后自动锁定安装入口</p>
  </main>;
}

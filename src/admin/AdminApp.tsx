import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, Check, Clipboard, Cog, FileClock, Gauge, KeyRound, Layers3,
  LoaderCircle, LogOut, Menu, PackagePlus, RefreshCw, ShieldCheck, TicketCheck, UserCog,
  Users, X,
} from 'lucide-react';
import {
  adminApi, AdminApiError, type AdminIdentity, type AdminRecord, type AdminRole, type AdminSettings,
  type AuditRecord, type BackupRecord, type CatalogAdminRecord, type CdkRecord, type DashboardStats,
  type JobReviewRecord, type PackageRecord, type ResourceRecord, type SessionRecord,
  type UpdateState,
  type SecurityReport,
} from './api';
import { AdminDialogProvider, CenteredModal, useAdminDialog } from './dialog';
import { usePagedList } from './pagination';
import { allPackageOptions } from './api';
import { ThemeToggle, useTheme } from '../panelark/theme';
import type { Theme } from '../panelark/types';
import { PanelArkMark } from '../components/PanelArkMark';
import { CdkCodesDialog, CdkManagementTable } from './CdkManagement';
import { updateReloadParameter, useUpdatePageReload } from './update-refresh';
import { AdminTabs } from './layout';
import { AdminManagement, AuditManagement, BackupManagement, CatalogManagement, JobManagement, PackageManagement, ResourceManagement } from './Management';

type AdminView = 'overview' | 'jobs' | 'cdk' | 'catalog' | 'resources' | 'settings' | 'admins' | 'backups' | 'update' | 'audit' | 'account';
type Notice = { kind: 'success' | 'error'; text: string } | null;

const emptySettings: AdminSettings = { purchaseEnabled: true, purchaseButtonText: '购买 CDK', purchaseUrl: '', supportUrl: '', siteNotice: '', adminPath: '/admin' };
const roleNames: Record<AdminRole, string> = { super_admin: '超级管理员', operator: '运营管理员', support: '售后人员' };

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatDate(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '永久有效'; }

export default function AdminApp() { return <AdminDialogProvider><AdminAppContent /></AdminDialogProvider>; }

function AdminAppContent() {
  const dialog = useAdminDialog();
  const setNotice = useCallback((notice: Notice) => { if (notice) void dialog.alert({ message: notice.text, tone: notice.kind }); }, [dialog]);
  const notice: Notice = null;
  const [theme, toggleTheme] = useTheme();
  const [state, setState] = useState<'loading' | 'bootstrap' | 'login' | 'ready'>('loading');
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [view, setView] = useState<AdminView>(() => new URLSearchParams(window.location.search).has(updateReloadParameter) ? 'update' : 'overview');
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const invalidated = (event: Event) => {
      setAdmin(null); setState('login'); setView('overview');
      const adminPath = (event as CustomEvent<{ adminPath?: string }>).detail?.adminPath;
      const currentPath = window.location.pathname.replace(/\/+$/g, '') || '/';
      if (adminPath && currentPath !== adminPath && !currentPath.startsWith(`${adminPath}/`)) window.location.assign(adminPath);
    };
    window.addEventListener('panelark-session-invalidated', invalidated);
    return () => window.removeEventListener('panelark-session-invalidated', invalidated);
  }, []);

  useEffect(() => {
    adminApi.bootstrapState().then(async ({ required }) => {
      if (required) return setState('bootstrap');
      try {
        const session = await adminApi.session();
        setAdmin(session.admin); setState('ready');
      } catch { setState('login'); }
    }).catch(error => { setNotice({ kind: 'error', text: message(error) }); setState('login'); });
  }, []);

  const authenticated = (identity: AdminIdentity) => { setAdmin(identity); setState('ready'); setView('overview'); };
  if (state === 'loading') return <AdminLoading />;
  if (state === 'bootstrap') return <AdminAccess mode="bootstrap" theme={theme} onToggleTheme={toggleTheme} onAuthenticated={authenticated} notice={notice} setNotice={setNotice} />;
  if (state === 'login') return <AdminAccess mode="login" theme={theme} onToggleTheme={toggleTheme} onAuthenticated={authenticated} notice={notice} setNotice={setNotice} />;
  if (!admin) return null;

  const logout = async () => {
    try { await adminApi.logout(); } finally { setAdmin(null); setState('login'); }
  };
  const navigate = (next: AdminView) => { setView(next); setMenuOpen(false); };

  return <div className="admin-shell">
    <aside className={`admin-sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="admin-brand"><span className="brand-mark"><PanelArkMark size={29} /></span><div><strong>PanelArk</strong><small>CONTROL CENTER</small></div><button onClick={() => setMenuOpen(false)} aria-label="关闭菜单"><X size={18} /></button></div>
      <nav className="admin-nav">
        <AdminNav active={view === 'overview'} icon={Gauge} label="业务概览" onClick={() => navigate('overview')} />
        <AdminNav active={view === 'jobs'} icon={Activity} label="任务售后" onClick={() => navigate('jobs')} />
        <AdminNav active={view === 'cdk'} icon={TicketCheck} label="CDK 管理" onClick={() => navigate('cdk')} />
        {admin.role !== 'support' && <AdminNav active={view === 'catalog'} icon={Layers3} label="目录运营" onClick={() => navigate('catalog')} />}
        {admin.role !== 'support' && <AdminNav active={view === 'resources'} icon={PackagePlus} label="资源推荐" onClick={() => navigate('resources')} />}
        <AdminNav active={view === 'settings'} icon={Cog} label="站点配置" onClick={() => navigate('settings')} />
        {admin.role === 'super_admin' && <AdminNav active={view === 'admins'} icon={Users} label="管理员" onClick={() => navigate('admins')} />}
        {admin.role === 'super_admin' && <AdminNav active={view === 'backups'} icon={ShieldCheck} label="备份迁移" onClick={() => navigate('backups')} />}
        {admin.role === 'super_admin' && <AdminNav active={view === 'update'} icon={RefreshCw} label="系统更新" onClick={() => navigate('update')} />}
        <AdminNav active={view === 'audit'} icon={FileClock} label="审计日志" onClick={() => navigate('audit')} />
        <AdminNav active={view === 'account'} icon={UserCog} label="我的账号" onClick={() => navigate('account')} />
      </nav>
      <div className="admin-sidebar-foot">
        <a href="/"><ArrowLeft size={15} /> 返回用户端</a>
        <button onClick={logout}><LogOut size={15} /> 退出登录</button>
      </div>
    </aside>
    {menuOpen && <button className="admin-menu-mask" onClick={() => setMenuOpen(false)} aria-label="关闭导航" />}
    <main className="admin-main">
      <header className="admin-topbar">
        <button className="admin-menu-button" onClick={() => setMenuOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
        <div className="admin-session"><span>安全管理会话</span><strong>{admin.username}</strong><em>{roleNames[admin.role]}</em></div>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>
      <div className="admin-content">
        {view === 'overview' && <OverviewPage notify={setNotice} />}
        {view === 'jobs' && <JobsPage admin={admin} notify={setNotice} />}
        {view === 'cdk' && <CdkPage admin={admin} notify={setNotice} />}
        {view === 'catalog' && admin.role !== 'support' && <CatalogAdminPage notify={setNotice} />}
        {view === 'resources' && admin.role !== 'support' && <ResourcesPage notify={setNotice} />}
        {view === 'settings' && <SettingsPage admin={admin} notify={setNotice} />}
        {view === 'admins' && admin.role === 'super_admin' && <AdminsPage current={admin} onChanged={setAdmin} notify={setNotice} />}
        {view === 'backups' && admin.role === 'super_admin' && <BackupsPage notify={setNotice} />}
        {view === 'update' && admin.role === 'super_admin' && <UpdatePage notify={setNotice} />}
        {view === 'audit' && <AuditPage admin={admin} notify={setNotice} />}
        {view === 'account' && <AccountPage admin={admin} onChanged={setAdmin} notify={setNotice} />}
      </div>
    </main>
  </div>;
}

function AdminLoading() {
  return <div className="admin-loading"><div className="brand-mark"><PanelArkMark size={30} /></div><LoaderCircle className="spin" size={22} /><span>正在建立安全管理会话…</span></div>;
}

export function AdminAccess({ mode, theme, onToggleTheme, onAuthenticated, notice, setNotice }: { mode: 'bootstrap' | 'login'; theme: Theme; onToggleTheme: () => void; onAuthenticated: (admin: AdminIdentity) => void; notice: Notice; setNotice: (notice: Notice) => void }) {
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = mode === 'bootstrap' ? await adminApi.bootstrap(setupToken, username, password) : await adminApi.login(username, password, requiresTotp ? totpCode : undefined);
      onAuthenticated(result.admin);
    } catch (error) {
      if (error instanceof AdminApiError && ['TOTP_REQUIRED', 'TOTP_INVALID'].includes(error.code || '')) setRequiresTotp(true);
      if (error instanceof AdminApiError && error.code === 'TOTP_REQUIRED') { setNotice(null); return; }
      setNotice({ kind: 'error', text: message(error) });
    } finally { setBusy(false); }
  };
  return <div className="admin-access">
    <div className="admin-access-theme"><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
    <div className="admin-access-glow" />
    <form noValidate className="admin-access-card" onSubmit={submit}>
      <div className="admin-access-brand"><span className="brand-mark"><PanelArkMark size={30} /></span><strong>PanelArk</strong></div>
      <span className="admin-kicker">{mode === 'bootstrap' ? 'FIRST RUN SECURITY' : 'CONTROL CENTER'}</span>
      <h1>{mode === 'bootstrap' ? '初始化管理后台' : '欢迎回来'}</h1>
      <p>{mode === 'bootstrap' ? '首次启动需要初始化令牌。此入口仅供宝塔 / 1Panel 部署初始化；一键脚本请在 SSH 终端运行 pa init。' : '登录后管理 CDK、购买入口与站点。未启用双重验证的账号，只需用户名和密码。'}</p>
      {mode === 'bootstrap' && <label className="admin-field"><span>初始化令牌</span><input type="password" value={setupToken} onChange={event => setSetupToken(event.target.value)} required autoComplete="off" placeholder="PAK-SETUP-…" /></label>}
      <label className="admin-field"><span>管理员用户名</span><input value={username} onChange={event => { setUsername(event.target.value); setRequiresTotp(false); setTotpCode(''); }} required autoComplete="username" placeholder="panelark_admin" /></label>
      <label className="admin-field"><span>{mode === 'bootstrap' ? '设置密码' : '登录密码'}</span><input type="password" value={password} onChange={event => { setPassword(event.target.value); setRequiresTotp(false); setTotpCode(''); }} required autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'} placeholder={mode === 'bootstrap' ? '至少 6 位' : '输入管理密码'} /></label>
      {mode === 'login' && requiresTotp && <label className="admin-field admin-totp-field"><span>此账号已启用双重验证</span><input inputMode="numeric" value={totpCode} onChange={event => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" placeholder="输入验证器中的 6 位验证码" required pattern="[0-9]{6}" minLength={6} maxLength={6} autoFocus /><small>请输入验证器当前显示的动态码，不是登录密码。</small></label>}
      {notice && <div className={`admin-inline-notice ${notice.kind}`}>{notice.text}</div>}
      <button className="admin-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{busy ? '正在验证…' : mode === 'bootstrap' ? '创建超级管理员' : requiresTotp ? '验证并登录' : '登录管理后台'}</button>
      <a href="/">返回 PanelArk 用户端</a>
    </form>
  </div>;
}

function AdminNav({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Gauge; label: string; onClick: () => void }) {
  return <button className={active ? 'active' : ''} onClick={onClick}><Icon size={17} /><span>{label}</span></button>;
}

function PageHeading({ kicker, title, description, action }: { kicker: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="admin-page-heading"><div><span>{kicker}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function OverviewPage({ notify }: { notify: (notice: Notice) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const load = useCallback(() => adminApi.dashboard().then(result => setStats(result.stats)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <PageHeading kicker="Overview" title="业务概览" description="掌握 CDK 库存、使用与当前任务占用情况。" action={<button className="admin-ghost" onClick={load}><RefreshCw size={15} /> 刷新</button>} />
    <div className="admin-stat-grid">
      <AdminStat icon={KeyRound} label="CDK 总量" value={stats?.totalCdks} />
      <AdminStat icon={TicketCheck} label="可用 CDK" value={stats?.activeCdks} />
      <AdminStat icon={Activity} label="已核销次数" value={stats?.consumed} />
      <AdminStat icon={ShieldCheck} label="任务锁定中" value={stats?.locked} />
      <AdminStat icon={Activity} label="待人工审核" value={stats?.jobsPendingReview} />
      <AdminStat icon={PackagePlus} label="推荐点击" value={stats?.resourceClicks} />
    </div>
    <details className="admin-panel admin-disclosure admin-overview-notes"><summary>平台能力与安全说明</summary><div className="admin-welcome"><div><span className="admin-panel-icon"><Gauge size={21} /></span><h2>PanelArk 运营控制中心</h2><p>CDK 商业闭环、部署任务售后、动态目录、资源推荐、角色权限、2FA、会话审计与加密迁移均由真实服务端驱动。</p></div><div className="admin-security-list"><span><Check size={15} /> CDK 加密保存，管理员可查看和导出</span><span><Check size={15} /> 管理会话使用 HttpOnly Cookie</span><span><Check size={15} /> 备份使用 AES-256-GCM 加密</span><span><Check size={15} /> 恢复前自动快照并支持失败回滚</span></div></div></details>
  </>;
}

function AdminStat({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value?: number }) {
  return <article className="admin-stat"><span><Icon size={18} /></span><small>{label}</small><strong>{value ?? '—'}</strong></article>;
}

function CdkPage({ admin, notify }: { admin: AdminIdentity; notify: (notice: Notice) => void }) {
  const writable = admin.role !== 'support';
  const [view, setView] = useState<'cdks' | 'packages' | 'batches'>('cdks');
  const [creating, setCreating] = useState<'package' | 'batch' | null>(null);
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [packageForm, setPackageForm] = useState({ name: '', description: '', maxUses: 1, validityDays: 30 });
  const [batchForm, setBatchForm] = useState({ packageId: '', name: '', quantity: 10 });
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const options = await allPackageOptions();
      setPackages(options);
      setBatchForm(current => ({ ...current, packageId: options.some(item => item.id === current.packageId && item.enabled) ? current.packageId : options.find(item => item.enabled)?.id || '' }));
    } catch (error) { notify({ kind: 'error', text: message(error) }); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);
  const createPackage = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await adminApi.createPackage(packageForm); setPackageForm({ name: '', description: '', maxUses: 1, validityDays: 30 }); setCreating(null); setView('packages'); setRefreshKey(key => key + 1); notify({ kind: 'success', text: '套餐已创建' }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  const createBatch = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const result = await adminApi.createBatch(batchForm); setCreating(null); setView('cdks'); setGenerated(result.codes); setRefreshKey(key => key + 1); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  return <>
    <PageHeading kicker="Commercial access" title="CDK 管理" description="授权码、套餐与批次分区管理，随时查看、编辑和导出。" action={<div className="management-actions"><button className="admin-ghost" onClick={() => { void load(); setRefreshKey(key => key + 1); }}><RefreshCw size={15} />刷新</button>{writable && <><button className="admin-ghost" onClick={() => setCreating('package')}>新建套餐</button><button className="admin-primary" onClick={() => setCreating('batch')} disabled={!packages.some(item => item.enabled)}>批量生成</button></>}</div>} />
    <AdminTabs<'cdks' | 'packages' | 'batches'> label="授权管理分区" value={view} onChange={setView} items={writable ? [{ value: 'cdks', label: 'CDK 列表' }, { value: 'packages', label: '套餐管理' }, { value: 'batches', label: '批次管理' }] : [{ value: 'cdks', label: 'CDK 列表' }]}>
      {view === 'cdks' ? <CdkManagementTable admin={admin} notify={notify} refreshKey={refreshKey} /> : <PackageManagement view={view} notify={notify} refreshKey={refreshKey} onChanged={() => { void load(); setRefreshKey(key => key + 1); }} />}
    </AdminTabs>
    {creating && <CenteredModal title={creating === 'package' ? '创建套餐' : '批量生成 CDK'} onClose={() => { if (!busy) setCreating(null); }}>
      {creating === 'package' ? <form noValidate onSubmit={createPackage}><p className="admin-readonly">设置部署次数和有效期，0 天代表永久有效。</p><fieldset disabled={busy}><div className="admin-form-grid"><AdminInput label="套餐名称" value={packageForm.name} setValue={name => setPackageForm({ ...packageForm, name })} required /><AdminInput label="最多部署次数" type="number" value={String(packageForm.maxUses)} setValue={value => setPackageForm({ ...packageForm, maxUses: Number(value) })} required /><AdminInput label="有效天数" type="number" value={String(packageForm.validityDays)} setValue={value => setPackageForm({ ...packageForm, validityDays: Number(value) })} /><AdminInput label="说明" value={packageForm.description} setValue={description => setPackageForm({ ...packageForm, description })} /></div></fieldset><div className="admin-dialog-actions"><button type="button" className="admin-ghost" disabled={busy} onClick={() => setCreating(null)}>取消</button><button className="admin-primary" disabled={busy}>创建套餐</button></div></form> : <form noValidate onSubmit={createBatch}><p className="admin-readonly">每次最多生成 500 个，可随时重新查看和导出。</p><fieldset disabled={busy}><label className="admin-field"><span>选择套餐</span><select value={batchForm.packageId} onChange={event => setBatchForm({ ...batchForm, packageId: event.target.value })} required>{packages.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name} · {item.max_uses} 次</option>)}</select></label><div className="admin-form-grid"><AdminInput label="批次名称" value={batchForm.name} setValue={name => setBatchForm({ ...batchForm, name })} /><AdminInput label="生成数量" type="number" value={String(batchForm.quantity)} setValue={value => setBatchForm({ ...batchForm, quantity: Number(value) })} required /></div></fieldset><div className="admin-dialog-actions"><button type="button" className="admin-ghost" disabled={busy} onClick={() => setCreating(null)}>取消</button><button className="admin-primary" disabled={busy || !batchForm.packageId}>生成 CDK</button></div></form>}
    </CenteredModal>}
    {generated && <CdkCodesDialog codes={generated} onClose={() => setGenerated(null)} notify={notify} />}
  </>;
}

function SettingsPage({ admin, notify }: { admin: AdminIdentity; notify: (notice: Notice) => void }) {
  const editable = admin.role !== 'support';
  const [form, setForm] = useState<AdminSettings>(emptySettings);
  const [saved, setSaved] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    adminApi.settings().then(({ success: _success, ...settings }) => { if (active) { setForm(settings); setSaved(settings); setLoading(false); } }).catch(error => { if (active) notify({ kind: 'error', text: message(error) }); });
    return () => { active = false; };
  }, [notify]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const { success: _success, ...settings } = await adminApi.updateSettings(form);
      setForm(settings);
      setSaved(settings);
      try { window.localStorage.setItem('panelark-settings-changed', String(Date.now())); } catch { /* focus refresh remains available */ }
      const currentPath = window.location.pathname.replace(/\/+$/g, '') || '/';
      if (currentPath !== settings.adminPath && !currentPath.startsWith(`${settings.adminPath}/`)) {
        window.location.assign(settings.adminPath);
        return;
      }
      notify({ kind: 'success', text: `配置已保存。\n购买 CDK 跳转：${settings.purchaseEnabled ? settings.purchaseUrl || '未设置' : '已关闭购买入口'}\n客服链接：${settings.supportUrl || '未设置'}\n购买与客服是两个独立配置，修改客服链接不会改变购买跳转。` });
    }
    catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  return <><PageHeading kicker="Site configuration" title="站点配置" description="管理访问入口、CDK 购买渠道和站点公告。保存后购买跳转立即生效。" /><form noValidate className="admin-panel admin-settings-form" onSubmit={submit}>
    <fieldset disabled={loading || busy} className="admin-settings-section"><legend>访问入口</legend><AdminInput label="站点名称" value={form.siteName || ''} setValue={siteName => setForm({ ...form, siteName })} disabled={!editable} /><AdminInput label="站点地址（HTTP/HTTPS）" value={form.siteUrl || ''} setValue={siteUrl => setForm({ ...form, siteUrl })} disabled={!editable} /><AdminInput label="管理后台路径（仅超级管理员）" value={form.adminPath} setValue={adminPath => setForm({ ...form, adminPath })} placeholder="/admin" disabled={admin.role !== 'super_admin'} /><p className="admin-readonly">修改后会跳转到新后台地址，请保存此地址。</p></fieldset>
    <fieldset disabled={loading || busy} className="admin-settings-section"><legend>购买 CDK 跳转</legend>
    <label className="admin-switch"><span><strong>显示购买 CDK 按钮</strong><small>在验证 CDK 操作区显示购买入口</small></span><input type="checkbox" checked={form.purchaseEnabled} onChange={event => setForm({ ...form, purchaseEnabled: event.target.checked })} disabled={!editable} /><i /></label>
    <AdminInput label="购买按钮文字" value={form.purchaseButtonText} setValue={purchaseButtonText => setForm({ ...form, purchaseButtonText })} disabled={!editable} />
    <AdminInput label="购买 CDK 的跳转链接（HTTPS）" type="url" value={form.purchaseUrl} setValue={purchaseUrl => setForm({ ...form, purchaseUrl })} placeholder="https://shop.example.com/cdk" disabled={!editable} />
    <div className="admin-settings-help"><p>“购买 CDK”按钮只使用这里的购买链接，不使用下面的客服链接。修改后请点击“保存配置”。</p><p>已保存的购买地址：<strong data-saved-purchase>{loading ? '正在读取…' : saved?.purchaseUrl || '未设置'}</strong></p>{saved && form.purchaseUrl !== saved.purchaseUrl && <p role="status">购买链接有未保存修改，当前跳转仍使用上方已保存地址。</p>}{saved?.purchaseEnabled && saved.purchaseUrl && <a href="/api/public/purchase" target="_blank" rel="noopener noreferrer">测试已保存的购买跳转 ↗</a>}</div></fieldset>
    <fieldset disabled={loading || busy} className="admin-settings-section"><legend>客服链接（独立配置）</legend><AdminInput label="客服链接（HTTPS，不影响购买 CDK 跳转）" type="url" value={form.supportUrl} setValue={supportUrl => setForm({ ...form, supportUrl })} placeholder="https://support.example.com" disabled={!editable} /><div className="admin-settings-help"><p>客服地址不会替代购买地址。要更换“购买 CDK”跳转，请修改上面的购买链接。</p><p>已保存的客服地址：<strong data-saved-support>{loading ? '正在读取…' : saved?.supportUrl || '未设置'}</strong></p></div></fieldset>
    <fieldset disabled={loading || busy} className="admin-settings-section"><legend>站点公告</legend><AdminInput label="全站公告" value={form.siteNotice} setValue={siteNotice => setForm({ ...form, siteNotice })} disabled={!editable} /></fieldset>
    {editable ? <button className="admin-primary" disabled={busy || loading}>{loading ? '正在读取配置…' : busy ? '正在保存…' : '保存配置'}</button> : <p className="admin-readonly">当前角色只有查看权限。</p>}
  </form></>;
}

function AdminsPage({ current, onChanged, notify }: { current: AdminIdentity; onChanged: (admin: AdminIdentity) => void; notify: (notice: Notice) => void }) { return <AdminManagement current={current} onChanged={onChanged} notify={notify} />; }

function JobsPage({ admin, notify }: { admin: AdminIdentity; notify: (notice: Notice) => void }) { return <JobManagement admin={admin} notify={notify} />; }

function CatalogAdminPage({ notify }: { notify: (notice: Notice) => void }) { return <CatalogManagement notify={notify} />; }

function ResourcesPage({ notify }: { notify: (notice: Notice) => void }) { return <ResourceManagement notify={notify} />; }

function BackupsPage({ notify }: { notify: (notice: Notice) => void }) { return <BackupManagement notify={notify} />; }

function UpdatePage({ notify }: { notify: (notice: Notice) => void }) {
  const dialog = useAdminDialog();
  const [state, setState] = useState<UpdateState | null>(null);
  const [adapterVersion, setAdapterVersion] = useState('built-in');
  const [signingConfigured, setSigningConfigured] = useState<boolean | null>(null);
  const [updatePolicy, setUpdatePolicy] = useState({ supported: true, hint: '' });
  const [security, setSecurity] = useState<SecurityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [securityError, setSecurityError] = useState('');
  const mounted = useRef(false);
  const statusPending = useRef(false);
  const statusRequest = useRef<AbortController | null>(null);
  const securityRequest = useRef<AbortController | null>(null);
  const refreshWarning = useUpdatePageReload(state);
  const load = useCallback(async (includeSecurity = true) => {
    if (!includeSecurity && statusPending.current) return;
    statusRequest.current?.abort();
    const request = new AbortController();
    statusRequest.current = request;
    statusPending.current = true;
    setLoading(true); setStatusError('');
    const timeout = window.setTimeout(() => request.abort(), 15000);
    // Security checks are independent: they must never delay version/signature information.
    if (includeSecurity) {
      securityRequest.current?.abort();
      const reportRequest = new AbortController();
      securityRequest.current = reportRequest;
      setSecurityError('');
      const reportTimeout = window.setTimeout(() => reportRequest.abort(), 15000);
      void adminApi.securityReport(reportRequest.signal).then(result => {
        if (mounted.current && securityRequest.current === reportRequest) setSecurity(result.report);
      }).catch(error => {
        if (mounted.current && securityRequest.current === reportRequest) setSecurityError(reportRequest.signal.aborted ? '读取安全报告超时，请刷新状态重试' : message(error));
      }).finally(() => window.clearTimeout(reportTimeout));
    }
    try {
      const result = await adminApi.updateStatus(request.signal);
      if (!mounted.current || statusRequest.current !== request) return;
      setState(result.state); setAdapterVersion(result.adapterCatalogVersion); setSigningConfigured(result.signingConfigured);
      setUpdatePolicy({ supported: result.applicationUpdateSupported, hint: result.applicationUpdateHint });
    } catch (error) {
      if (mounted.current && statusRequest.current === request) setStatusError(request.signal.aborted ? '读取更新状态超时，请检查网络后刷新状态重试' : message(error));
    } finally {
      window.clearTimeout(timeout);
      if (statusRequest.current === request) statusPending.current = false;
      if (mounted.current && statusRequest.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; statusRequest.current?.abort(); securityRequest.current?.abort(); };
  }, [load]);
  useEffect(() => {
    if (!state || !['downloading', 'applying', 'restarting'].includes(state.phase)) return;
    const timer = window.setInterval(() => void load(false), 4000);
    return () => window.clearInterval(timer);
  }, [state?.phase, load]);
  const check = async () => { setBusy(true); try { const result = await adminApi.checkUpdate(); setState(result.state); notify({ kind: 'success', text: `${result.state.message}。检测不会下载或安装；如有新版本，请手动点击更新按钮。` }); } catch (error) { notify({ kind: 'error', text: message(error) }); await load(); } finally { setBusy(false); } };
  const update = async () => { if (!await dialog.confirm({ title: '确认安装更新', message: '系统会使用本机托管密钥自动创建更新前备份，然后下载、校验、安装并重启服务；失败时自动回滚。确定继续？' })) return; setBusy(true); try { let current = state; if (current?.phase === 'available') { setState({ ...current, phase: 'downloading', progress: 25, message: '正在创建更新前自动备份并下载签名更新包' }); const prepared = await adminApi.prepareUpdate(); current = prepared.state; setState(current); } if (current?.phase !== 'prepared') throw new Error('没有已验证并等待应用的更新包'); const result = await adminApi.applyUpdate(); setState(result.state); notify({ kind: 'success', text: '更新执行器已启动，页面会自动跟踪安装与重启状态' }); } catch (error) { notify({ kind: 'error', text: message(error) }); await load(); } finally { setBusy(false); } };
  const adapters = async () => { if (!await dialog.confirm({ title: '更新适配器目录', message: '确认下载并应用适配器目录？此操作不会更新或重启主程序。' })) return; setBusy(true); try { const result = await adminApi.updateAdapters(); setAdapterVersion(result.version); notify({ kind: 'success', text: `已更新 ${result.updated} 个适配器目录项` }); } catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); } };
  const terminal = state && ['completed', 'rolled_back', 'failed'].includes(state.phase);
  const activeUpdate = Boolean(state && !state.error && ['downloading', 'applying', 'restarting'].includes(state.phase));
  const progressLabel = activeUpdate ? `${state?.progress ?? 0}%` : state?.phase === 'completed' ? '已完成' : state?.phase === 'prepared' ? '待应用' : state?.phase === 'failed' ? '失败' : state?.phase === 'rolled_back' ? '已回滚' : '未运行';
  const pendingLabel = statusError ? '读取失败' : '读取中';
  return <><PageHeading kicker="Signed updates" title="系统更新与回滚" description="只接受受信任 Ed25519 签名清单和 SHA-256 匹配的构建包；更新状态保存在独立数据目录，服务重启后仍可继续读取。" action={<button className="admin-ghost" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={15} /> 刷新状态</button>} />
    {statusError && <div className="admin-inline-notice error" role="alert">无法读取更新状态：{statusError}。请点击“刷新状态”重试。</div>}
    {signingConfigured === false && !loading && !statusError && <div className="admin-inline-notice error">未找到正式发布签名公钥，在线更新已安全禁用。请使用正式发布包或配置 PANELARK_UPDATE_PUBLIC_KEY。</div>}
    {!updatePolicy.supported && <div className="admin-inline-notice">{updatePolicy.hint}</div>}
    {refreshWarning && <div className="admin-inline-notice error" role="alert">{refreshWarning}<button className="admin-ghost" onClick={() => window.location.reload()}>重新加载页面</button></div>}
    <div className="admin-stat-grid admin-update-strip" aria-busy={loading}><article className="admin-stat"><span><RefreshCw size={18} /></span><small>当前版本</small><strong>{state?.currentVersion || pendingLabel}</strong></article><article className="admin-stat"><span><ShieldCheck size={18} /></span><small>签名状态</small><strong>{statusError || signingConfigured === null ? pendingLabel : signingConfigured ? '可信' : '未配置'}</strong></article><article className="admin-stat"><span><Layers3 size={18} /></span><small>适配器目录</small><strong>{state ? adapterVersion : pendingLabel}</strong></article><article className="admin-stat"><span><Activity size={18} /></span><small>更新状态</small><strong>{state ? progressLabel : pendingLabel}</strong></article></div>
    <div className="admin-two-column"><section className="admin-panel"><PanelTitle icon={RefreshCw} title="更新控制" subtitle={`正式版仅使用稳定更新通道；检测只读取版本信息，确认安装后自动完成备份、下载、校验、应用与重启。当前 ${state?.currentVersion || pendingLabel} · 目标 ${state?.targetVersion || '未检查'}`} /><div className="modal-actions"><button className="admin-ghost" disabled={busy || loading || Boolean(statusError) || !signingConfigured || Boolean(state && ['downloading', 'applying', 'restarting'].includes(state.phase))} onClick={check}>检测更新</button>{updatePolicy.supported && ['available', 'prepared'].includes(state?.phase || '') && <button className="admin-primary" disabled={busy || loading || Boolean(statusError) || !signingConfigured} onClick={update}>{state?.phase === 'prepared' ? '继续安装更新' : '下载并安装更新'}</button>}</div>{state?.manifest?.adapterCatalog && <button className="admin-ghost" disabled={busy || loading || Boolean(statusError) || !signingConfigured} onClick={adapters}>独立更新适配器目录至 {state.manifest.adapterCatalog.version}</button>}</section><section className="admin-panel"><PanelTitle icon={Activity} title="真实更新状态" subtitle={state?.updatedAt ? `最后更新 ${formatDate(state.updatedAt)}` : pendingLabel} />{activeUpdate && <div className="progress-track large"><div style={{ width: `${state?.progress ?? 0}%` }}><span /></div></div>}<p className={terminal && state?.phase === 'failed' ? 'admin-warning' : 'admin-readonly'}>{state?.message || (statusError ? '更新状态读取失败，请刷新状态重试' : '正在读取更新状态…')}</p>{state?.preUpdateBackup && <p className="admin-readonly">更新前自动备份：<code>{state.preUpdateBackup}</code></p>}{state?.error && <p className="admin-warning">{state.error}</p>}</section></div>
    <details className="admin-panel admin-table-panel admin-disclosure"><summary><PanelTitle icon={FileClock} title="更新事件" subtitle="服务重启后继续从持久化状态读取" /></summary><div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>阶段</th><th>进度</th><th>说明</th></tr></thead><tbody>{[...(state?.events || [])].reverse().map((event, index) => <tr key={`${event.at}-${index}`}><td>{formatDate(event.at)}</td><td><code>{event.phase}</code></td><td>{event.progress}%</td><td>{event.message}</td></tr>)}</tbody></table>{!state?.events.length && <Empty text="暂无更新事件" />}</div></details>
    <details className="admin-panel admin-table-panel admin-disclosure"><summary><PanelTitle icon={ShieldCheck} title="安全基线检查" subtitle={securityError ? `读取失败：${securityError}` : security ? `${security.failed} 项失败 · ${security.warnings} 项建议` : '正在读取'} /></summary><div className="admin-table-wrap"><table><thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead><tbody>{security?.checks.map(check => <tr key={check.id}><td>{check.label}</td><td><span className={`admin-status ${check.status === 'pass' ? 'active' : check.status === 'fail' ? 'disabled' : 'refunded'}`}>{check.status === 'pass' ? '通过' : check.status === 'fail' ? '失败' : '建议'}</span></td><td>{check.detail}</td></tr>)}</tbody></table></div></details>
  </>;
}

function AuditPage({ admin, notify }: { admin: AdminIdentity; notify: (notice: Notice) => void }) { return <AuditManagement admin={admin} notify={notify} />; }

function AccountPage({ admin, onChanged, notify }: { admin: AdminIdentity; onChanged: (admin: AdminIdentity) => void; notify: (notice: Notice) => void }) {
  const [form, setForm] = useState({ username: admin.username, currentPassword: '', newPassword: '' });
  const dialog = useAdminDialog();
  const { items: sessions, data: sessionData, load: loadSessions, pager } = usePagedList<SessionRecord, Awaited<ReturnType<typeof adminApi.sessions>>>(adminApi.sessions, notify);
  const currentSessionId = sessionData?.currentSessionId || '';
  const [totp, setTotp] = useState<{ secret: string; code: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { const result = await adminApi.updateAccount(form); onChanged(result.admin); setForm(current => ({ ...current, currentPassword: '', newPassword: '' })); notify({ kind: 'success', text: '账号信息已安全更新' }); }
    catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  const setup2fa = async () => { try { const result = await adminApi.setup2fa(form.currentPassword); setTotp({ secret: result.secret, code: '' }); notify({ kind: 'success', text: '请将密钥加入验证器并输入动态码确认' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const enable2fa = async () => { if (!totp) return; try { await adminApi.enable2fa(totp.code); setTotp(null); onChanged({ ...admin, totpEnabled: true }); notify({ kind: 'success', text: '2FA 已启用，下次登录必须输入动态验证码' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const disable2fa = async () => { const code = await dialog.prompt({ title: '停用双重验证', message: '输入当前 2FA 动态验证码', pattern: '^[0-9]{6}$' }); if (code === null) return; try { await adminApi.disable2fa(form.currentPassword, code); onChanged({ ...admin, totpEnabled: false }); notify({ kind: 'success', text: '2FA 已停用' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const revoke = async (id: string) => { try { const result = await adminApi.revokeSession(id); if (result.currentRevoked) window.location.reload(); else await loadSessions(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  return <><PageHeading kicker="Personal security" title="我的账号" description="管理密码、双重验证与全部登录会话。修改密码会注销其他管理会话。" /><div className="admin-two-column"><form noValidate className="admin-panel admin-account-form" onSubmit={submit}><PanelTitle icon={UserCog} title="账号资料" subtitle="用户名与强密码" /><AdminInput label="管理员用户名" value={form.username} setValue={username => setForm({ ...form, username })} required /><AdminInput label="当前密码" type="password" value={form.currentPassword} setValue={currentPassword => setForm({ ...form, currentPassword })} required /><AdminInput label="新密码（不修改可留空）" type="password" value={form.newPassword} setValue={newPassword => setForm({ ...form, newPassword })} placeholder="至少 6 位" /><button className="admin-primary">确认更新</button></form><section className="admin-panel"><PanelTitle icon={ShieldCheck} title="双重验证" subtitle="兼容标准 TOTP 验证器" />{totp ? <><p className="admin-warning">密钥：<code>{totp.secret}</code></p><AdminInput label="当前动态验证码" value={totp.code} setValue={code => setTotp({ ...totp, code: code.replace(/\D/g, '').slice(0, 6) })} /><button className="admin-primary" onClick={enable2fa}>确认启用 2FA</button></> : admin.totpEnabled ? <><p className="admin-readonly">2FA 已启用。停用前请在左侧输入当前密码。</p><button className="admin-ghost" type="button" onClick={disable2fa}>停用 2FA</button></> : <><p className="admin-readonly">先在左侧输入当前密码，再生成仅本次显示的 TOTP 密钥。</p><button className="admin-primary" type="button" onClick={setup2fa}>设置 2FA</button></>}</section></div><section className="admin-panel admin-table-panel"><PanelTitle icon={FileClock} title="登录会话" subtitle="可撤销其他设备或当前会话" /><div className="admin-table-wrap"><table><thead><tr><th>设备</th><th>IP</th><th>最后活动</th><th>操作</th></tr></thead><tbody>{sessions.map(item => <tr key={item.id}><td>{item.user_agent?.slice(0, 60) || '未知设备'}{item.id === currentSessionId && <small> · 当前</small>}</td><td>{item.ip || '—'}</td><td>{formatDate(item.last_seen_at)}</td><td><button className="admin-ghost" onClick={() => revoke(item.id)}>撤销</button></td></tr>)}</tbody></table></div>{pager}</section></>;
}

function PanelTitle({ icon: Icon, title, subtitle }: { icon: typeof Gauge; title: string; subtitle: string }) { return <div className="admin-panel-title"><span><Icon size={18} /></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>; }
function AdminInput({ label, value, setValue, type = 'text', placeholder, required, disabled }: { label: string; value: string; setValue: (value: string) => void; type?: string; placeholder?: string; required?: boolean; disabled?: boolean }) { return <label className="admin-field"><span>{label}</span><input type={type} value={value} onChange={event => setValue(event.target.value)} placeholder={placeholder} required={required} disabled={disabled} /></label>; }
function StatusBadge({ status }: { status: CdkRecord['status'] }) { const names = { active: '启用', disabled: '停用', refunded: '已返还' }; return <span className={`admin-status ${status}`}>{names[status]}</span>; }
function Empty({ text }: { text: string }) { return <div className="admin-empty">{text}</div>; }

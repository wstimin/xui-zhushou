import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  Activity, ArrowLeft, Check, Clipboard, Cog, FileClock, Gauge, KeyRound, Layers3,
  LoaderCircle, LogOut, Menu, PackagePlus, RefreshCw, ShieldCheck, TicketCheck, UserCog,
  Users, X,
} from 'lucide-react';
import {
  adminApi, type AdminIdentity, type AdminRecord, type AdminRole, type AdminSettings,
  type AuditRecord, type BackupRecord, type CatalogAdminRecord, type CdkRecord, type DashboardStats,
  type JobReviewRecord, type PackageRecord, type ResourceRecord, type SessionRecord,
  type UpdateState,
  type SecurityReport,
} from './api';

type AdminView = 'overview' | 'jobs' | 'cdk' | 'catalog' | 'resources' | 'settings' | 'admins' | 'backups' | 'update' | 'audit' | 'account';
type Notice = { kind: 'success' | 'error'; text: string } | null;

const emptySettings: AdminSettings = { purchaseEnabled: true, purchaseButtonText: '购买 CDK', purchaseUrl: '', supportUrl: '', siteNotice: '' };
const roleNames: Record<AdminRole, string> = { super_admin: '超级管理员', operator: '运营管理员', support: '售后人员' };

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatDate(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '永久有效'; }

export default function AdminApp() {
  const [state, setState] = useState<'loading' | 'bootstrap' | 'login' | 'ready'>('loading');
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [view, setView] = useState<AdminView>('overview');
  const [notice, setNotice] = useState<Notice>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('panelark-theme') === 'light' ? 'light' : 'dark';
    adminApi.bootstrapState().then(async ({ required }) => {
      if (required) return setState('bootstrap');
      try {
        const session = await adminApi.session();
        setAdmin(session.admin); setState('ready');
      } catch { setState('login'); }
    }).catch(error => { setNotice({ kind: 'error', text: message(error) }); setState('login'); });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const authenticated = (identity: AdminIdentity) => { setAdmin(identity); setState('ready'); setView('overview'); };
  if (state === 'loading') return <AdminLoading />;
  if (state === 'bootstrap') return <AdminAccess mode="bootstrap" onAuthenticated={authenticated} notice={notice} setNotice={setNotice} />;
  if (state === 'login') return <AdminAccess mode="login" onAuthenticated={authenticated} notice={notice} setNotice={setNotice} />;
  if (!admin) return null;

  const logout = async () => {
    try { await adminApi.logout(); } finally { setAdmin(null); setState('login'); }
  };
  const navigate = (next: AdminView) => { setView(next); setMenuOpen(false); };

  return <div className="admin-shell">
    <aside className={`admin-sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="admin-brand"><span className="brand-mark"><Layers3 size={18} /></span><div><strong>Panel<span>Ark</span></strong><small>CONTROL CENTER</small></div><button onClick={() => setMenuOpen(false)} aria-label="关闭菜单"><X size={18} /></button></div>
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
        <div><span>安全管理会话</span><strong>{admin.username}</strong><em>{roleNames[admin.role]}</em></div>
      </header>
      <div className="admin-content">
        {view === 'overview' && <OverviewPage notify={setNotice} />}
        {view === 'jobs' && <JobsPage notify={setNotice} />}
        {view === 'cdk' && <CdkPage admin={admin} notify={setNotice} />}
        {view === 'catalog' && admin.role !== 'support' && <CatalogAdminPage notify={setNotice} />}
        {view === 'resources' && admin.role !== 'support' && <ResourcesPage notify={setNotice} />}
        {view === 'settings' && <SettingsPage admin={admin} notify={setNotice} />}
        {view === 'admins' && admin.role === 'super_admin' && <AdminsPage current={admin} notify={setNotice} />}
        {view === 'backups' && admin.role === 'super_admin' && <BackupsPage notify={setNotice} />}
        {view === 'update' && admin.role === 'super_admin' && <UpdatePage notify={setNotice} />}
        {view === 'audit' && <AuditPage notify={setNotice} />}
        {view === 'account' && <AccountPage admin={admin} onChanged={setAdmin} notify={setNotice} />}
      </div>
    </main>
    {notice && <div className={`admin-toast ${notice.kind}`} role="status">{notice.kind === 'success' ? <Check size={17} /> : <X size={17} />}<span>{notice.text}</span></div>}
  </div>;
}

function AdminLoading() {
  return <div className="admin-loading"><div className="brand-mark"><Layers3 size={21} /></div><LoaderCircle className="spin" size={22} /><span>正在建立安全管理会话…</span></div>;
}

function AdminAccess({ mode, onAuthenticated, notice, setNotice }: { mode: 'bootstrap' | 'login'; onAuthenticated: (admin: AdminIdentity) => void; notice: Notice; setNotice: (notice: Notice) => void }) {
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = mode === 'bootstrap' ? await adminApi.bootstrap(setupToken, username, password) : await adminApi.login(username, password, totpCode);
      onAuthenticated(result.admin);
    } catch (error) { setNotice({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  return <div className="admin-access">
    <div className="admin-access-glow" />
    <form className="admin-access-card" onSubmit={submit}>
      <div className="admin-access-brand"><span className="brand-mark"><Layers3 size={20} /></span><strong>Panel<span>Ark</span></strong></div>
      <span className="admin-kicker">{mode === 'bootstrap' ? 'FIRST RUN SECURITY' : 'CONTROL CENTER'}</span>
      <h1>{mode === 'bootstrap' ? '初始化管理后台' : '欢迎回来'}</h1>
      <p>{mode === 'bootstrap' ? '首次启动需要初始化令牌。令牌默认保存在服务器 data/admin-setup-token.txt，也可由环境变量指定。' : '登录后管理 CDK、购买入口、账号权限与操作审计。'}</p>
      {mode === 'bootstrap' && <label className="admin-field"><span>初始化令牌</span><input type="password" value={setupToken} onChange={event => setSetupToken(event.target.value)} required autoComplete="off" placeholder="PAK-SETUP-…" /></label>}
      <label className="admin-field"><span>管理员用户名</span><input value={username} onChange={event => setUsername(event.target.value)} required autoComplete="username" placeholder="panelark_admin" /></label>
      <label className="admin-field"><span>{mode === 'bootstrap' ? '设置强密码' : '登录密码'}</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'} placeholder={mode === 'bootstrap' ? '至少 12 位，含大小写、数字和符号' : '输入管理密码'} /></label>
      {mode === 'login' && <label className="admin-field"><span>2FA 动态验证码（启用后必填）</span><input inputMode="numeric" value={totpCode} onChange={event => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" placeholder="000000" /></label>}
      {notice && <div className={`admin-inline-notice ${notice.kind}`}>{notice.text}</div>}
      <button className="admin-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{busy ? '正在验证…' : mode === 'bootstrap' ? '创建超级管理员' : '安全登录'}</button>
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
    <section className="admin-panel admin-welcome"><div><span className="admin-panel-icon"><Gauge size={21} /></span><h2>阶段七运营控制中心</h2><p>CDK 商业闭环、部署任务售后、动态目录、资源推荐、角色权限、2FA、会话审计与加密迁移均由真实服务端驱动。</p></div><div className="admin-security-list"><span><Check size={15} /> CDK 仅保存不可逆哈希</span><span><Check size={15} /> 管理会话使用 HttpOnly Cookie</span><span><Check size={15} /> 备份使用 AES-256-GCM 加密</span><span><Check size={15} /> 恢复前自动快照并支持失败回滚</span></div></section>
  </>;
}

function AdminStat({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value?: number }) {
  return <article className="admin-stat"><span><Icon size={18} /></span><small>{label}</small><strong>{value ?? '—'}</strong></article>;
}

function CdkPage({ admin, notify }: { admin: AdminIdentity; notify: (notice: Notice) => void }) {
  const writable = admin.role !== 'support';
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [cdks, setCdks] = useState<CdkRecord[]>([]);
  const [packageForm, setPackageForm] = useState({ name: '', description: '', maxUses: 1, validityDays: 30 });
  const [batchForm, setBatchForm] = useState({ packageId: '', name: '', quantity: 10 });
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [packageResult, cdkResult] = await Promise.all([adminApi.packages(), adminApi.cdks()]);
      setPackages(packageResult.items); setCdks(cdkResult.items);
      setBatchForm(current => ({ ...current, packageId: current.packageId || packageResult.items[0]?.id || '' }));
    } catch (error) { notify({ kind: 'error', text: message(error) }); }
  }, [notify]);
  useEffect(() => { void load(); }, [load]);
  const createPackage = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await adminApi.createPackage(packageForm); setPackageForm({ name: '', description: '', maxUses: 1, validityDays: 30 }); notify({ kind: 'success', text: '套餐已创建' }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  const createBatch = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const result = await adminApi.createBatch(batchForm); setGenerated(result.codes); notify({ kind: 'success', text: `已生成 ${result.codes.length} 个 CDK` }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  const updateStatus = async (id: string, status: CdkRecord['status']) => {
    try { await adminApi.updateCdk(id, status); notify({ kind: 'success', text: 'CDK 状态已更新' }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  return <>
    <PageHeading kicker="Commercial access" title="CDK 管理" description="创建授权套餐、批量生成 CDK，并处理停用或返还。明文只显示一次。" action={<button className="admin-ghost" onClick={load}><RefreshCw size={15} /> 刷新</button>} />
    {writable && <div className="admin-two-column">
      <form className="admin-panel" onSubmit={createPackage}><PanelTitle icon={PackagePlus} title="创建套餐" subtitle="定义次数和有效期" /><div className="admin-form-grid"><AdminInput label="套餐名称" value={packageForm.name} setValue={name => setPackageForm({ ...packageForm, name })} required /><AdminInput label="最多部署次数" type="number" value={String(packageForm.maxUses)} setValue={value => setPackageForm({ ...packageForm, maxUses: Number(value) })} required /><AdminInput label="有效天数" type="number" value={String(packageForm.validityDays)} setValue={value => setPackageForm({ ...packageForm, validityDays: Number(value) })} /><AdminInput label="说明" value={packageForm.description} setValue={description => setPackageForm({ ...packageForm, description })} /></div><button className="admin-primary" disabled={busy}>创建套餐</button></form>
      <form className="admin-panel" onSubmit={createBatch}><PanelTitle icon={KeyRound} title="批量生成" subtitle="最多一次生成 500 个" /><label className="admin-field"><span>选择套餐</span><select value={batchForm.packageId} onChange={event => setBatchForm({ ...batchForm, packageId: event.target.value })} required>{packages.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name} · {item.max_uses} 次</option>)}</select></label><div className="admin-form-grid"><AdminInput label="批次名称" value={batchForm.name} setValue={name => setBatchForm({ ...batchForm, name })} /><AdminInput label="生成数量" type="number" value={String(batchForm.quantity)} setValue={value => setBatchForm({ ...batchForm, quantity: Number(value) })} required /></div><button className="admin-primary" disabled={busy || !batchForm.packageId}>生成 CDK</button></form>
    </div>}
    <section className="admin-panel admin-table-panel"><PanelTitle icon={TicketCheck} title="CDK 列表" subtitle={`共 ${cdks.length} 个记录`} /><div className="admin-table-wrap"><table><thead><tr><th>标识</th><th>套餐</th><th>使用</th><th>状态</th><th>有效期</th><th>操作</th></tr></thead><tbody>{cdks.map(item => <tr key={item.id}><td><code>{item.code_hint}</code></td><td>{item.package_name}</td><td>{item.used_count}/{item.max_uses}{item.locked_count > 0 && <small> · 锁定 {item.locked_count}</small>}</td><td><StatusBadge status={item.status} /></td><td>{formatDate(item.expires_at)}</td><td>{writable ? <select className="table-select" value={item.status} onChange={event => updateStatus(item.id, event.target.value as CdkRecord['status'])}><option value="active">启用</option><option value="disabled">停用</option><option value="refunded">已返还</option></select> : '只读'}</td></tr>)}</tbody></table>{!cdks.length && <Empty text="尚无 CDK 记录" />}</div></section>
    {generated && <div className="modal-backdrop"><section className="modal admin-codes-modal"><div className="modal-head"><div><span className="eyebrow plain">ONE-TIME DISPLAY</span><h2>立即保存这些 CDK</h2></div><button className="icon-button" onClick={() => setGenerated(null)}><X size={18} /></button></div><div className="modal-body"><p className="admin-warning">为保证安全，系统只保存 CDK 哈希。关闭后无法再次查看这些明文。</p><textarea readOnly value={generated.join('\n')} /><div className="modal-actions"><button className="button button-secondary" onClick={() => navigator.clipboard.writeText(generated.join('\n')).then(() => notify({ kind: 'success', text: 'CDK 已复制' }))}><Clipboard size={15} /> 复制全部</button><button className="button button-primary" onClick={() => setGenerated(null)}>我已安全保存</button></div></div></section></div>}
  </>;
}

function SettingsPage({ admin, notify }: { admin: AdminIdentity; notify: (notice: Notice) => void }) {
  const editable = admin.role !== 'support';
  const [form, setForm] = useState<AdminSettings>(emptySettings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { adminApi.settings().then(({ success: _success, ...settings }) => setForm(settings)).catch(error => notify({ kind: 'error', text: message(error) })); }, [notify]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const { success: _success, ...settings } = await adminApi.updateSettings(form); setForm(settings); notify({ kind: 'success', text: '站点配置已保存，用户端刷新后生效' }); }
    catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); }
  };
  return <><PageHeading kicker="Site configuration" title="站点配置" description="配置用户端购买按钮、跳转链接、客服入口与公告。外链必须使用 HTTPS。" /><form className="admin-panel admin-settings-form" onSubmit={submit}>
    <label className="admin-switch"><span><strong>显示购买 CDK 按钮</strong><small>关闭后用户端隐藏购买入口</small></span><input type="checkbox" checked={form.purchaseEnabled} onChange={event => setForm({ ...form, purchaseEnabled: event.target.checked })} disabled={!editable} /><i /></label>
    <div className="admin-form-grid"><AdminInput label="按钮文字" value={form.purchaseButtonText} setValue={purchaseButtonText => setForm({ ...form, purchaseButtonText })} disabled={!editable} /><AdminInput label="购买链接" type="url" value={form.purchaseUrl} setValue={purchaseUrl => setForm({ ...form, purchaseUrl })} placeholder="https://shop.example.com/cdk" disabled={!editable} /><AdminInput label="客服链接" type="url" value={form.supportUrl} setValue={supportUrl => setForm({ ...form, supportUrl })} placeholder="https://support.example.com" disabled={!editable} /><AdminInput label="全站公告" value={form.siteNotice} setValue={siteNotice => setForm({ ...form, siteNotice })} disabled={!editable} /></div>
    {editable ? <button className="admin-primary" disabled={busy}>{busy ? '正在保存…' : '保存配置'}</button> : <p className="admin-readonly">当前角色只有查看权限。</p>}
  </form></>;
}

function AdminsPage({ current, notify }: { current: AdminIdentity; notify: (notice: Notice) => void }) {
  const [items, setItems] = useState<AdminRecord[]>([]);
  const [form, setForm] = useState<{ username: string; password: string; role: AdminRole }>({ username: '', password: '', role: 'operator' });
  const load = useCallback(() => adminApi.admins().then(result => setItems(result.items)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try { await adminApi.createAdmin(form); setForm({ username: '', password: '', role: 'operator' }); notify({ kind: 'success', text: '管理员已创建' }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  const update = async (item: AdminRecord, role: AdminRole, enabled: boolean) => {
    try { await adminApi.updateAdmin(item.id, { role, enabled }); notify({ kind: 'success', text: '管理员权限已更新' }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  return <><PageHeading kicker="Access control" title="管理员与权限" description="按职责分配超级管理员、运营或售后角色，可随时停用非当前账号。" /><div className="admin-two-column narrow-right"><section className="admin-panel admin-table-panel"><PanelTitle icon={Users} title="账号列表" subtitle={`${items.length} 位管理员`} /><div className="admin-table-wrap"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.username}{item.id === current.id && <small> · 当前</small>}</td><td><select className="table-select" value={item.role} disabled={item.id === current.id} onChange={event => update(item, event.target.value as AdminRole, Boolean(item.enabled))}>{Object.entries(roleNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></td><td><button className={`status-toggle ${item.enabled ? 'on' : ''}`} disabled={item.id === current.id} onClick={() => update(item, item.role, !item.enabled)}>{item.enabled ? '已启用' : '已停用'}</button></td></tr>)}</tbody></table></div></section><form className="admin-panel" onSubmit={create}><PanelTitle icon={UserCog} title="创建管理员" subtitle="密码必须满足强度要求" /><AdminInput label="用户名" value={form.username} setValue={username => setForm({ ...form, username })} required /><AdminInput label="初始密码" type="password" value={form.password} setValue={password => setForm({ ...form, password })} required /><label className="admin-field"><span>角色</span><select value={form.role} onChange={event => setForm({ ...form, role: event.target.value as AdminRole })}><option value="operator">运营管理员</option><option value="support">售后人员</option><option value="super_admin">超级管理员</option></select></label><button className="admin-primary">创建账号</button></form></div></>;
}

function JobsPage({ notify }: { notify: (notice: Notice) => void }) {
  const [items, setItems] = useState<JobReviewRecord[]>([]);
  const load = useCallback(() => adminApi.jobs().then(result => setItems(result.items)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  const review = async (item: JobReviewRecord, refund = false) => {
    const note = window.prompt(refund ? '填写返还原因' : '填写审核备注', item.note || '') ?? '';
    try {
      if (refund) await adminApi.refundJob(item.id, note); else await adminApi.reviewJob(item.id, { status: 'resolved', note });
      notify({ kind: 'success', text: refund ? 'CDK 权益已幂等返还' : '任务审核已完成' }); await load();
    } catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  return <><PageHeading kicker="After-sales workflow" title="任务售后与人工审核" description="检查失败、人工恢复和异常任务，记录处置结论并按任务返还 CDK 权益。" action={<button className="admin-ghost" onClick={load}><RefreshCw size={15} /> 刷新</button>} /><section className="admin-panel admin-table-panel"><div className="admin-table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>审核</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><code>{item.id.slice(0, 8)}</code><small> · {item.kind}</small></td><td>{item.status}{item.error_message && <small> · {item.error_message.slice(0, 50)}</small>}</td><td>{item.progress}%</td><td>{item.review_status || '待处理'} · {item.refund_status || 'none'}</td><td><button className="admin-ghost" onClick={() => review(item)}>审核</button> <button className="admin-ghost" disabled={!item.task_key || item.refund_status === 'refunded'} onClick={() => review(item, true)}>返还 CDK</button></td></tr>)}</tbody></table>{!items.length && <Empty text="暂无部署任务" />}</div></section></>;
}

function CatalogAdminPage({ notify }: { notify: (notice: Notice) => void }) {
  const [items, setItems] = useState<CatalogAdminRecord[]>([]);
  const load = useCallback(() => adminApi.catalog().then(result => setItems(result.items)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  const save = async (item: CatalogAdminRecord) => {
    try { await adminApi.updateCatalog(item.id, item); notify({ kind: 'success', text: `${item.name} 已更新` }); await load(); }
    catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  const patch = (id: string, changes: Partial<CatalogAdminRecord>) => setItems(current => current.map(item => item.id === id ? { ...item, ...changes } : item));
  return <><PageHeading kicker="Catalog operations" title="目录运营" description="无需修改代码即可调整分类、排序、文案以及紧急上架或下架。" action={<button className="admin-ghost" onClick={load}><RefreshCw size={15} /> 刷新</button>} /><section className="admin-panel admin-table-panel"><div className="admin-table-wrap"><table><thead><tr><th>名称</th><th>分类</th><th>展示文案</th><th>排序</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><input value={item.name} onChange={event => patch(item.id, { name: event.target.value })} /><small> · {item.kind}</small></td><td><input value={item.category} onChange={event => patch(item.id, { category: event.target.value })} /></td><td><input value={item.description} onChange={event => patch(item.id, { description: event.target.value })} /></td><td><input type="number" value={item.sortOrder} onChange={event => patch(item.id, { sortOrder: Number(event.target.value) })} /></td><td><button className={`status-toggle ${item.enabled ? 'on' : ''}`} onClick={() => patch(item.id, { enabled: !item.enabled })}>{item.enabled ? '已上架' : '已下架'}</button></td><td><button className="admin-ghost" onClick={() => save(item)}>保存</button></td></tr>)}</tbody></table></div></section></>;
}

function ResourcesPage({ notify }: { notify: (notice: Notice) => void }) {
  const [items, setItems] = useState<ResourceRecord[]>([]);
  const [form, setForm] = useState({ type: 'vps' as ResourceRecord['type'], title: '', description: '', badge: '', url: '', enabled: 1, sort_order: 100 });
  const load = useCallback(() => adminApi.resources().then(result => setItems(result.items)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: FormEvent) => { event.preventDefault(); try { await adminApi.createResource(form); setForm({ type: 'vps', title: '', description: '', badge: '', url: '', enabled: 1, sort_order: 100 }); notify({ kind: 'success', text: '推荐资源已创建' }); await load(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const toggle = async (item: ResourceRecord) => { try { await adminApi.updateResource(item.id, { enabled: item.enabled ? 0 : 1 }); await load(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const patch = (id: string, changes: Partial<ResourceRecord>) => setItems(current => current.map(item => item.id === id ? { ...item, ...changes } : item));
  const save = async (item: ResourceRecord) => { try { await adminApi.updateResource(item.id, item); notify({ kind: 'success', text: '推荐资源已保存' }); await load(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const remove = async (item: ResourceRecord) => { if (!window.confirm(`删除推荐“${item.title}”？`)) return; try { await adminApi.deleteResource(item.id); notify({ kind: 'success', text: '推荐资源已删除' }); await load(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  return <><PageHeading kicker="Recommendations" title="资源推荐与点击统计" description="维护 VPS、域名、CDN 等 HTTPS 推荐链接，并查看真实点击次数。" /><div className="admin-two-column narrow-right"><section className="admin-panel admin-table-panel"><div className="admin-table-wrap"><table><thead><tr><th>标题</th><th>链接</th><th>点击</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><input value={item.title} onChange={event => patch(item.id, { title: event.target.value })} /></td><td><input type="url" value={item.url} onChange={event => patch(item.id, { url: event.target.value })} /></td><td>{item.click_count}</td><td><button className={`status-toggle ${item.enabled ? 'on' : ''}`} onClick={() => toggle(item)}>{item.enabled ? '上架' : '下架'}</button></td><td><button className="admin-ghost" onClick={() => save(item)}>保存</button> <button className="admin-ghost" onClick={() => remove(item)}>删除</button></td></tr>)}</tbody></table>{!items.length && <Empty text="尚未配置推荐资源" />}</div></section><form className="admin-panel" onSubmit={create}><PanelTitle icon={PackagePlus} title="新增推荐" subtitle="仅允许 HTTPS 外链" /><label className="admin-field"><span>类型</span><select value={form.type} onChange={event => setForm({ ...form, type: event.target.value as ResourceRecord['type'] })}><option value="vps">VPS</option><option value="domain">域名</option><option value="cdn">CDN</option><option value="other">其他</option></select></label><AdminInput label="标题" value={form.title} setValue={title => setForm({ ...form, title })} required /><AdminInput label="说明" value={form.description} setValue={description => setForm({ ...form, description })} /><AdminInput label="标签" value={form.badge} setValue={badge => setForm({ ...form, badge })} /><AdminInput label="HTTPS 链接" type="url" value={form.url} setValue={url => setForm({ ...form, url })} required /><button className="admin-primary">创建推荐</button></form></div></>;
}

function BackupsPage({ notify }: { notify: (notice: Notice) => void }) {
  const [items, setItems] = useState<BackupRecord[]>([]);
  const load = useCallback(() => adminApi.backups().then(result => setItems(result.items)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  const passphrase = () => window.prompt('输入备份加密密码（至少 12 位）。密码不会保存到数据库。') || '';
  const create = async () => { try { await adminApi.createBackup(passphrase()); notify({ kind: 'success', text: '加密 .pgbak 备份已创建' }); await load(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const preview = async (item: BackupRecord) => { try { const result = await adminApi.previewBackup(item.id, passphrase()); window.alert(JSON.stringify(result.preview, null, 2)); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const restore = async (item: BackupRecord) => { if (!window.confirm('恢复前会自动创建快照；恢复后当前会话可能失效。确定继续？')) return; try { const result = await adminApi.restoreBackup(item.id, passphrase()); notify({ kind: 'success', text: result.message }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const upload = async (file?: File) => { if (!file) return; try { await adminApi.uploadBackup(file); notify({ kind: 'success', text: '备份已上传，可先预览再恢复' }); await load(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  return <><PageHeading kicker="Encrypted migration" title="全站备份与迁移" description="AES-256-GCM 加密核心业务数据与 CDK 密钥，不包含 SSH 密码、私钥或临时会话。" action={<><label className="admin-ghost">上传 .pgbak<input type="file" accept=".pgbak" hidden onChange={event => void upload(event.target.files?.[0])} /></label><button className="admin-primary" onClick={create}>创建手动备份</button></>} /><section className="admin-panel admin-table-panel"><div className="admin-table-wrap"><table><thead><tr><th>文件</th><th>原因</th><th>大小</th><th>时间</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.filename}</td><td>{item.reason}</td><td>{Math.ceil(item.size_bytes / 1024)} KB</td><td>{formatDate(item.created_at)}</td><td><a className="admin-ghost" href={`/api/admin/backups/${item.id}/download`}>下载</a> <button className="admin-ghost" onClick={() => preview(item)}>预览</button> <button className="admin-ghost" onClick={() => restore(item)}>恢复</button></td></tr>)}</tbody></table>{!items.length && <Empty text="暂无备份记录" />}</div></section></>;
}

function UpdatePage({ notify }: { notify: (notice: Notice) => void }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [adapterVersion, setAdapterVersion] = useState('built-in');
  const [signingConfigured, setSigningConfigured] = useState(false);
  const [security, setSecurity] = useState<SecurityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => Promise.all([adminApi.updateStatus(), adminApi.securityReport()]).then(([result, securityResult]) => { setState(result.state); setChannel(result.state.channel); setAdapterVersion(result.adapterCatalogVersion); setSigningConfigured(result.signingConfigured); setSecurity(securityResult.report); }).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!state || !['applying', 'restarting'].includes(state.phase)) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [state?.phase, load]);
  const check = async () => { setBusy(true); try { const result = await adminApi.checkUpdate(channel); setState(result.state); notify({ kind: 'success', text: result.state.message }); } catch (error) { notify({ kind: 'error', text: message(error) }); await load(); } finally { setBusy(false); } };
  const prepare = async () => { const passphrase = window.prompt('输入更新前备份密码（至少 12 位）') || ''; setBusy(true); try { const result = await adminApi.prepareUpdate(passphrase); setState(result.state); notify({ kind: 'success', text: result.state.message }); } catch (error) { notify({ kind: 'error', text: message(error) }); await load(); } finally { setBusy(false); } };
  const apply = async () => { if (!window.confirm('应用更新会短暂重启服务；失败时系统将自动回滚。确定继续？')) return; setBusy(true); try { const result = await adminApi.applyUpdate(); setState(result.state); notify({ kind: 'success', text: '更新执行器已启动，页面会自动跟踪重启状态' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); } };
  const adapters = async () => { setBusy(true); try { const result = await adminApi.updateAdapters(); setAdapterVersion(result.version); notify({ kind: 'success', text: `已更新 ${result.updated} 个适配器目录项` }); } catch (error) { notify({ kind: 'error', text: message(error) }); } finally { setBusy(false); } };
  const terminal = state && ['completed', 'rolled_back', 'failed'].includes(state.phase);
  return <><PageHeading kicker="Signed updates" title="系统更新与回滚" description="只接受受信任 Ed25519 签名清单和 SHA-256 匹配的构建包；更新状态保存在独立数据目录，服务重启后仍可继续读取。" action={<button className="admin-ghost" onClick={load}><RefreshCw size={15} /> 刷新状态</button>} />
    {!signingConfigured && <div className="admin-inline-notice error">未找到正式发布签名公钥，在线更新已安全禁用。请使用正式发布包或配置 PANELARK_UPDATE_PUBLIC_KEY。</div>}
    <div className="admin-stat-grid"><article className="admin-stat"><span><RefreshCw size={18} /></span><small>当前版本</small><strong>{state?.currentVersion || '—'}</strong></article><article className="admin-stat"><span><ShieldCheck size={18} /></span><small>签名状态</small><strong>{signingConfigured ? '可信' : '未配置'}</strong></article><article className="admin-stat"><span><Layers3 size={18} /></span><small>适配器目录</small><strong>{adapterVersion}</strong></article><article className="admin-stat"><span><Activity size={18} /></span><small>更新进度</small><strong>{state?.progress ?? 0}%</strong></article></div>
    <div className="admin-two-column"><section className="admin-panel"><PanelTitle icon={RefreshCw} title="更新控制" subtitle={`当前 ${state?.currentVersion || '—'} · 目标 ${state?.targetVersion || '未检查'}`} /><label className="admin-field"><span>更新通道</span><select value={channel} onChange={event => setChannel(event.target.value as 'stable' | 'beta')} disabled={busy || Boolean(state && ['applying', 'restarting'].includes(state.phase))}><option value="stable">稳定通道</option><option value="beta">测试通道</option></select></label><div className="modal-actions"><button className="admin-ghost" disabled={busy || !signingConfigured} onClick={check}>检查更新</button>{state?.phase === 'available' && <button className="admin-primary" disabled={busy} onClick={prepare}>备份并下载</button>}{state?.phase === 'prepared' && <button className="admin-primary" disabled={busy} onClick={apply}>应用更新</button>}</div>{state?.manifest?.adapterCatalog && <button className="admin-ghost" disabled={busy} onClick={adapters}>独立更新适配器目录至 {state.manifest.adapterCatalog.version}</button>}</section><section className="admin-panel"><PanelTitle icon={Activity} title="真实更新状态" subtitle={state?.updatedAt ? `最后更新 ${formatDate(state.updatedAt)}` : '等待检查'} /><div className="progress-track large"><div style={{ width: `${state?.progress ?? 0}%` }}><span /></div></div><p className={terminal && state?.phase === 'failed' ? 'admin-warning' : 'admin-readonly'}>{state?.message || '尚未检查更新'}</p>{state?.preUpdateBackup && <p className="admin-readonly">更新前备份：<code>{state.preUpdateBackup}</code></p>}{state?.error && <p className="admin-warning">{state.error}</p>}</section></div>
    <section className="admin-panel admin-table-panel"><PanelTitle icon={FileClock} title="更新事件" subtitle="服务重启后继续从持久化状态读取" /><div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>阶段</th><th>进度</th><th>说明</th></tr></thead><tbody>{[...(state?.events || [])].reverse().map((event, index) => <tr key={`${event.at}-${index}`}><td>{formatDate(event.at)}</td><td><code>{event.phase}</code></td><td>{event.progress}%</td><td>{event.message}</td></tr>)}</tbody></table>{!state?.events.length && <Empty text="暂无更新事件" />}</div></section>
    <section className="admin-panel admin-table-panel"><PanelTitle icon={ShieldCheck} title="安全基线检查" subtitle={security ? `${security.failed} 项失败 · ${security.warnings} 项建议` : '正在读取'} /><div className="admin-table-wrap"><table><thead><tr><th>检查项</th><th>结果</th><th>说明</th></tr></thead><tbody>{security?.checks.map(check => <tr key={check.id}><td>{check.label}</td><td><span className={`admin-status ${check.status === 'pass' ? 'active' : check.status === 'fail' ? 'disabled' : 'refunded'}`}>{check.status === 'pass' ? '通过' : check.status === 'fail' ? '失败' : '建议'}</span></td><td>{check.detail}</td></tr>)}</tbody></table></div></section>
  </>;
}

function AuditPage({ notify }: { notify: (notice: Notice) => void }) {
  const [items, setItems] = useState<AuditRecord[]>([]);
  const load = useCallback(() => adminApi.audit().then(result => setItems(result.items)).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void load(); }, [load]);
  return <><PageHeading kicker="Audit trail" title="操作审计" description="关键后台操作、登录和安全事件均保留服务端审计记录。" action={<button className="admin-ghost" onClick={load}><RefreshCw size={15} /> 刷新</button>} /><section className="admin-panel admin-table-panel"><div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>目标</th><th>IP</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{formatDate(item.created_at)}</td><td>{item.username || '系统/访客'}</td><td><code>{item.action}</code></td><td>{item.target_type || '—'} {item.target_id ? `· ${item.target_id.slice(0, 8)}` : ''}</td><td>{item.ip || '—'}</td></tr>)}</tbody></table>{!items.length && <Empty text="暂无审计记录" />}</div></section></>;
}

function AccountPage({ admin, onChanged, notify }: { admin: AdminIdentity; onChanged: (admin: AdminIdentity) => void; notify: (notice: Notice) => void }) {
  const [form, setForm] = useState({ username: admin.username, currentPassword: '', newPassword: '' });
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [totp, setTotp] = useState<{ secret: string; code: string } | null>(null);
  const loadSessions = useCallback(() => adminApi.sessions().then(result => { setSessions(result.items); setCurrentSessionId(result.currentSessionId); }).catch(error => notify({ kind: 'error', text: message(error) })), [notify]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { const result = await adminApi.updateAccount(form); onChanged(result.admin); setForm(current => ({ ...current, currentPassword: '', newPassword: '' })); notify({ kind: 'success', text: '账号信息已安全更新' }); }
    catch (error) { notify({ kind: 'error', text: message(error) }); }
  };
  const setup2fa = async () => { try { const result = await adminApi.setup2fa(form.currentPassword); setTotp({ secret: result.secret, code: '' }); notify({ kind: 'success', text: '请将密钥加入验证器并输入动态码确认' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const enable2fa = async () => { if (!totp) return; try { await adminApi.enable2fa(totp.code); setTotp(null); onChanged({ ...admin, totpEnabled: true }); notify({ kind: 'success', text: '2FA 已启用，下次登录必须输入动态验证码' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const disable2fa = async () => { const code = window.prompt('输入当前 2FA 动态验证码') || ''; try { await adminApi.disable2fa(form.currentPassword, code); onChanged({ ...admin, totpEnabled: false }); notify({ kind: 'success', text: '2FA 已停用' }); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  const revoke = async (id: string) => { try { const result = await adminApi.revokeSession(id); if (result.currentRevoked) window.location.reload(); else await loadSessions(); } catch (error) { notify({ kind: 'error', text: message(error) }); } };
  return <><PageHeading kicker="Personal security" title="我的账号" description="管理密码、双重验证与全部登录会话。修改密码会注销其他管理会话。" /><div className="admin-two-column"><form className="admin-panel admin-account-form" onSubmit={submit}><PanelTitle icon={UserCog} title="账号资料" subtitle="用户名与强密码" /><AdminInput label="管理员用户名" value={form.username} setValue={username => setForm({ ...form, username })} required /><AdminInput label="当前密码" type="password" value={form.currentPassword} setValue={currentPassword => setForm({ ...form, currentPassword })} required /><AdminInput label="新密码（不修改可留空）" type="password" value={form.newPassword} setValue={newPassword => setForm({ ...form, newPassword })} placeholder="至少 12 位，含大小写、数字和符号" /><button className="admin-primary">确认更新</button></form><section className="admin-panel"><PanelTitle icon={ShieldCheck} title="双重验证" subtitle="兼容标准 TOTP 验证器" />{totp ? <><p className="admin-warning">密钥：<code>{totp.secret}</code></p><AdminInput label="当前动态验证码" value={totp.code} setValue={code => setTotp({ ...totp, code: code.replace(/\D/g, '').slice(0, 6) })} /><button className="admin-primary" onClick={enable2fa}>确认启用 2FA</button></> : admin.totpEnabled ? <><p className="admin-readonly">2FA 已启用。停用前请在左侧输入当前密码。</p><button className="admin-ghost" type="button" onClick={disable2fa}>停用 2FA</button></> : <><p className="admin-readonly">先在左侧输入当前密码，再生成仅本次显示的 TOTP 密钥。</p><button className="admin-primary" type="button" onClick={setup2fa}>设置 2FA</button></>}</section></div><section className="admin-panel admin-table-panel"><PanelTitle icon={FileClock} title="登录会话" subtitle="可撤销其他设备或当前会话" /><div className="admin-table-wrap"><table><thead><tr><th>设备</th><th>IP</th><th>最后活动</th><th>操作</th></tr></thead><tbody>{sessions.map(item => <tr key={item.id}><td>{item.user_agent?.slice(0, 60) || '未知设备'}{item.id === currentSessionId && <small> · 当前</small>}</td><td>{item.ip || '—'}</td><td>{formatDate(item.last_seen_at)}</td><td><button className="admin-ghost" onClick={() => revoke(item.id)}>撤销</button></td></tr>)}</tbody></table></div></section></>;
}

function PanelTitle({ icon: Icon, title, subtitle }: { icon: typeof Gauge; title: string; subtitle: string }) { return <div className="admin-panel-title"><span><Icon size={18} /></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>; }
function AdminInput({ label, value, setValue, type = 'text', placeholder, required, disabled }: { label: string; value: string; setValue: (value: string) => void; type?: string; placeholder?: string; required?: boolean; disabled?: boolean }) { return <label className="admin-field"><span>{label}</span><input type={type} value={value} onChange={event => setValue(event.target.value)} placeholder={placeholder} required={required} disabled={disabled} /></label>; }
function StatusBadge({ status }: { status: CdkRecord['status'] }) { const names = { active: '启用', disabled: '停用', refunded: '已返还' }; return <span className={`admin-status ${status}`}>{names[status]}</span>; }
function Empty({ text }: { text: string }) { return <div className="admin-empty">{text}</div>; }

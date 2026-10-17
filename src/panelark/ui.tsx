import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  CircleDot,
  Code2,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  Menu,
  MemoryStick,
  Moon,
  Network,
  Search,
  Server,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { navItems } from './catalog';
import {
  validateCdk,
  type CdkGrant,
  type RecommendedResource,
  type ServerEnvironment,
} from './api';
import type { CatalogItem, Theme, View } from './types';
import { PurchaseLink } from './PurchaseLink';
import { PanelArkMark } from '../components/PanelArkMark';
export { AutomaticServerModal as ServerConnectModal, AutomaticDeploymentModal as DeployModal } from './automatic-ui';

export function Header({
  theme,
  view,
  mobileMenuOpen,
  deploymentUnlocked,
  serverConnected,
  onToggleTheme,
  onToggleMenu,
  onViewChange,
  onConnect,
}: {
  theme: Theme;
  view: View;
  mobileMenuOpen: boolean;
  deploymentUnlocked: boolean;
  serverConnected: boolean;
  onToggleTheme: () => void;
  onToggleMenu: () => void;
  onViewChange: (view: View) => void;
  onConnect: () => void;
  purchaseEnabled: boolean;
  purchaseButtonText: string;
}) {
  return (
    <header className="site-header">
      <div className="nav-wrap">
        <button className="brand" onClick={() => onViewChange('deploy')} aria-label="面板部署中心">
          <span className="brand-mark"><PanelArkMark size={29} /></span>
          <span className="brand-word">PanelArk</span>
        </button>

        <nav className={`main-nav ${mobileMenuOpen ? 'is-open' : ''}`} aria-label="主导航">
          {navItems.map(item => (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => onViewChange(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="nav-actions">
          <button className={`access-pill ${deploymentUnlocked ? 'unlocked' : ''}`} onClick={onConnect}>
            {deploymentUnlocked ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
            <span>{deploymentUnlocked ? '部署已解锁' : '只读浏览'}</span>
          </button>
          <button className={`server-pill ${serverConnected ? 'connected' : ''}`} onClick={onConnect} title={serverConnected ? '查看当前服务器' : '连接服务器'}>
            <CircleDot size={14} />
            <span>{serverConnected ? '服务器已就绪' : '未连接服务器'}</span>
          </button>
          <button className="icon-button theme-toggle" onClick={onToggleTheme} aria-label="切换主题">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button menu-toggle" onClick={onToggleMenu} aria-label="打开导航菜单">
            {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
    </header>
  );
}

export function CatalogPage({
  items,
  title,
  eyebrow,
  description,
  deploymentUnlocked,
  serverConnected,
  serverEnvironment,
  onDeploy,
  onConnect,
  purchaseEnabled,
  purchaseButtonText,
  cdkGrant,
}: {
  items: CatalogItem[];
  title: string;
  eyebrow: string;
  description: string;
  deploymentUnlocked: boolean;
  serverConnected: boolean;
  serverEnvironment?: ServerEnvironment;
  onDeploy: (item: CatalogItem) => void;
  onConnect: () => void;
  purchaseEnabled: boolean;
  purchaseButtonText: string;
  cdkGrant?: CdkGrant | null;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const categories = useMemo(() => ['全部', ...Array.from(new Set(items.map(item => item.category)))], [items]);
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter(item => (category === '全部' || item.category === category) && (!normalized || `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(normalized)));
  }, [category, items, query]);

  return (
    <section className="section-shell page-section">
      <div className="page-hero">
        <div><span className="eyebrow plain">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
        <div className="catalog-access-actions">
        <div className={`connection-card ${serverConnected ? 'connected' : deploymentUnlocked ? 'unlocked' : ''}`}>
          <div className="connection-icon">{deploymentUnlocked ? <Server size={20} /> : <LockKeyhole size={20} />}</div>
          <div><small>{deploymentUnlocked ? '目标服务器' : '当前权限'}</small><strong>{serverEnvironment?.targetHost || (deploymentUnlocked ? '等待连接' : '只读浏览')}</strong></div>
          <div className="connection-actions"><button onClick={onConnect}>{serverConnected ? '更换服务器' : deploymentUnlocked ? '填写服务器' : '验证 CDK'}</button><PurchaseLink enabled={purchaseEnabled} text={purchaseButtonText} /></div>
        </div>
        {cdkGrant && deploymentUnlocked && <div className="cdk-usage" role="status">{cdkGrant.packageName} · 总次数 {cdkGrant.totalUses ?? '—'} · 已用 {cdkGrant.usedCount ?? '—'} · 剩余 {cdkGrant.remaining} 次{Boolean(cdkGrant.lockedCount) && `（另有 ${cdkGrant.lockedCount} 次使用中）`}</div>}
        </div>
      </div>

      <DeploymentFlow step={!deploymentUnlocked ? 1 : !serverConnected ? 2 : 3} />

      <div className="catalog-toolbar glass-card">
        <label className="search-box"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索面板或工具…" /></label>
        <div className="filter-scroll">
          {categories.map(item => <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
      </div>

      {visibleItems.length ? (
        <div className="catalog-grid">
          {visibleItems.map(item => <CatalogCard key={item.id} item={item} deploymentUnlocked={deploymentUnlocked} serverConnected={serverConnected} onDeploy={onDeploy} />)}
        </div>
      ) : (
        <div className="empty-state glass-card"><Search size={30} /><h3>没有找到匹配项</h3><p>尝试更换关键词或选择其他分类。</p><button className="button button-secondary" onClick={() => { setQuery(''); setCategory('全部'); }}>清除筛选</button></div>
      )}
    </section>
  );
}

function CatalogCard({ item, deploymentUnlocked, serverConnected, onDeploy }: { item: CatalogItem; deploymentUnlocked: boolean; serverConnected: boolean; onDeploy: (item: CatalogItem) => void }) {
  const Icon = item.icon;
  const requirements = item.requirements;
  return (
    <article className="catalog-card glass-card">
      <div className="catalog-card-head">
        <span className={`product-icon ${item.accent}`}><Icon size={24} /></span>
        <div className="status-stack">{item.featured && <span className="tag gold-tag">推荐</span>}{serverConnected && typeof item.installed === 'boolean' ? <span className={`tag ${item.installed ? 'success-tag' : 'neutral-tag'}`}>{item.installed ? '已安装' : '未安装'}</span> : null}</div>
      </div>
      <div className="catalog-card-copy"><span className="category-label">{item.category}</span><h3>{item.name}</h3><p>{item.description}</p></div>
      <div className="catalog-meta"><span><Code2 size={14} /> {item.version}</span><span><MemoryStick size={14} /> {item.memory}</span><span><Network size={14} /> {item.port}</span></div>
      <div className="catalog-requirements">
        {item.supportedSystems?.length ? <span><strong>适用系统</strong>{item.supportedSystems.join(' · ')}</span> : null}
        {requirements?.architectures?.length ? <span><strong>支持架构</strong>{requirements.architectures.join(' / ')}</span> : null}
        {requirements?.minDiskMb ? <span><strong>可用磁盘</strong>{requirements.minDiskMb >= 1024 ? `${requirements.minDiskMb / 1024} GB+` : `${requirements.minDiskMb} MB+`}</span> : null}
        {requirements?.systemd ? <span><strong>运行条件</strong>systemd · 可联网</span> : null}
      </div>
      {requirements?.autoInstallDependencies?.length ? <div className="catalog-auto-dependency"><Boxes size={14} /><span><strong>无需手工准备</strong>缺少 {requirements.autoInstallDependencies.join(' + ')} 时自动安装并验证</span></div> : null}
      <button className="button button-card" onClick={() => onDeploy(item)}>
        {!deploymentUnlocked ? <><LockKeyhole size={15} /> 先验证并检测服务器</> : !serverConnected ? <><Server size={15} /> 先填写服务器信息</> : item.installed ? <>重新部署 <ArrowRight size={16} /></> : <>一键部署 <ArrowRight size={16} /></>}
      </button>
    </article>
  );
}

export function DocsPage({ onStart }: { onStart: () => void }) {
  return (
    <section className="section-shell page-section docs-page">
      <div className="page-hero docs-hero">
        <div><span className="eyebrow plain">Deployment documentation</span><h1>部署文档</h1><p>完成 CDK 授权、填写服务器、选择面板，后续自动执行并交付结果。</p></div>
        <button className="button button-primary" onClick={onStart}>验证并开始部署 <ArrowRight size={16} /></button>
      </div>
      <div className="docs-layout">
        <aside className="docs-nav glass-card"><span>快速开始</span><a href="#deployment-flow-doc">部署流程</a><a href="#server-requirements-doc">服务器要求</a><a href="#cdk-doc">CDK 授权</a><a href="#network-doc">端口与防火墙</a><a href="#result-doc">结果与故障处理</a></aside>
        <article className="docs-content glass-card">
          <span className="doc-kicker">QUICK START</span><h2 id="deployment-flow-doc">标准部署流程</h2>
          <p>CDK不会阻止你查看网站，但在验证通过前，服务器凭据、面板参数等执行型表单保持锁定。</p>
          {[
            ['浏览支持内容', '无需授权即可查看面板、工具、文档和资源推荐。'],
            ['验证 CDK', '点击开始部署后验证权益，成功后解锁操作表单。'],
            ['填写服务器', '输入 SSH 信息，系统自动连接并检测，无需单独确认指纹或安装依赖。'],
            ['选择安装项目', '点击需要安装的面板或工具，系统自动处理兼容性、依赖、端口和本机防火墙。'],
            ['等待并保存结果', '安装成功后返回实际登录信息，结果不会自动关闭，可复制或下载后手动关闭；失败时显示原因与处理建议。'],
          ].map(([stepTitle, copy], index) => <div className="doc-step" key={stepTitle}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{stepTitle}</h3><p>{copy}</p></div></div>)}
          <div className="doc-note"><ShieldCheck size={18} /><p><strong>安全提示</strong>真实版本不会在普通日志中显示 SSH 密码、私钥、CDK 明文或面板密钥。</p></div>
          <h2 id="server-requirements-doc">服务器要求</h2><p>使用项目卡片列出的 Linux 系统与 CPU 架构，并满足内存、磁盘要求。SSH 账号需要 root 或免密 sudo 权限。请先确认填写的服务器地址正确，首次连接由系统自动记录并校验本次会话的主机指纹。</p>
          <h2 id="cdk-doc">CDK 授权</h2><p>验证不扣除次数。安装任务开始后锁定额度，成功才核销；失败自动释放。授权码的使用范围由套餐决定。</p>
          <h2 id="network-doc">端口与防火墙</h2><p>可调整的服务端口遇到占用时自动分配空闲端口；固定端口冲突且无法安全处理时会停止，不中断已有业务。本机 UFW / firewalld 自动放行。云厂商安全组无法由系统代为修改，结果会列出需要放行的实际端口。</p>
          <h2 id="result-doc">结果与故障处理</h2><p>成功后显示实际访问地址、账号、密码或管理密钥。结果不会自动关闭，也不能通过遮罩或 Esc 关闭；请先复制或下载保存，刷新或离开页面后不可重新查看。第三方账号 OAuth 授权及个人 API 凭据配置仍由账号本人完成。失败页面会提供原因、处理建议和任务编号。</p>
        </article>
      </div>
    </section>
  );
}

export function Footer({ onNavigate }: { onNavigate: (view: View) => void }) {
  return (
    <footer className="site-footer"><div className="footer-inner">
      <div><div className="brand footer-brand"><span className="brand-mark"><PanelArkMark size={27} /></span><span className="brand-word">PanelArk</span></div><p>连接服务器，一键装好所需面板。</p></div>
      <div className="footer-links"><button onClick={() => onNavigate('deploy')}>面板部署</button><button onClick={() => onNavigate('tools')}>工具箱</button><button onClick={() => onNavigate('docs')}>部署文档</button><button onClick={() => onNavigate('resources')}>资源推荐</button></div>
      <span className="footer-note">PanelArk · Secure deployment access</span>
    </div></footer>
  );
}

export function ResourcesPage({ items }: { items: RecommendedResource[] }) {
  return <section className="section-shell page-section resources-page"><div className="page-hero"><div><span className="eyebrow plain">Recommended resources</span><h1>资源推荐</h1><p>服务器、域名及其他部署资源独立展示，不打断安装流程。</p></div></div>
    {items.length ? <div className="resource-grid">{items.map((item, index) => <article className="resource-card" key={item.id}><div className="resource-number">{String(index + 1).padStart(2, '0')}</div><div><span>{item.badge}</span><h3>{item.title}</h3><p>{item.description}</p></div><a href={`/api/resources/${encodeURIComponent(item.id)}/open`} target="_blank" rel="noopener noreferrer" aria-label={`查看${item.title}`}><ExternalLink size={17} /></a></article>)}</div> : <div className="empty-state glass-card"><Boxes size={28} /><h3>暂无推荐资源</h3><p>站点发布的推荐资源将在这里展示。</p></div>}
  </section>;
}

export function CdkGateModal({ onClose, onVerified, purchaseEnabled, purchaseButtonText }: { onClose: () => void; onVerified: (grant: CdkGrant) => void; purchaseEnabled: boolean; purchaseButtonText: string }) {
  const [cdk, setCdk] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const verify = async () => {
    if (!/^PAK-[A-Z0-9-]{8,}$/.test(cdk.trim().toUpperCase())) {
      setError('请输入有效的 PAK- 开头授权码');
      return;
    }
    setChecking(true);
    try {
      const grant = await validateCdk(cdk.trim().toUpperCase());
      onVerified(grant);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CDK 验证失败');
      setChecking(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className="modal cdk-modal" role="dialog" aria-modal="true" aria-labelledby="cdk-modal-title">
        <div className="modal-head"><div><span className="eyebrow plain">Deployment access</span><h2 id="cdk-modal-title">验证 CDK，解锁部署操作</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>
        <div className="modal-body license-body">
          <DeploymentFlow step={1} compact />
          <div className="license-icon"><KeyRound size={26} /></div>
          <h3>浏览免费，执行需要授权</h3>
          <p>验证前可以查看全部公开内容，但不能填写服务器凭据或部署参数。验证不会立即扣除次数，安装成功后才核销。</p>
          <label className={`field license-field ${error ? 'has-error' : ''}`}><span>CDK 授权码</span><input value={cdk} onChange={event => { setCdk(event.target.value); setError(''); }} placeholder="PAK-XXXX-XXXX-XXXX" autoFocus />{error && <small className="field-error">{error}</small>}</label>
          <div className="license-benefit"><CheckCircle2 size={17} /><span>验证成功后，下一步先填写和检测服务器，再选择兼容面板</span></div>
          <div className="modal-actions license-actions"><button className="button button-primary" onClick={verify} disabled={checking}>{checking ? '正在验证…' : '验证 CDK'} {!checking && <ArrowRight size={16} />}</button><PurchaseLink enabled={purchaseEnabled} text={purchaseButtonText} /></div>
        </div>
      </section>
    </div>
  );
}

function DeploymentFlow({ step, compact = false }: { step: 1 | 2 | 3; compact?: boolean }) {
  const steps = ['验证 CDK', '检测服务器', '选择面板'];
  return <div className={`deployment-flow ${compact ? 'compact' : ''}`} aria-label="部署步骤">
    {steps.map((label, index) => {
      const number = index + 1;
      const state = number < step ? 'done' : number === step ? 'active' : '';
      return <div className={state} key={label} aria-current={number === step ? 'step' : undefined}><span>{number < step ? <Check size={13} /> : number}</span><strong>{label}</strong>{index < steps.length - 1 && <i aria-hidden="true" />}</div>;
    })}
  </div>;
}

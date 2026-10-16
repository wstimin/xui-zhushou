import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  FileCode2,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Menu,
  MemoryStick,
  Moon,
  Network,
  PackageCheck,
  Play,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { deploymentPorts, hasConfigurablePort, navItems, panels } from './catalog';
import {
  checkServerPorts,
  connectServer,
  consumeCdk,
  createDeploymentJob,
  disconnectServer,
  getDeploymentResult,
  releaseCdk,
  inspectRemoteServer,
  installDockerRuntime,
  installServerDependencies,
  lockCdk,
  openServerFirewall,
  restoreService,
  startDeploymentJob,
  subscribeDeploymentJob,
  temporarilyStopService,
  validateCdk,
  type CdkGrant,
  type PortState,
  type RecommendedResource,
  type ServerEnvironment,
} from './api';
import type { ActiveServer, CatalogItem, ServerDraft, Theme, View } from './types';
import { PurchaseLink } from './PurchaseLink';
import { PanelArkMark } from '../components/PanelArkMark';

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
  purchaseEnabled,
  purchaseButtonText,
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
        <button className="brand" onClick={() => onViewChange('home')} aria-label="返回首页">
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
          <PurchaseLink enabled={purchaseEnabled} text={purchaseButtonText} className="header-purchase" />
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

export function HomePage({
  catalogItems,
  recommendedResources,
  onOpenResource,
  deploymentUnlocked,
  serverConnected,
  serverEnvironment,
  onStart,
  purchaseEnabled,
  onOpenDocs,
  onViewPanels,
  onConnect,
  onToast,
  purchaseButtonText,
}: {
  catalogItems?: CatalogItem[];
  recommendedResources: RecommendedResource[];
  onOpenResource: (id: string) => void;
  deploymentUnlocked: boolean;
  serverConnected: boolean;
  serverEnvironment?: ServerEnvironment;
  onStart: () => void;
  purchaseEnabled: boolean;
  onOpenDocs: () => void;
  onViewPanels: () => void;
  onConnect: () => void;
  onToast: (message: string) => void;
  purchaseButtonText: string;
}) {
  return (
    <>
      <section className="hero section-shell">
        <div className="hero-copy reveal-up">
          <div className="eyebrow"><Sparkles size={14} /> VPS deployment, refined.</div>
          <h1>一键部署，<br /><em>优雅高效。</em></h1>
          <p className="hero-lead">连接 Linux 服务器，PanelArk 自动检测环境、补齐依赖并处理端口问题，将繁琐的终端操作变成清晰可靠的部署流程。</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={onStart}>
              {serverConnected ? '选择部署面板' : deploymentUnlocked ? '填写服务器信息' : '验证 CDK 并开始'} <ArrowRight size={17} />
            </button>
            <PurchaseLink enabled={purchaseEnabled} text={purchaseButtonText} />
            <button className="button button-secondary" onClick={onOpenDocs}><BookOpen size={16} /> 查看文档</button>
          </div>
          <div className="trust-row">
            <span><ShieldCheck size={15} /> 安全预检</span>
            <span><Zap size={15} /> 自动依赖</span>
            <span><Boxes size={15} /> 多面板支持</span>
          </div>
        </div>

        <div className="hero-console reveal-up delay-one" aria-label="部署流程预览">
          <div className="console-orbit orbit-one" />
          <div className="console-orbit orbit-two" />
          <div className="console-card glass-card">
            <div className="console-head">
              <div><span className="micro-label">DEPLOYMENT SESSION</span><strong>{serverConnected ? 'Production VPS' : deploymentUnlocked ? '等待连接服务器' : '只读浏览状态'}</strong></div>
              <span className={`live-badge ${serverConnected ? 'online' : ''}`}><span /> {serverConnected ? 'READY' : 'STANDBY'}</span>
            </div>
            <div className="console-steps">
              {[
                ['01', '验证部署授权', deploymentUnlocked ? '完成' : '需要 CDK'],
                ['02', '连接并检测服务器', serverConnected ? '完成' : '授权后填写'],
                ['03', '选择并配置面板', '智能推荐'],
                ['04', '安装、验证与交付', '自动执行'],
              ].map(([index, label, state], itemIndex) => {
                const done = (deploymentUnlocked && itemIndex === 0) || (serverConnected && itemIndex < 2);
                return (
                  <div className={`console-step ${done ? 'done' : ''}`} key={index}>
                    <span className="step-index">{index}</span>
                    <div><strong>{label}</strong><small>{state}</small></div>
                    {done ? <Check size={17} /> : <ChevronRight size={17} />}
                  </div>
                );
              })}
            </div>
            <button className="console-action" onClick={serverConnected ? onViewPanels : onConnect}>
              {deploymentUnlocked ? <Terminal size={16} /> : <KeyRound size={16} />}
              {serverConnected ? '浏览兼容面板' : deploymentUnlocked ? '填写服务器信息' : '验证 CDK 解锁操作'}
            </button>
          </div>
          <div className="floating-chip chip-security"><ShieldCheck size={15} /> 安全执行边界</div>
          <div className="floating-chip chip-deps"><PackageCheck size={15} /> 依赖自动补齐</div>
        </div>
      </section>

      <section className="section-shell overview-section">
        <div className="section-heading compact-heading">
          <div><span className="eyebrow plain">Server overview</span><h2>{serverConnected ? '服务器已准备就绪' : deploymentUnlocked ? '等待连接服务器' : '验证后填写服务器信息'}</h2></div>
          <button className="text-link" onClick={onConnect}>{serverConnected ? '重新检测服务器' : deploymentUnlocked ? '连接服务器' : '解锁部署操作'} <ArrowRight size={15} /></button>
        </div>
        <div className="stats-grid">
          <StatCard icon={Server} label="操作系统" value={serverEnvironment?.osName || '等待检测'} meta={serverEnvironment ? `${serverEnvironment.arch} · ${serverEnvironment.systemdAvailable ? 'systemd' : '无 systemd'}` : '授权后读取真实系统'} locked={!deploymentUnlocked} />
          <StatCard icon={Cpu} label="处理器" value={serverEnvironment ? `${serverEnvironment.cpuCores} vCPU` : '等待检测'} meta={serverEnvironment ? `SSH 延迟 ${serverEnvironment.latencyMs}ms` : '授权后读取真实资源'} locked={!deploymentUnlocked} />
          <StatCard icon={MemoryStick} label="运行内存" value={serverEnvironment ? `${Math.round(serverEnvironment.totalRamMb / 102.4) / 10} GB` : '等待检测'} meta={serverEnvironment ? `可用 ${Math.round(serverEnvironment.freeRamMb / 102.4) / 10} GB` : '授权后读取真实资源'} locked={!deploymentUnlocked} />
          <StatCard icon={HardDrive} label="系统磁盘" value={serverEnvironment ? `可用 ${Math.round(serverEnvironment.diskFreeMb / 102.4) / 10} GB` : '等待检测'} meta={serverEnvironment ? `${serverEnvironment.packageManager} · ${serverEnvironment.firewall.kind}` : '授权后读取真实资源'} locked={!deploymentUnlocked} />
        </div>
      </section>

      <section className="section-shell feature-section">
        <div className="section-heading centered-heading">
          <span className="eyebrow plain">Built for confidence</span>
          <h2>复杂的服务器工作，<em>清晰地完成。</em></h2>
          <p>每一步都有依据、有反馈，也有明确的恢复边界。</p>
        </div>
        <div className="feature-grid">
          <FeatureCard icon={ShieldCheck} number="01" title="执行前先检查" description="识别系统、权限、资源、端口和已有服务，避免在不兼容环境中盲目安装。" />
          <FeatureCard icon={PackageCheck} number="02" title="依赖自动补齐" description="缺少安全依赖时自动安装并二次验证，存在业务风险时暂停并说明影响。" />
          <FeatureCard icon={Wrench} number="03" title="冲突可以选择" description="端口被占用时可换端口或临时停止服务，任务结束后按原状态恢复。" />
        </div>
      </section>

      <section className="section-shell showcase-section">
        <div className="showcase-card glass-card">
          <div className="showcase-copy">
            <span className="eyebrow plain">Curated catalog</span>
            <h2>不是脚本堆砌，<br />而是可审计的部署适配器。</h2>
            <p>每个上架面板都拥有明确的兼容范围、依赖声明、验证步骤与结果格式。</p>
            <button className="button button-secondary" onClick={onViewPanels}>探索面板目录 <ArrowRight size={16} /></button>
          </div>
          <div className="mini-catalog">
            {(catalogItems || panels).slice(0, 4).map(panel => {
              const Icon = panel.icon;
              return (
                <button key={panel.id} onClick={() => onToast(`${panel.name} 可在部署中心查看详情`)}>
                  <span className={`mini-icon ${panel.accent}`}><Icon size={18} /></span>
                  <span><strong>{panel.name}</strong><small>{panel.category}</small></span>
                  <ChevronRight size={16} />
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section-shell resource-section">
        <div className="section-heading compact-heading">
          <div><span className="eyebrow plain">Recommended resources</span><h2>为下一次部署准备合适的资源</h2></div>
          <span className="sponsored-note">推荐内容由后台配置</span>
        </div>
        <div className="resource-grid">
          {(recommendedResources.length ? recommendedResources : [
            { id: '', title: '全球 VPS', description: '覆盖常见区域与主流 Linux 镜像', badge: '适合面板部署' },
            { id: '', title: '域名与 DNS', description: '为面板入口和自动 SSL 做好准备', badge: '快速解析' },
            { id: '', title: '安全与 CDN', description: '为公开管理入口增加访问保护', badge: '按需启用' },
          ]).map((item, index) => (
            <article className="resource-card" key={`${item.id}-${item.title}`}>
              <div className="resource-number">0{index + 1}</div>
              <div><span>{item.badge}</span><h3>{item.title}</h3><p>{item.description}</p></div>
              <button onClick={() => item.id ? onOpenResource(item.id) : onToast('资源购买链接将由管理后台配置')} aria-label={`查看${item.title}`}><ExternalLink size={16} /></button>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function StatCard({ icon: Icon, label, value, meta, locked }: { icon: LucideIcon; label: string; value: string; meta: string; locked?: boolean }) {
  return (
    <article className={`stat-card glass-card ${locked ? 'locked-card' : ''}`}>
      <div className="stat-icon">{locked ? <LockKeyhole size={18} /> : <Icon size={19} />}</div>
      <span>{label}</span><strong>{locked ? '授权后可检测' : value}</strong><small>{locked ? '当前为只读浏览' : meta}</small>
    </article>
  );
}

function FeatureCard({ icon: Icon, number, title, description }: { icon: LucideIcon; number: string; title: string; description: string }) {
  return (
    <article className="feature-card glass-card">
      <div className="feature-top"><span className="feature-icon"><Icon size={21} /></span><span className="feature-number">{number}</span></div>
      <h3>{title}</h3><p>{description}</p>
    </article>
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
        <PurchaseLink enabled={purchaseEnabled} text={purchaseButtonText} />
        <div className={`connection-card ${serverConnected ? 'connected' : deploymentUnlocked ? 'unlocked' : ''}`}>
          <div className="connection-icon">{deploymentUnlocked ? <Server size={20} /> : <LockKeyhole size={20} />}</div>
          <div><small>{deploymentUnlocked ? '目标服务器' : '当前权限'}</small><strong>{serverEnvironment?.targetHost || (deploymentUnlocked ? '等待连接' : '只读浏览')}</strong></div>
          <button onClick={onConnect}>{serverConnected ? '重新检测' : deploymentUnlocked ? '连接服务器' : '验证 CDK'}</button>
        </div>
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
        <div className="status-stack">{item.featured && <span className="tag gold-tag">推荐</span>}{item.verifiedSystems?.length ? <span className="tag success-tag">部分系统已验收</span> : item.supportLevel === 'verified' ? <span className="tag success-tag">实机已验证</span> : item.supportLevel === 'pending' ? <span className="tag neutral-tag">待实机验收</span> : null}<span className={`tag ${item.installed ? 'success-tag' : 'neutral-tag'}`}>{item.installed ? '已安装' : '未安装'}</span></div>
      </div>
      <div className="catalog-card-copy"><span className="category-label">{item.category}</span><h3>{item.name}</h3><p>{item.description}</p></div>
      <div className="catalog-meta"><span><Code2 size={14} /> {item.version}</span><span><MemoryStick size={14} /> {item.memory}</span><span><Network size={14} /> {item.port}</span></div>
      <div className="catalog-requirements">
        {item.supportedSystems?.length ? <span><strong>适用系统</strong>{item.supportedSystems.join(' · ')}</span> : null}
        {item.verifiedSystems?.length ? <span><strong>实机已测</strong>{item.verifiedSystems.join('、')}；其他系统待验收</span> : null}
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
        <div><span className="eyebrow plain">Documentation</span><h1>从授权到交付，<br />每一步都清楚。</h1><p>公开内容可以自由浏览；服务器信息和部署表单在 CDK 验证后解锁。</p></div>
        <button className="button button-primary" onClick={onStart}>验证并开始部署 <ArrowRight size={16} /></button>
      </div>
      <div className="docs-layout">
        <aside className="docs-nav glass-card"><span>快速开始</span><button className="active">部署流程</button><button>服务器要求</button><button>CDK 授权</button><button>端口与防火墙</button><button>常见问题</button></aside>
        <article className="docs-content glass-card">
          <span className="doc-kicker">QUICK START</span><h2>标准部署流程</h2>
          <p>CDK不会阻止你查看网站，但在验证通过前，服务器凭据、面板参数等执行型表单保持锁定。</p>
          {[
            ['浏览支持内容', '无需授权即可查看面板、工具、文档和资源推荐。'],
            ['验证 CDK', '点击开始部署后验证权益，成功后解锁操作表单。'],
            ['连接服务器', '填写 SSH 信息并确认首次连接的主机指纹。'],
            ['选择并配置', '系统检查兼容性、依赖、端口和防火墙。'],
            ['安装与交付', '确认安装时锁定权益，成功验证后核销并返回结果。'],
          ].map(([stepTitle, copy], index) => <div className="doc-step" key={stepTitle}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{stepTitle}</h3><p>{copy}</p></div></div>)}
          <div className="doc-note"><ShieldCheck size={18} /><p><strong>安全提示</strong>真实版本不会在普通日志中显示 SSH 密码、私钥、CDK 明文或面板密钥。</p></div>
        </article>
      </div>
    </section>
  );
}

export function AboutPage({ onViewPanels }: { onViewPanels: () => void }) {
  return (
    <section className="section-shell page-section about-page">
      <div className="about-hero glass-card">
        <div className="about-mark"><PanelArkMark size={62} /></div><span className="eyebrow plain">About PanelArk</span>
        <h1>把复杂留在系统里，<br /><em>把确定性交给用户。</em></h1>
        <p>PanelArk 面向需要快速交付 VPS 面板的用户与服务者，专注安装前检查、可靠执行和可直接交付的结果。</p>
        <button className="button button-primary" onClick={onViewPanels}>查看支持面板 <ArrowRight size={16} /></button>
      </div>
      <div className="principle-grid">
        <article><span>01</span><h3>不盲目执行</h3><p>先检查环境和冲突，再生成清晰的执行计划。</p></article>
        <article><span>02</span><h3>不隐藏风险</h3><p>影响现有业务的操作必须说明影响并等待选择。</p></article>
        <article><span>03</span><h3>不伪造成功</h3><p>服务、端口、页面与凭据验证通过后才算完成。</p></article>
      </div>
    </section>
  );
}

export function Footer({ onNavigate }: { onNavigate: (view: View) => void }) {
  return (
    <footer className="site-footer"><div className="footer-inner">
      <div><div className="brand footer-brand"><span className="brand-mark"><PanelArkMark size={27} /></span><span className="brand-word">PanelArk</span></div><p>连接服务器，一键装好所需面板。</p></div>
      <div className="footer-links"><button onClick={() => onNavigate('deploy')}>面板部署</button><button onClick={() => onNavigate('tools')}>工具箱</button><button onClick={() => onNavigate('docs')}>使用文档</button><button onClick={() => onNavigate('about')}>关于我们</button></div>
      <span className="footer-note">PanelArk · Secure deployment access</span>
    </div></footer>
  );
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

export function ServerConnectModal({ onClose, onConnected, draft, onDraftChange, grantToken }: { onClose: () => void; onConnected: (server: ActiveServer) => void; draft: ServerDraft; onDraftChange: (draft: ServerDraft) => void; grantToken: string }) {
  const [phase, setPhase] = useState<'form' | 'connecting' | 'fingerprint' | 'scanning' | 'installing' | 'docker' | 'ready'>('form');
  const [confirmClose, setConfirmClose] = useState(false);
  const [formError, setFormError] = useState('');
  const [autoInstall, setAutoInstall] = useState(true);
  const [pending, setPending] = useState<{ sessionId: string; fingerprint: string; host: string; latencyMs: number } | null>(null);
  const [environment, setEnvironment] = useState<ServerEnvironment | null>(null);
  const [preparationError, setPreparationError] = useState('');
  const checks = ['建立加密 SSH 会话', '确认服务器主机指纹', '读取系统与架构信息', '检测权限、资源与依赖', '检查端口和防火墙', '生成兼容性结论'];
  const hasUserInput = Boolean(draft.host || draft.password || draft.privateKey || draft.port !== '22' || draft.username !== 'root' || draft.authType !== 'password');
  const busy = ['connecting', 'scanning', 'installing', 'docker'].includes(phase);

  const updateDraft = (changes: Partial<ServerDraft>) => {
    onDraftChange({ ...draft, ...changes });
    setFormError('');
  };

  const disconnectPending = async () => {
    if (!pending) return;
    try { await disconnectServer(grantToken, pending.sessionId); } catch { /* Session expiry needs no user action. */ }
  };

  const requestClose = () => {
    if (busy) return;
    if (phase === 'form' && hasUserInput) {
      setConfirmClose(true);
      return;
    }
    void disconnectPending();
    onClose();
  };

  const startScan = async () => {
    if (!draft.host.trim() || !draft.port.trim() || !draft.username.trim()) {
      setFormError('请完整填写服务器地址、SSH 端口和用户名');
      return;
    }
    if (draft.authType === 'password' ? !draft.password : !draft.privateKey.trim()) {
      setFormError(draft.authType === 'password' ? '请输入 SSH 密码' : '请输入 SSH 私钥');
      return;
    }
    setFormError(''); setPhase('connecting');
    try {
      const result = await connectServer(grantToken, {
        ipOrDomain: draft.host,
        sshPort: Number(draft.port),
        sshUser: draft.username,
        authType: draft.authType === 'key' ? 'privateKey' : 'password',
        sshPassword: draft.authType === 'password' ? draft.password : undefined,
        sshPrivateKey: draft.authType === 'key' ? draft.privateKey : undefined,
      });
      setPending({ sessionId: result.serverSessionId, fingerprint: result.fingerprint, host: result.host, latencyMs: result.latencyMs });
      setPhase('fingerprint');
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'SSH 连接失败');
      setPhase('form');
    }
  };

  const installMissing = async (details: ServerEnvironment) => {
    if (!pending || !details.missingDependencies.length) return details;
    setPhase('installing'); setPreparationError('');
    try {
      const result = await installServerDependencies(grantToken, pending.sessionId, details.missingDependencies.map(item => item.id));
      return { ...details, dependencies: result.dependencies, missingDependencies: result.dependencies.filter(item => !item.installed) };
    } catch (reason) {
      setPreparationError(reason instanceof Error ? reason.message : '依赖自动安装失败');
      return details;
    }
  };

  const confirmFingerprint = async () => {
    if (!pending) return;
    setPhase('scanning'); setPreparationError('');
    try {
      const result = await inspectRemoteServer(grantToken, pending.sessionId, pending.fingerprint);
      let details = result.details;
      setEnvironment(details);
      if (details.compatibility.compatible && autoInstall && details.missingDependencies.length) {
        details = await installMissing(details);
        setEnvironment(details);
      }
      setPhase('ready');
    } catch (reason) {
      setPreparationError(reason instanceof Error ? reason.message : '服务器环境检测失败');
      setPhase('fingerprint');
    }
  };

  const retryDependencies = async () => {
    if (!environment) return;
    const details = await installMissing(environment);
    setEnvironment(details); setPhase('ready');
  };

  const installDocker = async () => {
    if (!pending || !environment) return;
    setPhase('docker'); setPreparationError('');
    try {
      const result = await installDockerRuntime(grantToken, pending.sessionId);
      setEnvironment({ ...environment, docker: result.docker });
    } catch (reason) {
      setPreparationError(reason instanceof Error ? reason.message : 'Docker 与 Compose 安装失败');
    } finally { setPhase('ready'); }
  };

  const backToForm = async () => {
    await disconnectPending();
    setPending(null); setEnvironment(null); setPreparationError(''); setPhase('form');
  };

  return (
    <div className="modal-backdrop protected-backdrop" role="presentation">
      <section className="modal server-modal" role="dialog" aria-modal="true" aria-labelledby="server-modal-title">
        <div className="modal-head"><div><span className="eyebrow plain">Secure connection</span><h2 id="server-modal-title">连接目标服务器</h2></div><button className="icon-button" onClick={requestClose} disabled={busy} aria-label={busy ? '操作期间不可关闭' : '关闭'}><X size={19} /></button></div>
        <DeploymentFlow step={2} compact />
        {phase === 'form' && <div className="modal-body">
          <div className="notice-line"><ShieldCheck size={17} /><span>已通过 CDK 授权。提交后将建立真实 SSH 连接，但不会保存密码或私钥。</span></div>
          <div className="session-memory-note"><LockKeyhole size={16} /><span><strong>仅保留在当前页面</strong>不会写入数据库或浏览器永久存储。刷新页面、关闭标签页或重新进入后，全部服务器信息都会丢失。</span></div>
          <div className="form-grid"><label className="field field-span-two"><span>服务器 IP 或域名</span><input value={draft.host} onChange={event => updateDraft({ host: event.target.value })} placeholder="例如：203.0.113.24" autoComplete="off" /></label><label className="field"><span>SSH 端口</span><input value={draft.port} onChange={event => updateDraft({ port: event.target.value })} inputMode="numeric" /></label><label className="field"><span>SSH 用户名</span><input value={draft.username} onChange={event => updateDraft({ username: event.target.value })} autoComplete="off" /></label></div>
          <div className="segmented"><button className={draft.authType === 'password' ? 'active' : ''} onClick={() => updateDraft({ authType: 'password' })}><KeyRound size={15} /> 密码登录</button><button className={draft.authType === 'key' ? 'active' : ''} onClick={() => updateDraft({ authType: 'key' })}><FileCode2 size={15} /> 私钥登录</button></div>
          {draft.authType === 'password' ? <label className="field"><span>SSH 密码</span><input type="password" value={draft.password} onChange={event => updateDraft({ password: event.target.value })} autoComplete="new-password" placeholder="仅在当前页面临时保留" /></label> : <label className="field"><span>SSH 私钥</span><textarea rows={5} value={draft.privateKey} onChange={event => updateDraft({ privateKey: event.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>}
          <label className="toggle-row"><span><strong>自动安装缺失基础依赖</strong><small>仅安装白名单中的 curl、证书、解压和 SSL 工具，并在完成后二次验证</small></span><input type="checkbox" checked={autoInstall} onChange={event => setAutoInstall(event.target.checked)} /><i /></label>
          {formError && <div className="form-error-banner">{formError}</div>}
          <div className="modal-actions"><button className="button button-secondary" onClick={requestClose}>取消</button><button className="button button-primary" onClick={() => void startScan()}>建立 SSH 连接 <ArrowRight size={16} /></button></div>
          {confirmClose && <div className="close-confirm"><div><LockKeyhole size={18} /><span><strong>暂时关闭服务器信息弹窗？</strong><small>已填内容仍会保留在当前页面中；刷新、关闭页面或重新进入后会全部清空。</small></span></div><div><button className="button button-secondary" onClick={() => setConfirmClose(false)}>继续填写</button><button className="button button-primary" onClick={onClose}>暂时关闭</button></div></div>}
        </div>}
        {phase === 'connecting' && <ServerProgress title="正在建立 SSH 安全会话" description="正在进行网络连接、认证和主机密钥读取，密码或私钥不会写入数据库。" checks={checks} activeIndex={0} />}
        {phase === 'fingerprint' && pending && <div className="modal-body fingerprint-body"><div className="license-icon"><LockKeyhole size={26} /></div><h3>确认服务器主机指纹</h3><p>请与 VPS 厂商控制台或首次 SSH 连接显示的指纹核对。确认后才会读取系统环境。</p><div className="fingerprint-confirm"><small>{pending.host} · {pending.latencyMs}ms</small><code>{pending.fingerprint}</code></div>{preparationError && <div className="form-error-banner">{preparationError}</div>}<div className="modal-actions"><button className="button button-secondary" onClick={() => void backToForm()}>不是这台服务器</button><button className="button button-primary" onClick={() => void confirmFingerprint()}>指纹一致，继续检测 <ShieldCheck size={16} /></button></div></div>}
        {phase === 'scanning' && <ServerProgress title="正在检查真实服务器环境" description="读取系统、架构、权限、资源、包管理器、依赖和本机防火墙状态。" checks={checks} activeIndex={3} />}
        {phase === 'installing' && <ServerProgress title="正在自动补齐基础依赖" description="只执行白名单包安装；结束后会逐项重新检查，未通过则不会进入部署。" checks={environment?.missingDependencies.map(item => `安装 ${item.label}`) || []} activeIndex={Math.max(0, (environment?.missingDependencies.length || 1) - 1)} />}
        {phase === 'docker' && <ServerProgress title="正在安装 Docker 与 Compose" description="根据系统使用发行版软件源或 Docker 官方 RPM 软件源，启动服务后进行版本二次验证。" checks={['配置受信任软件源', '安装 Docker Engine', '安装 Compose 插件', '启动并验证 Docker']} activeIndex={2} />}
        {phase === 'ready' && environment && <div className="modal-body ready-body"><div className={environment.compatibility.compatible && !environment.missingDependencies.length ? 'success-seal' : 'conflict-icon'}>{environment.compatibility.compatible && !environment.missingDependencies.length ? <Check size={28} /> : <AlertTriangle size={27} />}</div><h3>{!environment.compatibility.compatible ? '服务器暂不兼容' : environment.missingDependencies.length ? '环境准备尚未完成' : '服务器兼容性良好'}</h3><p>{!environment.compatibility.compatible ? environment.compatibility.reasons.join('；') : environment.missingDependencies.length ? '仍有依赖未通过二次验证，请重试或登录服务器手工处理。' : '真实环境检查和基础依赖验证均已完成，可以选择面板。'}</p><div className="ready-grid"><span><small>系统</small><strong>{environment.osName}</strong></span><span><small>架构</small><strong>{environment.arch}</strong></span><span><small>权限</small><strong>{environment.isRoot ? 'root' : environment.canSudo ? 'sudo -n' : '权限不足'}</strong></span><span><small>防火墙</small><strong>{environment.firewall.kind} · {environment.firewall.active ? 'active' : 'inactive'}</strong></span></div><div className="dependency-summary">{environment.dependencies.map(item => <span className={item.installed ? 'ok' : 'missing'} key={item.id}>{item.installed ? <Check size={12} /> : <X size={12} />}{item.label}</span>)}<span className={environment.docker.installed && environment.docker.composeInstalled ? 'ok' : 'optional'}>{environment.docker.installed && environment.docker.composeInstalled ? <Check size={12} /> : <Boxes size={12} />}Docker + Compose {environment.docker.installed && environment.docker.composeInstalled ? '已就绪' : '部署 Docker 项目时自动安装'}</span></div>{environment.warnings.map(warning => <div className="server-warning" key={warning}><AlertTriangle size={14} />{warning}</div>)}{preparationError && <div className="form-error-banner">{preparationError}</div>}<div className="fingerprint"><LockKeyhole size={16} /><span><small>主机指纹已确认</small>{environment.hostKeyFingerprint}</span><span className="verified-label">已确认</span></div>{environment.compatibility.compatible && environment.missingDependencies.length > 0 && <button className="button button-secondary button-block" onClick={() => void retryDependencies()}>重试自动安装依赖</button>}{environment.compatibility.compatible && !environment.missingDependencies.length && (!environment.docker.installed || !environment.docker.composeInstalled) && <button className="button button-secondary button-block docker-install-button" onClick={() => void installDocker()}><Boxes size={15} /> 提前安装 Docker 与 Compose（也可部署时自动完成）</button>}<div className="modal-actions"><button className="button button-secondary" onClick={() => void backToForm()}>重新填写</button><button className="button button-primary" disabled={!environment.compatibility.compatible || environment.missingDependencies.length > 0} onClick={() => pending && onConnected({ sessionId: pending.sessionId, environment })}>检测完成，选择面板 <ArrowRight size={16} /></button></div></div>}
      </section>
    </div>
  );
}

function ServerProgress({ title, description, checks, activeIndex }: { title: string; description: string; checks: string[]; activeIndex: number }) {
  const total = Math.max(checks.length, 1);
  return <div className="modal-body scan-body"><div className="scan-radar"><Server size={27} /><span /></div><h3>{title}</h3><p>{description}</p><div className="progress-track"><div style={{ width: `${Math.max(12, ((activeIndex + 1) / total) * 100)}%` }} /></div><div className="check-list">{checks.map((check, index) => <div className={index <= activeIndex ? 'done' : ''} key={check}>{index < activeIndex ? <Check size={15} /> : index === activeIndex ? <span className="spinner" /> : <span className="check-dot" />}<span>{check}</span></div>)}</div></div>;
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

export function DeployModal({ item, grantToken, server, onConsumed, onClose, onToast }: { item: CatalogItem; grantToken: string; server: ActiveServer; onConsumed: () => void; onClose: () => void; onToast: (message: string) => void }) {
  const defaultPort = item.port.includes('随机') || item.port.includes('自动') ? '28641' : item.port.match(/\d+/)?.[0] || '28641';
  const [phase, setPhase] = useState<'config' | 'preflight' | 'conflict' | 'firewall' | 'running' | 'success' | 'error'>('config');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [locking, setLocking] = useState(false);
  const [entitlementError, setEntitlementError] = useState('');
  const [servicePort, setServicePort] = useState(defaultPort);
  const [domain, setDomain] = useState('');
  const [sslEnabled, setSslEnabled] = useState(true);
  const [adminUsername, setAdminUsername] = useState('ark_admin');
  const [adminPassword, setAdminPassword] = useState('');
  const [deploymentResult, setDeploymentResult] = useState<Record<string, unknown>>({});
  const [canRetryFinish, setCanRetryFinish] = useState(false);
  const [portConflict, setPortConflict] = useState<PortState | null>(null);
  const [firewallMessage, setFirewallMessage] = useState('');
  const [pendingAction, setPendingAction] = useState<'run' | 'stop'>('run');
  const [restoreToken, setRestoreToken] = useState('');
  const [jobId, setJobId] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const [taskKey] = useState(() => globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const Icon = item.icon;
  const isProxyPanel = item.category === '代理面板';
  const isThreeXUi = item.adapterId === '3x-ui';
  const isConfigurablePort = hasConfigurablePort(item);
  const canChangeConflictPort = isConfigurablePort && !(item.adapterId === 'cliproxyapi' && [8085, 1455, 54545, 51121, 11451].includes(portConflict?.port || 0));
  const requirements = item.requirements;
  const requirementSummary = [
    item.supportedSystems?.length ? `系统：${item.supportedSystems.join('、')}` : '',
    requirements?.architectures?.length ? `架构：${requirements.architectures.join(' / ')}` : '',
    requirements?.systemd ? '需要 systemd' : '',
    requirements?.network ? '需要可访问互联网' : '',
    item.verifiedSystems?.length ? `实测环境：${item.verifiedSystems.join('、')}，其他系统仍需验收` : '',
  ].filter(Boolean).join(' · ');
  const panelPort = Number(servicePort);
  const canTemporarilyStopConflict = Boolean(
    isThreeXUi
    && sslEnabled
    && domain.trim()
    && portConflict?.service
    && [80, 443].includes(portConflict.port)
    && portConflict.port !== panelPort,
  );

  const resultValue = (key: string) => {
    const value = deploymentResult[key];
    const normalized = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return normalized === '[redacted]' ? '' : normalized;
  };

  const copyResult = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    onToast(`${label}已复制`);
  };

  const cleanupFailedDeployment = async (failureMessage: string, restoreTokenOverride = '') => {
    const cleanupErrors: string[] = [];
    const tokenToRestore = restoreTokenOverride || restoreToken;
    if (tokenToRestore) {
      try { await restoreService(grantToken, server.sessionId, tokenToRestore); setRestoreToken(''); }
      catch (reason) { cleanupErrors.push(reason instanceof Error ? reason.message : '临时停止的服务未能自动恢复'); }
    }
    try { await disconnectServer(grantToken, server.sessionId); }
    catch (reason) { cleanupErrors.push(reason instanceof Error ? reason.message : 'SSH 安全会话未能主动断开'); }
    try { await releaseCdk(grantToken, taskKey); }
    catch (reason) { cleanupErrors.push(reason instanceof Error ? reason.message : 'CDK 权益释放失败'); }
    onConsumed();
    setCanRetryFinish(false);
    setEntitlementError([failureMessage, ...cleanupErrors].filter(Boolean).join('；'));
    setPhase('error');
  };

  const requiredPorts = () => deploymentPorts(item, servicePort, sslEnabled, domain);

  const finalizeStart = async (action: 'run' | 'stop') => {
    setLocking(true); setEntitlementError('');
    let newRestoreToken = '';
    try {
      if (action === 'stop') {
        if (!canTemporarilyStopConflict || !portConflict?.service) throw new Error('该端口会被新服务持续占用，请先手工停止或迁移现有服务');
        const stopped = await temporarilyStopService(grantToken, server.sessionId, portConflict.service);
        newRestoreToken = stopped.restoreToken;
        setRestoreToken(stopped.restoreToken);
        onToast(`${stopped.service} 已临时停止；${stopped.safetyRestoreMinutes} 分钟后有服务器端兜底恢复`);
      }
      await lockCdk(grantToken, taskKey);
      if (!item.adapterId) throw new Error('此目录项目没有绑定正式安装适配器');
      const created = await createDeploymentJob(grantToken, taskKey, {
        kind: `${item.kind}:${item.id}`,
        serverKey: `${server.environment.targetHost}:${server.environment.sshPort}`,
        idempotencyKey: `${taskKey}:${item.id}`,
        maxAttempts: 2,
        adapterId: item.adapterId,
        operation: 'install',
        payload: { panelId: item.id, servicePort, domain, autoSSL: sslEnabled, panelUsername: adminUsername, panelPassword: adminPassword, serverSessionId: server.sessionId, ipOrDomain: server.environment.targetHost, sshPort: server.environment.sshPort, sshUser: server.environment.sshUser },
      });
      setJobId(created.job.id);
      setPhase('running');
      let source: EventSource;
      source = subscribeDeploymentJob(grantToken, created.job.id, event => {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        if (event.type === 'log' || event.type.startsWith('step_') || event.type === 'recovery') {
          setLogs(current => [...current, `[${timestamp}] ${event.message}`]);
        }
        const eventProgress = typeof event.payload.progress === 'number' ? event.payload.progress : undefined;
        if (eventProgress !== undefined) setProgress(eventProgress);
        if (event.type === 'succeeded') {
          source.close(); eventSourceRef.current = null; setProgress(100); void finishEntitlement(created.job.id, newRestoreToken);
        } else if (['failed', 'cancelled', 'timed_out', 'interrupted', 'manual'].includes(event.type)) {
          source.close(); eventSourceRef.current = null; void cleanupFailedDeployment(event.message, newRestoreToken);
        }
      });
      eventSourceRef.current = source;
      await startDeploymentJob(grantToken, taskKey, created.job.id);
    } catch (reason) {
      if (newRestoreToken) {
        try { await restoreService(grantToken, server.sessionId, newRestoreToken); setRestoreToken(''); }
        catch { /* The target-side safety timer remains active. */ }
      }
      try { await releaseCdk(grantToken, taskKey); } catch { /* A timed-out lock will expire and be recoverable by the task engine. */ }
      setEntitlementError(reason instanceof Error ? reason.message : '无法锁定 CDK 权益');
      setPhase(action === 'stop' ? 'conflict' : 'config');
    } finally { setLocking(false); }
  };

  const prepareFirewall = async (action: 'run' | 'stop') => {
    setLocking(true); setEntitlementError('');
    try {
      const result = await openServerFirewall(grantToken, server.sessionId, requiredPorts());
      setFirewallMessage(result.message);
      if (result.localAction === 'manual_required' || result.cloudSecurityGroupRequired) {
        setPendingAction(action); setPhase('firewall');
      } else await finalizeStart(action);
    } catch (reason) {
      setEntitlementError(reason instanceof Error ? reason.message : '端口放行处理失败');
      setPhase(action === 'stop' ? 'conflict' : 'config');
    } finally { setLocking(false); }
  };

  const startPreflight = async () => {
    setLocking(true); setEntitlementError(''); setPhase('preflight');
    try {
      if (isThreeXUi && !/^[A-Za-z0-9_.@-]{3,64}$/.test(adminUsername)) throw new Error('管理员用户名需为 3 到 64 位，只能包含字母、数字、点、下划线、@ 和短横线');
      if (isThreeXUi && (adminPassword.length < 8 || adminPassword.length > 128)) throw new Error('正式部署请设置 8 到 128 位管理员密码');
      const ports = requiredPorts();
      if (!ports.length) {
        await finalizeStart('run');
        return;
      }
      const result = await checkServerPorts(grantToken, server.sessionId, ports);
      const conflict = result.items.find(port => port.occupied) || null;
      setPortConflict(conflict);
      if (conflict) setPhase('conflict');
      else await prepareFirewall('run');
    } catch (reason) {
      setEntitlementError(reason instanceof Error ? reason.message : '端口预检失败');
      setPhase('config');
    } finally { setLocking(false); }
  };

  const finishEntitlement = async (completedJobId = jobId, restoreTokenOverride = '') => {
    try {
      if (!completedJobId) throw new Error('缺少部署任务标识，无法读取交付结果');
      const delivery = await getDeploymentResult(grantToken, taskKey, completedJobId);
      setDeploymentResult(delivery.result);
      const tokenToRestore = restoreTokenOverride || restoreToken;
      if (tokenToRestore) {
        await restoreService(grantToken, server.sessionId, tokenToRestore);
        setRestoreToken('');
      }
      try { await disconnectServer(grantToken, server.sessionId); }
      catch { onToast('部署已完成；SSH 会话将由服务器在超时后自动关闭'); }
      await consumeCdk(grantToken, taskKey);
      onConsumed();
      setCanRetryFinish(false);
      setProgress(100); setPhase('success');
    } catch (reason) {
      setCanRetryFinish(true);
      setEntitlementError(reason instanceof Error ? reason.message : '部署完成，但 CDK 核销失败');
      setPhase('error');
    }
  };

  useEffect(() => () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && !['preflight', 'running'].includes(phase) && onClose()}>
      <section className="modal deploy-modal" role="dialog" aria-modal="true" aria-labelledby="deploy-modal-title">
        <div className="modal-head"><div className="modal-product-title"><span className={`product-icon ${item.accent}`}><Icon size={22} /></span><div><span className="eyebrow plain">{item.kind === 'panel' ? 'Panel deployment' : 'Tool installation'}</span><h2 id="deploy-modal-title">部署 {item.name}</h2></div></div>{!['preflight', 'running'].includes(phase) && <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>}</div>
        {phase === 'config' && <div className="modal-body">
          <div className="deploy-summary"><span><small>目标服务器</small><strong>{server.environment.targetHost}</strong></span><span><small>推荐版本</small><strong>{item.version}</strong></span><span><small>最低内存</small><strong>{requirements?.minRamMb ? `${requirements.minRamMb} MB` : item.memory}</strong></span>{requirements?.minDiskMb ? <span><small>最低可用磁盘</small><strong>{requirements.minDiskMb >= 1024 ? `${requirements.minDiskMb / 1024} GB` : `${requirements.minDiskMb} MB`}</strong></span> : null}</div>
          {requirementSummary ? <div className="deployment-requirements"><ShieldCheck size={16} /><span><strong>安装前提</strong>{requirementSummary}</span></div> : null}
          {requirements?.autoInstallDependencies?.length ? <div className="deployment-auto-dependency"><Boxes size={17} /><span><strong>依赖将自动处理</strong>如果服务器未安装 {requirements.autoInstallDependencies.join(' + ')}，PanelArk 会自动安装、启动并二次验证，无需用户手工操作。</span></div> : null}
          {isThreeXUi ? <><div className="form-grid"><label className="field"><span>面板端口</span><input value={servicePort} onChange={event => setServicePort(event.target.value)} inputMode="numeric" /></label><label className="field"><span>绑定域名（可选）</span><input value={domain} onChange={event => setDomain(event.target.value)} placeholder="panel.example.com" /></label><label className="field"><span>管理员用户名</span><input value={adminUsername} onChange={event => setAdminUsername(event.target.value)} autoComplete="username" /></label><label className="field"><span>管理员密码</span><input type="password" value={adminPassword} onChange={event => setAdminPassword(event.target.value)} autoComplete="new-password" placeholder="至少 8 位" /></label></div>
          <label className="toggle-row"><span><strong>自动配置 SSL</strong><small>填写域名后额外检查 80/443 端口并处理本机防火墙</small></span><input type="checkbox" checked={sslEnabled} onChange={event => setSslEnabled(event.target.checked)} /><i /></label></> : isConfigurablePort ? <><div className="form-grid"><label className="field"><span>面板端口</span><input value={servicePort} onChange={event => setServicePort(event.target.value)} inputMode="numeric" /></label></div><div className="notice-line"><ShieldCheck size={16} /><span>{item.adapterId === 'cliproxyapi' ? '系统会自动安装 Docker、生成管理密钥与 API Key；账号 OAuth 授权需由账号所有者在管理中心手动完成。' : '系统会自动安装 Docker 与项目容器，并在部署后执行网页健康检查。'}</span></div></> : <div className="notice-line"><ShieldCheck size={16} /><span>此适配器将按官方安装方式执行，并使用目录声明的固定端口与安装后验证规则。</span></div>}
          <div className="command-preview"><div><Terminal size={15} /><span>正式部署计划</span><span className="safe-label">服务端适配器</span></div><code>{item.adapterId} · install · 安装后强制验证</code></div>
          <div className="license-benefit compact-benefit"><CheckCircle2 size={17} /><span>点击后先在真实服务器检测端口并尝试放行防火墙，确认可继续时才锁定 CDK 权益</span></div>
          {entitlementError && <p className="deploy-error">{entitlementError}</p>}
          <div className="modal-actions"><button className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" onClick={() => void startPreflight()} disabled={locking}>{locking ? '正在执行预检…' : '检查端口并准备安装'} {!locking && <Play size={15} />}</button></div>
        </div>}
        {phase === 'preflight' && <ServerProgress title="正在执行端口与防火墙预检" description="识别真实监听进程和系统服务；不会未经确认停止任何现有服务。" checks={['检测服务端口', '检查 80/443 证书端口', '识别占用进程', '读取本机防火墙']} activeIndex={2} />}
        {phase === 'conflict' && <div className="modal-body conflict-body">
          <div className="conflict-icon"><AlertTriangle size={27} /></div>
          <span className="eyebrow plain">Action required</span>
          <h3>{portConflict?.port} 端口已被{portConflict?.process ? ` ${portConflict.process}` : '其他进程'}占用</h3>
          <p>PanelArk 已在真实服务器上检测到端口冲突，不会在未确认时停止现有网站，请选择处理方式。</p>
          <div className="conflict-detail">
            <span><small>占用进程</small><strong>{portConflict?.process || '权限不足，未读取'}{portConflict?.pid ? ` · PID ${portConflict.pid}` : ''}</strong></span>
            <span><small>可管理服务</small><strong>{portConflict?.service || '未识别，需手工处理'}</strong></span>
            <span><small>影响范围</small><strong>可能短暂中断现有网站</strong></span>
          </div>
          <button className="choice-card" onClick={() => { setPhase('config'); onToast(canChangeConflictPort ? '已返回配置，请更换服务端口' : '请先在服务器上停止或迁移占用端口的服务，再重新检查'); }}><span><strong>{canChangeConflictPort ? '更换使用端口' : '返回并处理端口冲突'}</strong><small>{canChangeConflictPort ? '返回配置，不影响当前服务' : '此端口为固定端口，需先在服务器上释放'}</small></span><ChevronRight size={17} /></button>
          {canTemporarilyStopConflict && <button className="choice-card recommended" disabled={locking} onClick={() => void prepareFirewall('stop')}><span><strong>{locking ? '正在准备安全操作…' : `临时停止 ${portConflict?.service} 并继续`}</strong><small>仅在证书阶段暂停，任务结束后恢复；目标机还有 10 分钟兜底恢复</small></span><span className="tag gold-tag">需确认</span></button>}
          {!canTemporarilyStopConflict && <div className="license-benefit compact-benefit"><ShieldCheck size={17} /><span>新服务需要持续使用该端口，不能安全地“临时停止后恢复”；请先迁移或停止现有服务。</span></div>}
          {entitlementError && <p className="deploy-error">{entitlementError}</p>}
          <div className="conflict-foot"><ShieldCheck size={15} /><span>恢复动作在目标服务器验证服务重新运行后才算完成。</span></div>
          <div className="modal-actions"><button className="button button-secondary" onClick={onClose}>取消安装</button></div>
        </div>}
        {phase === 'firewall' && <div className="modal-body conflict-body"><div className="conflict-icon"><Network size={27} /></div><span className="eyebrow plain">Cloud firewall check</span><h3>请检查 VPS 厂商安全组</h3><p>{firewallMessage}</p><div className="license-benefit"><ShieldCheck size={17} /><span>PanelArk 已尝试处理 UFW 或 firewalld。本机无法代替你修改阿里云、腾讯云、AWS 等厂商控制台安全组。</span></div>{entitlementError && <p className="deploy-error">{entitlementError}</p>}<div className="modal-actions"><button className="button button-secondary" onClick={() => setPhase(portConflict ? 'conflict' : 'config')}>返回修改</button><button className="button button-primary" disabled={locking} onClick={() => void finalizeStart(pendingAction)}>{locking ? '正在准备…' : '我已检查安全组，继续安装'} <ArrowRight size={15} /></button></div></div>}
        {phase === 'running' && <div className="modal-body running-body"><div className="running-top"><div><span className="eyebrow plain">Persistent deployment task</span><h3>正在执行 {item.name} 任务</h3></div><strong>{progress}%</strong></div><div className="progress-track large"><div style={{ width: `${progress}%` }}><span /></div></div><div className="stage-strip"><span className={progress > 10 ? 'done' : 'active'}>准备环境</span><span className={progress > 36 ? 'done' : progress > 10 ? 'active' : ''}>验证依赖</span><span className={progress > 72 ? 'done' : progress > 36 ? 'active' : ''}>处理端口</span><span className={progress >= 100 ? 'done' : progress > 72 ? 'active' : ''}>收尾核验</span></div><div className="log-panel"><div className="log-head"><span><Terminal size={14} /> 持久化任务日志 {jobId ? `· ${jobId.slice(0, 8)}` : ''}</span><span className="live-dot">LIVE</span></div><div className="log-lines">{logs.length ? logs.map((log, index) => <div key={`${log}-${index}`}><span>{index === logs.length - 1 ? '›' : '✓'}</span>{log}</div>) : <div><span>›</span>正在建立持久化任务会话…</div>}</div></div><p className="running-note">任务由服务端持久化并通过 SSE 推送；3x-ui 使用独立适配器执行真实验证，页面断开不会使任务记录消失。</p></div>}
        {phase === 'success' && <div className="modal-body success-body"><div className="success-seal"><Check size={28} /></div><span className="eyebrow plain">Deployment complete</span><h3>{item.name} 已完成部署与验证</h3><p>真实 SSH 预检、依赖、端口、防火墙、适配器任务、结果验证和服务恢复均已执行并持久化。</p><div className="result-card"><ResultRow label="目标服务器" value={resultValue('host') || server.environment.targetHost} />{resultValue('accessUrl') && <ResultRow label="实际访问地址" value={resultValue('accessUrl')} onCopy={() => void copyResult('访问地址', resultValue('accessUrl'))} />}{resultValue('username') && <ResultRow label="管理员用户名" value={resultValue('username')} onCopy={() => void copyResult('管理员用户名', resultValue('username'))} />}{resultValue('password') && <ResultRow label="管理员密码" value={resultValue('password')} onCopy={() => void copyResult('管理员密码', resultValue('password'))} />}{resultValue('managementKey') && <ResultRow label="管理密钥" value={resultValue('managementKey')} onCopy={() => void copyResult('管理密钥', resultValue('managementKey'))} />}{resultValue('apiToken') && <ResultRow label="API Token" value={resultValue('apiToken')} onCopy={() => void copyResult('API Token', resultValue('apiToken'))} />}{resultValue('installInfo') && <ResultRow label="安装信息" value={resultValue('installInfo')} onCopy={() => void copyResult('安装信息', resultValue('installInfo'))} />}{resultValue('nextStep') && <ResultRow label="下一步" value={resultValue('nextStep')} />}<ResultRow label="安装验证" value="适配器验证通过" success /><ResultRow label="CDK 状态" value="已幂等核销" success /></div><div className="success-actions">{isProxyPanel && <button className="button button-secondary" onClick={() => onToast('可从独立节点任务继续配置代理节点')}>继续搭建节点 <Network size={16} /></button>}<button className="button button-primary" onClick={() => { onToast('部署结果已完成并保存'); onClose(); }}>完成并关闭 <Check size={16} /></button></div></div>}
        {phase === 'error' && <div className="modal-body success-body"><div className="conflict-icon"><AlertTriangle size={27} /></div><span className="eyebrow plain">Deployment attention</span><h3>{canRetryFinish ? '任务收尾需要重试' : '部署任务未成功'}</h3><p>{entitlementError}</p><div className="license-benefit"><ShieldCheck size={17} /><span>{canRetryFinish ? '系统会重新读取真实交付结果、恢复临时停止的服务，并幂等核销 CDK。' : '系统已尝试恢复临时停止的服务并释放 CDK 权益；如提示恢复失败，请立即登录服务器检查。'}</span></div><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>关闭</button>{canRetryFinish && <button className="button button-primary" onClick={() => void finishEntitlement()}>重试任务收尾</button>}</div></div>}
      </section>
    </div>
  );
}

function ResultRow({ label, value, onCopy, success }: { label: string; value: string; onCopy?: () => void; success?: boolean }) {
  return <div className={`result-row${['安装信息', '下一步'].includes(label) ? ' result-row-wrap' : ''}`}><span>{label}</span><strong className={success ? 'success-text' : ''}>{success && <CheckCircle2 size={14} />}{value}</strong>{onCopy && <button onClick={onCopy} aria-label={`复制${label}`}><Copy size={15} /></button>}</div>;
}

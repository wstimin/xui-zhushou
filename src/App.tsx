import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { adapterMetadataToCatalog, panels, tools } from './panelark/catalog';
import { defaultPublicConfig, getPublicConfig, listPanelAdapters, listRecommendedResources, openRecommendedResource, type CdkGrant, type PublicConfig, type RecommendedResource } from './panelark/api';
import type { ActiveServer, CatalogItem, ServerDraft, View } from './panelark/types';
import { useTheme } from './panelark/theme';
import {
  AboutPage,
  CatalogPage,
  CdkGateModal,
  DeployModal,
  DocsPage,
  Footer,
  Header,
  HomePage,
  ServerConnectModal,
} from './panelark/ui';

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [deploymentUnlocked, setDeploymentUnlocked] = useState(false);
  const [cdkGrant, setCdkGrant] = useState<CdkGrant | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig>(defaultPublicConfig);
  const [cdkModalOpen, setCdkModalOpen] = useState(false);
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [activeServer, setActiveServer] = useState<ActiveServer | null>(null);
  const [serverDraft, setServerDraft] = useState<ServerDraft>({ host: '', port: '22', username: 'root', authType: 'password', password: '', privateKey: '' });
  const [deployTarget, setDeployTarget] = useState<CatalogItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [catalogPanels, setCatalogPanels] = useState<CatalogItem[]>(panels);
  const [catalogTools, setCatalogTools] = useState<CatalogItem[]>(tools);
  const [recommendedResources, setRecommendedResources] = useState<RecommendedResource[]>([]);
  const serverConnected = Boolean(activeServer);

  useEffect(() => { document.title = publicConfig.siteName || 'PanelArk 面板方舟'; }, [publicConfig.siteName]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMobileMenuOpen(false);
  }, [view]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true, sequence = 0;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const request = ++sequence;
      getPublicConfig().then(config => { if (active && request === sequence) setPublicConfig(config); }).catch(() => undefined);
    };
    const storage = (event: StorageEvent) => { if (event.key === 'panelark-settings-changed') refresh(); };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', storage);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  useEffect(() => {
    listPanelAdapters().then(response => {
      const dynamicItems = adapterMetadataToCatalog(response.items);
      if (dynamicItems.length) {
        setCatalogPanels(dynamicItems.filter(item => item.kind === 'panel'));
        setCatalogTools(dynamicItems.filter(item => item.kind === 'tool'));
      }
    }).catch(() => setToast('暂时无法读取动态适配器目录，已显示本地缓存目录'));
    listRecommendedResources().then(response => setRecommendedResources(response.items)).catch(() => undefined);
  }, []);

  const openResource = async (id: string) => {
    try {
      const { url } = await openRecommendedResource(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch { setToast('推荐资源暂时不可用'); }
  };

  const requestConnection = () => {
    if (!deploymentUnlocked) {
      setCdkModalOpen(true);
      return;
    }
    setServerModalOpen(true);
  };

  const requestDeploy = (item?: CatalogItem) => {
    if (!deploymentUnlocked) {
      setCdkModalOpen(true);
      return;
    }
    if (!serverConnected) {
      setServerModalOpen(true);
      return;
    }
    if (item) {
      setDeployTarget(item);
      return;
    }
    setView('deploy');
  };

  const handleCdkVerified = (grant: CdkGrant) => {
    setCdkGrant(grant);
    setActiveServer(null);
    setDeploymentUnlocked(true);
    setCdkModalOpen(false);
    setToast('CDK 验证成功，请填写并检测目标服务器');
    setServerModalOpen(true);
  };

  const handleServerConnected = (server: ActiveServer) => {
    setActiveServer(server);
    setServerModalOpen(false);
    setView('deploy');
    setToast('服务器检测完成，请选择需要安装的面板');
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grain" />

      <Header
        theme={theme}
        view={view}
        mobileMenuOpen={mobileMenuOpen}
        deploymentUnlocked={deploymentUnlocked}
        serverConnected={serverConnected}
        onToggleTheme={toggleTheme}
        purchaseEnabled={publicConfig.purchaseEnabled}
        purchaseButtonText={publicConfig.purchaseButtonText}
        onToggleMenu={() => setMobileMenuOpen(open => !open)}
        onViewChange={setView}
        onConnect={requestConnection}
      />

      <main className="main-content">
        {view === 'home' && (
          <HomePage
            catalogItems={catalogPanels}
            recommendedResources={recommendedResources}
            onOpenResource={openResource}
            deploymentUnlocked={deploymentUnlocked}
            serverConnected={serverConnected}
            serverEnvironment={activeServer?.environment}
            onStart={() => requestDeploy()}
            purchaseEnabled={publicConfig.purchaseEnabled}
            purchaseButtonText={publicConfig.purchaseButtonText}
            onOpenDocs={() => setView('docs')}
            onViewPanels={() => setView('deploy')}
            onConnect={requestConnection}
            onToast={setToast}
          />
        )}
        {view === 'deploy' && (
          <CatalogPage
            items={catalogPanels}
            title="面板部署中心"
            purchaseEnabled={publicConfig.purchaseEnabled}
            purchaseButtonText={publicConfig.purchaseButtonText}
            eyebrow="Panel catalog"
            description="可先浏览面板目录；正式部署必须依次完成 CDK 验证和服务器检测，之后再选择面板。"
            deploymentUnlocked={deploymentUnlocked}
            serverConnected={serverConnected}
            serverEnvironment={activeServer?.environment}
            onDeploy={requestDeploy}
            onConnect={requestConnection}
          />
        )}
        {view === 'tools' && (
          <CatalogPage
            items={catalogTools}
            title="系统工具箱"
            purchaseEnabled={publicConfig.purchaseEnabled}
            purchaseButtonText={publicConfig.purchaseButtonText}
            eyebrow="System toolkit"
            description="安全地安装常用组件与优化项，不接管你的日常服务器运维。"
            deploymentUnlocked={deploymentUnlocked}
            serverConnected={serverConnected}
            serverEnvironment={activeServer?.environment}
            onDeploy={requestDeploy}
            onConnect={requestConnection}
          />
        )}
        {view === 'docs' && <DocsPage onStart={() => requestDeploy()} />}
        {view === 'about' && <AboutPage onViewPanels={() => setView('deploy')} />}
      </main>

      <Footer onNavigate={setView} />

      {cdkModalOpen && (
        <CdkGateModal
          onClose={() => setCdkModalOpen(false)}
          onVerified={handleCdkVerified}
          purchaseEnabled={publicConfig.purchaseEnabled}
          purchaseButtonText={publicConfig.purchaseButtonText}
        />
      )}
      {serverModalOpen && (
        <ServerConnectModal
          onClose={() => setServerModalOpen(false)}
          onConnected={handleServerConnected}
          draft={serverDraft}
          onDraftChange={setServerDraft}
          grantToken={cdkGrant?.grantToken || ''}
        />
      )}
      {deployTarget && cdkGrant && activeServer && <DeployModal item={deployTarget} grantToken={cdkGrant.grantToken} server={activeServer} onConsumed={() => setDeploymentUnlocked(false)} onClose={() => { setDeployTarget(null); if (!deploymentUnlocked) { setCdkGrant(null); setActiveServer(null); } }} onToast={setToast} />}

      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span></div>}
    </div>
  );
}

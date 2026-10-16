import {
  Activity,
  Cloud,
  Container,
  Globe2,
  Layers3,
  LockKeyhole,
  MemoryStick,
  Network,
  PanelTop,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { CatalogItem, View } from './types';
import type { PanelAdapterMetadata } from './api';

export const panels: CatalogItem[] = [
  {
    id: '1panel', adapterId: '1panel', name: '1Panel', category: '服务器面板', icon: PanelTop, accent: 'gold',
    description: '现代化 Linux 服务器运维面板，适合网站、数据库与容器服务。',
    version: 'v2 Stable', memory: '1 GB+', port: '随机安全端口', installed: true, featured: true, kind: 'panel',
  },
  {
    id: 'aapanel', adapterId: 'aapanel', name: 'aaPanel', category: '建站面板', icon: Layers3, accent: 'sage',
    description: '宝塔国际版，快速搭建网站、数据库与常用 Web 环境。',
    version: 'Latest', memory: '512 MB+', port: '7800', featured: true, kind: 'panel',
  },
  {
    id: '3x-ui', adapterId: '3x-ui', name: '3x-ui', category: '代理面板', icon: Network, accent: 'blue',
    description: 'Xray 多协议面板，安装后可继续创建节点、订阅与二维码。',
    version: 'Official', memory: '512 MB+', port: '自动生成', featured: true, kind: 'panel',
  },
  {
    id: 's-ui', adapterId: 's-ui', name: 'S-UI', category: '代理面板', icon: Network, accent: 'sage',
    description: '轻量 Sing-box 面板，提供基础入站和用户管理能力。',
    version: 'Stable', memory: '512 MB+', port: '2095', kind: 'panel',
  },
  {
    id: 'hiddify', adapterId: 'hiddify', name: 'Hiddify Manager', category: '代理面板', icon: ShieldCheck, accent: 'violet',
    description: '面向多协议代理和订阅管理的统一面板。',
    version: 'Stable', memory: '1 GB+', port: '443', kind: 'panel',
  },
  {
    id: 'casaos', adapterId: 'casaos', name: 'CasaOS', category: '家庭云面板', icon: Cloud, accent: 'blue',
    description: '面向家庭服务器和 NAS 的轻量容器面板。',
    version: 'Stable', memory: '1 GB+', port: '80', kind: 'panel',
  },
  {
    id: 'portainer', adapterId: 'portainer', name: 'Portainer', category: 'Docker 面板', icon: Container, accent: 'violet',
    description: '简洁可靠的 Docker 与容器环境可视化管理平台。',
    version: 'CE LTS', memory: '512 MB+', port: '9443', kind: 'panel',
  },
  {
    id: 'npm', adapterId: 'npm', name: 'Nginx Proxy Manager', category: 'Docker 面板', icon: Globe2, accent: 'sage',
    description: '通过友好界面管理反向代理、证书与访问策略。',
    version: 'Latest', memory: '1 GB+', port: '81', kind: 'panel',
  },
  {
    id: 'nezha', adapterId: 'nezha', name: '哪吒监控', category: '监控面板', icon: Activity, accent: 'rose',
    description: '轻量服务器监控面板与 Agent 管理中心。',
    version: 'Stable', memory: '512 MB+', port: '8008', kind: 'panel',
  },
  {
    id: 'uptime-kuma', adapterId: 'uptime-kuma', name: 'Uptime Kuma', category: '监控面板', icon: Activity, accent: 'sage',
    description: '部署独立的服务可用性监控面板与公开状态页。',
    version: 'Latest', memory: '512 MB+', port: '3001', kind: 'panel',
  },
  {
    id: 'marzban', adapterId: 'marzban', name: 'Marzban', category: '代理面板', icon: ShieldCheck, accent: 'gold',
    description: '支持 API 与多用户管理的代理服务控制面板。',
    version: 'Stable', memory: '1 GB+', port: '8000', kind: 'panel',
  },
];

export const tools: CatalogItem[] = [
  {
    id: 'docker', adapterId: 'docker', name: 'Docker Engine', category: '容器环境', icon: Container, accent: 'blue',
    description: '自动安装 Docker Engine 与 Compose，并完成服务验证。',
    version: 'Stable', memory: '512 MB+', port: '无需端口', installed: true, kind: 'tool',
  },
  {
    id: 'nginx', adapterId: 'nginx', name: 'Nginx', category: 'Web 环境', icon: Globe2, accent: 'sage',
    description: '安装高性能 Web 服务器并检查 80/443 端口冲突。',
    version: 'Stable', memory: '128 MB+', port: '80 / 443', kind: 'tool',
  },
  {
    id: 'fail2ban', adapterId: 'fail2ban', name: 'Fail2Ban', category: '安全加固', icon: ShieldCheck, accent: 'rose',
    description: '部署基础暴力破解防护并启用 SSH 安全策略。',
    version: 'Latest', memory: '128 MB+', port: '无需端口', kind: 'tool',
  },
  {
    id: 'bbr', adapterId: 'bbr', name: 'BBR 加速', category: '网络优化', icon: Zap, accent: 'gold',
    description: '检测内核支持情况并配置 TCP 拥塞控制参数。',
    version: 'Kernel', memory: '无需额外内存', port: '无需端口', kind: 'tool',
  },
  {
    id: 'swap', adapterId: 'swap', name: 'Swap', category: '系统优化', icon: MemoryStick, accent: 'violet',
    description: '根据内存和磁盘状态创建合理大小的交换空间。',
    version: 'System', memory: '自动计算', port: '无需端口', kind: 'tool',
  },
  {
    id: 'certbot', adapterId: 'certbot', name: 'SSL 证书工具', category: 'Web 环境', icon: LockKeyhole, accent: 'gold',
    description: '安装 Certbot 并验证 ACME 工具链；安装工具本身不占用端口。',
    version: 'Latest', memory: '128 MB+', port: '无需端口', kind: 'tool',
  },
];

const adapterIcons: Record<string, CatalogItem['icon']> = {
  '3x-ui': Network,
  's-ui': Network,
  marzban: ShieldCheck,
  hiddify: ShieldCheck,
  '1panel': PanelTop,
  aapanel: Layers3,
  casaos: Cloud,
  portainer: Container,
  npm: Globe2,
  nezha: Activity,
  'uptime-kuma': Activity,
  docker: Container,
  nginx: Globe2,
  fail2ban: ShieldCheck,
  bbr: Zap,
  swap: MemoryStick,
  certbot: LockKeyhole,
};

export function adapterMetadataToCatalog(items: PanelAdapterMetadata[]): CatalogItem[] {
  return items.filter(item => item.enabled).map(item => ({
    id: item.id,
    adapterId: item.id,
    name: item.name,
    category: item.category,
    icon: adapterIcons[item.id] || PanelTop,
    accent: item.accent,
    description: item.description,
    version: item.version,
    memory: item.memory,
    port: item.port,
    kind: item.kind,
    enabled: item.enabled,
    supportLevel: item.supportLevel,
    supportedSystems: item.supportedSystems,
  }));
}

export const navItems: Array<{ id: View; label: string }> = [
  { id: 'home', label: '首页' },
  { id: 'deploy', label: '面板部署' },
  { id: 'tools', label: '工具箱' },
  { id: 'docs', label: '文档' },
  { id: 'about', label: '关于' },
];

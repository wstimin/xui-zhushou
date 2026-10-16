import type { LucideIcon } from 'lucide-react';
import type { ServerEnvironment } from './api';

export type Theme = 'light' | 'dark';
export type View = 'home' | 'deploy' | 'tools' | 'docs' | 'about';
export type CatalogKind = 'panel' | 'tool';
export type Accent = 'gold' | 'sage' | 'blue' | 'rose' | 'violet';

export interface CatalogItem {
  id: string;
  adapterId?: string;
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  accent: Accent;
  version: string;
  memory: string;
  port: string;
  installed?: boolean;
  featured?: boolean;
  kind: CatalogKind;
  enabled?: boolean;
  supportLevel?: 'verified' | 'pending';
  supportedSystems?: string[];
  requirements?: {
    os: string[];
    minRamMb: number;
    minDiskMb?: number;
    systemd: boolean;
    network: boolean;
    architectures?: string[];
    autoInstallDependencies?: string[];
  };
}

export interface ServerDraft {
  host: string;
  port: string;
  username: string;
  authType: 'password' | 'key';
  password: string;
  privateKey: string;
}

export interface ActiveServer {
  sessionId: string;
  environment: ServerEnvironment;
}

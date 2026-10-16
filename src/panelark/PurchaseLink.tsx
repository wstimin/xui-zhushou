import { ExternalLink, KeyRound } from 'lucide-react';

export function PurchaseLink({ enabled, text = '购买 CDK', className = 'button button-secondary' }: { enabled: boolean; text?: string; className?: string }) {
  if (!enabled) return null;
  return <a className={`${className} purchase-button`} href="/api/public/purchase" target="_blank" rel="noopener noreferrer"><KeyRound size={16} /><span>{text || '购买 CDK'}</span><ExternalLink size={14} /></a>;
}

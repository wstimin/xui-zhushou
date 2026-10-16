import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import type { Theme } from './types';

export function resolveInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try { const saved = window.localStorage.getItem('panelark-theme'); if (saved === 'light' || saved === 'dark') return saved; } catch { /* optional storage */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem('panelark-theme', theme); } catch { /* switching still works */ }
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === 'panelark-theme' || event.key === null) setTheme(resolveInitialTheme()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return [theme, () => setTheme(current => current === 'dark' ? 'light' : 'dark')] as const;
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === 'dark' ? '切换为浅色主题' : '切换为暗色主题';
  return <button type="button" className="admin-theme-toggle" onClick={onToggle} aria-label={label} title={label}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}<span>{theme === 'dark' ? '浅色模式' : '暗色模式'}</span></button>;
}

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import AdminApp from './admin/AdminApp.tsx';
import SetupApp from './setup/SetupApp.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { resolveInitialTheme } from './panelark/theme';
import './index.css';
import './admin/admin.css';

const rootElement = document.getElementById('root')!;
document.documentElement.dataset.theme = resolveInitialTheme();
const adminView = rootElement.dataset.panelarkView === 'admin';

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      {rootElement.dataset.panelarkView === 'setup' ? <SetupApp /> : adminView ? <AdminApp /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);


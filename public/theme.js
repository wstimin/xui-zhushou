try {
  const saved = localStorage.getItem('panelark-theme');
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch (_) {
  document.documentElement.dataset.theme = 'dark';
}

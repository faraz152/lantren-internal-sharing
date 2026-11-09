'use strict';

(() => {
  const key = 'lantern-share-theme';
  let theme = '';
  try { theme = localStorage.getItem(key) || ''; } catch { /* Use the system setting when storage is unavailable. */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === 'dark' ? '#111a15' : '#f2f5f0';
})();

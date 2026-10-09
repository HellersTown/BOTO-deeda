import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker caches the app shell for offline launch. Production only:
// in development it would serve stale modules.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.warn('Service worker registration failed', err);
    });
  });
}

import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
if (import.meta.env.PROD && !window.QuietPaperNative && 'serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => {});

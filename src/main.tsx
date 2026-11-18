import { createRoot } from 'react-dom/client';
import App from './App';
import { startAppearance } from './appearance';
import './theme.css';

startAppearance();
createRoot(document.getElementById('root')!).render(<App />);
if (import.meta.env.PROD && !window.QuietPaperNative && 'serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => {});

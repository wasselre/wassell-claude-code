import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './lib/i18n';
import { useAppStore } from './stores/appStore';

// DEV-only debug handle so local browser-driven tests (Claude preview tooling)
// can read/inject store state without an authenticated backend. Dead code in
// production builds (import.meta.env.DEV is statically false).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__appStore = useAppStore;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

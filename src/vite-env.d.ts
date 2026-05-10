/// <reference types="vite/client" />

// Injected at build time by vite.config.ts via `define`. Holds the short
// commit SHA on Vercel builds, or a `dev-<timestamp>` fallback locally.
// Compared against /api/version at runtime to trigger a "new version
// available, reload" banner so users never have to clear cache manually.
declare const __BUILD_VERSION__: string;

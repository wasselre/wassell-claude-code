import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Build version stamp — used by the in-app update detector.
// On Vercel git deploys: `VERCEL_GIT_COMMIT_SHA` is set automatically per build.
// On Vercel CLI deploys (which carry no commit context): the env var is
// either unset or a string of zeros — both treated as fallback.
// Locally: falls back to a timestamp so dev rebuilds still differ.
const rawSha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').trim();
const isZeroes = /^0+$/.test(rawSha);
const buildVersion =
  rawSha && !isZeroes
    ? rawSha.slice(0, 12)
    : `dev-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;

/**
 * Dev-only: run SELECTED `/api/*` functions from THIS checkout inside the vite
 * dev server, so a new endpoint can be tested locally before it is deployed.
 * Opt-in: `WASSEL_DEV_LOCAL_API=client-prefs/from-text,other` (paths under
 * api/, without .ts). Every other `/api` path still falls through to
 * `WASSEL_DEV_API_PROXY`. The handler gets the raw Node req/res, exactly like
 * a Vercel nodejs function; server env (.env.local) is copied into
 * process.env for it. Never active in a build.
 */
function localApiPlugin(names: string[], env: Record<string, string>): Plugin {
  return {
    name: 'wassel-local-api',
    apply: 'serve',
    configureServer(server) {
      for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const name = names.find((n) => path === `/api/${n}`);
        if (!name) return next();
        try {
          const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as {
            default: (q: typeof req, s: typeof res) => Promise<void>;
          };
          await mod.default(req, res);
        } catch (err) {
          console.error(`[local-api] /api/${name} failed:`, err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
          }
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `vite dev` serves the SPA only — the `/api/*` Vercel functions do not run
  // here, so every API-driven surface (the Marketing workspace, chats, decks…)
  // 404s locally. Opt-in escape hatch for live verification: set
  // `WASSEL_DEV_API_PROXY=https://app.wassel.re` in `.env.local` and the dev
  // server forwards `/api` to that origin (same-origin from the browser's
  // point of view, so the user's Supabase JWT rides along and CORS never
  // enters). Unset = unchanged behaviour. Never a default: it points a dev
  // tab at PRODUCTION data.
  const devEnv = loadEnv(mode, process.cwd(), '');
  const apiProxy = (devEnv.WASSEL_DEV_API_PROXY ?? '').trim().replace(/\/$/, '');
  const localApis = (devEnv.WASSEL_DEV_LOCAL_API ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9/-]+$/i.test(s));
  return {
  plugins: [react(), ...(localApis.length ? [localApiPlugin(localApis, devEnv)] : [])],
  // Honor an assigned PORT (Claude preview tooling / parallel worktree dev
  // servers all sharing one machine) — falls back to the historical fixed
  // port. Explicit `--port` CLI flags still win over this.
  server: {
    port: Number(process.env.PORT) || 5182,
    ...(apiProxy
      ? { proxy: { '/api': { target: apiProxy, changeOrigin: true, secure: true } } }
      : {}),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Dedupe React so a parent-vs-worktree node_modules layout (or any other
    // accidental dual-install) can't end up with two React copies in the
    // bundle, which would trip "Invalid hook call" in dev. Harmless on a
    // single-install setup.
    dedupe: ['react', 'react-dom'],
  },
  // Inject the build version into the bundle as a literal — readable at
  // runtime as `__BUILD_VERSION__`. The version poller compares this against
  // /api/version to detect when a new build is live and prompt the user to
  // reload, instead of asking real users to clear their browser cache.
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  };
});

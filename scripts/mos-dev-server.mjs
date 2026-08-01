#!/usr/bin/env node
/**
 * mos-dev-server.mjs — deterministic local full-stack dev server.
 *
 * Serves the repo's Edge-style api/ functions natively (node:http + web
 * Request/Response, handlers lazily bundled with esbuild) and proxies
 * everything else to the Vite dev server. Replacement for `vercel dev`,
 * which is flaky on Windows — used to run the app against an isolated
 * Supabase branch for fixtures + visual captures.
 *
 * Usage:
 *   node scripts/mos-dev-server.mjs [--port 3000] [--vite-port 5173] [--env .mos-branch.env]
 *
 * No new dependencies: esbuild is already a transitive devDependency (via
 * vite); if direct import resolution fails we fall back to `npx esbuild`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ */
/* CLI args                                                           */
/* ------------------------------------------------------------------ */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { port: 3000, vitePort: 5173, env: '.mos-branch.env' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--port') out.port = Number(next());
    else if (a === '--vite-port') out.vitePort = Number(next());
    else if (a === '--env') out.env = next();
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/mos-dev-server.mjs [--port 3000] [--vite-port 5173] [--env .mos-branch.env]');
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port <= 0) throw new Error(`bad --port: ${out.port}`);
  if (!Number.isInteger(out.vitePort) || out.vitePort <= 0) throw new Error(`bad --vite-port: ${out.vitePort}`);
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ */
/* env loading — MUST run before any handler module is imported        */
/* ------------------------------------------------------------------ */

function loadEnvFile(file) {
  const abs = path.resolve(REPO_ROOT, file);
  if (!fs.existsSync(abs)) {
    console.warn(`[mos-dev] env file not found: ${abs} (continuing with process.env only)`);
    return { abs, count: 0 };
  }
  let count = 0;
  for (const rawLine of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip one layer of surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
      count++;
    }
  }
  return { abs, count };
}

/** Branch aliases → the names handlers + the SPA actually read. */
function applyEnvAliases() {
  const aliases = [
    ['MOS_BRANCH_URL', ['SUPABASE_URL', 'VITE_SUPABASE_URL']],
    ['MOS_BRANCH_ANON_KEY', ['SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY']],
    ['MOS_BRANCH_SERVICE_ROLE_KEY', ['SUPABASE_SERVICE_ROLE_KEY']],
  ];
  for (const [src, targets] of aliases) {
    const v = process.env[src];
    if (!v) continue;
    for (const t of targets) if (!process.env[t]) process.env[t] = v;
  }
}

const envInfo = loadEnvFile(ARGS.env);
applyEnvAliases();

function mask(v) {
  if (!v) return '(unset)';
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
}

/* ------------------------------------------------------------------ */
/* endpoint registry + lazy esbuild bundling                          */
/* ------------------------------------------------------------------ */

const ROUTES = {
  '/api/marketing-os': 'api/marketing-os.ts',
  '/api/value-translate': 'api/value-translate.ts',
  '/api/internal/send-notification-wa': 'api/internal/send-notification-wa.ts',
};

const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-dev-server-'));
const moduleCache = new Map(); // routePath -> Promise<handler>

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch (err) {
    return null; // fall back to npx esbuild below
  }
}

function bundleWithNpx(entryAbs, outAbs) {
  return new Promise((resolve, reject) => {
    const args = [
      'esbuild', entryAbs,
      '--bundle', '--platform=browser', '--conditions=worker,import',
      '--target=es2022', '--format=esm', `--outfile=${outAbs}`,
    ];
    const child = spawn('npx', args, { cwd: REPO_ROOT, shell: process.platform === 'win32' });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npx esbuild exited ${code}:\n${out}`));
    });
  });
}

async function bundleHandler(entryRel) {
  const entryAbs = path.resolve(REPO_ROOT, entryRel);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(`handler file not found: ${entryAbs}`);
  }
  const outAbs = path.join(BUNDLE_DIR, `${crypto.createHash('sha1').update(entryRel).digest('hex')}.mjs`);

  const esbuild = await loadEsbuild();
  if (esbuild) {
    await esbuild.build({
      entryPoints: [entryAbs],
      bundle: true,
      platform: 'browser',
      conditions: ['worker', 'import'],
      external: [],
      target: 'es2022',
      format: 'esm',
      outfile: outAbs,
      logLevel: 'silent',
    });
  } else {
    console.warn('[mos-dev] esbuild import failed — falling back to `npx esbuild`');
    await bundleWithNpx(entryAbs, outAbs);
  }

  // cache-bust the import URL so a rebuild would re-import; we only build once
  // per process, but the query keeps node from deduping against a stale entry.
  const mod = await import(`${pathToFileURL(outAbs).href}?t=${Date.now()}`);
  if (typeof mod.default !== 'function') {
    throw new Error(`${entryRel}: bundled module has no default export (expected an Edge handler)`);
  }
  return mod.default;
}

function getHandler(routePath) {
  let p = moduleCache.get(routePath);
  if (!p) {
    p = bundleHandler(ROUTES[routePath]);
    // on failure, drop the cache entry so the next request retries loudly
    p.catch(() => moduleCache.delete(routePath));
    moduleCache.set(routePath, p);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* IncomingMessage → web Request, Response → ServerResponse           */
/* ------------------------------------------------------------------ */

async function toWebRequest(req, port) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = `http://localhost:${port}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody = body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? body : undefined,
  });
}

async function writeWebResponse(res, webRes) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    // node sets its own transfer-encoding/content-length below
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.setHeader('content-length', buf.length);
  res.end(buf);
}

function sendError(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

/* ------------------------------------------------------------------ */
/* proxy to Vite                                                      */
/* ------------------------------------------------------------------ */

function proxyToVite(req, res, vitePort) {
  const upstream = http.request(
    {
      host: 'localhost',
      port: vitePort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${vitePort}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    console.error(`[mos-dev] vite proxy error for ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      sendError(res, 502, `vite proxy error: ${err.message}\n(is the vite dev server running on port ${vitePort}?)`);
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}

let hmrNoticeShown = false;
function proxyUpgrade(req, socket, head, vitePort) {
  const upstream = http.request({
    host: 'localhost',
    port: vitePort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${vitePort}` },
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n',
    );
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  upstream.on('error', (err) => {
    if (!hmrNoticeShown) {
      hmrNoticeShown = true;
      console.warn(`[mos-dev] websocket upgrade not proxied (${err.message}) — Vite HMR over ws may not work through this server; captures are unaffected.`);
    }
    socket.destroy();
  });
  upstream.end();
}

/* ------------------------------------------------------------------ */
/* server                                                             */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  try {
    if (Object.prototype.hasOwnProperty.call(ROUTES, urlPath)) {
      let handler;
      try {
        handler = await getHandler(urlPath);
      } catch (err) {
        const text = `[mos-dev] failed to bundle/import ${ROUTES[urlPath]}:\n${err?.stack ?? err}`;
        console.error(text);
        sendError(res, 500, text);
        return;
      }
      let webRes;
      try {
        const webReq = await toWebRequest(req, ARGS.port);
        webRes = await handler(webReq);
      } catch (err) {
        const text = `[mos-dev] handler ${urlPath} threw:\n${err?.stack ?? err}`;
        console.error(text);
        sendError(res, 500, text);
        return;
      }
      await writeWebResponse(res, webRes);
      return;
    }
    proxyToVite(req, res, ARGS.vitePort);
  } catch (err) {
    console.error(`[mos-dev] unhandled error for ${req.method} ${req.url}:`, err);
    if (!res.headersSent) sendError(res, 500, String(err?.stack ?? err));
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, ARGS.vitePort));

server.listen(ARGS.port, () => {
  console.log('');
  console.log('┌─ mos-dev-server ──────────────────────────────────────────');
  console.log(`│  listening:    http://localhost:${ARGS.port}`);
  console.log(`│  vite proxy:   http://localhost:${ARGS.vitePort} (everything not in ROUTES)`);
  console.log(`│  env file:     ${envInfo.abs} (${envInfo.count} vars loaded)`);
  console.log(`│  SUPABASE_URL: ${process.env.SUPABASE_URL ?? '(unset)'}`);
  console.log(`│  anon key:     ${mask(process.env.SUPABASE_ANON_KEY)}`);
  console.log('│  api routes:');
  for (const [route, file] of Object.entries(ROUTES)) {
    const exists = fs.existsSync(path.resolve(REPO_ROOT, file));
    console.log(`│    ${route}  →  ${file}${exists ? '' : '  (MISSING — will 500 on first hit)'}`);
  }
  console.log('└────────────────────────────────────────────────────────────');
  console.log('');
});

function shutdown() {
  console.log('\n[mos-dev] shutting down…');
  server.close(() => process.exit(0));
  // don't hang on keep-alive sockets
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

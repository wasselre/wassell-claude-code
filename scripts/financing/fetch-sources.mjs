/**
 * Stage 1 of the financing ingestion pipeline: FETCH.
 *
 *   node scripts/financing/fetch-sources.mjs [--only=key1,key2] [--group=regulatory|provider]
 *                                            [--concurrency=6] [--out=data/financing/snapshots]
 *
 * Runs every manifest source through its own Browserbase session, in parallel,
 * and writes one raw snapshot JSON per source. Nothing is interpreted here —
 * that is deliberate. Parsing reads the snapshots, so a parser fix can be
 * replayed against the exact bytes a source served, and a source that went dark
 * is recorded as a failure rather than silently becoming "no products".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchAll, writeSnapshot } from './lib/browserFetch.mjs';
import { ALL_SOURCES, REGULATORY_SOURCES, PROVIDER_SOURCES } from './sources/manifest.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

let sources = ALL_SOURCES;
if (args.group === 'regulatory') sources = REGULATORY_SOURCES;
if (args.group === 'provider') sources = PROVIDER_SOURCES;
if (args.only) {
  const keys = new Set(String(args.only).split(',').map((s) => s.trim()));
  sources = sources.filter((s) => keys.has(s.key));
}

const outDir = path.resolve(String(args.out ?? 'data/financing/snapshots'));
const concurrency = Number(args.concurrency ?? 6);

console.error(`[fetch] ${sources.length} sources, concurrency ${concurrency} → ${outDir}`);

const runStartedAt = new Date().toISOString();
const results = await fetchAll(sources, {
  concurrency,
  onResult: (r, worker) => {
    const flag = r.status === 'ok' ? 'OK  ' : r.status === 'fetch_blocked' ? 'BLOK' : 'FAIL';
    console.error(
      `[fetch][w${worker}] ${flag} ${r.source_key} (${r.duration_ms ?? '?'}ms, ${r.text.length} chars)` +
        (r.blocked_reason ? ` — ${r.blocked_reason}` : '') +
        (r.error ? ` — ${r.error.slice(0, 120)}` : ''),
    );
  },
});

for (const r of results) writeSnapshot(outDir, r);

const summary = {
  run_started_at: runStartedAt,
  run_finished_at: new Date().toISOString(),
  total: results.length,
  ok: results.filter((r) => r.status === 'ok').length,
  blocked: results.filter((r) => r.status === 'fetch_blocked').length,
  failed: results.filter((r) => r.status === 'fetch_failed').length,
  sources: results.map((r) => ({
    key: r.source_key,
    status: r.status,
    http_status: r.http_status,
    blocked_reason: r.blocked_reason,
    chars: r.text.length,
    content_hash: r.content_hash,
    error: r.error,
  })),
};
fs.writeFileSync(path.join(outDir, '_run.json'), JSON.stringify(summary, null, 1), 'utf8');
console.error(`[fetch] done — ok=${summary.ok} blocked=${summary.blocked} failed=${summary.failed}`);
console.log(JSON.stringify(summary, null, 1));

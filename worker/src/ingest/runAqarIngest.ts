// ============================================================================
// Aqar ingestion runtime lane — the orchestration glue that ties the tested,
// deterministic adapter to the Gate A write-path + publisher RPCs. This is the
// ONLY place with live I/O (HTTP fetch + Storage upload); the parsing/mapping it
// calls is pure and unit-tested (aqar.test.ts).
//
// Flow per listing (idempotent + deterministic on retry — the RPCs dedup):
//   fetch HTML → parseAqarListing → upload html/jsonld bytes to market-raw via
//   the DEDICATED uploader identity (NOT service_role) → ingest_capture_put →
//   source_field_observe (per field) → schema_gap_raise (per captured-but-
//   unmapped) → optionally market_listing_publish (allowlist+flag gated).
//
// SECRET/PII HYGIENE: never logs raw listing content, phone numbers, advertiser
// data or credentials — only external_id + counts + states.
// ============================================================================
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';
import { makeServiceClient } from '../lib/serviceClient.js';
import { AQAR_ADAPTER_ID, AQAR_ADAPTER_VERSION, extractJsonLd, parseAqarListing } from './adapters/aqar.js';
import type { AdapterResult } from './contract.js';

const AQAR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface AqarIngestOptions {
  publish?: boolean;      // attempt market_listing_publish (still gated by flag+allowlist in SQL)
  proxyUrl?: string | null;
  proxyToken?: string | null;
}

/** Fetch a listing detail page: direct first, then the allowlisted proxy. */
async function fetchListingHtml(url: string, opts: AqarIngestOptions): Promise<{ html: string; status: number; finalUrl: string }> {
  let directErr = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': AQAR_UA, 'Accept-Language': 'ar,en' }, redirect: 'follow' });
    if (res.ok) return { html: await res.text(), status: res.status, finalUrl: res.url || url };
    directErr = `source fetch ${res.status}`;
  } catch (err) {
    directErr = `direct fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!opts.proxyUrl || !opts.proxyToken) throw new Error(directErr);
  const via = `${opts.proxyUrl}?url=${encodeURIComponent(url)}`;
  const res = await fetch(via, { headers: { Authorization: `Bearer ${opts.proxyToken}` } });
  if (!res.ok) throw new Error(`${directErr}; proxy ${res.status}`);
  return { html: await res.text(), status: res.status, finalUrl: res.url || url };
}

/** Sign in as the dedicated market-raw uploader (auth user, NOT service_role). */
async function makeUploaderClient(env: WorkerEnv): Promise<SupabaseClient> {
  const email = process.env.MARKET_RAW_UPLOADER_EMAIL;
  const password = process.env.MARKET_RAW_UPLOADER_PASSWORD;
  const anon = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!email || !password || !anon) {
    throw new Error('market-raw uploader credentials absent (MARKET_RAW_UPLOADER_EMAIL/PASSWORD, anon key)');
  }
  const c = createClient(env.SUPABASE_URL, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`uploader sign-in failed: ${error.message}`);
  return c;
}

/** Upload one immutable blob to market-raw at aqar/<sha256>; existing hash = no-op. */
async function uploadBlob(uploader: SupabaseClient, path: string, bytes: string | Uint8Array, contentType: string): Promise<void> {
  const { error } = await uploader.storage.from('market-raw').upload(path, bytes as never, { upsert: false, contentType });
  // A duplicate content-addressed object is expected on retry — treat as success.
  if (error && !/exists|duplicate/i.test(error.message)) {
    throw new Error(`market-raw upload failed for ${path}: ${error.message}`);
  }
}

async function ingestOne(
  svc: SupabaseClient, uploader: SupabaseClient, runId: string,
  target: { external_id: string; url: string }, opts: AqarIngestOptions,
): Promise<{ external_id: string; state: string; published?: boolean; reason?: string }> {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await svc.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data;
  };

  try {
    await rpc('ingestion_item_set_state', { p_run_id: runId, p_source: 'aqar', p_external_id: target.external_id, p_state: 'fetched' });
    const { html, status, finalUrl } = await fetchListingHtml(target.url, opts);

    const result: AdapterResult = parseAqarListing({
      external_id: target.external_id, url: finalUrl, html, http_status: status,
      fetched_at: new Date().toISOString(),
    });
    const e = result.evidence;

    // upload the byte-bearing blobs (html + jsonld) to market-raw. The jsonld
    // bytes are recomputed from the SAME html the adapter hashed, so the uploaded
    // object matches its content-addressed key.
    for (const b of e.blobs) {
      if (!b.storage_object_path || b.storage_bucket !== 'market-raw') continue;
      const bytes = b.media_type === 'text/html' ? html : JSON.stringify(extractJsonLd(html));
      await uploadBlob(uploader, b.storage_object_path, bytes, b.media_type);
    }

    await rpc('ingest_capture_put', {
      p_run_id: runId, p_source: 'aqar', p_external_id: target.external_id,
      p_adapter_id: AQAR_ADAPTER_ID, p_adapter_version: AQAR_ADAPTER_VERSION,
      p_manifest_hash: e.manifest_hash, p_media_summary: e.media_summary,
      p_blobs: e.blobs, p_artifacts: e.artifacts, p_manifest: e.manifest,
    });

    await rpc('ingestion_item_set_state', {
      p_run_id: runId, p_source: 'aqar', p_external_id: target.external_id, p_state: 'parsed',
    });

    for (const o of result.observed) {
      await rpc('source_field_observe', {
        p_platform: 'aqar', p_adapter_id: AQAR_ADAPTER_ID, p_contract_version: result.contract_version,
        p_source_path: o.source_path, p_page_section: o.page_section ?? null, p_source_label: o.source_label ?? null,
        p_raw_data_type: o.raw_data_type ?? null, p_unit: o.unit ?? null, p_language: o.language ?? null,
        p_example_values: o.example_values, p_example_snapshot_id: null, p_example_listing_id: null,
      });
    }
    for (const g of result.gaps) {
      await rpc('schema_gap_raise', {
        p_platform: 'aqar', p_source_path: g.source_path, p_contract_version: result.contract_version,
        p_suggested_type: g.suggested_type ?? null, p_suggested_canonical_field: g.suggested_canonical_field ?? null,
        p_criticality: g.criticality, p_affected_record_delta: 1, p_sample_listing_id: null,
      });
    }

    let published: boolean | undefined; let reason: string | undefined;
    if (opts.publish) {
      const pub = (await rpc('market_listing_publish', {
        p_source: 'aqar', p_external_id: target.external_id, p_canonical: result.canonical,
        p_snapshot_id: null, p_adapter_version: AQAR_ADAPTER_VERSION, p_ingestion_item_id: null,
      })) as { published: boolean; reason?: string };
      published = pub?.published; reason = pub?.reason;
    }

    console.log(`[aqar-ingest] ${target.external_id} captured (class=${result.capture_class}, gaps=${result.gaps.length}, published=${published ?? 'n/a'}${reason ? `:${reason}` : ''})`);
    return { external_id: target.external_id, state: 'captured', published, reason };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await svc.rpc('ingestion_item_set_state', {
      p_run_id: runId, p_source: 'aqar', p_external_id: target.external_id,
      p_state: /fetch/i.test(msg) ? 'fetch_failed' : 'parse_failed', p_error: msg,
    });
    console.log(`[aqar-ingest] ${target.external_id} FAILED: ${msg}`);
    return { external_id: target.external_id, state: 'failed', reason: msg };
  }
}

/** Run one Aqar ingestion run over the given listing targets. */
export async function runAqarIngest(
  env: WorkerEnv, targets: { external_id: string; url: string }[], opts: AqarIngestOptions = {},
): Promise<{ run_id: string; results: Awaited<ReturnType<typeof ingestOne>>[] }> {
  const svc = makeServiceClient(env, 'aqar-ingest');
  const uploader = await makeUploaderClient(env);
  const { data: runId, error } = await svc.rpc('ingestion_run_start', { p_source: 'aqar', p_adapter_version: AQAR_ADAPTER_VERSION });
  if (error || !runId) throw new Error(`ingestion_run_start failed: ${error?.message ?? 'no run id'}`);

  const results = [];
  for (const t of targets) results.push(await ingestOne(svc, uploader, runId as string, t, opts));

  await svc.rpc('ingestion_run_finish', {
    p_run_id: runId,
    p_summary: { targets: targets.length, captured: results.filter((r) => r.state === 'captured').length, failed: results.filter((r) => r.state === 'failed').length },
  });
  console.log(`[aqar-ingest] run ${String(runId).slice(0, 8)} done: ${results.length} targets`);
  return { run_id: runId as string, results };
}

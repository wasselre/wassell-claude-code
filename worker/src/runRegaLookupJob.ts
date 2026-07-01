/**
 * runRegaLookupJob — on-demand advertiser-phone lookup for a market_listings
 * record, off the browser-held HTTP request and onto the Fly worker (same queue
 * pattern as deck_jobs / data_migration_jobs).
 *
 * Pipeline (all inside ONE Browserbase session, no wall-clock ceiling):
 *   1. Open the listing's Aqar ad page (hydrated) and read the OFFICIAL REGA
 *      advertising-license link — `a[href*="rega.gov.sa"][href*="ElanDetails"]`.
 *      The FULL href is used verbatim: it carries the broker-type path segment
 *      (OfficesBroker for companies, IndividualBroker for individuals) — rebuilding
 *      the URL with a hardcoded segment returns a blank template (a real bug we hit).
 *   2. Open that REGA page. It sits behind Cloudflare; a real browser (Browserbase)
 *      clears the challenge, a plain HTTP fetch gets a 403 "Just a moment".
 *   3. Parse the label→value list: اسم المعلن (advertiser), الموظف المسؤول عن الإعلان
 *      (agent), رقم جوال مسؤول الإعلان (agent mobile), رخصة فال, رقم الترخيص.
 *   4. Write advertiser_phone (E.164) + advertiser_name + rega_* metadata onto the
 *      listing via record_save (version-unaware — the browser never writes this
 *      record during a job, so no echo-dedup conflict). The SPA reads it via
 *      Realtime and opens an in-app WhatsApp chat.
 *
 * Outcomes written to record.data.rega_lookup_status:
 *   'done'       — a phone was found (advertiser_phone set).
 *   'no_license' — no active REGA license link, or the license page is blank
 *                  (closed / withdrawn / unlicensed listing) → no phone available.
 *   'failed'     — an infra error (Browserbase / navigation). Also rethrown so the
 *                  job row is marked failed; the record is patched here FIRST so the
 *                  SPA spinner exits immediately (not only via the 10-min watchdog).
 *
 * Legitimacy: REGA is a PUBLIC government registry that discloses the advertiser
 * by law — no login, no cap. Browserbase is pointed only at public Aqar + REGA.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import type { WorkerEnv } from './env.js';

/** Shape of a claimed rega_lookup_jobs row. */
export interface RegaLookupJob {
  /** rega_lookup_jobs.id */
  id: string;
  /** records.id — the market_listings record. */
  recordId: string;
  /** auth.users.id of the submitter. */
  userId: string;
  attempts: number;
}

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: RegaLookupJob;
}

interface RegaData {
  advertiser: string | null;
  agentName: string | null;
  mobile: string | null; // as printed: 05XXXXXXXX
  falLicense: string | null;
  licenseNo: string | null;
  unified: string | null; // الرقم الموحد لمنشأة المعلن
}

/** REGA mobile (05XXXXXXXX) → KSA E.164 (+9665XXXXXXXX). Null if not a KSA mobile. */
function toE164(mobile: string | null): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  // 05XXXXXXXX (10) → 9665XXXXXXXX
  if (/^05\d{8}$/.test(digits)) return `+966${digits.slice(1)}`;
  // 9665XXXXXXXX (12) already
  if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
  // 5XXXXXXXX (9) → 9665XXXXXXXX
  if (/^5\d{8}$/.test(digits)) return `+966${digits}`;
  return null;
}

/** The ad id (external_id) for the Aqar URL — prefer the stored field, else the
 * trailing -<id> of the source_url. */
function resolveAdId(data: Record<string, unknown>): string | null {
  const ext = data.external_id;
  if (typeof ext === 'string' && /^\d{5,}$/.test(ext.trim())) return ext.trim();
  if (typeof ext === 'number') return String(ext);
  const url = typeof data.source_url === 'string' ? data.source_url : '';
  const m = url.match(/(?:\/ad\/|-)(\d{5,})(?:[/?]|$)/);
  return m ? m[1] : null;
}

/** Create a Browserbase session with a residential Saudi IP (REGA is a KSA gov
 * site). Returns the CDP connect URL. */
async function createBrowserbaseSession(apiKey: string, projectId: string): Promise<string> {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      proxies: [{ type: 'browserbase', geolocation: { country: 'SA', city: 'RIYADH' } }],
    }),
  });
  const session = (await res.json()) as { id?: string; connectUrl?: string; message?: string };
  if (!session.connectUrl) {
    throw new Error(`Browserbase session create failed: ${session.message ?? JSON.stringify(session).slice(0, 200)}`);
  }
  return session.connectUrl;
}

export async function runRegaLookupJob({ supabase, env, job }: RunArgs): Promise<Record<string, unknown>> {
  if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID) {
    throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set on the worker');
  }

  // Resolve the market_listings model id (for record_save dispatch).
  const { data: modelRow, error: modelErr } = await supabase
    .from('models')
    .select('id')
    .eq('name', 'market_listings')
    .single();
  if (modelErr || !modelRow) {
    throw new Error(`market_listings model not found: ${modelErr?.message ?? 'unknown'}`);
  }
  const modelId = modelRow.id as string;

  /** Merge a patch into the listing's data via record_save (version-unaware —
   * the browser never writes this record during a job). Re-reads fresh so an
   * unrelated concurrent edit survives. */
  const patchRecord = async (patch: Record<string, unknown>): Promise<void> => {
    const { data: row, error } = await supabase
      .from('records')
      .select('data, created_by_user_id')
      .eq('id', job.recordId)
      .single();
    if (error || !row) throw new Error(`listing not found ${job.recordId}: ${error?.message ?? 'not found'}`);
    const data = ((row.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const newData = { ...data, ...patch };
    const { error: saveErr } = await supabase.rpc('record_save', {
      p_model_id: modelId,
      p_id: job.recordId,
      p_data: newData,
      p_created_by: (row as { created_by_user_id: string | null }).created_by_user_id ?? null,
      p_expected_version: null,
    });
    if (saveErr) throw new Error(`record_save failed: ${saveErr.message}`);
  };

  // Read the listing to get the ad id.
  const { data: listingRow, error: listingErr } = await supabase
    .from('records')
    .select('data')
    .eq('id', job.recordId)
    .single();
  if (listingErr || !listingRow) {
    throw new Error(`listing not found ${job.recordId}: ${listingErr?.message ?? 'not found'}`);
  }
  const listingData = ((listingRow.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const adId = resolveAdId(listingData);
  if (!adId) throw new Error('could not resolve the Aqar ad id (external_id / source_url) for this listing');

  // Mark running (cross-session visibility + watchdog anchor). The SPA also
  // tracks a local spinner from the click, so this is belt-and-suspenders.
  await patchRecord({ rega_lookup_status: 'running', rega_lookup_error: null });

  const connectUrl = await createBrowserbaseSession(env.BROWSERBASE_API_KEY, env.BROWSERBASE_PROJECT_ID);
  const browser = await chromium.connectOverCDP(connectUrl);
  try {
    const ctx = browser.contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // 1. Prefer the STORED REGA license link (`ad_license_url`) — every listing
    // carries it (~92% of the set), and it already has the correct broker-type
    // path (OfficesBroker/IndividualBroker). Using it skips the Aqar page
    // entirely: faster, no dependency on Aqar exposing the anchor, one fewer
    // Cloudflare-fronted site. Only when it's missing/invalid do we fall back to
    // scraping the Aqar ad page for the link.
    const storedLink = typeof listingData.ad_license_url === 'string' ? listingData.ad_license_url.trim() : '';
    let href: string | null = /rega\.gov\.sa\/.*ElanDetails\//i.test(storedLink) ? storedLink : null;
    if (!href) {
      await page.goto(`https://sa.aqar.fm/ad/${adId}/ar`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      href = await page
        .waitForFunction(
          () => {
            // Runs in the browser page (serialized by Playwright) — reference the
            // DOM through a narrow typed view of globalThis so the Node-only worker
            // tsconfig type-checks without pulling in the whole DOM lib.
            const doc = (globalThis as unknown as {
              document: { querySelector(s: string): { href: string } | null };
            }).document;
            const a = doc.querySelector('a[href*="rega.gov.sa"][href*="ElanDetails"]');
            return a ? a.href : null;
          },
          { timeout: 45_000 },
        )
        .then((h) => h.jsonValue() as Promise<string | null>)
        .catch(() => null);
    }

    if (!href) {
      // No active REGA license link — closed / withdrawn / unlicensed listing.
      await patchRecord({
        rega_lookup_status: 'no_license',
        rega_lookup_error: 'لا يوجد ترخيص إعلان نشط لهذا الإعلان (قد يكون مغلقاً أو منتهي الترخيص).',
        rega_lookup_at: new Date().toISOString(),
      });
      return { outcome: 'no_license', adId };
    }

    // 2. REGA page → clear Cloudflare + wait for the actual DATA to render.
    // Wait specifically for the agent MOBILE (a 05… number), NOT just the
    // "اسم المعلن" label: the label list renders before the async values
    // populate, so an early-out on the label parses an empty page → false
    // "no_license". An active license always shows a 05 mobile (resolves in a
    // few seconds); a genuinely empty/expired license never does → the 60s
    // timeout elapses and the parse correctly yields no_license.
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page
      .waitForFunction(
        () => {
          const doc = (globalThis as unknown as {
            document: { title: string; body: { innerText: string } | null };
          }).document;
          const t = doc.title || '';
          const b = doc.body ? doc.body.innerText : '';
          return !/just a moment/i.test(t) && /05\d{8}/.test(b);
        },
        { timeout: 60_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(1500);

    // 3. Parse the label→value list.
    const parsed = (await page.evaluate(() => {
      const doc = (globalThis as unknown as {
        document: { body: { innerText: string } | null };
      }).document;
      const lines = (doc.body?.innerText || '')
        .split('\n')
        .map((s: string) => s.replace(/ /g, ' ').trim())
        .filter(Boolean);
      const v = (label: string): string | null => {
        const i = lines.indexOf(label);
        if (i === -1 || i + 1 >= lines.length) return null;
        const x = lines[i + 1]!;
        return x === '-' || x === '.' || x === '' ? null : x;
      };
      return {
        advertiser: v('اسم المعلن'),
        agentName: v('الموظف المسؤول عن الإعلان'),
        mobile: v('رقم جوال مسؤول الإعلان'),
        falLicense: v('رقم رخصة فال للوساطة والتسويق العقاري'),
        licenseNo: v('رقم الترخيص'),
        unified: v('الرقم الموحد لمنشأة المعلن'),
      };
    })) as RegaData;

    const e164 = toE164(parsed.mobile);
    if (!e164) {
      // Page rendered but no mobile (all-dashes / expired license).
      await patchRecord({
        rega_lookup_status: 'no_license',
        rega_lookup_error: 'ترخيص الإعلان لا يعرض رقم جوال (قد يكون منتهياً).',
        rega_lookup_at: new Date().toISOString(),
      });
      return { outcome: 'no_license', adId, href };
    }

    // 4. Success — upsert the advertiser CONTACT (dedup by phone) into the
    // `advertisers` module + link the listing to it, then write the phone +
    // provenance onto the listing. broker_type is derived from the license URL
    // (OfficesBroker = company, IndividualBroker = individual).
    const brokerType = /OfficesBroker/i.test(href) ? 'office' : /IndividualBroker/i.test(href) ? 'individual' : null;
    let advertiserId: string | null = null;
    const { data: advId, error: advErr } = await supabase.rpc('rega_upsert_advertiser', {
      p_name: parsed.advertiser ?? (listingData.advertiser_name as string | null) ?? null,
      p_phone: e164,
      p_agent: parsed.agentName ?? null,
      p_fal: parsed.falLicense ?? null,
      p_unified: parsed.unified ?? null,
      p_broker_type: brokerType,
      p_created_by: job.userId ?? null,
    });
    if (advErr) console.error(`[rega] advertiser upsert failed (ad ${adId}): ${advErr.message}`);
    else advertiserId = (advId as string | null) ?? null;

    await patchRecord({
      advertiser_phone: e164,
      advertiser_name: parsed.advertiser ?? listingData.advertiser_name ?? null,
      rega_agent_name: parsed.agentName ?? null,
      rega_fal_license: parsed.falLicense ?? null,
      rega_license_no: parsed.licenseNo ?? null,
      rega_unified_number: parsed.unified ?? null,
      ...(advertiserId ? { advertiser: advertiserId } : {}),
      rega_lookup_status: 'done',
      rega_lookup_error: null,
      rega_lookup_at: new Date().toISOString(),
    });
    return { outcome: 'done', adId, phone: e164, advertiser: advertiserId };
  } catch (err) {
    // Reflect the failure onto the record FIRST so the SPA spinner exits now
    // (not only via the 10-min watchdog), then rethrow so the job is marked failed.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await patchRecord({
        rega_lookup_status: 'failed',
        rega_lookup_error: 'تعذّر جلب رقم المعلن. حاول مرة أخرى.',
        rega_lookup_at: new Date().toISOString(),
      });
    } catch {
      // best-effort; the watchdog is the backstop.
    }
    throw new Error(`rega lookup failed (ad ${adId}): ${msg}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

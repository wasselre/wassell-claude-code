/**
 * POST /api/research-project
 *
 * Runs an end-to-end "2 km market study" for one All Projects record:
 *
 *   1. Spin up a hosted Chromium session via Browserbase.
 *   2. Log in to paseet.ai with stored credentials, navigate to the chat.
 *   3. Send an Arabic prompt that asks Paseet for transaction stats around
 *      the project's Maps URL (a 2 km radius, 50–300 m² floor sizes).
 *   4. Parse the rendered table from Paseet's response.
 *   5. Find — or create — the matching Targeted Projects record in the CRM
 *      and append the rows into the "جدول مقارنة 2 كيلو حول المشروع"
 *      `table` field.
 *   6. Return a JSON summary the browser turns into a toast.
 *
 * The previous version of this route forwarded the trigger message to a
 * Claude Code routine. That routine could not actually browse Paseet (login
 * + JS rendering needed a real browser, which the routine didn't have), so
 * we drive the browser directly here and write to Supabase ourselves.
 *
 * Required env vars:
 *   BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID — hosted-browser provider.
 *   PASEET_EMAIL, PASEET_PASSWORD                — paseet.ai login.
 *   SUPABASE_URL, SUPABASE_ANON_KEY              — for record CRUD via the
 *                                                  caller's JWT (RLS-scoped).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { chromium, type Page } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

// Use the Node runtime — Edge can't ship playwright-core.
// maxDuration: 240s — Paseet's chat response can take 30–90s and we want
// headroom for login + parse + Supabase write. Pro plan supports up to 300s.
// (The Node major version is set by the Vercel project settings; here we
// only declare the runtime family. "nodejs20.x" is rejected by Vercel — only
// "nodejs" / "edge" / "experimental-edge" are accepted in this field.)
export const config = {
  runtime: 'nodejs',
  maxDuration: 240,
};

interface RequestBody {
  project_name?: string;
  location?: string;
  record_id?: string;
}

interface ParsedRow {
  source: string;
  use: string;
  deals: number | null;
  avg_deal_price: number | null;
  min_area: number | null;
  max_area: number | null;
  avg_area: number | null;
  min_price: number | null;
  max_price: number | null;
}

const TARGETED_PROJECTS_MODEL_NAME = 'targeted_projects';
const ALL_PROJECTS_MODEL_NAME = 'all_projects';

/**
 * The Arabic prompt sent to Paseet. The 9 columns we ask for align 1:1 with
 * the `جدول مقارنة 2 كيلو حول المشروع` table field's columns in the CRM
 * (col_1..col_9). The routine's earlier 12-column prompt was trimmed because
 * the schema only carries 9 of those columns today.
 */
function buildPaseetPrompt(locationUrl: string): string {
  return [
    `عطني العناصر التالية للمنطقة المحددة (${locationUrl}) و 2 كيلو حولها:`,
    'الحد الأدنى للمساحة، الحد الأقصى للمساحة، متوسط المساحة الإجمالي،',
    'الحد الأدنى للسعر، الحد الأقصى للسعر، متوسط سعر الصفقة.',
    'فقط خذ في الحسبان مساحات من 50 إلى 300 متر.',
    'ولكل مصدر عطني عدد الصفقات المبني عليها هذه الأرقام، ونوع الاستخدام.',
    'ثم استخرج الجدول واجعله من اليمين إلى اليسار.',
  ].join('\n');
}

async function createBrowserbaseSession(
  apiKey: string,
  projectId: string,
): Promise<{ id: string; connectUrl: string }> {
  // Basic session — no proxies, no CAPTCHA solver, no advancedStealth.
  // Those are Hobby+/Scale-tier paid features and Browserbase 403s the
  // request when the project's plan doesn't include them. We log the
  // response body on failure so a future 403 tells us exactly why.
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Browserbase session create failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as { id: string; connectUrl: string };
}

async function loginToPaseet(page: Page, email: string, password: string): Promise<void> {
  log('[paseet] navigating to login');
  await page.goto('https://paseet.ai/ar/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  log('[paseet] login form ready at', page.url(), '— filling email');
  await page.fill('input[type="email"]', email);
  log('[paseet] email filled — filling password');
  await page.fill('input[type="password"]', password);
  log('[paseet] password filled — looking for submit button');

  // Inspect the submit button before clicking — verifies the selector,
  // catches "still disabled because validation hasn't fired" cases.
  const submitInfo = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    return btn
      ? { found: true, text: (btn.textContent ?? '').trim().slice(0, 40), disabled: btn.disabled }
      : { found: false, text: '', disabled: false };
  });
  log('[paseet] submit-button probe:', submitInfo);

  await page.click('button[type="submit"]', { timeout: 10000 });
  log('[paseet] clicked submit — waiting for navigation away from /login');

  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 25000 });
  } catch (err) {
    // Capture page state to see WHY login didn't navigate (CAPTCHA? error
    // toast? still on /login with the form rejecting?).
    const after = await page.evaluate(() => ({
      url: window.location.href,
      bodyHead: document.body.innerText.slice(0, 600),
      hasError: /خطأ|incorrect|invalid|wrong|بيانات/i.test(document.body.innerText),
    })).catch(() => ({ url: 'eval-failed', bodyHead: '', hasError: false }));
    log('[paseet] login navigation never fired. Page state:', after);
    throw new Error(
      `Paseet login did not navigate away from /login. URL: ${after.url}. Body excerpt: ${after.bodyHead.slice(0, 200)}`,
    );
  }
  log('[paseet] logged in, url:', page.url());
}

/**
 * Send `prompt` into the Paseet chat and wait for the streaming response to
 * settle, then return all `<table>` elements that landed on the page.
 *
 * "Settled" means the body innerText length stops growing for ~3 consecutive
 * seconds. Paseet streams tokens, so we can't just `waitForSelector` on the
 * table — it appears partially-rendered partway through the response.
 */
async function askPaseet(page: Page, prompt: string): Promise<ParsedRow[]> {
  log('[paseet] navigating to chat');
  await page.goto('https://paseet.ai/ar/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('textarea', { timeout: 15000 });
  log('[paseet] chat ready, sending prompt');

  // Use `fill` (single CDP call to set value) rather than `type` (one CDP
  // call per keystroke). With Vercel→Browserbase cross-region latency at
  // ~150ms per round-trip, a 300-char prompt typed char-by-char would burn
  // ~45 seconds. `fill` does the whole string in one round-trip.
  const textarea = page.locator('textarea').first();
  await textarea.click({ timeout: 10000 });
  log('[paseet] textarea clicked, filling');
  await textarea.fill(prompt, { timeout: 10000 });
  log('[paseet] filled, pressing Enter');
  await page.keyboard.press('Enter');
  log('[paseet] prompt sent, waiting for table to render');

  // Wait until a `<table>` appears AND stops growing for ~2 seconds.
  // Polling on table presence is a much sharper signal than polling
  // body innerText length (which fluctuates from layout shifts and
  // animations regardless of streaming progress).
  const t0 = Date.now();
  let lastTableLen = -1;
  let stableSince: number | null = null;
  const maxMs = 90_000; // hard cap
  const stableMs = 2000;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(750);
    const tableLen = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const last = tables[tables.length - 1];
      return last ? (last.textContent || '').length : 0;
    });
    if (tableLen > 0 && tableLen === lastTableLen) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) break;
    } else {
      stableSince = null;
      lastTableLen = tableLen;
    }
  }
  log('[paseet] table settled in', Date.now() - t0, 'ms; tableLen=', lastTableLen);

  // Grab the last `<table>` on the page — that's the one Paseet just rendered
  // for the prompt we sent. Pagination ("صفحة 1 من 1") sits next to it; if
  // multi-page we'd click "تحميل المزيد" but for the 2km study the result is
  // typically one page.
  const rows = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    if (tables.length === 0) return [];
    const lastTable = tables[tables.length - 1]!;
    const trs = Array.from(lastTable.querySelectorAll('tr'));
    return trs.map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent || '').trim()),
    );
  });

  if (rows.length === 0) {
    throw new Error('Paseet returned no table for the prompt');
  }

  // Drop the header row, then map columns by header label so we're robust to
  // column reordering. Paseet may emit columns in a different order than what
  // the prompt requested.
  const header = rows[0]!;
  const dataRows = rows.slice(1);

  const idx = (...labels: string[]) => {
    for (const lbl of labels) {
      const i = header.findIndex((h) => h.includes(lbl));
      if (i >= 0) return i;
    }
    return -1;
  };
  const numCol = (row: string[], i: number): number | null => {
    if (i < 0) return null;
    const raw = row[i];
    if (!raw) return null;
    // Strip Arabic-Indic digits → ASCII, drop commas/SAR/spaces, parse.
    const ascii = raw
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[,،\s]|ر\.س|SAR/g, '');
    const n = parseFloat(ascii);
    return Number.isFinite(n) ? n : null;
  };
  const txtCol = (row: string[], i: number): string => (i >= 0 ? row[i] || '' : '');

  const iSource = idx('المصدر', 'مصدر');
  const iUse = idx('الاستخدام', 'استخدام');
  const iDeals = idx('عدد الصفقات', 'الصفقات');
  const iAvgDealPrice = idx('متوسط سعر الصفقة');
  const iMinArea = idx('الحد الأدنى للمساحة', 'أدنى للمساحة');
  const iMaxArea = idx('الحد الأقصى للمساحة', 'أقصى للمساحة');
  const iAvgArea = idx('متوسط المساحة');
  const iMinPrice = idx('الحد الأدنى للسعر', 'أدنى للسعر');
  const iMaxPrice = idx('الحد الأقصى للسعر', 'أقصى للسعر');

  const parsed: ParsedRow[] = dataRows
    .filter((r) => r.some((c) => c.length > 0))
    .map((r) => ({
      source: txtCol(r, iSource),
      use: txtCol(r, iUse),
      deals: numCol(r, iDeals),
      avg_deal_price: numCol(r, iAvgDealPrice),
      min_area: numCol(r, iMinArea),
      max_area: numCol(r, iMaxArea),
      avg_area: numCol(r, iAvgArea),
      min_price: numCol(r, iMinPrice),
      max_price: numCol(r, iMaxPrice),
    }))
    // Drop "صفحة 1 من 1" / "تحميل المزيد" rows that snuck in.
    .filter((r) => r.source && r.use);

  return parsed;
}

/** Convert ParsedRow → CRM `table` field row keyed by col_N column names. */
function rowToCrmCells(row: ParsedRow): Record<string, unknown> {
  return {
    col_1: row.source,
    col_2: row.use,
    col_3: row.deals,
    col_4: row.avg_deal_price,
    col_5: row.min_area,
    col_6: row.max_area,
    col_7: row.avg_area,
    col_8: row.min_price,
    col_9: row.max_price,
  };
}

// `process.stderr.write` flushes immediately, unlike `console.log` which
// Vercel buffers and emits on response — when the function is killed by
// maxDuration the buffer is dropped and we lose all visibility. stderr lines
// land in Vercel's runtime logs as they're written.
function log(...parts: unknown[]): void {
  process.stderr.write(`${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
}

/* ─── Node ↔ Web Request/Response adapter ────────────────────────────────
 *
 * Vercel's Node runtime hands functions a Node `IncomingMessage` (where
 * `headers` is a plain object) and expects a Node `ServerResponse` (call
 * `res.end()`), even when the function signature is typed as
 * `(req: Request) => Response`. The TypeScript annotation is a fiction at
 * runtime — calling `req.headers.get('Authorization')` throws.
 *
 * This wrapper bridges the gap: it converts the IncomingMessage into a
 * Web `Request`, runs the existing Web-Request-style handler (which uses
 * `withAuth` and other helpers that assume Web standards), then writes
 * the resulting Web `Response` back to the Node `ServerResponse`.
 * ──────────────────────────────────────────────────────────────────── */

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  log('[research-project] L0 wrapper entered, method=', nodeReq.method ?? '?', 'url=', nodeReq.url ?? '?');
  let webReq: Request;
  try {
    webReq = await nodeToWebRequest(nodeReq);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('[research-project] L0! adapter failure:', msg);
    nodeRes.statusCode = 500;
    nodeRes.setHeader('Content-Type', 'application/json');
    nodeRes.end(JSON.stringify({ error: `request adapter failed: ${msg}` }));
    return;
  }
  log('[research-project] L0a adapted to web request');
  let webResp: Response;
  try {
    webResp = await mainHandler(webReq);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('[research-project] L0! handler threw:', msg);
    webResp = jsonError(500, `unhandled: ${msg}`);
  }
  await writeWebResponseToNode(webResp, nodeRes);
}

async function mainHandler(req: Request): Promise<Response> {
  log('[research-project] L1 handler entered, method=', req.method);
  log('[research-project] L2 url=', req.url);
  log('[research-project] L3 has-supabase-url=', !!process.env.SUPABASE_URL, 'has-anon=', !!process.env.SUPABASE_ANON_KEY);
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  log('[research-project] L4 about to call withAuth');

  return withAuth(req, async (_user) => {
    log('[research-project] L5 inside withAuth callback (auth verified)');
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const projectName = (body.project_name ?? '').trim();
    const locationUrl = (body.location ?? '').trim();
    const recordId = (body.record_id ?? '').trim();
    if (!projectName) return jsonError(400, 'project_name is required');
    if (!locationUrl) return jsonError(400, 'location is required');
    if (!recordId) return jsonError(400, 'record_id is required');
    log('[research-project] inputs:', { projectName, locationUrl, recordId });

    const bbApiKey = process.env.BROWSERBASE_API_KEY;
    const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
    const paseetEmail = process.env.PASEET_EMAIL;
    const paseetPassword = process.env.PASEET_PASSWORD;
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!bbApiKey || !bbProjectId) return jsonError(500, 'Browserbase env vars missing');
    if (!paseetEmail || !paseetPassword) return jsonError(500, 'Paseet env vars missing');
    if (!supabaseUrl || !supabaseAnonKey) return jsonError(500, 'Supabase env vars missing');

    // Caller's JWT — used so RLS scopes our reads/writes to their permissions.
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // 1. The All Projects record we're researching is identified by record_id
    //    coming from the button — direct ID lookup, not a full-table scan.
    log('[research-project] loading all_projects record', recordId);
    const tDb1 = Date.now();
    const { data: matched, error: apRecErr } = await supabase
      .from('records')
      .select('id, model_id')
      .eq('id', recordId)
      .single();
    if (apRecErr || !matched) {
      return jsonError(404, `All Projects record ${recordId} not found: ${apRecErr?.message ?? ''}`);
    }
    log('[research-project] all_projects record found in', Date.now() - tDb1, 'ms; model_id=', matched.model_id);

    // 2. Load the Targeted Projects model schema so we know the lookup + table
    //    field slugs (the Builder lets users rename slugs, so we resolve by
    //    structural role rather than hardcoding names).
    log('[research-project] loading targeted_projects model');
    const tDb2 = Date.now();
    const { data: tpModel, error: tpModelErr } = await supabase
      .from('models')
      .select('id, schema')
      .eq('name', TARGETED_PROJECTS_MODEL_NAME)
      .single();
    if (tpModelErr || !tpModel) {
      return jsonError(500, `Could not load targeted_projects model: ${tpModelErr?.message ?? 'not found'}`);
    }
    type Field = {
      name: string;
      type: string;
      lookup_model_id?: string | null;
      label_ar?: string;
    };
    const tpSchema = tpModel.schema as { sections: { fields: Field[] }[] };
    const allTpFields: Field[] = tpSchema.sections.flatMap((s) => s.fields);
    const lookupField = allTpFields.find(
      (f) => f.type === 'lookup' && f.lookup_model_id === matched.model_id,
    );
    const tableField = allTpFields.find(
      (f) => f.type === 'table' && (f.label_ar ?? '').includes('2 كيلو'),
    );
    if (!lookupField) return jsonError(500, 'Targeted Projects has no lookup pointing at All Projects');
    if (!tableField) return jsonError(500, 'Targeted Projects has no "2 كيلو" table field');
    log('[research-project] targeted_projects schema loaded in', Date.now() - tDb2, 'ms; lookup=', lookupField.name, 'table=', tableField.name);

    // 3. Find an existing Targeted Projects record for this project via
    //    server-side JSONB filter — `data->>{lookup_slug} == recordId`.
    //    Avoids pulling every targeted_projects row for client-side scanning.
    log('[research-project] searching targeted_projects for existing record');
    const tDb3 = Date.now();
    const { data: existingTpRows, error: tpFindErr } = await supabase
      .from('records')
      .select('id, data')
      .eq('model_id', tpModel.id)
      .eq(`data->>${lookupField.name}`, recordId)
      .limit(1);
    if (tpFindErr) return jsonError(500, `targeted records query failed: ${tpFindErr.message}`);
    const existingTp = existingTpRows?.[0] ?? null;
    let targetedRecordId: string | undefined = existingTp?.id;
    let existingTableRows: Record<string, unknown>[] = [];
    if (existingTp) {
      const cur = (existingTp.data as Record<string, unknown> | undefined)?.[tableField.name];
      if (Array.isArray(cur)) existingTableRows = cur as Record<string, unknown>[];
    }
    log('[research-project] targeted_projects search', Date.now() - tDb3, 'ms; existing=', !!existingTp, 'existingRows=', existingTableRows.length);

    // 4. Drive Paseet via Browserbase.
    log('[research-project] creating Browserbase session');
    const tBb = Date.now();
    const session = await createBrowserbaseSession(bbApiKey, bbProjectId);
    log('[research-project] BB session', session.id, 'in', Date.now() - tBb, 'ms');
    const browser = await chromium.connectOverCDP(session.connectUrl);
    log('[research-project] CDP connected in', Date.now() - tBb, 'ms');
    let parsed: ParsedRow[] = [];
    try {
      const ctx = browser.contexts()[0]!;
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const tLogin = Date.now();
      await loginToPaseet(page, paseetEmail, paseetPassword);
      log('[research-project] login took', Date.now() - tLogin, 'ms');
      const tAsk = Date.now();
      parsed = await askPaseet(page, buildPaseetPrompt(locationUrl));
      log('[research-project] askPaseet took', Date.now() - tAsk, 'ms; rows=', parsed.length);
    } finally {
      await browser.close().catch(() => {});
    }

    if (parsed.length === 0) {
      return jsonError(502, 'Paseet returned no usable rows. The chat response may have changed shape.');
    }

    // 5. Append the new rows to the table field and upsert. We append, not
    //    replace, so the user can re-run research over time.
    const newCells = parsed.map(rowToCrmCells);
    const mergedRows = [...existingTableRows, ...newCells];

    if (targetedRecordId) {
      log('[research-project] updating existing targeted record', targetedRecordId, 'with', mergedRows.length, 'rows');
      const { error: upErr } = await supabase
        .from('records')
        .update({
          data: {
            ...((existingTp?.data as Record<string, unknown> | undefined) ?? {}),
            [tableField.name]: mergedRows,
          },
        })
        .eq('id', targetedRecordId);
      if (upErr) return jsonError(500, `Targeted Projects record update failed: ${upErr.message}`);
    } else {
      log('[research-project] inserting new targeted record with', newCells.length, 'rows');
      const newId = crypto.randomUUID();
      const { error: insErr } = await supabase.from('records').insert({
        id: newId,
        model_id: tpModel.id,
        data: {
          [lookupField.name]: recordId,
          [tableField.name]: newCells,
        },
      });
      if (insErr) return jsonError(500, `Targeted Projects record create failed: ${insErr.message}`);
      targetedRecordId = newId;
    }
    log('[research-project] done; rows_added=', parsed.length);

    return jsonOk({
      ok: true,
      project_name: projectName,
      rows_added: parsed.length,
      sources: parsed.map((p) => p.source),
      targeted_record_id: targetedRecordId,
      browserbase_session_id: session.id,
    });
  });
}

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
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    throw new Error(`Browserbase session create failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string; connectUrl: string };
}

async function loginToPaseet(page: Page, email: string, password: string): Promise<void> {
  await page.goto('https://paseet.ai/ar/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 30000 });
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
  await page.goto('https://paseet.ai/ar/chat', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('textarea', { timeout: 15000 });

  const beforeLen = await page.evaluate(() => document.body.innerText.length);

  const textarea = await page.$('textarea');
  if (!textarea) throw new Error('Paseet chat textarea not found');
  await textarea.click();
  await textarea.type(prompt, { delay: 5 });
  await page.keyboard.press('Enter');

  // Wait for streaming to finish. Sample length every 1s; if it hasn't grown
  // for 3 consecutive samples, assume done. Cap at 120s.
  let lastLen = beforeLen;
  let stableCount = 0;
  const maxIters = 120;
  for (let i = 0; i < maxIters; i++) {
    await page.waitForTimeout(1000);
    const len = await page.evaluate(() => document.body.innerText.length);
    if (len === lastLen && len > beforeLen) {
      stableCount += 1;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
      lastLen = len;
    }
  }

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

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const projectName = (body.project_name ?? '').trim();
    const locationUrl = (body.location ?? '').trim();
    if (!projectName) return jsonError(400, 'project_name is required');
    if (!locationUrl) return jsonError(400, 'location is required');

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

    // 1. Resolve which All Projects record this corresponds to. We match by
    //    the `project_name` field (text-equal, case-insensitive).
    const { data: allProjectsModel, error: apModelErr } = await supabase
      .from('models')
      .select('id, schema')
      .eq('name', ALL_PROJECTS_MODEL_NAME)
      .single();
    if (apModelErr || !allProjectsModel) {
      return jsonError(500, `Could not load all_projects model: ${apModelErr?.message ?? 'not found'}`);
    }

    const { data: candidateRecords, error: apRecsErr } = await supabase
      .from('records')
      .select('id, data')
      .eq('model_id', allProjectsModel.id);
    if (apRecsErr) return jsonError(500, `records query failed: ${apRecsErr.message}`);

    const matched = (candidateRecords ?? []).find((r) => {
      const name = String((r.data as Record<string, unknown>)?.project_name ?? '').trim().toLowerCase();
      return name === projectName.toLowerCase();
    });
    if (!matched) {
      return jsonError(404, `Project '${projectName}' not found in All Projects`);
    }

    // 2. Resolve the Targeted Projects model + the lookup/table field slugs.
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
      (f) => f.type === 'lookup' && f.lookup_model_id === allProjectsModel.id,
    );
    const tableField = allTpFields.find(
      (f) => f.type === 'table' && (f.label_ar ?? '').includes('2 كيلو'),
    );
    if (!lookupField) return jsonError(500, 'Targeted Projects has no lookup pointing at All Projects');
    if (!tableField) return jsonError(500, 'Targeted Projects has no "2 كيلو" table field');

    // 3. Find the existing Targeted Projects record for this all_projects id,
    //    or create one. The lookup field's stored value is a string (single-
    //    select lookup, is_multi=false).
    const { data: tpRecords, error: tpRecsErr } = await supabase
      .from('records')
      .select('id, data')
      .eq('model_id', tpModel.id);
    if (tpRecsErr) return jsonError(500, `targeted records query failed: ${tpRecsErr.message}`);

    let targetedRecordId = (tpRecords ?? []).find((r) => {
      const v = (r.data as Record<string, unknown>)?.[lookupField.name];
      return typeof v === 'string' && v === matched.id;
    })?.id;

    let existingTableRows: Record<string, unknown>[] = [];
    if (targetedRecordId) {
      const existing = (tpRecords ?? []).find((r) => r.id === targetedRecordId);
      const cur = (existing?.data as Record<string, unknown> | undefined)?.[tableField.name];
      if (Array.isArray(cur)) existingTableRows = cur as Record<string, unknown>[];
    }

    // 4. Drive Paseet via Browserbase.
    const session = await createBrowserbaseSession(bbApiKey, bbProjectId);
    const browser = await chromium.connectOverCDP(session.connectUrl);
    let parsed: ParsedRow[] = [];
    try {
      const ctx = browser.contexts()[0]!;
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await loginToPaseet(page, paseetEmail, paseetPassword);
      parsed = await askPaseet(page, buildPaseetPrompt(locationUrl));
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
      const { error: upErr } = await supabase
        .from('records')
        .update({
          data: {
            ...((tpRecords ?? []).find((r) => r.id === targetedRecordId)?.data as Record<string, unknown>),
            [tableField.name]: mergedRows,
          },
        })
        .eq('id', targetedRecordId);
      if (upErr) return jsonError(500, `Targeted Projects record update failed: ${upErr.message}`);
    } else {
      const newId = crypto.randomUUID();
      const { error: insErr } = await supabase.from('records').insert({
        id: newId,
        model_id: tpModel.id,
        data: {
          [lookupField.name]: matched.id,
          [tableField.name]: newCells,
        },
      });
      if (insErr) return jsonError(500, `Targeted Projects record create failed: ${insErr.message}`);
      targetedRecordId = newId;
    }

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

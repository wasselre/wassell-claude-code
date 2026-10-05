/**
 * Lead-portal RECIPE engine — a small declarative step language the worker
 * replays inside a real (Browserbase) browser to register a customer in a
 * developer's / marketer's broker portal.
 *
 * WHY declarative JSON instead of one TypeScript adapter per portal: every
 * broker portal is a different form (different sign-in, different fields), and
 * new ones appear whenever we start selling a new developer's project. A recipe
 * is DATA on the `lead_portals` record — adding or fixing a portal is an edit in
 * the app (or a Claude session), not a worker deploy. The step vocabulary is
 * deliberately small and safe: navigate, fill, click, select, wait, branch on
 * visibility, ask the rep for an OTP, assert success. No arbitrary JS.
 *
 * Templating: any string value may contain `{{path}}` or `{{path|filter|…}}`.
 *   path    — `lead.<key>` (the customer fields collected in the modal),
 *             `portal.<login_url|login_phone|login_email|login_password|name>`,
 *             `client.<field>` / `project.<field>` (raw record data),
 *             `input.<key>` (answers to request_input steps), `vars.<key>` (set).
 *   filters — local (E.164 → 05XXXXXXXX), ksa_short (→ 5XXXXXXXX, for portals
 *             with a separate +966 selector), digits, no_plus, e164, intl (966…),
 *             upper, lower, trim, first_word, rest_words, default:<text>.
 *
 * Documented for operators in docs/lead-portal-recipes.md — keep both in sync.
 */

import type { Locator, Page } from 'playwright-core';
import { captureJsonInventory, type SaveJsonStep } from './jsonInventory.js';
import { waitForAutomaticCaptcha, type WaitCaptchaStep } from './captcha.js';

// ── Step vocabulary ─────────────────────────────────────────────────────────

/** How a step points at an element. Exactly one of these is used, in this
 *  priority: selector → text → label → placeholder → role. */
export interface Target {
  /** Playwright locator string (CSS, `xpath=…`, `text=…`, `#id`, …). */
  selector?: string;
  /** Visible text (substring, case-insensitive) — buttons, links, tabs. */
  text?: string;
  /** Form-control label text. */
  label?: string;
  /** Input placeholder text. */
  placeholder?: string;
  /** ARIA role + accessible name, e.g. role:"button", name:"تسجيل". */
  role?: string;
  name?: string;
  /** Pick the Nth match (0-based) when several match. Default 0. */
  nth?: number;
  /** Match text / label / placeholder / role name EXACTLY (whole string,
   *  case-sensitive) instead of as a substring. Use it when names overlap
   *  ("يمام 1" would otherwise match "يمام 15"). */
  exact?: boolean;
}

export type RecipeStep =
  | { do: 'goto'; url: string; wait?: 'load' | 'domcontentloaded' | 'networkidle'; timeout_ms?: number }
  | ({ do: 'fill'; value: string; clear?: boolean; timeout_ms?: number } & Target)
  | ({ do: 'type'; value: string; delay_ms?: number; clear?: boolean; timeout_ms?: number } & Target)
  // Segmented input (a 6-box OTP field): `selector` matches the N boxes, each
  // gets one character of `value`. Handles the common one-input-per-digit
  // widget that a single `fill`/`type` can't populate.
  | ({ do: 'fill_otp'; value: string; timeout_ms?: number } & Target)
  | ({ do: 'click'; optional?: boolean; timeout_ms?: number; force?: boolean } & Target)
  | ({ do: 'select'; value?: string; option_label?: string; timeout_ms?: number } & Target)
  | ({ do: 'check'; checked?: boolean; timeout_ms?: number } & Target)
  | ({ do: 'press'; key: string } & Target)
  | { do: 'wait'; ms: number }
  | ({ do: 'wait_for'; state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout_ms?: number } & Target)
  | { do: 'wait_for_url'; pattern: string; timeout_ms?: number }
  | WaitCaptchaStep
  /** Record authentication only after a positive authenticated-page assertion. */
  | { do: 'auth_state'; reused: boolean }
  | {
      do: 'request_input';
      /** Where the answer lands: `{{input.<key>}}`. */
      key: string;
      kind?: 'otp' | 'text';
      prompt_ar: string;
      prompt_en: string;
      /** Expected length (OTP digits) — shown as a hint, not enforced. */
      length?: number;
      /** How long to wait for the rep. Default 300 s. */
      timeout_s?: number;
    }
  | { do: 'screenshot'; label?: string; full?: boolean }
  /** Prepare the automatic email-OTP read for the request_input of `key`:
   *  verify the connected mailbox and snapshot the recent-message baseline.
   *  MUST run immediately BEFORE the portal click that sends the OTP (never
   *  after), so a code that arrived earlier is never mistaken for this run's.
   *  Only the runtimes that own a mail reader install the hook; anywhere else
   *  the step fails loudly instead of silently falling back to manual entry. */
  | { do: 'prepare_email_otp'; key: string }
  /** Save the current page's HTML next to the screenshots (private bucket) —
   *  for writing a recipe against a portal whose pages need a sign-in to see. */
  | { do: 'save_html'; label?: string }
  | ({ do: 'assert'; timeout_ms?: number; error_ar?: string; error_en?: string } & Target)
  | ({ do: 'if_visible'; timeout_ms?: number; then?: RecipeStep[]; else?: RecipeStep[] } & Target)
  | { do: 'phase'; ar: string; en: string }
  /** Read the portal's own client list (status checks). Visits `url` for page
   *  1..last and reads the page's embedded Inertia JSON (`#app[data-page]`),
   *  so it follows the portal's DATA, not its table markup. */
  | CollectRowsStep
  | SaveItemsStep
  | SaveInertiaStep
  | SaveJsonStep
  /** `outcome` turns the stop into a recorded ANSWER instead of a failure —
   *  e.g. the portal says the client is already another broker's. */
  | { do: 'fail'; ar: string; en: string; outcome?: RecipeOutcome }
  | { do: 'set'; key: string; value: string };

// ── Errors ──────────────────────────────────────────────────────────────────

/** One client as the portal lists it (status checks). */
export interface CollectedRow {
  ref: string | null;
  name: string | null;
  phone: string | null;
  status_code: string | null;
  status_label: string | null;
}

/**
 * Save the HTML of every repeated item (a unit card) on a set of paginated
 * pages, for the automated project-update lane to read later
 * (project_update_runs). Pages are fetched INSIDE the signed-in page (same
 * cookies), parsed there, and only the matching items' outerHTML is kept — a
 * whole page is ~300 KB, the cards on it a few KB. Walks `?page=1,2,…` per URL
 * until a page has no items or repeats the previous page. Riding the daily
 * status check means one sign-in code a day covers both jobs.
 */
export interface SaveItemsStep {
  do: 'save_items';
  /** Storage file name, e.g. "units" → inventory/<portal record id>/units.json. */
  key: string;
  /** Page URLs with `{{page}}`, e.g. https://broker.safainv.sa/project/properties/108?page={{page}}. */
  urls: string[];
  /** CSS selector of ONE item, e.g. "div.unit_details". */
  item_selector: string;
  /** Per-URL safety ceiling — more pages FAILS loudly. Default 80. */
  max_pages?: number;
  /** When true, a failure here is LOGGED (run log + worker stderr) and the
   *  recipe carries on — for a step riding on a status check whose own job
   *  (syncing client statuses) must not be lost to an inventory hiccup. */
  optional?: boolean;
}

/**
 * Save the page JSON (the `data-page` attribute) of a Laravel + Inertia
 * portal's list pages and of each listed record's DETAIL page, all inside the
 * one signed-in visit (Al Ramz, 2026-10-05: its broker portal sends a sign-in
 * code every time, so a second visit to follow links would cost a second
 * code). Fetched in-page with the page's own cookies, like save_items.
 * Saved as inventory/<portal record id>/<key>.json:
 *   { saved_at, rows_path, list: [{url, component, props}], details: {<id>: {url, component, props}} }
 */
export interface SaveInertiaStep {
  do: 'save_inertia';
  key: string;
  /** List page URL; `{{page}}` = 1, 2, … */
  list_url: string;
  /** Dot path to the row array in the page JSON (e.g. `props.projects.data`).
   *  When absent the FIRST array of objects with an `id_key` under `props`
   *  (or `props.<x>.data`) is used, and the path found is saved — for
   *  exploring a portal whose shape is not known yet. */
  rows_path?: string;
  /** Detail page URL with `{{id}}`. */
  detail_url?: string;
  /** Row key holding the id for detail_url. Default "id". */
  id_key?: string;
  /** Ceilings — exceeding them FAILS loudly. Defaults 10 pages / 60 details. */
  max_pages?: number;
  max_details?: number;
  optional?: boolean;
}

export interface CollectRowsStep {
  do: 'collect_rows';
  /** Page URL; `{{page}}` is replaced by the page number (1, 2, …). */
  url: string;
  /**
   * 'inertia' — JSON in the `data-page` attribute of `#app` (Laravel + Inertia,
   *             e.g. Al Ramz): `rows_path` + `last_page_path`, and `fields`
   *             are JSON keys.
   * 'table'   — a plain HTML table (e.g. Riva's Livewire «طلباتي»):
   *             `rows_selector` picks the rows and `fields` are CSS selectors
   *             INSIDE a row. Pages are walked until one comes back empty or
   *             repeats the previous page (a portal that clamps ?page=99).
   */
  source: 'inertia' | 'table';
  /** inertia: dot path inside the page JSON to the row array, e.g. `props.clients.data`. */
  rows_path?: string;
  /** inertia: dot path to the last page number, e.g. `props.clients.last_page`. */
  last_page_path?: string;
  /** table: CSS selector for one row, e.g. `table tbody tr`. */
  rows_selector?: string;
  /** Row field → JSON key (inertia) or, for table, a CSS selector inside the
   *  row — `@attr` reads an attribute of the row itself, `sel@attr` one of a
   *  child. `status_detail` (table) is appended to the status as
   *  "status — detail" (Safa: stage «مغلق» + outcome «خسارة»). */
  fields: { ref?: string; name?: string; phone?: string; status?: string; status_detail?: string };
  /** Regex with ONE capture group applied to the ref, e.g. "(\\d+)$" turns
   *  "lead-info-83964" into "83964". No match ⇒ the ref is kept as read. */
  ref_pattern?: string;
  /** Prepended to the ref (Al Ramz shows its ids as "#14157"). */
  ref_prefix?: string;
  /** Portal status code → the label the portal shows, e.g. { new: "جديد" }. */
  status_labels?: Record<string, string>;
  /** Safety ceiling — more pages than this FAILS loudly (never a silent cut). Default 200. */
  max_pages?: number;
}

/** Put the page number into a collect_rows URL. Runs BEFORE renderTemplate,
 *  which would otherwise treat `{{page}}` as an unknown path and blank it. */
export function withPage(url: string, n: number): string {
  return url.replace(/\{\{\s*page\s*\}\}/g, String(n));
}

/** Runs INSIDE the portal page: fetch an Inertia page with the page's own
 *  session and return its `data-page` JSON text (DOMParser decodes the
 *  entities), or null when the page has none. Also returns the final URL so
 *  a redirect to the sign-in page is visible. */
export const READ_INERTIA = new Function('a', `
  return fetch(a.url, { credentials: 'include' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' at ' + a.url);
    var finalUrl = r.url;
    return r.text().then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var el = doc.querySelector('[data-page]');
      return { url: finalUrl, page: el ? el.getAttribute('data-page') : null };
    });
  });
`);

/** The row array of an Inertia page: at `path`, or (exploring) the first
 *  array of objects carrying `idKey` under props / props.<x>.data. */
export function findInertiaRows(page: unknown, path: string | undefined, idKey: string): { path: string; rows: unknown[] } | null {
  if (path) {
    const rows = jsonPath(page, path);
    return Array.isArray(rows) ? { path, rows } : null;
  }
  const props = (page as { props?: Record<string, unknown> })?.props;
  if (!props || typeof props !== 'object') return null;
  const isRows = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && idKey in (x as object));
  for (const [k, v] of Object.entries(props)) {
    if (isRows(v)) return { path: `props.${k}`, rows: v as unknown[] };
    const inner = (v as { data?: unknown } | null)?.data;
    if (v && typeof v === 'object' && isRows(inner)) return { path: `props.${k}.data`, rows: inner as unknown[] };
  }
  return null;
}

/** Runs INSIDE the portal page: fetch a URL with the page's own session and
 *  return the outerHTML of every item. A string body for the same reason as
 *  READ_TABLE_ROWS (no bundler helpers in the page). */
export const READ_ITEMS = new Function('a', `
  return fetch(a.url, { credentials: 'include' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' at ' + a.url);
    return r.text();
  }).then(function (html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.prototype.map.call(doc.querySelectorAll(a.sel), function (el) { return el.outerHTML; });
  });
`);

type RawTableRow = { ref: string; name: string; phone: string; status: string; status_detail: string };
/**
 * Runs INSIDE the portal page (Playwright serialises it). Built from a string
 * on purpose: a bundler that wraps named inner functions (esbuild keepNames ⇒
 * `__name(...)`) would ship a helper the page does not have, and the step dies
 * with "__name is not defined". A string body has nothing to wrap.
 */
export const READ_TABLE_ROWS = new Function('trs', 'f', `
  return trs.map(function (tr) {
    function clean(v) { return (v || '').replace(/\\s+/g, ' ').trim(); }
    function pick(sel) {
      if (!sel) return '';
      var at = sel.lastIndexOf('@');
      if (at >= 0) {
        var host = at === 0 ? tr : tr.querySelector(sel.slice(0, at));
        return host ? clean(host.getAttribute(sel.slice(at + 1))) : '';
      }
      var el = tr.querySelector(sel);
      return el ? clean(el.textContent) : '';
    }
    return { ref: pick(f.ref), name: pick(f.name), phone: pick(f.phone), status: pick(f.status), status_detail: pick(f.status_detail) };
  });
`) as (trs: unknown[], f: CollectRowsStep['fields']) => RawTableRow[];

/** Walk a dot path through parsed JSON. */
export function jsonPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Map one portal JSON row onto a CollectedRow (pure — unit-tested). */
export function toCollectedRow(raw: unknown, step: Pick<CollectRowsStep, 'fields' | 'ref_prefix' | 'status_labels'>): CollectedRow {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (k?: string): string | null => {
    if (!k) return null;
    const v = o[k];
    if (v == null || v === '') return null;
    return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
  };
  const ref = text(step.fields.ref);
  const code = text(step.fields.status);
  return {
    ref: ref == null ? null : `${step.ref_prefix ?? ''}${ref}`,
    name: text(step.fields.name),
    phone: text(step.fields.phone),
    status_code: code,
    status_label: code == null ? null : (step.status_labels?.[code] ?? code),
  };
}

/** Named results a `fail` step can end a run with instead of a plain failure. */
export type RecipeOutcome = 'already_registered';
export const RECIPE_OUTCOMES: readonly RecipeOutcome[] = ['already_registered'];

/** A recipe-level failure with a bilingual, rep-facing message. */
export class RecipeError extends Error {
  constructor(
    public readonly ar: string,
    public readonly en: string,
    public readonly stepIndex?: number,
    /** Set when the recipe ended on a known answer (see RecipeOutcome). */
    public readonly outcome?: RecipeOutcome,
  ) {
    super(`${ar}\n${en}`);
    this.name = 'RecipeError';
  }
}

/** The rep cancelled (or the watchdog failed) the job while it was running. */
export class RecipeCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'RecipeCancelledError';
  }
}

/**
 * A control-flow signal raised by the RUNTIME (not a step failure) that the
 * job runner must see with its type intact. `stepError` rethrows it unwrapped.
 * Wrapping it into "Step N failed" is exactly how the OTP-relay timeout lost
 * its type and failed runs it was meant to park (2026-09-29).
 */
export class RecipeInterrupt extends Error {}

// ── Templating ──────────────────────────────────────────────────────────────

export type TemplateScope = Record<string, unknown>;

function digitsOf(v: string): string {
  return v.replace(/\D/g, '');
}

/** Saudi mobile in the shape a portal wants. Non-KSA numbers pass through the
 *  digit-only form unchanged so nothing silently becomes a wrong number. */
function ksaLocal(v: string): string {
  const d = digitsOf(v);
  if (/^9665\d{8}$/.test(d)) return `0${d.slice(3)}`;
  if (/^5\d{8}$/.test(d)) return `0${d}`;
  return d;
}
function ksaE164(v: string): string {
  const d = digitsOf(v);
  if (/^05\d{8}$/.test(d)) return `+966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `+966${d}`;
  if (/^9665\d{8}$/.test(d)) return `+${d}`;
  return d ? `+${d}` : '';
}

/** 5XXXXXXXX — the 9-digit form portals with a separate +966 country-code
 *  selector expect. */
function ksaShort(v: string): string {
  const local = ksaLocal(v);
  return /^05\d{8}$/.test(local) ? local.slice(1) : local;
}

function applyFilter(value: string, filter: string): string {
  const [name, arg] = filter.split(':', 2) as [string, string | undefined];
  switch (name.trim()) {
    case 'local':
      return ksaLocal(value);
    case 'ksa_short':
      return ksaShort(value);
    case 'digits':
      return digitsOf(value);
    case 'no_plus':
      return value.replace(/^\+/, '');
    case 'e164':
      return ksaE164(value);
    case 'intl':
      return ksaE164(value).replace(/^\+/, '');
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'trim':
      return value.trim();
    case 'first_word':
      return value.trim().split(/\s+/)[0] ?? '';
    case 'rest_words':
      return value.trim().split(/\s+/).slice(1).join(' ');
    case 'default':
      return value === '' ? (arg ?? '') : value;
    default:
      throw new RecipeError(`مرشّح غير معروف في القالب: ${name}`, `Unknown template filter: ${name}`);
  }
}

function lookupPath(scope: TemplateScope, path: string): string {
  const parts = path.trim().split('.');
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return '';
    }
  }
  if (cur == null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  // Lookup values stored as {id} / arrays render empty rather than "[object Object]".
  return '';
}

/** Render `{{path|filter|…}}` placeholders. Everything else passes through. */
export function renderTemplate(input: string, scope: TemplateScope): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => {
    const [path, ...filters] = expr.split('|');
    let v = lookupPath(scope, path ?? '');
    for (const f of filters) v = applyFilter(v, f);
    return v;
  });
}

// ── Recipe parsing ──────────────────────────────────────────────────────────

const KNOWN_STEPS = new Set([
  'goto', 'fill', 'type', 'fill_otp', 'click', 'select', 'check', 'press', 'wait', 'wait_for', 'wait_for_url',
  'request_input', 'prepare_email_otp', 'screenshot', 'save_html', 'assert', 'if_visible', 'phase', 'fail', 'set', 'collect_rows', 'save_items',
  'save_inertia',
  'wait_captcha', 'auth_state', 'save_json',
]);

/** Parse the `recipe` field (JSON text or an already-parsed array). Throws a
 *  RecipeError naming the problem so a broken recipe fails BEFORE a browser is
 *  paid for. Validation is shallow on purpose (the step vocabulary is small);
 *  each step is re-checked when it runs. */
export function parseRecipe(raw: unknown): RecipeStep[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) throw new RecipeError('خطوات الأتمتة فارغة لهذه البوابة', 'This portal has no automation recipe yet');
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new RecipeError(
        'خطوات الأتمتة ليست JSON صالحاً',
        `Recipe is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { steps?: unknown }).steps)) {
    value = (value as { steps: unknown[] }).steps;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new RecipeError('خطوات الأتمتة يجب أن تكون قائمة خطوات', 'Recipe must be a non-empty array of steps');
  }
  const check = (steps: unknown[], prefix: string): RecipeStep[] => {
    return steps.map((s, i) => {
      const at = `${prefix}${i}`;
      if (!s || typeof s !== 'object' || typeof (s as { do?: unknown }).do !== 'string') {
        throw new RecipeError(`الخطوة ${at} بلا نوع (do)`, `Step ${at} has no "do"`);
      }
      const step = s as RecipeStep;
      if (!KNOWN_STEPS.has(step.do)) {
        throw new RecipeError(`نوع خطوة غير معروف: ${step.do} (الخطوة ${at})`, `Unknown step "${step.do}" at ${at}`);
      }
      if (step.do === 'if_visible') {
        if (step.then) step.then = check(step.then, `${at}.then.`);
        if (step.else) step.else = check(step.else, `${at}.else.`);
      }
      if (step.do === 'request_input' && !step.key) {
        throw new RecipeError(`خطوة request_input بلا key (الخطوة ${at})`, `request_input at ${at} needs a "key"`);
      }
      if (step.do === 'prepare_email_otp' && (typeof step.key !== 'string' || step.key.trim() === '')) {
        throw new RecipeError(`خطوة prepare_email_otp بلا key (الخطوة ${at})`, `prepare_email_otp at ${at} needs a non-empty string "key"`);
      }
      if (step.do === 'save_json' && (!step.key || !step.selector || !step.attr)) {
        throw new RecipeError(`خطوة save_json ناقصة (الخطوة ${at})`, `save_json at ${at} needs key, selector and attr`);
      }
      if (step.do === 'auth_state' && typeof step.reused !== 'boolean') {
        throw new RecipeError(`خطوة auth_state ناقصة (الخطوة ${at})`, `auth_state at ${at} needs reused:true/false`);
      }
      return step;
    });
  };
  return check(value, '');
}

// ── Runtime ─────────────────────────────────────────────────────────────────

export interface RecipeRuntime {
  page: Page;
  /** Template scope: { lead, portal, client, project, input, vars }. Mutated by
   *  `set` and `request_input`. */
  scope: TemplateScope & { input: Record<string, string>; vars: Record<string, string> };
  log: (msg: string) => void;
  /** Show a bilingual progress label to the rep. */
  phase: (ar: string, en: string) => Promise<void>;
  /** Capture the current page for the run's evidence trail (`full` = whole
   *  scrollable page, not just the viewport). */
  screenshot: (label: string, full?: boolean) => Promise<void>;
  /** Pause: ask the rep a question (an OTP) and wait for the answer. */
  requestInput: (step: Extract<RecipeStep, { do: 'request_input' }>) => Promise<string>;
  /** Prepare the automatic email-OTP read for the upcoming request_input of
   *  `key` (verify the mailbox + snapshot the recent-message baseline). Only
   *  runtimes with a configured mail reader install it — the job runner also
   *  installs an explicit NO-OP when mail is deliberately disabled, so a
   *  recipe step here never fails a portal whose relay is manual. Absent ⇒
   *  the step fails loudly (a missing hook means misconfigured runtime, and
   *  proceeding would click the portal's "send OTP" with nobody reading). */
  prepareEmailOtp?: (key: string) => Promise<void>;
  /** Throws RecipeCancelledError if the rep cancelled meanwhile. */
  checkCancelled: () => Promise<void>;
  /** Keep long automated CAPTCHA waits and inventory fetches alive. */
  heartbeat?: () => Promise<void>;
  /** Auth metadata for an opt-in persistent portal context. */
  authState?: (reused: boolean) => Promise<void>;
  /** Store the page HTML as run evidence (`save_html`). Absent ⇒ the step fails loudly. */
  saveHtml?: (label: string) => Promise<void>;
  /** Store what `save_items` read. Absent ⇒ the step fails loudly. */
  saveItems?: (key: string, data: { saved_at: string } & Record<string, unknown>) => Promise<void>;
  /** Where `collect_rows` puts what it read. Absent on a registration run,
   *  where a `collect_rows` step is a recipe mistake and fails loudly. */
  collected?: CollectedRow[];
  /** Set only when a collect_rows step actually executes (empty list is valid). */
  didCollectRows?: boolean;
  /** Completed inventory captures, for inventory-only status_check results. */
  savedInventories?: { key: string; totalCount?: number }[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

function describeTarget(t: Target): string {
  return t.selector ?? t.text ?? t.label ?? t.placeholder ?? (t.role ? `${t.role}:${t.name ?? ''}` : '?');
}

function locate(page: Page, t: Target, scope: TemplateScope): Locator {
  const r = (s: string) => renderTemplate(s, scope);
  const exact = t.exact === true;
  let loc: Locator;
  if (t.selector) loc = page.locator(r(t.selector));
  else if (t.text) loc = page.getByText(r(t.text), { exact });
  else if (t.label) loc = page.getByLabel(r(t.label), { exact });
  else if (t.placeholder) loc = page.getByPlaceholder(r(t.placeholder), { exact });
  else if (t.role) {
    loc = page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: r(t.name), exact } : undefined);
  } else {
    throw new RecipeError('خطوة بلا هدف (selector/text/label/placeholder/role)', 'Step has no target');
  }
  return loc.nth(t.nth ?? 0);
}

function stepError(step: RecipeStep, index: number, err: unknown): RecipeError {
  if (err instanceof RecipeError) return err;
  if (err instanceof RecipeCancelledError || err instanceof RecipeInterrupt) throw err;
  const msg = err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
  const what = 'selector' in step || 'text' in step || 'label' in step || 'placeholder' in step || 'role' in step
    ? ` (${describeTarget(step as Target)})`
    : '';
  return new RecipeError(
    `فشلت الخطوة ${index + 1} (${step.do}${what}): ${msg}`,
    `Step ${index + 1} (${step.do}${what}) failed: ${msg}`,
    index,
  );
}

async function runOne(step: RecipeStep, index: number, rt: RecipeRuntime): Promise<void> {
  const { page, scope } = rt;
  const r = (s: string) => renderTemplate(s, scope);
  const tmo = (s: { timeout_ms?: number }) => s.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  switch (step.do) {
    case 'goto': {
      const url = r(step.url);
      rt.log(`goto ${url}`);
      await page.goto(url, { waitUntil: step.wait ?? 'domcontentloaded', timeout: step.timeout_ms ?? 90_000 });
      return;
    }
    case 'fill': {
      const loc = locate(page, step, scope);
      const value = r(step.value);
      rt.log(`fill ${describeTarget(step)} ← ${value ? '<value>' : '<empty>'}`);
      await loc.waitFor({ state: 'visible', timeout: tmo(step) });
      if (step.clear) await loc.fill('');
      await loc.fill(value, { timeout: tmo(step) });
      return;
    }
    case 'type': {
      const loc = locate(page, step, scope);
      const value = r(step.value);
      rt.log(`type ${describeTarget(step)}`);
      await loc.waitFor({ state: 'visible', timeout: tmo(step) });
      await loc.click({ timeout: tmo(step) });
      if (step.clear) await loc.fill('');
      await loc.pressSequentially(value, { delay: step.delay_ms ?? 60 });
      return;
    }
    case 'fill_otp': {
      const value = r(step.value).replace(/\s+/g, '');
      const boxes = locate(page, step, scope);
      await boxes.first().waitFor({ state: 'visible', timeout: tmo(step) });
      const count = await boxes.count();
      rt.log(`fill_otp ${describeTarget(step)} → ${count} boxes`);
      if (count <= 1) {
        // Single input that happens to accept the whole code — type it in.
        await boxes.first().click({ timeout: tmo(step) });
        await boxes.first().fill('');
        await boxes.first().pressSequentially(value, { delay: 60 });
        return;
      }
      for (let i = 0; i < Math.min(count, value.length); i++) {
        await boxes.nth(i).fill(value[i]!, { timeout: tmo(step) });
      }
      return;
    }
    case 'click': {
      const loc = locate(page, step, scope);
      rt.log(`click ${describeTarget(step)}${step.optional ? ' (optional)' : ''}`);
      try {
        await loc.click({ timeout: tmo(step), force: step.force ?? false });
      } catch (err) {
        if (step.optional) {
          rt.log(`optional click skipped: ${describeTarget(step)}`);
          return;
        }
        throw err;
      }
      return;
    }
    case 'select': {
      const loc = locate(page, step, scope);
      rt.log(`select ${describeTarget(step)}`);
      if (step.value != null) await loc.selectOption({ value: r(step.value) }, { timeout: tmo(step) });
      else if (step.option_label != null) await loc.selectOption({ label: r(step.option_label) }, { timeout: tmo(step) });
      else throw new RecipeError('خطوة select بلا value أو option_label', 'select needs "value" or "option_label"');
      return;
    }
    case 'check': {
      const loc = locate(page, step, scope);
      rt.log(`check ${describeTarget(step)}`);
      await loc.setChecked(step.checked ?? true, { timeout: tmo(step) });
      return;
    }
    case 'press': {
      rt.log(`press ${step.key}`);
      if (step.selector || step.text || step.label || step.placeholder || step.role) {
        await locate(page, step, scope).press(step.key);
      } else {
        await page.keyboard.press(step.key);
      }
      return;
    }
    case 'wait': {
      await page.waitForTimeout(Math.min(step.ms, 60_000));
      return;
    }
    case 'wait_for': {
      const loc = locate(page, step, scope);
      rt.log(`wait_for ${describeTarget(step)} ${step.state ?? 'visible'}`);
      await loc.waitFor({ state: step.state ?? 'visible', timeout: tmo(step) });
      return;
    }
    case 'wait_for_url': {
      const p = r(step.pattern);
      rt.log(`wait_for_url ${p}`);
      const matcher = p.startsWith('re:') ? new RegExp(p.slice(3)) : p;
      await page.waitForURL(matcher, { timeout: step.timeout_ms ?? 60_000 });
      return;
    }
    case 'request_input': {
      rt.log(`request_input ${step.key}`);
      const answer = await rt.requestInput(step);
      scope.input[step.key] = answer;
      return;
    }
    case 'prepare_email_otp': {
      // Log the step and key ONLY — the hook's own logging (mailbox, codes,
      // message ids) is the mail reader's responsibility and must stay opaque.
      rt.log(`prepare_email_otp ${step.key}`);
      if (!rt.prepareEmailOtp) {
        throw new RecipeError(
          'قراءة رمز البريد الإلكتروني غير مهيأة لهذا التشغيل',
          'prepare_email_otp is not available in this runtime',
          index,
        );
      }
      await rt.prepareEmailOtp(step.key);
      return;
    }
    case 'wait_captcha': {
      await waitForAutomaticCaptcha(page, {
        ...step,
        token_selector: step.token_selector ? r(step.token_selector) : undefined,
        success_selector: step.success_selector ? r(step.success_selector) : undefined,
        success_url: step.success_url ? r(step.success_url) : undefined,
      }, rt);
      return;
    }
    case 'auth_state': {
      if (!rt.authState) throw new RecipeError('حالة الدخول غير متاحة هنا', 'auth_state is not available here', index);
      await rt.authState(step.reused);
      return;
    }
    case 'save_json': {
      if (!rt.saveItems) throw new RecipeError('حفظ البيانات غير متاح هنا', 'save_json is not available here', index);
      const payload = await captureJsonInventory(page, { ...step, selector: r(step.selector), attr: r(step.attr) }, rt);
      await rt.saveItems(step.key, { ...payload });
      (rt.savedInventories ??= []).push({ key: step.key, totalCount: payload.totalCount });
      return;
    }
    case 'save_items': {
      if (!rt.saveItems) throw new RecipeError('حفظ العناصر غير متاح هنا', 'save_items is not available here', index);
      if (!step.key || !Array.isArray(step.urls) || !step.item_selector) {
        throw new RecipeError('save_items يحتاج key و urls و item_selector', 'save_items needs key, urls and item_selector', index);
      }
      const maxPages = step.max_pages ?? 80;
      const pages: Record<string, string[][]> = {};
      try {
      for (const tpl of step.urls) {
        const list: string[][] = [];
        let prevSig = '';
        for (let n = 1; ; n++) {
          if (n > maxPages) {
            throw new RecipeError(`أكثر من ${maxPages} صفحة في ${tpl}`, `More than ${maxPages} pages at ${tpl}; raise max_pages`, index);
          }
          await rt.checkCancelled();
          const url = r(withPage(tpl, n));
          const items = (await page.evaluate(READ_ITEMS as (a: { url: string; sel: string }) => Promise<string[]>, { url, sel: step.item_selector })) as string[];
          const sig = items.length ? items[0]!.slice(0, 400) : '';
          if (items.length === 0 || sig === prevSig) break;
          prevSig = sig;
          list.push(items);
        }
        rt.log(`save_items ${tpl}: ${list.reduce((a, x) => a + x.length, 0)} items on ${list.length} pages`);
        pages[tpl] = list;
      }
      await rt.saveItems(step.key, { saved_at: new Date().toISOString(), pages });
      (rt.savedInventories ??= []).push({ key: step.key });
      } catch (err) {
        // Scoped to save_items with optional:true. A cancellation still
        // propagates (it is not an inventory failure).
        if (!step.optional || err instanceof RecipeCancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        rt.log(`save_items (optional) FAILED — the rest of the recipe continues: ${msg}`);
        console.error(`[portal] optional save_items ${step.key} failed: ${msg}`);
      }
      return;
    }
    case 'save_inertia': {
      if (!rt.saveItems) throw new RecipeError('حفظ العناصر غير متاح هنا', 'save_inertia is not available here', index);
      if (!step.key || !step.list_url) {
        throw new RecipeError('save_inertia يحتاج key و list_url', 'save_inertia needs key and list_url', index);
      }
      const maxPages = step.max_pages ?? 10;
      const maxDetails = step.max_details ?? 60;
      const idKey = step.id_key ?? 'id';
      type Saved = { url: string; component: unknown; props: unknown };
      const read = async (url: string): Promise<Saved> => {
        const got = (await page.evaluate(READ_INERTIA as (a: { url: string }) => Promise<{ url: string; page: string | null }>, { url })) as { url: string; page: string | null };
        if (!got.page) throw new RecipeError(`لا توجد بيانات صفحة في ${url}`, `No data-page JSON at ${url} (landed on ${got.url})`, index);
        const data = JSON.parse(got.page) as { component?: unknown; props?: unknown };
        if (typeof data.component === 'string' && /login/i.test(data.component)) {
          throw new RecipeError('انتهت جلسة الدخول قبل الحفظ', `Not signed in — ${url} answered the ${data.component} page`, index);
        }
        return { url: got.url, component: data.component ?? null, props: data.props ?? null };
      };
      try {
        const list: Saved[] = [];
        const ids: string[] = [];
        let rowsPath: string | null = step.rows_path ?? null;
        let prevSig = '';
        for (let n = 1; ; n++) {
          if (n > maxPages) throw new RecipeError(`أكثر من ${maxPages} صفحة في ${step.list_url}`, `More than ${maxPages} pages at ${step.list_url}; raise max_pages`, index);
          await rt.checkCancelled();
          const saved = await read(r(withPage(step.list_url, n)));
          const found = findInertiaRows(saved, rowsPath ?? undefined, idKey);
          const pageIds = (found?.rows ?? []).map((x) => String((x as Record<string, unknown>)[idKey]));
          const sig = pageIds.join('|');
          if (n === 1 || (pageIds.length && sig !== prevSig)) list.push(saved);
          if (!found || pageIds.length === 0 || sig === prevSig) break;
          rowsPath = found.path;
          prevSig = sig;
          ids.push(...pageIds);
          if (!step.list_url.includes('{{page}}')) break;
        }
        const details: Record<string, Saved> = {};
        if (step.detail_url) {
          const unique = [...new Set(ids)];
          if (unique.length > maxDetails) throw new RecipeError(`أكثر من ${maxDetails} سجل`, `${unique.length} records — over the ${maxDetails} ceiling; raise max_details`, index);
          for (const id of unique) {
            await rt.checkCancelled();
            details[id] = await read(r(step.detail_url.replace(/\{\{\s*id\s*\}\}/g, encodeURIComponent(id))));
          }
        }
        rt.log(`save_inertia ${step.key}: ${list.length} list page(s), ${ids.length} rows at ${rowsPath ?? '(none found)'}, ${Object.keys(details).length} detail page(s)`);
        await rt.saveItems(step.key, { saved_at: new Date().toISOString(), rows_path: rowsPath, list, details });
        (rt.savedInventories ??= []).push({ key: step.key });
      } catch (err) {
        if (!step.optional || err instanceof RecipeCancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        rt.log(`save_inertia (optional) FAILED — the rest of the recipe continues: ${msg}`);
        console.error(`[portal] optional save_inertia ${step.key} failed: ${msg}`);
      }
      return;
    }
    case 'save_html': {
      if (!rt.saveHtml) throw new RecipeError('حفظ الصفحة غير متاح هنا', 'save_html is not available here', index);
      await rt.saveHtml(step.label ?? `page-${index + 1}`);
      return;
    }
    case 'screenshot': {
      await rt.screenshot(step.label ?? `step-${index + 1}`, step.full === true);
      return;
    }
    case 'assert': {
      const loc = locate(page, step, scope);
      rt.log(`assert ${describeTarget(step)}`);
      try {
        await loc.waitFor({ state: 'visible', timeout: step.timeout_ms ?? 20_000 });
      } catch {
        throw new RecipeError(
          step.error_ar ?? `لم يظهر العنصر المتوقع: ${describeTarget(step)}`,
          step.error_en ?? `Expected element did not appear: ${describeTarget(step)}`,
          index,
        );
      }
      return;
    }
    case 'if_visible': {
      const loc = locate(page, step, scope);
      // ONLY a timeout means "not visible". Anything else (the page closed, a
      // bad selector, the browser dropped) is a real failure and must fail the
      // step — until 2026-10-05 every error read as "not visible", so a broken
      // check silently took the wrong branch (Riva: the login was skipped and
      // the run died 30 s later on the login page with a misleading message).
      const visible = await loc
        .waitFor({ state: 'visible', timeout: step.timeout_ms ?? 3_000 })
        .then(() => true)
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'TimeoutError') return false;
          throw err;
        });
      rt.log(`if_visible ${describeTarget(step)} → ${visible}`);
      const branch = visible ? step.then : step.else;
      if (branch) await runSteps(branch, rt);
      return;
    }
    case 'phase': {
      await rt.phase(r(step.ar), r(step.en));
      return;
    }
    case 'fail': {
      if (step.outcome !== undefined && !RECIPE_OUTCOMES.includes(step.outcome)) {
        throw new RecipeError(`نتيجة غير معروفة في خطوة fail: ${String(step.outcome)}`, `Unknown fail outcome: ${String(step.outcome)}`, index);
      }
      throw new RecipeError(r(step.ar), r(step.en), index, step.outcome);
    }
    case 'set': {
      scope.vars[step.key] = r(step.value);
      return;
    }
    case 'collect_rows': {
      rt.didCollectRows = true;
      if (!rt.collected) {
        throw new RecipeError('خطوة collect_rows تعمل في فحص الحالات فقط', 'collect_rows only runs in a status check', index);
      }
      const maxPages = step.max_pages ?? 200;
      if (step.source === 'table') {
        if (!step.rows_selector) throw new RecipeError('collect_rows (table) يحتاج rows_selector', 'collect_rows (table) needs rows_selector', index);
        let prevSig = '';
        for (let n = 1; ; n++) {
          if (n > maxPages) {
            throw new RecipeError(
              `قائمة البوابة أطول من ${maxPages} صفحة؛ ارفع max_pages`,
              `Portal list runs past ${maxPages} pages; raise max_pages`,
              index,
            );
          }
          await rt.checkCancelled();
          const url = r(withPage(step.url, n));
          rt.log(`collect_rows page ${n} ${url}`);
          await page.goto(url, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT_MS });
          const raw = await page.$$eval(step.rows_selector, READ_TABLE_ROWS, step.fields);
          // Drop "no results" / spacer rows (Riva's «لا توجد طلبات بعد» sits in
          // the first cell). A real lead row has a phone — the very thing the
          // sync matches on, so a phoneless row could never be used anyway.
          const rows = raw.filter((x) => /\d{6,}/.test(x.phone.replace(/\D/g, '')));
          const sig = rows.map((x) => x.ref || x.phone).join('|');
          if (rows.length === 0 || sig === prevSig) break;
          prevSig = sig;
          const refRe = step.ref_pattern ? new RegExp(step.ref_pattern) : null;
          for (const x of rows) {
            const ref = refRe ? (refRe.exec(x.ref)?.[1] ?? x.ref) : x.ref;
            const code = [x.status, x.status_detail].filter(Boolean).join(' — ');
            rt.collected.push({
              ref: ref ? `${step.ref_prefix ?? ''}${ref}` : null,
              name: x.name || null,
              phone: x.phone || null,
              status_code: code || null,
              status_label: code ? (step.status_labels?.[code] ?? code) : null,
            });
          }
        }
        rt.log(`collect_rows read ${rt.collected.length} rows`);
        return;
      }
      if (step.source !== 'inertia' || !step.rows_path || !step.last_page_path) {
        throw new RecipeError(
          `collect_rows: مصدر غير مدعوم أو ناقص (${String(step.source)})`,
          `collect_rows: unsupported or incomplete source (${String(step.source)}) — inertia needs rows_path + last_page_path`,
          index,
        );
      }
      const rowsPath = step.rows_path;
      const lastPagePath = step.last_page_path;
      let last = 1;
      for (let n = 1; n <= last; n++) {
        await rt.checkCancelled();
        const url = r(withPage(step.url, n));
        rt.log(`collect_rows page ${n}${last > 1 ? `/${last}` : ''} ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
        const attr = await page.locator('#app').getAttribute('data-page', { timeout: DEFAULT_TIMEOUT_MS });
        if (!attr) throw new RecipeError('لم أجد بيانات الصفحة (data-page)', 'The page has no data-page JSON', index);
        let data: unknown;
        try {
          data = JSON.parse(attr);
        } catch (err) {
          throw new RecipeError('بيانات الصفحة ليست JSON صالحاً', `data-page is not valid JSON: ${(err as Error).message}`, index);
        }
        const rows = jsonPath(data, rowsPath);
        if (!Array.isArray(rows)) {
          throw new RecipeError(`لم أجد قائمة العملاء في ${rowsPath}`, `No row array at ${rowsPath}`, index);
        }
        for (const row of rows) rt.collected.push(toCollectedRow(row, step));
        if (n === 1) {
          const lp = Number(jsonPath(data, lastPagePath));
          last = Number.isFinite(lp) && lp >= 1 ? Math.floor(lp) : 1;
          if (last > maxPages) {
            throw new RecipeError(
              `قائمة البوابة ${last} صفحة — أكثر من الحد ${maxPages}؛ ارفع max_pages`,
              `Portal list has ${last} pages — over the ${maxPages} ceiling; raise max_pages`,
              index,
            );
          }
        }
      }
      rt.log(`collect_rows read ${rt.collected.length} rows over ${last} page(s)`);
      return;
    }
  }
}

/** Run a step list in order. Cancellation is checked before every step. */
/** Top-level `phase` steps in a recipe. A registration's LAST phase is its
 *  submit — the point after which the portal may already hold the client, so
 *  a worker restart must not start the run again (see the 'committing' phase
 *  in runPortalRegistrationJob and portal_registration_job_handback). */
export function countTopLevelPhases(steps: RecipeStep[]): number {
  return steps.filter((s) => s.do === 'phase').length;
}

export async function runSteps(steps: RecipeStep[], rt: RecipeRuntime): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    await rt.checkCancelled();
    try {
      await runOne(step, i, rt);
    } catch (err) {
      throw stepError(step, i, err);
    }
  }
}

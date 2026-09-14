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
  | ({ do: 'assert'; timeout_ms?: number; error_ar?: string; error_en?: string } & Target)
  | ({ do: 'if_visible'; timeout_ms?: number; then?: RecipeStep[]; else?: RecipeStep[] } & Target)
  | { do: 'phase'; ar: string; en: string }
  | { do: 'fail'; ar: string; en: string }
  | { do: 'set'; key: string; value: string };

// ── Errors ──────────────────────────────────────────────────────────────────

/** A recipe-level failure with a bilingual, rep-facing message. */
export class RecipeError extends Error {
  constructor(
    public readonly ar: string,
    public readonly en: string,
    public readonly stepIndex?: number,
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
  'request_input', 'screenshot', 'assert', 'if_visible', 'phase', 'fail', 'set',
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
  /** Throws RecipeCancelledError if the rep cancelled meanwhile. */
  checkCancelled: () => Promise<void>;
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
  if (err instanceof RecipeCancelledError) throw err;
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
      const visible = await loc
        .waitFor({ state: 'visible', timeout: step.timeout_ms ?? 3_000 })
        .then(() => true)
        .catch(() => false);
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
      throw new RecipeError(r(step.ar), r(step.en), index);
    }
    case 'set': {
      scope.vars[step.key] = r(step.value);
      return;
    }
  }
}

/** Run a step list in order. Cancellation is checked before every step. */
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

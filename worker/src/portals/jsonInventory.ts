import type { Page } from 'playwright-core';

/** Deliberately closed JSON endpoint capture: no JavaScript is accepted from
 * recipes. The endpoint must be from the currently signed-in portal. */
export interface SaveJsonStep {
  do: 'save_json';
  key: string;
  selector: string;
  attr: string;
  items_path?: string;
  total_path?: string;
  page_no_path?: string;
  page_size_path?: string;
  page_param?: string;
  page_size_param?: string;
  page_size?: number;
  id_key?: string;
  max_pages?: number;
  timeout_ms?: number;
  /** Empty inventories require an explicit decision; otherwise fail closed. */
  allow_empty?: boolean;
}

export interface JsonInventory {
  saved_at: string;
  complete: true;
  totalCount: number;
  items: Record<string, unknown>[];
}

/** Built from a string so esbuild cannot inject helpers absent in the page.
 * Cookies stay inside the browser; redirected login HTML is never accepted. */
export const READ_JSON_PAGE = new Function('a', `
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, a.timeout);
  return fetch(a.url, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal })
    .then(function (r) {
      if (!r.ok) throw new Error('Inventory HTTP ' + r.status);
      if (!/json/i.test(r.headers.get('content-type') || '')) throw new Error('Inventory endpoint did not return JSON (login expired?)');
      return r.json();
    }).finally(function () { clearTimeout(timer); });
`) as (args: { url: string; timeout: number }) => Promise<unknown>;

function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object'
    ? (current as Record<string, unknown>)[key] : undefined, value);
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  }
  return value;
}

/** Fetch one page at a time and only return an all-or-nothing snapshot. Count
 * drift, repeated/clamped pages, duplicate IDs and partial pages fail loudly. */
export async function captureJsonInventory(
  page: Page,
  step: SaveJsonStep,
  hooks: { checkCancelled: () => Promise<void>; heartbeat?: () => Promise<void>; log: (msg: string) => void },
): Promise<JsonInventory> {
  const savedAt = new Date().toISOString();
  const pageSize = integer(step.page_size ?? 1000, 'page_size', 1, 1000);
  const maxPages = integer(step.max_pages ?? 50, 'max_pages', 1, 1000);
  const timeout = integer(step.timeout_ms ?? 30_000, 'timeout_ms', 1000, 60_000);
  if (!step.key || !step.selector || !step.attr) throw new Error('save_json needs key, selector and attr');
  const attr = await page.locator(step.selector).first().getAttribute(step.attr, { timeout });
  if (!attr?.trim()) throw new Error(`Inventory URL attribute ${step.attr} is missing`);
  const current = new URL(page.url());
  const endpoint = new URL(attr, current);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.origin !== current.origin) {
    throw new Error('Inventory endpoint must use the signed-in portal origin');
  }
  const items: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  const idKey = step.id_key ?? 'id';
  let totalCount: number | undefined;
  let responseSize: number | undefined;
  for (let n = 1; n <= maxPages; n++) {
    await hooks.checkCancelled();
    await hooks.heartbeat?.();
    const url = new URL(endpoint);
    url.searchParams.set(step.page_param ?? 'pageNo', String(n));
    url.searchParams.set(step.page_size_param ?? 'pageSize', String(pageSize));
    const data = await page.evaluate(READ_JSON_PAGE, { url: url.href, timeout });
    const rows = at(data, step.items_path ?? 'data.items');
    const total = integer(at(data, step.total_path ?? 'data.totalCount'), 'totalCount', 0, 1_000_000);
    const actualPage = integer(at(data, step.page_no_path ?? 'data.pageNo'), 'response pageNo', 1, maxPages);
    const size = integer(at(data, step.page_size_path ?? 'data.pageSize'), 'response pageSize', 1, pageSize);
    if (actualPage !== n) throw new Error(`Inventory returned page ${actualPage} when page ${n} was requested`);
    if (totalCount != null && total !== totalCount) throw new Error('Inventory totalCount changed during pagination');
    if (responseSize != null && responseSize !== size) throw new Error('Inventory pageSize changed during pagination');
    totalCount = total;
    responseSize = size;
    if (!Array.isArray(rows)) throw new Error('Inventory items is not an array');
    const expected = Math.min(size, Math.max(0, totalCount - items.length));
    if (rows.length !== expected) throw new Error(`Inventory page ${n} has ${rows.length} items; expected ${expected}`);
    for (const value of rows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid inventory item');
      const row = value as Record<string, unknown>;
      const id = row[idKey];
      if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim() || (typeof id === 'number' && !Number.isFinite(id))) {
        throw new Error(`Inventory item lacks a valid ${idKey}`);
      }
      const key = String(id).trim();
      if (ids.has(key)) throw new Error(`Inventory duplicate ${idKey}: ${key}`);
      ids.add(key);
      items.push(row);
    }
    hooks.log(`save_json page ${n}: ${items.length}/${totalCount} items`);
    if (items.length === totalCount) {
      if (!items.length && step.allow_empty !== true) throw new Error('Empty inventory rejected; verify the login and filters');
      await hooks.checkCancelled();
      return { saved_at: savedAt, complete: true, totalCount, items };
    }
  }
  throw new Error(`Inventory incomplete after ${maxPages} pages: ${items.length}/${totalCount}`);
}

/** An older capture must never replace a newer validated snapshot. Portal
 * jobs are serialized in claim_next; this also protects delayed old jobs. */
export function assertSnapshotIsNewer(incoming: string, stored: unknown): void {
  const next = Date.parse(incoming);
  if (!Number.isFinite(next)) throw new Error('Inventory snapshot timestamp is invalid');
  if (!stored || typeof stored !== 'object') throw new Error('Stored inventory snapshot is not an object');
  const previous = Date.parse(String((stored as Record<string, unknown>).saved_at ?? ''));
  if (!Number.isFinite(previous)) throw new Error('Stored inventory snapshot timestamp is invalid');
  if (previous >= next) throw new Error('Stale inventory capture rejected; a newer snapshot is already stored');
}

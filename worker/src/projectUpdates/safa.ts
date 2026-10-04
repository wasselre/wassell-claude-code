/**
 * Safa (صفا للاستثمار) adapter — TWO partial sources, as the manual runs found
 * (migrate-project SKILL.md, 2026-09-07):
 *
 *  - PUBLIC  https://safainv.sa/project/units/<id>?page=N — customer-facing
 *    units; no login; read here directly.
 *  - BROKER  https://broker.safainv.sa/project/properties/<id>?page=N — the
 *    broker-released units; login needs an SMS code. The portal's daily
 *    status check (lead_portals «صفا (برنامج كسب)», status_recipe) already
 *    signs in with the WhatsApp code relay; its `save_items` step stores the
 *    unit cards in `portal-registrations/inventory/<portal>/units.json`. This
 *    adapter reads that file.
 *
 * Neither source shows sold / reserved. "Listed for sale" = the UNION of both;
 * a CRM unit that is available but listed by NEITHER is sold — and that rule
 * is only safe when BOTH lists are fresh, so without a fresh broker file the
 * run marks nothing sold (it still updates prices and adds new units).
 *
 * Join: the unit code («SF085-A01-F01-001-APT») == CRM unit_model ==
 * developer_unit_code. Roof units are «-R01-», not «-F0x-» (a F-only regex
 * dropped 27 units in the manual run — the code pattern below takes both).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { num, toAsciiDigits } from './reconcile.js';
import type { SourceProject, SourceUnit, UnitStatus } from './types.js';

const PUBLIC = 'https://safainv.sa/project/units';
export const SAFA_PORTAL_RECORD_ID = 'd2c8bfd8-5f37-4979-ad25-10709218d0df';
const BROKER_FILE = `inventory/${SAFA_PORTAL_RECORD_ID}/units.json`;
/** A broker snapshot older than this does not count as "fresh". */
export const BROKER_MAX_AGE_MS = 36 * 3600_000;

const CODE_RE = /SF\d{3}-[A-Z0-9]+-[FR]\d+-\d+-[A-Z]{2,4}/;

function strip(html: string): string {
  return toAsciiDigits(
    html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function typeOf(code: string, text: string): string | null {
  const suf = code.split('-').pop() ?? '';
  const map: Record<string, string> = { APT: 'شقة', TWH: 'تاون هاوس', VIL: 'فيلا', DPX: 'دبلكس', PH: 'بنتهاوس', PNT: 'بنتهاوس' };
  if (map[suf]) return map[suf]!;
  return /شقة|تاون|فيلا|دبلكس|بنتهاوس|دور/.exec(text)?.[0] ?? null;
}

/** One PUBLIC card (`div.unit-card-item`). */
export function parsePublicCard(html: string, comingSoon: boolean): SourceUnit | null {
  const code = html.match(/class="unit-title"[^>]*>\s*([^<]+?)\s*</)?.[1]?.trim() ?? CODE_RE.exec(html)?.[0] ?? null;
  if (!code) return null;
  const area = num(html.match(/([\d.,]+)\s*م²/)?.[1]);
  const priceBlock = html.match(/class="price"[^>]*>([\s\S]*?)<div class="icons/)?.[1] ?? '';
  const price = num(strip(priceBlock).match(/[\d,]{4,}/)?.[0]);
  const icons = html.match(/class="icons[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  const spans = [...icons.matchAll(/<span[^>]*>\s*([^<]*?)\s*<\/span>/g)].map((m) => m[1]!.trim());
  const label = strip(html.match(/class="label"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
  const soon = comingSoon || /قريب/.test(label);
  return {
    sourceId: html.match(/data-id="(\d+)"/)?.[1] ?? null,
    unitCode: code,
    unitModel: code,
    unitType: typeOf(code, strip(html)),
    status: (soon ? 'under_construction' : 'available') as UnitStatus,
    // The public price is on a DIFFERENT basis from the one we store (VAT
    // included / a discount: صفا 80 1,598,000 vs our 1,521,879 = +5%). Prices
    // come from the broker cards only; the public figure is kept as a note.
    price: null,
    description: price != null && price > 0 ? `سعر الموقع العام: ${price.toLocaleString('en-US')} ر.س (قد يشمل الضريبة أو خصماً)` : null,
    area,
    bedrooms: num(spans[0]),
    bathrooms: num(spans[1]),
    floor: spans[2] ?? null,
  };
}

/**
 * One BROKER card (`div.unit_details`). The broker card also shows the
 * commission, so the price is the largest amount on the card — the commission
 * is a few thousand or a percentage, the unit price six or seven digits.
 */
export function parseBrokerCard(html: string): SourceUnit | null {
  const text = strip(html);
  const code = CODE_RE.exec(text)?.[0] ?? CODE_RE.exec(html)?.[0] ?? null;
  if (!code) return null;
  const amounts = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{5,})(?:\.\d+)?/g)]
    .map((m) => num(m[1]))
    .filter((n): n is number => n != null && n >= 100_000);
  const price = amounts.length ? Math.max(...amounts) : null;
  const area = num(text.match(/([\d.]+)\s*(?:م²|م2|متر)/)?.[1]);
  return {
    sourceId: html.match(/property\/(\d+)/)?.[1] ?? null,
    unitCode: code,
    unitModel: code,
    unitType: typeOf(code, text),
    status: 'available',
    price,
    area,
  };
}

export interface PublicListing { units: SourceUnit[]; comingSoon: boolean }

/** A pause between public page fetches: ~60 quick requests in a row made the
 *  site answer «لا توجد نتائج» for EVERY project (2026-10-04) — a soft block
 *  that looks exactly like a sold-out project. */
const PUBLIC_PAGE_GAP_MS = 1500;

export async function fetchPublic(id: string): Promise<PublicListing> {
  const seen = new Map<string, SourceUnit>();
  let comingSoon = false;
  for (let page = 1; page <= 60; page++) {
    const res = await fetch(`${PUBLIC}/${id}?page=${page}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (WasselCRM project updates)', 'Accept-Language': 'ar' },
    });
    if (!res.ok) throw new Error(`safainv.sa units ${id} page ${page} → HTTP ${res.status}`);
    const html = await res.text();
    if (page === 1 && /قريباً|قريبا/.test(html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '')) comingSoon = true;
    const cards = html.split('unit-card-item').slice(1).map((c) => c.split('col-lg-4')[0] ?? c);
    let added = 0;
    for (const c of cards) {
      const u = parsePublicCard(c, comingSoon);
      if (u && !seen.has(u.unitModel!)) { seen.set(u.unitModel!, u); added++; }
    }
    if (added === 0) break;
    await new Promise((r) => setTimeout(r, PUBLIC_PAGE_GAP_MS));
  }
  return { units: [...seen.values()], comingSoon };
}

export interface BrokerSnapshot {
  savedAt: string;
  fresh: boolean;
  /** broker project id → units */
  byProject: Map<string, SourceUnit[]>;
}

/** Read the broker cards the status check saved. Null when there is no file. */
export async function loadBrokerSnapshot(supabase: SupabaseClient, now = Date.now()): Promise<BrokerSnapshot | null> {
  const { data, error } = await supabase.storage.from('portal-registrations').download(BROKER_FILE);
  if (error || !data) {
    if (error && !/not found|Object not found|404/i.test(error.message)) {
      throw new Error(`safa broker snapshot: ${error.message}`);
    }
    return null;
  }
  const j = JSON.parse(await data.text()) as { saved_at: string; pages: Record<string, string[][]> };
  const byProject = new Map<string, SourceUnit[]>();
  for (const [url, pages] of Object.entries(j.pages ?? {})) {
    const pid = url.match(/properties\/(\d+)/)?.[1];
    if (!pid) continue;
    const seen = new Map<string, SourceUnit>();
    for (const items of pages) {
      for (const h of items) {
        const u = parseBrokerCard(h);
        if (u && !seen.has(u.unitModel!)) seen.set(u.unitModel!, u);
      }
    }
    byProject.set(pid, [...seen.values()]);
  }
  // A snapshot whose cards could not be read at all (portal markup changed,
  // empty pages) is NOT a list — treating it as one would make every unit
  // missing from the public site look sold.
  const parsed = [...byProject.values()].reduce((n, u) => n + u.length, 0);
  return { savedAt: j.saved_at, fresh: parsed > 0 && now - Date.parse(j.saved_at) <= BROKER_MAX_AGE_MS, byProject };
}

/** Union of the two lists; the broker price wins when both have the unit. */
export function unionSafa(broker: SourceUnit[] | null, pub: SourceUnit[]): SourceUnit[] {
  const out = new Map<string, SourceUnit>();
  for (const u of pub) out.set(u.unitModel!, u);
  for (const b of broker ?? []) {
    const p = out.get(b.unitModel!);
    out.set(b.unitModel!, p
      ? { ...p, price: b.price ?? null, area: p.area ?? b.area, status: p.status ?? b.status }
      : b);
  }
  return [...out.values()];
}

/**
 * `publicHealthy` = the public site returned units for at least one Safa
 * project in this run. When it returned none anywhere, it is treated as DOWN
 * (soft block / outage), never as "everything sold".
 */
export async function fetchSafaProject(
  id: string,
  broker: BrokerSnapshot | null,
  pub: PublicListing,
  publicHealthy: boolean,
): Promise<SourceProject> {
  const fromBroker = broker?.fresh ? broker.byProject.get(id) ?? [] : null;
  const units = unionSafa(fromBroker, pub.units).map((u) =>
    pub.comingSoon && u.status === 'available' ? { ...u, status: 'under_construction' as UnitStatus } : u);
  return {
    sourceId: id,
    name: '',
    url: `https://broker.safainv.sa/project/details/${id}`,
    units,
    declaredTotal: null,
    meta: {
      public_units: pub.units.length,
      broker_units: fromBroker?.length ?? null,
      broker_saved_at: broker?.savedAt ?? null,
      broker_fresh: broker?.fresh ?? false,
      public_healthy: publicHealthy,
      // "Absent from both lists → sold" needs BOTH lists to be real.
      absent_means_sold: (broker?.fresh ?? false) && publicHealthy,
      coming_soon: pub.comingSoon,
    },
  };
}

export function safaProjectId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return url.match(/(?:details|properties|units)\/(\d+)/)?.[1] ?? null;
}

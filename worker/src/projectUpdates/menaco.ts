/**
 * Menaco (مينا للتطوير) — the public listing pages on menaco.sa, no login.
 *
 * A listing (/listings/<id>) is a Laravel + Livewire v3 page. Its unit cards
 * load six at a time through the «sub-listing» component: GET the page (cookie
 * + CSRF token), take the wire:snapshot whose memo.name is
 * 'homez.sub-listing-component', then POST /livewire/update calling loadMore,
 * feeding back each returned snapshot until hasMorePages is false. The last
 * response's effects.html holds EVERY card (verified 2026-10-05: 51 cards for
 * مينا 51, 16 for مينا 52 — every CRM unit present, sold ones included).
 *
 * Card facts (verified on the live pages 2026-10-05):
 *   - text «<model> <price> الرياض - حي … <beds> غرفة نوم <baths> حمام <gross> متر مربع»,
 *     sometimes with a «متاح للزيارة» tag in front — that tag is a VISIT
 *     marker, never a status (it sits on reserved units too).
 *   - status = the <span class="for-what"> badge only: مباع / محجوز / للبيع.
 *   - a reserved card may hide its price.
 *   - the card area is GROSS (terrace included) — never stored as unit_area.
 * The unit's own page (/listings/sub/<id>) states the NET area, the floor and
 * the type in its meta description («شقة … تقع في السطح … بمساحة إجمالية تبلغ
 * 125.94 م²» — equal to the CRM unit_area) and its floor plan as og:image.
 * Those pages are ~7 MB, so they are read only for units the CRM lacks.
 */

import { BROWSER_UA } from './http.js';
import { mapFloor, mapUnitType, normUnitKey, num } from './reconcile.js';
import type { CrmUnit, SourceProject, SourceUnit, UnitStatus } from './types.js';

const ORIGIN = 'https://menaco.sa';
const TIMEOUT_MS = 60_000;
const MAX_PAGES = 60; // 6 cards a page → 360 units; a bigger listing is a parse problem

export function menacoListingId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return url.match(/menaco\.sa\/listings\/(\d+)/)?.[1] ?? null;
}

export function menacoStatus(badge: string | null): UnitStatus {
  if (badge && /مباع/.test(badge)) return 'sold';
  if (badge && /محجوز/.test(badge)) return 'reserved';
  return 'available';
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function cardText(card: string): string {
  return card
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Every unit card in the final sub-listing HTML. */
export function parseMenacoCards(html: string): SourceUnit[] {
  const keys = [...html.matchAll(/wire:key="sub-listing-(\d+)-(\d+)"/g)];
  const out: SourceUnit[] = [];
  for (let n = 0; n < keys.length; n++) {
    let card = html.slice(keys[n]!.index!, n + 1 < keys.length ? keys[n + 1]!.index : html.length);
    const cut = card.indexOf('{ if (showInterestedModal)');
    if (cut > 0) card = card.slice(0, cut);
    const text = cardText(card).replace(/^wire:key="[^"]*">/, '');
    // The head before the city is «[متاح للزيارة] <model> <price>» in some order.
    const head = (text.split('الرياض')[0] ?? '').replace(/متاح للزيارة/g, ' ').trim().split(' ').filter(Boolean);
    const priceTok = head.find((t) => /^\d{1,3}(,\d{3})+$/.test(t));
    const model = head.filter((t) => t !== priceTok).pop() ?? null;
    const sub = card.match(/listings\/sub\/(\d+)/)?.[1] ?? null;
    if (!model) continue;
    const badge = card.match(/class="for-what[^"]*"[^>]*>([^<]*)</)?.[1]?.trim() ?? null;
    const price = priceTok ? num(priceTok) : null;
    out.push({
      sourceId: sub,
      unitModel: model,
      status: menacoStatus(badge),
      price: price != null && price > 0 ? price : null,
      bedrooms: num(text.match(/(\d+) غرف/)?.[1]),
      bathrooms: num(text.match(/(\d+) حمام/)?.[1]),
      // area deliberately NOT set: the card's figure is gross (see header).
      description: `مساحة البطاقة الإجمالية مع التراس: ${text.match(/([\d.,]+) متر مربع/)?.[1] ?? '؟'} م²`,
    });
  }
  return out;
}

/** The unit page's meta description: net area, floor, type; og:image = plan. */
export function parseMenacoSub(html: string): { area: number | null; floor: string | null; unitType: string | null; planUrl: string | null } {
  const desc = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '').replace(/&nbsp;| /g, ' ');
  const area = num(desc.match(/بمساحة إجمالية تبلغ\s*([\d.,]+)\s*م/)?.[1]);
  const floorRaw = desc.match(/تقع في\s+(?:ال)?(?:دور\s+)?(\S+(?:\s*\([^)]*\))?)/)?.[1] ?? null;
  return {
    area: area != null && area > 0 ? area : null,
    floor: mapFloor(floorRaw),
    unitType: mapUnitType(desc.split(/\s/).slice(0, 4).join(' ')),
    planUrl: html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null,
  };
}

// ── HTTP: a minimal cookie jar (Livewire needs the session cookie) ─────────

class Jar {
  private c = new Map<string, string>();
  take(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const kv = raw.split(';')[0] ?? '';
      const i = kv.indexOf('=');
      if (i > 0) this.c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header(): string { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function getText(url: string, jar?: Jar): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ar,en;q=0.8', ...(jar ? { Cookie: jar.header() } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  jar?.take(res);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return text;
}

interface LivewireSnapshot { data?: { hasMorePages?: boolean }; memo?: { name?: string } }

export async function fetchMenacoProject(listingId: string): Promise<SourceProject> {
  const url = `${ORIGIN}/listings/${listingId}`;
  const jar = new Jar();
  const page = await getText(url, jar);
  const csrf = page.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error(`menaco ${listingId}: no CSRF token on the listing page`);
  let snapshot: LivewireSnapshot | null = null;
  for (const m of page.matchAll(/wire:snapshot="([^"]+)"/g)) {
    const s = JSON.parse(decode(m[1]!)) as LivewireSnapshot;
    if (s.memo?.name === 'homez.sub-listing-component') { snapshot = s; break; }
  }
  if (!snapshot) throw new Error(`menaco ${listingId}: the unit list component is missing — the page layout changed`);

  let html = '';
  for (let i = 0; snapshot.data?.hasMorePages; i++) {
    if (i >= MAX_PAGES) throw new Error(`menaco ${listingId}: still «more pages» after ${MAX_PAGES} — refusing to guess`);
    const res = await fetch(`${ORIGIN}/livewire/update`, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', Accept: 'application/json',
        'X-CSRF-TOKEN': csrf, 'X-Livewire': 'true', 'X-Requested-With': 'XMLHttpRequest',
        Cookie: jar.header(), Referer: url,
      },
      body: JSON.stringify({ _token: csrf, components: [{ snapshot: JSON.stringify(snapshot), updates: {}, calls: [{ path: '', method: 'loadMore', params: [] }] }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    jar.take(res);
    if (!res.ok) throw new Error(`menaco ${listingId}: loadMore answered ${res.status}`);
    const body = (await res.json()) as { components?: Array<{ snapshot: string; effects?: { html?: string } }> };
    const comp = body.components?.[0];
    if (!comp) throw new Error(`menaco ${listingId}: loadMore returned no component`);
    snapshot = JSON.parse(comp.snapshot) as LivewireSnapshot;
    if (comp.effects?.html) html = comp.effects.html;
  }
  // A listing short enough to need no loadMore keeps its cards in the page.
  const units = parseMenacoCards(html || page);
  return { sourceId: listingId, name: '', url, units, declaredTotal: null };
}

/** For units the CRM does not have yet, read their own page for the NET
 *  area, floor, type and floor plan (the card has only the gross area). */
export async function enrichNewMenacoUnits(src: SourceProject, crm: CrmUnit[]): Promise<void> {
  const have = new Set(crm.map((u) => normUnitKey(u.data.unit_model)));
  for (const u of src.units) {
    if (!u.sourceId || have.has(normUnitKey(u.unitModel)) || u.status === 'sold') continue;
    const d = parseMenacoSub(await getText(`${ORIGIN}/listings/sub/${u.sourceId}`));
    u.area = d.area;
    u.floor = d.floor;
    u.unitType = d.unitType;
    u.planUrl = d.planUrl;
  }
}

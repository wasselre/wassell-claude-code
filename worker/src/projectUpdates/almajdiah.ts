/**
 * Almajdiah (الماجدية) adapter — the developer's own public units API.
 *
 * `https://etmaam.almajdiah.com/api/client/v1/projects/<id>?page=N` (no auth,
 * 30 units a page, `units.meta.last_page`). Unlike a broker portal it lists
 * EVERY unit with its real status (available / booked / sold), so it is a
 * complete source: a CRM unit it does not list is reported, and the status it
 * states wins.
 *
 * Identity: the API's own unit `id`, stored on our unit as
 * `developer_unit_code = MAJD-<id>`. The CRM rows were written by different
 * migrations in different shapes («A 1», «Block 3 - 307», «VILLA 101», model
 * codes), so the first run matches on building + number / the composed title
 * and records the id; later runs match on the id.
 */

import { num } from './reconcile.js';
import type { SourceProject, SourceUnit, UnitStatus } from './types.js';

const API = 'https://etmaam.almajdiah.com/api/client/v1/projects';

interface MajdUnit {
  id: number;
  full_name?: string | null;
  building_name?: string | null;
  unit_number?: string | number | null;
  status?: string | null;
  floor?: string | null;
  floor_text?: string | null;
  room_count?: string | number | null;
  bathroom_count?: string | number | null;
  area?: string | number | null;
  total_area?: string | number | null;
  price_before_tax?: number | string | null;
  website_price_text?: number | string | null;
  unit_description?: string | null;
  chart_file_urls?: string[] | null;
  scheme_images?: string[] | null;
}

export function majdStatus(s: unknown): UnitStatus | null {
  switch (String(s ?? '').toLowerCase()) {
    case 'available': return 'available';
    case 'booked':
    case 'reserved':
    case 'pre_booking':
    case 'booked_paid': return 'reserved';
    case 'sold': return 'sold';
    default: return null;
  }
}

/** «ground» / «first» → our floor words; numbers pass through. */
function floorOf(u: MajdUnit): string | null {
  const f = String(u.floor ?? '').toLowerCase();
  const words: Record<string, string> = { ground: 'ارضي', first: 'اول', second: 'ثاني', third: 'ثالث', roof: 'الروف', annex: 'الروف' };
  if (words[f]) return words[f]!;
  return u.floor_text ?? (u.floor ? String(u.floor) : null);
}

export function majdUnit(u: MajdUnit): SourceUnit {
  const building = u.building_name ? String(u.building_name).trim() : null;
  const number = u.unit_number != null ? String(u.unit_number).trim() : null;
  // Price before tax is what the CRM has always stored (the migration's rule).
  const price = num(u.price_before_tax) ?? num(u.website_price_text);
  const plan = (u.chart_file_urls ?? []).find((x) => typeof x === 'string' && x) ?? null;
  // Some projects number units with a full code («TY01-H-0-1», «02-01-0144-19-454»)
  // that is already stored on our unit as unit_model / developer_unit_code — it
  // is the identity then. Otherwise the API id is.
  const codeLike = !!number && /[A-Za-z]|-/.test(number) && number.length >= 6;
  return {
    sourceId: String(u.id),
    unitCode: codeLike ? number : `MAJD-${u.id}`,
    // «A 1» — the shape most Almajdiah projects were migrated with.
    unitModel: codeLike ? number : building && number ? `${building} ${number}` : number,
    buildingNumber: building,
    // جزيل stores «Block 1» as the BLOCK; offering both lets either key match.
    block: building,
    unitNumber: num(number),
    status: majdStatus(u.status),
    price: price != null && price > 0 ? price : null,
    area: num(u.area),
    bedrooms: num(u.room_count),
    bathrooms: num(u.bathroom_count),
    floor: floorOf(u),
    description: u.unit_description ?? null,
    planUrl: plan,
  };
}

/** Project id from a URL like «…/api/client/v1/projects/229» or «…/projects/229». */
export function majdProjectId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return url.match(/projects\/(\d+)/)?.[1] ?? null;
}

export async function fetchMajdProject(id: string, onPage?: () => Promise<void>): Promise<SourceProject> {
  const units: SourceUnit[] = [];
  let last = 1;
  let total: number | null = null;
  let name = '';
  for (let page = 1; page <= last && page <= 200; page++) {
    const res = await fetch(`${API}/${id}?page=${page}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (WasselCRM project updates)' },
    });
    if (!res.ok) throw new Error(`almajdiah project ${id} page ${page} → HTTP ${res.status}`);
    const j = (await res.json()) as {
      project?: { display_name?: string; name?: string };
      units?: { data?: MajdUnit[]; meta?: { last_page?: number; total?: number } };
    };
    if (!name) name = j.project?.display_name ?? j.project?.name ?? '';
    last = j.units?.meta?.last_page ?? 1;
    total = j.units?.meta?.total ?? total;
    for (const u of j.units?.data ?? []) units.push(majdUnit(u));
    if (onPage) await onPage();
  }
  return { sourceId: id, name, url: `${API}/${id}`, units, declaredTotal: total };
}

/**
 * Riva broker portal adapter (riva.sa/broker) — login + scrape → SourceProject.
 *
 * What the manual runs learned (migrate-project SKILL.md, 2026-09-07):
 *  - plain `?page=N` paginates both /broker/projects and /broker/projects/<id>;
 *  - every unit card's «التفاصيل» button carries the WHOLE unit as
 *    `selectedUnit = JSON.parse('…')`; `case` 0/1/2 = available/reserved/sold
 *    is the ONLY status source (the badge on the card is the «مخطط» tag);
 *  - `unit_price` is a "1,439,000" string; `gallery[].is_plan` marks the plan;
 *  - pagination is UNSTABLE: a unit can show on 2–3 pages while another drops,
 *    so pages are walked in rounds and unioned by unit id until the union
 *    reaches the declared total or stops growing.
 */

import { HttpSession } from './http.js';
import { num, toAsciiDigits } from './reconcile.js';
import type { SourceProject, SourceUnit, UnitStatus } from './types.js';

const ORIGIN = 'https://riva.sa';

function htmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Decode the body of a JS single-quoted string literal. */
function jsUnescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === 'n') return '\n';
    if (e === 'r') return '\r';
    if (e === 't') return '\t';
    return e; // \' \" \\ \/
  });
}

/** Every `JSON.parse('…')` payload in the page that looks like a unit. */
export function extractUnitJsons(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /selectedUnit\s*=\s*JSON\.parse\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = jsUnescape(htmlUnescape(m[1]!));
    try {
      const j = JSON.parse(raw) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j as Record<string, unknown>);
    } catch {
      // A payload we can't parse is skipped and COUNTED by the caller
      // (parseErrors) — the run summary shows it, so a portal markup change
      // is loud rather than silently shrinking the unit list.
      out.push({ __parse_error: raw.slice(0, 200) });
    }
  }
  return out;
}

export function rivaStatus(c: unknown): UnitStatus | null {
  const n = num(c);
  if (n === 0) return 'available';
  if (n === 1) return 'reserved';
  if (n === 2) return 'sold';
  return null;
}

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return text(o.name_ar ?? o.name ?? o.title ?? o.label ?? null);
  }
  return null;
}

export function rivaUnit(j: Record<string, unknown>): SourceUnit {
  const gallery = Array.isArray(j.gallery) ? (j.gallery as Array<Record<string, unknown>>) : [];
  const plan = gallery.find((g) => g && (g.is_plan === true || g.is_plan === 1 || g.is_plan === '1'));
  const price = num(j.raw_price) ?? num(j.unit_price);
  return {
    sourceId: j.id != null ? String(j.id) : null,
    unitModel: text(j.title),
    buildingNumber: text(j.building_number),
    unitNumber: num(j.unit_number),
    unitType: text(j.unit_type),
    status: rivaStatus(j.case),
    price: price != null && price > 0 ? price : null,
    area: num(j.unit_area),
    bedrooms: num(j.beadrooms ?? j.bedrooms),
    bathrooms: num(j.bathrooms),
    floor: text(j.floor),
    description: text(j.description),
    planUrl: plan && typeof plan.url === 'string' ? plan.url : null,
  };
}

/** «Showing 1 to 12 of 69» / «عرض 1 إلى 12 من 69». */
export function declaredTotal(html: string): number | null {
  const t = toAsciiDigits(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  const m = t.match(/\bof\s+(\d+)\s*(?:results|نتائج)?/i) ?? t.match(/من\s+(\d+)\s+(?:نتائج|نتيجة)/);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Project cards on /broker/projects → {id, name}. The name is the first
 *  non-empty text inside the card's link, falling back to the image alt. */
export function extractProjectList(html: string): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  const re = /<a\b[^>]*href="(?:https?:\/\/riva\.sa)?\/broker\/projects\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const id = m[1]!;
    const inner = m[2]!;
    const alt = inner.match(/alt="([^"]+)"/)?.[1];
    const txt = htmlUnescape(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const name = (txt && !/^(التفاصيل|عرض|details)$/i.test(txt) ? txt : '') || (alt ? htmlUnescape(alt) : '');
    if (!seen.has(id) || (!seen.get(id) && name)) seen.set(id, name);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** The project's display name on its own page (first heading). */
export function extractProjectName(html: string): string | null {
  const h = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) ?? html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/);
  if (!h) return null;
  const t = htmlUnescape(h[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** Visible text of a page: scripts, styles, nav and footer removed. */
export function visibleText(html: string): string {
  return htmlUnescape(
    html
      .replace(/<(script|style|svg|nav|footer|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/**
 * The facts a broker shares with a client, as the portal itself composes them
 * (`projectShareMessage`): «📍 الرياض - الرمال», «المطوّر: أكنان», «نوع المشروع:
 * شقق», the public page URL. Plus the ad licence and the description paragraph.
 * This is what a NEW project is created from.
 */
export function rivaProjectMeta(html: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const m = html.match(/projectShareMessage:\s*'((?:[^'\\]|\\.)*)'/);
  if (m) {
    const msg = jsUnescape(htmlUnescape(m[1]!));
    const place = msg.match(/📍\s*([^\n]+)/)?.[1]?.trim();
    if (place) {
      const [city, district] = place.split(/\s+-\s+/);
      if (city) meta.city = city.trim();
      if (district) meta.district = district.trim();
    }
    const dev = msg.match(/المطو[ّ]?ر:\s*([^\n]+)/)?.[1]?.trim();
    if (dev) meta.developer = dev;
    const type = msg.match(/نوع المشروع:\s*([^\n]+)/)?.[1]?.trim();
    if (type) meta.project_type_text = type;
    const url = msg.match(/https?:\/\/riva\.sa\/project\/[^\s'"]+/)?.[0];
    if (url) meta.public_url = url;
    const from = msg.match(/تبدأ من\s*([\d,٬]+)/)?.[1];
    if (from) meta.price_from = num(from);
  }
  const text = visibleText(html);
  const lic = toAsciiDigits(text).match(/رخصة إعلان:\s*(\d{6,})/)?.[1];
  if (lic) meta.ad_license = lic;
  // No `\b` here: it is an ASCII word boundary and never fires next to Arabic.
  const after = text.match(/من قيمة كل وحدة مباعة\s+(.{40,})/)?.[1];
  if (after) {
    const cut = after.search(/\s(?:الوحدات المتاحة|عرض \d+ إلى|Showing \d)/);
    meta.description = (cut > 40 ? after.slice(0, cut) : after).slice(0, 1500).trim();
  }
  return meta;
}

export interface RivaCredentials {
  email: string;
  password: string;
}

export class RivaPortal {
  private s = new HttpSession(ORIGIN);
  private loggedIn = false;
  /** Every page fetch, for the run summary. */
  pagesFetched = 0;
  parseErrors = 0;
  /** Visible text of the first page of the last scraped project (a NEW
   *  project's details are read from it). */
  lastPageExcerpt = '';

  constructor(private readonly creds: RivaCredentials, private readonly onProgress?: () => Promise<void>) {}

  async login(): Promise<void> {
    const page = await this.s.request('/broker/login');
    const token =
      page.text.match(/name="_token"\s+value="([^"]+)"/)?.[1] ??
      page.text.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
    if (!token) throw new Error(`riva login page has no CSRF token (HTTP ${page.status})`);
    const res = await this.s.request('/broker/login', {
      method: 'POST',
      form: { _token: token, email: this.creds.email, password: this.creds.password, remember: 'on' },
      referer: `${ORIGIN}/broker/login`,
    });
    if (/\/broker\/login\b/.test(res.url)) {
      const msg = res.text.match(/class="[^"]*(?:text-red|error|invalid)[^"]*"[^>]*>([^<]{3,200})</)?.[1]?.trim();
      throw new Error(`riva login refused${msg ? `: ${msg}` : ''} (landed on ${res.url})`);
    }
    this.loggedIn = true;
  }

  private async get(path: string): Promise<string> {
    if (!this.loggedIn) await this.login();
    let res = await this.s.request(path, { referer: `${ORIGIN}/broker/projects` });
    if (/\/broker\/login\b/.test(res.url)) {
      // Session expired mid-run → log in once more and retry this page.
      this.loggedIn = false;
      await this.login();
      res = await this.s.request(path, { referer: `${ORIGIN}/broker/projects` });
      if (/\/broker\/login\b/.test(res.url)) throw new Error(`riva bounced ${path} to the login page twice`);
    }
    if (res.status >= 400) throw new Error(`riva ${path} → HTTP ${res.status}`);
    this.pagesFetched++;
    if (this.onProgress) await this.onProgress();
    return res.text;
  }

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    const all = new Map<string, string>();
    for (let page = 1; page <= 20; page++) {
      const html = await this.get(`/broker/projects?page=${page}`);
      const list = extractProjectList(html);
      let added = 0;
      for (const p of list) {
        if (!all.has(p.id)) { all.set(p.id, p.name); added++; }
        else if (!all.get(p.id) && p.name) all.set(p.id, p.name);
      }
      if (added === 0) break;
    }
    return [...all].map(([id, name]) => ({ id, name }));
  }

  /** All units of one portal project, unioned over up to `rounds` passes. */
  async scrapeProject(id: string, rounds = 3): Promise<SourceProject> {
    const units = new Map<string, SourceUnit>();
    let total: number | null = null;
    let name: string | null = null;
    let meta: Record<string, unknown> = {};
    for (let round = 0; round < rounds; round++) {
      const before = units.size;
      const maxPage = total != null ? Math.ceil(total / 12) + 1 : 40;
      for (let page = 1; page <= maxPage; page++) {
        const html = await this.get(`/broker/projects/${id}?page=${page}`);
        if (total == null) total = declaredTotal(html);
        if (name == null) {
          name = extractProjectName(html);
          this.lastPageExcerpt = visibleText(html).slice(0, 2500);
          meta = rivaProjectMeta(html);
        }
        const jsons = extractUnitJsons(html);
        if (jsons.length === 0) break;
        for (const j of jsons) {
          if ('__parse_error' in j) { this.parseErrors++; continue; }
          const u = rivaUnit(j);
          const k = u.sourceId ?? u.unitModel ?? '';
          if (k && !units.has(k)) units.set(k, u);
        }
      }
      if (total != null && units.size >= total) break;
      if (units.size === before) break;
    }
    return {
      sourceId: id,
      name: name ?? '',
      url: `${ORIGIN}/broker/projects/${id}`,
      units: [...units.values()],
      declaredTotal: total,
      meta,
    };
  }
}

/** Portal project id from a unit_updates.source_url («…/broker/projects/71»). */
export function rivaProjectIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return url.match(/\/broker\/projects\/(\d+)/)?.[1] ?? null;
}

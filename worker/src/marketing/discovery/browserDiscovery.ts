// ============================================================================
// Automated browser-based discovery primitives, run inside ONE Browserbase
// session (playwright-core over CDP — same pattern as runRegaLookupJob). These
// replace the manual "Claude drives Chrome" method: deterministic extraction,
// stored evidence, retries at the engine level. No human steering.
//
//   createDiscoverySession  — Browserbase session → CDP connectUrl
//   crawlSite               — deep-ish crawl of the org's own site (home + about
//                             + contact) → social links, JSON-LD sameAs, OG, bio
//   googleSearch            — real google.com results → platform account URLs +
//                             titles + snippets (the automated search discovery)
//   inspectProfile          — visit a candidate profile → display name, bio
//                             links, stable account id (page/channel id)
// ============================================================================
import { chromium, type Page } from 'playwright-core';

export interface EvidenceItem {
  source: string; kind: string; platform: string | null; handle: string | null;
  url: string | null; title: string | null; snippet: string | null; extracted: Record<string, unknown>;
}
export interface ProfileInfo { pageName: string | null; bioLinks: string[]; bioText: string | null; accountId: string | null }

const PLATFORM_HOSTS: Record<string, string> = {
  instagram: 'instagram.com', tiktok: 'tiktok.com', youtube: 'youtube.com',
  facebook: 'facebook.com', x: 'x.com', linkedin: 'linkedin.com', snapchat: 'snapchat.com',
};

/** Registrable-ish domain from a URL. */
export function hostOf(u: string): string | null {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Platform + normalized handle from a social URL, or null if not a profile URL. */
export function platformHandle(url: string): { platform: string; handle: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean);
  if (/(^|\.)instagram\.com$/.test(host)) {
    if (!seg[0] || ['p', 'reel', 'reels', 'explore', 'stories', 'accounts'].includes(seg[0])) return null;
    return { platform: 'instagram', handle: seg[0].toLowerCase() };
  }
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const h = seg.find((s) => s.startsWith('@'));
    if (!h) return null; return { platform: 'tiktok', handle: h.slice(1).toLowerCase() };
  }
  if (/(^|\.)youtube\.com$/.test(host)) {
    if (seg[0]?.startsWith('@')) return { platform: 'youtube', handle: seg[0].slice(1) };
    if (seg[0] === 'channel' && seg[1]) return { platform: 'youtube', handle: seg[1] };
    if (seg[0] === 'c' && seg[1]) return { platform: 'youtube', handle: seg[1] };
    if (seg[0] === 'user' && seg[1]) return { platform: 'youtube', handle: seg[1] };
    return null;
  }
  if (/(^|\.)facebook\.com$/.test(host)) {
    const fbReserved = ['sharer', 'plugins', 'tr', 'dialog', 'login', 'login.php', 'recover', 'recover.php', 'help', 'watch', 'story.php', 'events', 'groups', 'marketplace', 'gaming', 'reel', 'photo.php', 'permalink.php'];
    if (!seg[0] || fbReserved.includes(seg[0].toLowerCase())) return null;
    if (seg[0] === 'profile.php') { const id = u.searchParams.get('id'); return id ? { platform: 'facebook', handle: id } : null; }
    return { platform: 'facebook', handle: seg[0].toLowerCase() };
  }
  if (/(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host)) {
    if (!seg[0] || ['i', 'intent', 'share', 'home'].includes(seg[0])) return null;
    return { platform: 'x', handle: seg[0].toLowerCase() };
  }
  if (/(^|\.)linkedin\.com$/.test(host) && seg[0] === 'company' && seg[1]) return { platform: 'linkedin', handle: seg[1].toLowerCase() };
  if (/(^|\.)snapchat\.com$/.test(host) && (seg[0] === 'add' || seg[0] === 't') && seg[1]) return { platform: 'snapchat', handle: seg[1].toLowerCase() };
  return null;
}

export async function createDiscoverySession(apiKey: string, projectId: string): Promise<string> {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, proxies: [{ type: 'browserbase', geolocation: { country: 'SA', city: 'RIYADH' } }] }),
  });
  const s = (await res.json()) as { connectUrl?: string; message?: string };
  if (!s.connectUrl) throw new Error(`Browserbase session create failed: ${s.message ?? JSON.stringify(s).slice(0, 160)}`);
  return s.connectUrl;
}

/** Extract social links, JSON-LD sameAs, OG url + all outbound links from the current page. */
async function extractPageLinks(page: Page): Promise<{ links: string[]; sameAs: string[]; ogUrl: string | null; internal: string[]; host: string }> {
  return (await page.evaluate(() => {
    const doc = (globalThis as unknown as {
      document: {
        querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null; href?: string }>;
        querySelector(s: string): { getAttribute(n: string): string | null } | null;
        location: { host: string };
      };
    }).document;
    const abs = (h: string | null): string | null => { if (!h) return null; try { return new URL(h, 'https://' + doc.location.host).href; } catch { return null; } };
    const links: string[] = [];
    const internal: string[] = [];
    const host = doc.location.host.replace(/^www\./, '');
    const anchors = doc.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i++) {
      const h = abs(anchors[i]!.getAttribute('href'));
      if (!h) continue;
      if (/instagram\.com|tiktok\.com|youtube\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|snapchat\.com|linktr\.ee|linktree|lnk\.bio|beacons\.ai/i.test(h)) links.push(h);
      else if (h.includes(host)) internal.push(h);
    }
    // JSON-LD sameAs
    const sameAs: string[] = [];
    const ld = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < ld.length; i++) {
      try {
        const txt = (ld[i] as unknown as { textContent: string }).textContent || '';
        const j = JSON.parse(txt);
        const arr = Array.isArray(j) ? j : [j];
        for (const o of arr) { if (o && o.sameAs) for (const s of ([] as string[]).concat(o.sameAs)) sameAs.push(s); }
      } catch { /* malformed JSON-LD — skip */ }
    }
    const og = doc.querySelector('meta[property="og:url"]');
    return { links: [...new Set(links)], sameAs: [...new Set(sameAs)], ogUrl: og ? og.getAttribute('content') : null, internal: [...new Set(internal)], host };
  })) as { links: string[]; sameAs: string[]; ogUrl: string | null; internal: string[]; host: string };
}

/** Crawl the org site: home + up to 2 internal pages that look like about/contact. */
export async function crawlSite(page: Page, website: string): Promise<EvidenceItem[]> {
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  const pushLink = (url: string, source: string, kind: string) => {
    const ph = platformHandle(url);
    const key = ph ? `${ph.platform}:${ph.handle}` : url;
    if (seen.has(key)) return; seen.add(key);
    out.push({ source, kind, platform: ph?.platform ?? (hostOf(url) ? 'domain' : null), handle: ph?.handle ?? null, url, title: null, snippet: null, extracted: {} });
  };
  const visit = async (u: string, source: string): Promise<{ internal: string[]; host: string } | null> => {
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(1800); // let SPA hydrate
      const r = await extractPageLinks(page);
      for (const l of r.links) pushLink(l, source, /linktr|lnk\.bio|beacons/i.test(l) ? 'link_in_bio' : 'social_link');
      for (const s of r.sameAs) pushLink(s, source, 'jsonld_sameas');
      if (r.ogUrl) out.push({ source, kind: 'og_url', platform: 'domain', handle: null, url: r.ogUrl, title: null, snippet: null, extracted: {} });
      return { internal: r.internal, host: r.host };
    } catch { return null; }
  };
  const home = await visit(website, 'site_crawl');
  // follow up to 2 about/contact-ish internal pages
  const candidates = (home?.internal ?? []).filter((h) => /about|contact|من-نحن|تواصل|اتصل|company|نبذة/i.test(h)).slice(0, 2);
  for (const c of candidates) await visit(c, 'site_crawl');
  return out;
}

/** Extract platform-account result links from whatever search-results page is
 *  currently loaded. Engine-agnostic: scans every anchor, unwraps Bing/DDG
 *  redirect wrappers, and keeps only real profile URLs on the wanted hosts. */
async function extractSearchResults(page: Page, hosts: string[]): Promise<Array<{ url: string; title: string; snippet: string }>> {
  return (await page.evaluate((hostList: string[]) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null; closest(s: string): { innerText?: string } | null; textContent?: string }> } }).document;
    const g = globalThis as unknown as { atob(s: string): string; decodeURIComponent(s: string): string };
    // Unwrap a search engine's redirect wrapper to the real destination URL.
    const unwrap = (href: string): string => {
      try {
        // Bing: /ck/a?...&u=a1<base64url>  (the 'a1' prefix precedes the encoded URL)
        const m = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
        if (m && /bing\.com/.test(href)) {
          const b64 = m[1]!.replace(/-/g, '+').replace(/_/g, '/');
          return g.atob(b64 + '==='.slice((b64.length + 3) % 4));
        }
        // DuckDuckGo: /l/?uddg=<encoded>
        const d = href.match(/[?&]uddg=([^&]+)/);
        if (d) return g.decodeURIComponent(d[1]!);
      } catch { /* not a wrapper — fall through */ }
      return href;
    };
    const anchors = doc.querySelectorAll('a[href]');
    const res: Array<{ url: string; title: string; snippet: string }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      const raw = a.getAttribute('href') || '';
      const href = unwrap(raw);
      if (!hostList.some((h) => href.includes(h))) continue;
      if (/\/(p|reel|reels|explore|status|watch|hashtag|tags)\b/.test(href)) continue;
      const clean = href.split('#')[0]!.split('?')[0]!;
      if (seen.has(clean)) continue; seen.add(clean);
      const block = a.closest('li') || a.closest('div');
      const t = ((block?.innerText ?? a.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      res.push({ url: clean, title: t.slice(0, 70), snippet: t });
      if (res.length >= 20) break;
    }
    return res;
  }, hosts)) as Array<{ url: string; title: string; snippet: string }>;
}

/** Web search across multiple engines (Bing → DuckDuckGo → Google) until one
 *  yields platform-account results. Google is last because it most aggressively
 *  serves a consent interstitial to datacenter/proxy sessions (a Browserbase run
 *  gets 0 results behind it); Bing + DDG return parseable results without a wall.
 *  The engine that produced each hit is the evidence `source`. */
export async function webSearch(page: Page, query: string, wantPlatforms: string[]): Promise<EvidenceItem[]> {
  const hosts = wantPlatforms.map((p) => PLATFORM_HOSTS[p]).filter(Boolean);
  const engines: Array<{ source: string; url: string }> = [
    { source: 'bing', url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=30&setlang=en` },
    { source: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
    { source: 'google', url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en` },
  ];
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const eng of engines) {
    let rows: Array<{ url: string; title: string; snippet: string }> = [];
    try {
      await page.goto(eng.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(1400);
      rows = await extractSearchResults(page, hosts);
    } catch { continue; }
    for (const r of rows) {
      const ph = platformHandle(r.url);
      if (!ph) continue;
      const key = `${ph.platform}:${ph.handle}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ source: eng.source, kind: 'search_result', platform: ph.platform, handle: ph.handle, url: r.url, title: r.title, snippet: r.snippet, extracted: {} });
    }
    if (out.length > 0) break; // this engine answered — don't burn time on the rest
  }
  return out;
}

/** Visit a profile page → display name, bio links, stable id. Best-effort (walls tolerated). */
export async function inspectProfile(page: Page, platform: string, url: string): Promise<ProfileInfo> {
  const empty: ProfileInfo = { pageName: null, bioLinks: [], bioText: null, accountId: null };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(1600);
  } catch { return empty; }
  return (await page.evaluate((plat: string) => {
    const doc = (globalThis as unknown as {
      document: { title: string; querySelector(s: string): { getAttribute(n: string): string | null; textContent?: string } | null; querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null }>; body: { innerText: string } | null };
    }).document;
    const og = (p: string) => doc.querySelector(`meta[property="${p}"]`)?.getAttribute('content') ?? null;
    const pageName = og('og:title') || doc.title || null;
    const desc = og('og:description') || doc.querySelector('meta[name="description"]')?.getAttribute('content') || null;
    const bioLinks: string[] = [];
    const anchors = doc.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i++) {
      const h = anchors[i]!.getAttribute('href') || '';
      if (/^https?:\/\//.test(h) && !/instagram|tiktok|youtube|facebook|google|x\.com|twitter/i.test(h)) bioLinks.push(h.split('?')[0]!);
    }
    // stable id from html for youtube (channelId) / og:url
    let accountId: string | null = null;
    const ogUrl = og('og:url') || '';
    if (plat === 'youtube') {
      const html = (doc.body?.innerText || '') + ' ' + ogUrl;
      const m = html.match(/UC[0-9A-Za-z_-]{20,24}/) || ogUrl.match(/channel\/(UC[0-9A-Za-z_-]{20,24})/);
      accountId = m ? (m[0].startsWith('UC') ? m[0] : m[1] ?? null) : null;
    }
    return { pageName, bioText: desc, bioLinks: [...new Set(bioLinks)].slice(0, 8), accountId };
  }, platform)) as ProfileInfo;
}

export { chromium };

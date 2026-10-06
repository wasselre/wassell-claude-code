#!/usr/bin/env node
/**
 * investigate-uae-portals.mjs — one-shot field discovery for the UAE market-listings build.
 *
 * Drives a Browserbase session with a UAE residential IP (beats the Cloudflare / AWS-WAF
 * ASN block that 403s datacenter egress) and, for each of Property Finder / Bayut / Dubizzle,
 * captures the REAL data source and the REAL field set of a for-sale + residential listing:
 *
 *   - Bayut & Dubizzle  → harvest the Algolia app_id + search-only key + index from network
 *                         traffic, then dump one Algolia hit's full field structure.
 *   - Property Finder    → dump __NEXT_DATA__.props.pageProps listing object + any internal
 *                         search-API JSON seen on the wire.
 *
 * Output: writes ./uae-portal-fields.json (data sources, harvested keys, per-site sample
 * listing + the union of all field paths seen). That file is the ground truth we lock the
 * market_listings mapping against — no more guessing field names.
 *
 * Reuses the proven session pattern from worker/src/runRegaLookupJob.ts (only the geo flips
 * to AE). Requires: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID in env. playwright-core as a
 * CDP client (no browser download — Browserbase hosts the browser).
 *
 *   BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... node scripts/investigate-uae-portals.mjs
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const API_KEY = process.env.BROWSERBASE_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
if (!API_KEY || !PROJECT_ID) {
  console.error('Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in env.');
  process.exit(1);
}

// Search URLs already scoped to for-sale + residential (the exact corpus we want).
const SITES = [
  {
    key: 'bayut',
    kind: 'algolia',
    url: 'https://www.bayut.com/for-sale/residential/uae/',
    // one detail page too, to see the richest single-listing shape
    detailHint: 'a[href*="/property/details-"]',
  },
  {
    key: 'dubizzle',
    kind: 'algolia',
    url: 'https://uae.dubizzle.com/en/property-for-sale/residential/',
    detailHint: 'a[href*="/ad/"]',
  },
  {
    key: 'property_finder',
    kind: 'next_data',
    url: 'https://www.propertyfinder.ae/en/search?c=1&t=1&fu=0&ob=mr', // c=1 residential, t=1 sale
    detailHint: 'a[href*="/plp/"], a[href*="/en/buy/"]',
  },
];

/** Create a Browserbase session on a UAE residential IP. Mirrors runRegaLookupJob.ts. */
async function createSession() {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': API_KEY },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      proxies: [{ type: 'browserbase', geolocation: { country: 'AE', city: 'DUBAI' } }],
      browserSettings: { solveCaptchas: true },
    }),
  });
  const session = await res.json();
  if (!res.ok || !session.id) {
    throw new Error(`Browserbase session create failed: ${session.message ?? JSON.stringify(session).slice(0, 300)}`);
  }
  return session;
}

/** Recursively collect dotted field paths from a sample object (capped depth/breadth). */
function fieldPaths(obj, prefix = '', out = new Set(), depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    if (obj.length) fieldPaths(obj[0], `${prefix}[]`, out, depth + 1);
    return out;
  }
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    fieldPaths(obj[k], p, out, depth + 1);
  }
  return out;
}

async function investigate(page, site) {
  const report = { site: site.key, kind: site.kind, dataSources: new Set(), algolia: null, sampleListing: null, fieldPaths: [] };
  const jsonBodies = [];

  page.on('response', async (resp) => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    // Fingerprint the data source.
    if (/algolia\.net|algolianet\.com/.test(u)) {
      report.dataSources.add('algolia');
      // Harvest the app id + key from the request headers/url.
      const req = resp.request();
      const headers = req.headers();
      report.algolia = report.algolia || {
        endpoint: u.split('?')[0],
        appId: headers['x-algolia-application-id'] || (u.match(/https:\/\/([^.]+)\.algolia\.net/) || [])[1] || null,
        apiKey: headers['x-algolia-api-key'] || null,
      };
    }
    if (/propertyfinder\.ae\/.*(api|graphql|search)/i.test(u)) report.dataSources.add('pf-internal-api');
    if (!ct.includes('application/json')) return;
    try {
      const body = await resp.json();
      jsonBodies.push({ url: u.slice(0, 160), body });
    } catch { /* non-JSON or streamed body — skip, not our data source */ }
  });

  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(8_000); // let XHR/Algolia calls fire

  // Pull __NEXT_DATA__ if present (Property Finder, and Bayut is also Next.js).
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent || 'null'); } catch { return null; }
  });
  if (nextData) report.dataSources.add('__NEXT_DATA__');

  // Find the sample listing object.
  let sample = null;
  // 1) Algolia hits
  for (const { body } of jsonBodies) {
    const hits = body?.results?.[0]?.hits || body?.hits;
    if (Array.isArray(hits) && hits.length) { sample = hits[0]; break; }
  }
  // 2) PF __NEXT_DATA__ listing list (path varies by build — scan for an array of listing-shaped objs)
  if (!sample && nextData) {
    const scan = (o, d = 0) => {
      if (!o || typeof o !== 'object' || d > 8) return null;
      if (Array.isArray(o)) {
        const cand = o.find((x) => x && typeof x === 'object' && ('price' in x || 'bedrooms' in x || 'property_type' in x));
        if (cand) return cand;
        for (const x of o) { const r = scan(x, d + 1); if (r) return r; }
        return null;
      }
      for (const k of Object.keys(o)) { const r = scan(o[k], d + 1); if (r) return r; }
      return null;
    };
    sample = scan(nextData);
  }

  report.sampleListing = sample;
  report.fieldPaths = sample ? [...fieldPaths(sample)].sort() : [];
  report.dataSources = [...report.dataSources];
  report.jsonUrlsSeen = jsonBodies.map((j) => j.url).slice(0, 40);
  return report;
}

(async () => {
  const session = await createSession();
  console.error(`[bb] session ${session.id} — live view: ${session.connectUrl ? 'connecting…' : session.id}`);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const out = { generatedAt: new Date().toISOString(), sessionId: session.id, sites: [] };
  for (const site of SITES) {
    const page = await context.newPage();
    try {
      console.error(`[bb] investigating ${site.key} …`);
      out.sites.push(await investigate(page, site));
    } catch (e) {
      console.error(`[bb] ${site.key} failed: ${e.message}`);
      out.sites.push({ site: site.key, error: e.message });
    } finally {
      await page.close().catch(() => {});
    }
  }
  await browser.close().catch(() => {});
  writeFileSync('uae-portal-fields.json', JSON.stringify(out, null, 2));
  // Console summary
  for (const s of out.sites) {
    console.error(`\n=== ${s.site} ===`);
    if (s.error) { console.error(`  ERROR: ${s.error}`); continue; }
    console.error(`  data sources: ${s.dataSources?.join(', ') || 'none detected'}`);
    if (s.algolia) console.error(`  algolia appId=${s.algolia.appId} key=${s.algolia.apiKey ? s.algolia.apiKey.slice(0, 8) + '…' : 'n/a'}`);
    console.error(`  fields found: ${s.fieldPaths?.length || 0}`);
  }
  console.error('\nFull report → uae-portal-fields.json');
})().catch((e) => { console.error(e); process.exit(1); });

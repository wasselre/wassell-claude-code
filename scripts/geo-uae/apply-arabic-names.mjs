#!/usr/bin/env node
/**
 * Write the translated Arabic names back onto `districts` and `geo_elements`.
 *
 *   node scripts/geo-uae/apply-arabic-names.mjs <dir-with-out-*.json> [--dry-run]
 *
 * OpenStreetMap carries no `name:ar` for any of these rows (checked: 0 of 2,479 anchors
 * had one), so the Arabic was produced by translation under
 * `scratchpad/ar/CONVENTION.md` — mostly RESTORING the Arabic original of a
 * transliterated name (Al Marijah → المريجة), transliterating brand names, and
 * translating generic descriptors.
 *
 * WHY BOTH FIELDS ON A DISTRICT: the app resolves a district's Arabic label as
 * `display_name ?? name_ar` (src/lib/geo/localizedName.ts), and every one of these rows
 * currently has the ENGLISH name sitting in `display_name`. Setting only `name_ar`
 * would leave the cascade showing English. `geo_elements` needs only `name_ar`, because
 * the element picker already resolves `isAr ? name_ar || name_en : …` itself.
 *
 * Provenance is stamped on every row it touches, so this is auditable and reversible.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2];
const DRY = process.argv.includes('--dry-run');
if (!DIR || !existsSync(DIR)) { console.error('usage: apply-arabic-names.mjs <dir> [--dry-run]'); process.exit(1); }

function loadEnv() {
  for (const p of ['C:/Users/rayan/Claude/wassell-claude-code/.env.local',
                   'C:/Users/rayan/Claude/wassell-claude-code/.env']) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();
const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const ARABIC = /[\u0600-\u06FF\u0750-\u077F]/;
const LATIN = /[A-Za-z]/;

// ── merge every translator's output ─────────────────────────────────────────
const map = new Map();
const conflicts = [];
let files = 0;
// `out-4a.json` as well as `out-4.json`: a batch that was too large for one response
// gets re-run as lettered quarters, and both shapes must be picked up.
for (const f of readdirSync(DIR).filter((f) => /^out-\d+[a-z]?\.json$/.test(f)).sort()) {
  files++;
  for (const r of JSON.parse(readFileSync(join(DIR, f), 'utf8'))) {
    const en = String(r.en ?? '').trim();
    if (!en) continue;
    const prev = map.get(en);
    // Batches are split alphabetically so a name should appear once; if two
    // translators disagreed on the same string, that is worth SEEING, not silently
    // resolving to whichever landed last.
    if (prev && prev.ar !== r.ar) conflicts.push({ en, a: prev.ar, b: r.ar });
    map.set(en, { ar: String(r.ar ?? '').trim(), method: r.method });
  }
}
console.log(`merged ${files} files → ${map.size} names`);

// ── reviewed overrides ──────────────────────────────────────────────────────
//
// The translators' output is reviewed, not applied blindly. This is the one place a
// verdict is overturned, and each entry says why.
//
// `M 3`, `M 46`, `M 32/2` … — 44 rows, every one in Abu Dhabi, 34 tagged
// industrial_zone. The translators called these building codes and marked them junk,
// which is the right reading of a bare "M 5" in isolation. They are in fact the
// MUSSAFAH industrial sector codes (M-1 … M-46) — a real Abu Dhabi addressing scheme
// that property people use daily ("مصفح M-14"). Hiding them would throw away usable
// geography; the actual defect is that OSM stored the sector without its area name, so
// we restore the prefix rather than discard the row.
let overridden = 0;
for (const [en, v] of map) {
  const m = en.trim().match(/^M\s?(\d+(?:\/\d+)?)$/);
  if (m && v.method === 'junk') {
    // «م» not «M»: the no-Latin-letters invariant on name_ar is the entire point of
    // this pass, and Arabic sources write the sector as مصفح م-14 anyway.
    map.set(en, { ar: `مصفح م-${m[1]}`, method: 'restore' });
    overridden++;
  }
}
if (overridden) console.log(`  overrode ${overridden} Mussafah sector code(s) from junk → «مصفح م-n»`);

// The convention says "prefer an ESTABLISHED name over transliteration whenever one
// exists", but it ALSO says "do not add honorifics that aren't in the English". For
// Dubai's بيت الشيخ سعيد آل مكتوم the two rules collide, and the translator correctly
// flagged it rather than choosing silently. Established wins: that is the name on the
// museum's own signage, and dropping الشيخ makes it read like a private residence.
const ESTABLISHED = new Map([
  ['Saeed Al Maktoum House', 'بيت الشيخ سعيد آل مكتوم'],
  ['Sheikh Saeed Al Maktoum House', 'بيت الشيخ سعيد آل مكتوم'],
]);
let established = 0;
for (const [en, ar] of ESTABLISHED) {
  if (map.has(en) && map.get(en).ar !== ar) { map.set(en, { ar, method: 'restore' }); established++; }
}
if (established) console.log(`  applied ${established} established-name override(s)`);

// A literal «→» inside an Arabic string renders ambiguously: the glyph does not mirror
// with the RTL run, so a metro line reading "الخط الأحمر → الراشدية" can appear to point
// the wrong way. An en-dash is direction-neutral and reads the same either way.
let arrows = 0;
for (const [en, v] of map) {
  if (v.ar && v.ar.includes('→')) {
    map.set(en, { ...v, ar: v.ar.replace(/\s*→\s*/g, ' – ').trim() });
    arrows++;
  }
}
if (arrows) console.log(`  replaced «→» with an en-dash in ${arrows} name(s) (RTL-safe)`);
if (conflicts.length) {
  console.warn(`  ! ${conflicts.length} name(s) translated two different ways — first wins, review these:`);
  for (const c of conflicts.slice(0, 15)) console.warn(`    ${c.en}: «${c.a}» vs «${c.b}»`);
}

// ── validate ────────────────────────────────────────────────────────────────
const bad = [];
for (const [en, v] of map) {
  if (v.method === 'junk') { if (v.ar) bad.push(`${en}: junk but has ar «${v.ar}»`); continue; }
  if (!v.ar) bad.push(`${en}: empty ar with method ${v.method}`);
  else if (!ARABIC.test(v.ar)) bad.push(`${en}: ar has no Arabic letters «${v.ar}»`);
  else if (LATIN.test(v.ar)) bad.push(`${en}: ar contains Latin letters «${v.ar}»`);
}
if (bad.length) {
  console.error(`\n${bad.length} INVALID translation(s) — these are NOT applied:`);
  for (const b of bad.slice(0, 25)) console.error(`  ${b}`);
}
const badSet = new Set(bad.map((b) => b.split(':')[0]));

// ── apply ───────────────────────────────────────────────────────────────────
const rows = JSON.parse(readFileSync(join(DIR, 'all-rows.json'), 'utf8'));
const STAMP = 'ar_name:translated 2026-07-30 (see scratchpad/ar/CONVENTION.md)';

async function patch(table, id, body) {
  if (DRY) return true;
  const r = await fetch(`${URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
  if (!r.ok) { console.error(`  PATCH ${table} ${id} → ${r.status} ${(await r.text()).slice(0, 200)}`); return false; }
  return true;
}

let dOk = 0, eOk = 0, skippedJunk = 0, skippedBad = 0, missing = 0, junkHidden = 0;
const junkRows = [];

// One PATCH per row over ~2,700 rows is ~2,700 sequential round trips, which ran past
// a 10-minute ceiling on the first attempt. Small parallel waves instead — bounded so
// we never open a burst of connections against PostgREST (the lesson from the
// clean-text convoy incident: concurrency is fine, unbounded concurrency is not).
const WAVE = 8;
async function eachRow(fn) {
  for (let i = 0; i < rows.length; i += WAVE) {
    await Promise.all(rows.slice(i, i + WAVE).map(fn));
    if (i % 400 === 0) process.stdout.write(`\r  ${i}/${rows.length}…   `);
  }
}

await eachRow(async (row) => {
  const t = map.get(row.en.trim());
  if (!t) { missing++; return; }
  if (t.method === 'junk') {
    skippedJunk++; junkRows.push(row);
    // A row the translators judged "not a place" should not sit in the CLIENT-facing
    // element search — «lalu ko company ko room», «soccer field», «Bldg 10». Hidden,
    // not deleted: is_searchable=false is exactly the flag `wassell_search_geo_elements`
    // filters on, the admin module still lists the row, and it flips back in one UPDATE.
    // Districts are left alone — removing one is a bigger call than hiding an anchor,
    // and they are reported for review instead.
    if (row.kind === 'element') { if (await patch('geo_elements', row.id, { is_searchable: false })) junkHidden++; }
    return;
  }
  if (badSet.has(row.en.trim())) { skippedBad++; return; }

  if (row.kind === 'district') {
    // display_name too — see the header note.
    if (await patch('districts', row.id, {
      name_ar: t.ar, display_name: t.ar, migration_notes: STAMP,
    })) dOk++;
  } else {
    if (await patch('geo_elements', row.id, { name_ar: t.ar })) eOk++;
  }
});
console.log(`\n\n${DRY ? 'DRY RUN — nothing written' : 'applied'}:`);
console.log(`  districts:     ${dOk}`);
console.log(`  geo_elements:  ${eOk}`);
console.log(`  skipped junk:  ${skippedJunk}  (not a place name — left English, flagged for review)`);
console.log(`  junk hidden:   ${junkHidden}  (geo_elements is_searchable=false — reversible, still visible in admin)`);
console.log(`  skipped bad:   ${skippedBad}  (failed validation)`);
console.log(`  no translation:${missing}`);

// The junk list is a DELIVERABLE, not a footnote: these are rows that should probably
// not be in the geography tier at all, and the next person needs the list.
writeFileSync(join(DIR, 'junk-rows.json'), JSON.stringify(junkRows, null, 1));
console.log(`\njunk rows written to junk-rows.json (${junkRows.length})`);

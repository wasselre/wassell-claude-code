// One-time (re-runnable) script that populates the project_details icon
// library with the exact same hand-coded Lucide-style SVGs the public
// website already uses (Wassel Website/js/project-icons.js). The CRM
// library tab and the public site now render byte-identical icons.
//
// Why hand-coded and not AI-generated: every AI route we tried
// (recraft-v3 vector_illustration in any substyle; Claude Sonnet 4.6
// SVG via tool schema) drifted away from the clean 200-byte Lucide
// shape the website expects. Hand-coded gives us pixel parity for free.
//
// AI generation still has a place — see `api/icons/generate.ts` for
// the on-demand custom icon path used by the picker's "Generate" tab.
//
// Required env:
//   SUPABASE_URL                project URL
//   SUPABASE_SERVICE_ROLE_KEY   service-role key (storage write)
//
// Optional env:
//   ONLY                        comma-separated slug subset
//
// Usage:
//   node scripts/seed-icon-library.mjs
//   node scripts/seed-icon-library.mjs --only=building,metro

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// ─── Path data, copied 1:1 from Wassel Website/js/project-icons.js ─────
//
// Stays in sync with the website by convention — if a slug's path
// changes there, change it here too and re-run the script. Both sides
// also keep the same slug set; see iconLibrary.ts for the index.
const FEATURE_PATHS = {
  building:   '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21V12h6v9"/>',
  home:       '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  car:        '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18.4 7c-.4-1.2-1.5-2-2.8-2H7c-1.3 0-2.4.8-2.8 2L2.5 11.1C1.7 11.3 1 12.1 1 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  smart_home: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  ac:         '<path d="M2 12h20"/><path d="M12 2v20"/><path d="M5 5l14 14"/><path d="M19 5L5 19"/>',
  camera:     '<path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8-10-8-10-8z"/><circle cx="12" cy="12" r="3"/>',
  key:        '<path d="m21 7-4 4M3 17l4-4M14 4l-4 4M10 20l4-4"/><circle cx="9" cy="15" r="3"/>',
  facade:     '<path d="M3 3h18v18H3z"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  bed:        '<path d="M2 12V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6"/><path d="M2 18h20"/><path d="M2 22v-4"/><path d="M22 22v-4"/><path d="M2 12h20"/>',
  box:        '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  sparkle:    '<path d="m12 2 3 7h7l-5.5 4 2 8L12 17l-6.5 4 2-8L2 9h7z"/>',
  elevator:   '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M9 7h6M9 11h6M9 15h3"/>',
  shield:     '<path d="M12 22s8-4 8-12V5l-8-3-8 3v5c0 8 8 12 8 12z"/>',
  wifi:       '<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>',
  pool:       '<path d="M2 22a8 8 0 0 1 16 0"/><path d="M2 18a8 8 0 0 1 16 0"/><path d="M2 14a8 8 0 0 1 16 0"/>',
  gym:        '<path d="m6.5 6.5 11 11"/><path d="M21 21l-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/>',
};

const LANDMARK_PATHS = {
  metro:      '<rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6 18v2"/><path d="M18 18v2"/><circle cx="7" cy="13" r="1"/><circle cx="17" cy="13" r="1"/>',
  road:       '<path d="M4 19h16M4 12h16M4 5h16"/><path d="M9 5v14M15 5v14"/>',
  shop:       '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  school:     '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  hospital:   '<path d="M8 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3"/><path d="M12 11v6M9 14h6"/>',
  park:       '<path d="M12 22V8"/><path d="M5 22h14"/><path d="M12 8a4 4 0 0 0 4-4 4 4 0 0 0-8 0 4 4 0 0 0 4 4z"/><path d="M5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/><path d="M19 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/>',
  mosque:     '<path d="M4 21V11a8 8 0 0 1 16 0v10"/><path d="M2 21h20"/><path d="M12 6V3"/><path d="M10 3h4"/><path d="M9 21V14h6v7"/>',
  airport:    '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  restaurant: '<path d="M3 11h18l-2 9H5l-2-9z"/><path d="M11 11V8a3 3 0 0 1 6 0v3"/><path d="M7 11V8a3 3 0 0 1 0-6"/>',
  gas:        '<line x1="3" y1="22" x2="15" y2="22"/><line x1="4" y1="9" x2="14" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>',
  pin:        '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
};

const WASSEL_COPPER = '#B8734F';

// Wrap a path fragment in a Wassel-branded 24x24 monoline SVG envelope.
// Same shape the website uses, but with the copper stroke baked in
// (the website uses currentColor; here we encode the color directly so
// the bucket assets are self-contained and render anywhere).
function wrap(paths) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" `
    + `stroke="${WASSEL_COPPER}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`
    + `${paths}</svg>`
  );
}

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k, v ?? true]),
);
const onlyFilter = typeof args.only === 'string'
  ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function uploadSvg(slug, svg) {
  const { error } = await supabase.storage
    .from('marketing-assets')
    .upload(`icons/library/${slug}.svg`, Buffer.from(svg, 'utf-8'), {
      contentType: 'image/svg+xml',
      upsert: true,
    });
  if (error) throw new Error(`upload ${slug}: ${error.message}`);
}

async function processSlug(slug, paths) {
  const svg = wrap(paths);
  await uploadSvg(slug, svg);
  console.log(`[${slug}] uploaded (${svg.length} bytes)`);
}

(async () => {
  const all = Object.entries({ ...FEATURE_PATHS, ...LANDMARK_PATHS });
  const slugs = all.filter(([slug]) => (onlyFilter ? onlyFilter.has(slug) : true));
  if (onlyFilter && slugs.length === 0) {
    console.error(`No slugs matched --only=${args.only}`);
    process.exit(1);
  }
  let failed = 0;
  for (const [slug, paths] of slugs) {
    try {
      await processSlug(slug, paths);
    } catch (err) {
      failed += 1;
      console.error(`[${slug}] FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone. ${slugs.length - failed}/${slugs.length} succeeded.`);
  if (failed > 0) process.exit(2);
})();

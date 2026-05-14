// One-time (re-runnable) script that pre-renders the 27 curated project_details
// icons and uploads them to `marketing-assets/icons/library/<slug>.png` in the
// configured Supabase project. The runtime CRM resolves library URLs by slug
// against `VITE_SUPABASE_URL`, so this script is what makes those URLs exist.
//
// Re-runs upsert (overwrite) each PNG — handy when you tweak the prompt
// framing or the style and want to refresh the whole library.
//
// Required env:
//   FAL_KEY                     fal.ai API key
//   SUPABASE_URL                project URL (e.g. https://abc.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY   service-role key (write access to storage)
//
// Optional env:
//   FAL_BASE_URL                default https://queue.fal.run
//   FAL_ICON_MODEL_ID           default fal-ai/recraft-v3
//   ICON_STYLE                  default icon/broken_line
//   ONLY                        comma-separated slug subset to (re)generate
//
// Usage:
//   node scripts/seed-icon-library.mjs
//   node scripts/seed-icon-library.mjs --only=building,metro

import { createClient } from '@supabase/supabase-js';

const FAL_KEY = process.env.FAL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!FAL_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: FAL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const FAL_BASE_URL = process.env.FAL_BASE_URL ?? 'https://queue.fal.run';
const FAL_MODEL_ID = process.env.FAL_ICON_MODEL_ID ?? 'fal-ai/recraft-v3';
const STYLE = process.env.ICON_STYLE ?? 'vector_illustration';

// Slug → human noun. Keep in sync with FEATURE_ICONS / LANDMARK_ICONS in
// src/data/iconLibrary.ts (slugs) and supabase/functions/project-details-ai-v2
// (slugs the AI picks from).
const SLUG_PROMPTS = {
  // Features
  building:   'a modern multi-story residential building',
  home:       'a contemporary villa with a pitched roof',
  car:        'a car parked in a covered parking space',
  smart_home: 'a smart-home control panel with a Wi-Fi symbol',
  ac:         'a wall-mounted air conditioner unit',
  camera:     'a wall-mounted security camera',
  key:        'a modern door key',
  facade:     'a stylized building facade with windows',
  bed:        'a double bed seen from the side',
  box:        'a stack of storage boxes',
  sparkle:    'a sparkle indicating premium finish',
  elevator:   'an elevator door between two arrows',
  shield:     'a security shield with a check mark',
  wifi:       'a Wi-Fi signal symbol',
  pool:       'a swimming pool with a ladder',
  gym:        'a dumbbell representing a gym',
  // Landmarks
  metro:      'a metro train at a station platform',
  road:       'a highway road with lane markings',
  shop:       'a shopping bag with a handle',
  school:     'a school building with a flag',
  hospital:   'a hospital building with a cross symbol',
  park:       'a tree in a public park',
  mosque:     'a mosque with a dome and minaret',
  airport:    'an airplane taking off',
  restaurant: 'a fork and knife crossed for a restaurant',
  gas:        'a fuel pump for a gas station',
  pin:        'a map pin marking a generic location',
};

const STYLE_PREFIX =
  'Single real-estate icon, copper #B8734F outline on transparent background, ' +
  'flat vector, single line weight, centered, minimal, no text, no shadows. ' +
  'Subject: ';

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

function authHeader() {
  return `Key ${FAL_KEY}`;
}

async function startGeneration(prompt) {
  const url = `${FAL_BASE_URL.replace(/\/$/, '')}/${FAL_MODEL_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify({ prompt, style: STYLE, image_size: 'square_hd' }),
  });
  if (!res.ok) {
    throw new Error(`start failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function poll(statusUrl, responseUrl) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = await fetch(statusUrl, { headers: { Authorization: authHeader() } });
    if (!r.ok) throw new Error(`poll failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const status = (j.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const res = await fetch(responseUrl, { headers: { Authorization: authHeader() } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`response fetch failed (${res.status}): ${body.slice(0, 500)}`);
      }
      const data = await res.json();
      const u = data?.images?.[0]?.url;
      if (!u) throw new Error('no image URL in response');
      return u;
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'NSFW') {
      throw new Error(`${status}: ${j.error ?? j.detail ?? 'unknown'}`);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error('poll timeout');
}

// recraft-v3's `vector_illustration` style returns SVG, even though the
// fal.ai response URL ends in `.png`. Sniff the bytes so we store with
// the correct extension + content type — otherwise the browser refuses
// to render SVG bytes labelled as `image/png`.
function detectImage(bytes) {
  const head = bytes.subarray(0, 200).toString('utf-8').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) {
    return { ext: 'svg', contentType: 'image/svg+xml' };
  }
  return { ext: 'png', contentType: 'image/png' };
}

async function uploadAsset(slug, bytes) {
  const { ext, contentType } = detectImage(bytes);
  const { error } = await supabase.storage
    .from('marketing-assets')
    .upload(`icons/library/${slug}.${ext}`, bytes, {
      contentType,
      upsert: true,
    });
  if (error) throw new Error(`upload ${slug}: ${error.message}`);
  return ext;
}

async function processSlug(slug, subject) {
  const prompt = `${STYLE_PREFIX}${subject}.`;
  console.log(`[${slug}] generating…`);
  const started = await startGeneration(prompt);
  const sourceUrl = await poll(started.status_url, started.response_url);
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`fetch source failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ext = await uploadAsset(slug, bytes);
  console.log(`[${slug}] uploaded to icons/library/${slug}.${ext}`);
}

(async () => {
  const slugs = Object.entries(SLUG_PROMPTS).filter(([slug]) =>
    onlyFilter ? onlyFilter.has(slug) : true,
  );
  if (onlyFilter && slugs.length === 0) {
    console.error(`No slugs matched --only=${args.only}`);
    process.exit(1);
  }
  let failed = 0;
  for (const [slug, subject] of slugs) {
    try {
      await processSlug(slug, subject);
    } catch (err) {
      failed += 1;
      console.error(`[${slug}] FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone. ${slugs.length - failed}/${slugs.length} succeeded.`);
  if (failed > 0) process.exit(2);
})();

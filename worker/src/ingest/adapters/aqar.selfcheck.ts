// Deterministic unit test for the Aqar adapter. Run with:  npx tsx aqar.test.ts
// No test framework (worker has none) — plain node:assert, exits non-zero on fail.
import assert from 'node:assert/strict';
import { parseAqarListing, extractJsonLd, AQAR_ADAPTER_ID } from './aqar.js';
import { sampleAqarPage } from './aqar.fixture.js';

let n = 0;
const ok = (msg: string) => { n++; console.log(`  ok ${n} - ${msg}`); };

// resilience: 5 valid blocks + 1 malformed → 5 parsed, no throw
const blocks = extractJsonLd(sampleAqarPage.html);
assert.equal(blocks.length, 4, `expected 4 valid JSON-LD blocks, got ${blocks.length}`);
ok('extractJsonLd skips the malformed block (4 valid)');

const r = parseAqarListing(sampleAqarPage);

// canonical fields
const c = r.canonical;
assert.equal(c.external_id, '9999001'); assert.equal(c.source, 'aqar');
assert.equal(c.price, 990000); assert.equal(c.currency, 'SAR');
assert.equal(c.bedrooms, 2); assert.equal(c.bathrooms, 2); assert.equal(c.rooms, 3);
assert.equal(c.area, 80); assert.equal(c.area_unit, 'م²');
assert.equal(c.city, 'الرياض'); assert.equal(c.region, 'شمال الرياض');
assert.equal(c.district, 'حي النزهة'); assert.equal(c.country, 'SA');
assert.equal(c.property_type, 'شقة'); assert.equal(c.property_category, 'شقق-للبيع');
assert.equal(c.latitude, 24.760451); assert.equal(c.longitude, 46.707711);
ok('canonical scalar fields parsed from JSON-LD + URL path');

// features: only value===true, order preserved, false-valued excluded
assert.deepEqual(c.features, ['مدخل سيارة', 'موقف خاص']);
ok('features: true-valued only, order preserved');

// media
assert.deepEqual(c.image_urls, [
  'https://images.aqar.fm/webp/750x0/props/000000001_1700000000001.jpg',
  'https://images.aqar.fm/webp/750x0/props/000000002_1700000000002.jpg',
]);
assert.ok(String(c.video_url).endsWith('video.m3u8'));
ok('images[] + video_url extracted');

// capture class + manifest
assert.equal(r.capture_class, 'complete', 'optional-absent floor_plans must not reduce completeness');
const floor = r.evidence.manifest.find((m) => m.section === 'floor_plans');
assert.equal(floor?.state, 'not_present');
const geo = r.evidence.manifest.find((m) => m.section === 'geo');
assert.equal(geo?.state, 'captured');
ok('capture_class=complete; floor_plans not_present; geo captured');

// evidence blobs + artifacts (2 blobs; detail_html + jsonld + 2 images + 1 video = 5 artifacts)
assert.equal(r.evidence.blobs.length, 2);
assert.equal(r.evidence.adapter_id, AQAR_ADAPTER_ID);
const types = r.evidence.artifacts.map((a) => a.artifact_type);
assert.deepEqual(types, ['detail_html', 'jsonld', 'image', 'image', 'video']);
// image/video artifacts carry no bytes (URL-only) → NULL content_hash
for (const a of r.evidence.artifacts) {
  if (a.artifact_type === 'image' || a.artifact_type === 'video') {
    assert.equal(a.retention_mode, 'source_url_metadata_only');
    assert.equal(a.content_hash ?? null, null);
  } else {
    assert.equal(a.retention_mode, 'original_bytes');
    assert.match(String(a.content_hash), /^[a-f0-9]{64}$/);
  }
}
assert.match(r.evidence.manifest_hash, /^[a-f0-9]{64}$/);
ok('evidence: 2 blobs, 5 artifacts with correct retention modes, sha256 manifest_hash');

// media_summary retains source vs captured counts
assert.deepEqual(r.evidence.media_summary, {
  images: { source_count: 2, captured_count: 2 }, videos: { source_count: 1, captured_count: 1 },
});
ok('media_summary counts');

// captured-but-unmapped: leaseLength must raise exactly one gap; all mapped fields none
assert.equal(r.gaps.length, 1, `expected 1 gap, got ${JSON.stringify(r.gaps)}`);
assert.equal(r.gaps[0].source_path, 'offers.itemOffered.leaseLength');
ok('captured-but-unmapped field raises exactly one schema gap');

// determinism: same bytes → identical manifest_hash + identical canonical
const r2 = parseAqarListing(sampleAqarPage);
assert.equal(r2.evidence.manifest_hash, r.evidence.manifest_hash);
assert.deepEqual(r2.canonical, r.canonical);
ok('deterministic: identical output on re-parse');

console.log(`\nAqar adapter: ALL ${n} CHECKS PASSED`);

// ============================================================================
// Aqar (عقار / sa.aqar.fm) deterministic adapter.
//
// PURE + DETERMINISTIC: parses a captured Aqar detail page into the shared
// ingestion contract. No AI, no scoring, no network I/O — given the same page
// bytes it always produces the same AdapterResult. Byte retrieval + mirroring
// (images/video) and the DB writes are the worker's job; this module only
// reads the bytes it is handed.
//
// SOURCE: Aqar embeds schema.org JSON-LD in the page. The `RealEstateListing`
// / `Product` block (with `offers.itemOffered`) carries price, beds, baths,
// rooms, floorSize (area), amenityFeature (features), address and geo — a
// complete structured record. The canonical listing URL path carries the
// city / region / district segments. Both are stable, structured sources; we
// deliberately do NOT free-text scrape the HTML.
//
// Every field we read is declared in FIELD_MAP (the adapter's view of the
// authoritative source_field_mappings for contract v001). A structured field
// present in the JSON-LD but absent from FIELD_MAP is surfaced as a schema gap
// (captured-but-unmapped) — never silently dropped. A field the listing simply
// lacks is recorded on the capture manifest as not_present and is NOT a gap.
// ============================================================================
import { createHash } from 'node:crypto';
import {
  AdapterResult, CaptureManifestEntry, EvidencePackage, ObservedField,
  RawArtifactInput, RawBlobInput, SchemaGap, deriveCaptureClass,
} from '../contract.js';

export const AQAR_ADAPTER_ID = 'market-ingest/adapters/aqar';
export const AQAR_ADAPTER_VERSION = 'v0';
export const AQAR_CONTRACT_VERSION = 'v001'; // zero-padded: lexical "latest"

export interface AqarPageInput {
  external_id: string;
  url: string;               // canonical listing URL (post-redirect)
  html: string;              // raw detail HTML bytes (as text)
  http_status: number;
  fetched_at: string;        // ISO timestamp of capture
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Deterministically pull every application/ld+json block, flattened. */
export function extractJsonLd(html: string): Record<string, unknown>[] {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const out: Record<string, unknown>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const x of Array.isArray(parsed) ? parsed : [parsed]) {
        if (x && typeof x === 'object') out.push(x as Record<string, unknown>);
      }
    } catch {
      /* a single malformed block must not abort the whole parse */
    }
  }
  return out;
}

function hasType(block: Record<string, unknown>, t: string): boolean {
  const bt = block['@type'];
  return Array.isArray(bt) ? bt.includes(t) : bt === t;
}

/** category slug → canonical property type (deterministic, closed map). */
const CATEGORY_TYPE: Record<string, string> = {
  'شقق-للبيع': 'شقة', 'شقق-للايجار': 'شقة',
  'فلل-للبيع': 'فيلا', 'فلل-للايجار': 'فيلا',
  'اراضي-للبيع': 'أرض', 'عمائر-للبيع': 'عمارة',
  'استراحات-للبيع': 'استراحة', 'دور-للبيع': 'دور', 'دور-للايجار': 'دور',
};

/** Parse city/region/district/category from the canonical URL path (deterministic). */
function parseUrlPath(url: string): { category?: string; city?: string; region?: string; district?: string } {
  try {
    const path = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
    // /<category>/<city>/<region>/<district>/<street-…-id>. Segments are hyphen
    // slugs; deslug the place names (keep the category slug — it is a map key).
    const deslug = (s?: string) => (s ? s.replace(/-/g, ' ') : undefined);
    return { category: path[0], city: deslug(path[1]), region: deslug(path[2]), district: deslug(path[3]) };
  } catch {
    return {};
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

// Declared source→canonical mapping for contract v001 (adapter's view of the
// authoritative source_field_mappings). source_path → canonical_field.
const FIELD_MAP: Record<string, string> = {
  'jsonld.name': 'title',
  'jsonld.description': 'description',
  'jsonld.datePosted': 'date_posted',
  'offers.price': 'price',
  'offers.priceCurrency': 'currency',
  'offers.itemOffered.numberOfBedrooms': 'bedrooms',
  'offers.itemOffered.numberOfBathroomsTotal': 'bathrooms',
  'offers.itemOffered.numberOfRooms': 'rooms',
  'offers.itemOffered.floorSize.value': 'area',
  'offers.itemOffered.floorSize.unitText': 'area_unit',
  'offers.itemOffered.address.addressLocality': 'district',
  'offers.itemOffered.address.streetAddress': 'street',
  'offers.itemOffered.address.addressCountry': 'country',
  'offers.itemOffered.geo.latitude': 'latitude',
  'offers.itemOffered.geo.longitude': 'longitude',
  'offers.itemOffered.amenityFeature': 'features',
  'jsonld.image': 'image_urls',
  'video.contentUrl': 'video_url',
  'url.city': 'city',
  'url.region': 'region',
  'url.category': 'property_type',
};

export function parseAqarListing(input: AqarPageInput): AdapterResult {
  const blocks = extractJsonLd(input.html);
  const listing = blocks.find((b) => hasType(b, 'RealEstateListing') || hasType(b, 'Product'));
  const video = blocks.find((b) => hasType(b, 'VideoObject'));
  const urlParts = parseUrlPath(input.url);

  // ── evidence blobs: bytes the adapter actually holds (worker uploads them) ──
  const jsonldText = JSON.stringify(blocks);
  const htmlHash = sha256(input.html);
  const jsonldHash = sha256(jsonldText);
  const blobs: RawBlobInput[] = [
    { content_hash: htmlHash, media_type: 'text/html', size_bytes: Buffer.byteLength(input.html, 'utf8'),
      storage_bucket: 'market-raw', storage_object_path: `aqar/${htmlHash}` },
    { content_hash: jsonldHash, media_type: 'application/ld+json', size_bytes: Buffer.byteLength(jsonldText, 'utf8'),
      storage_bucket: 'market-raw', storage_object_path: `aqar/${jsonldHash}` },
  ];

  const artifacts: RawArtifactInput[] = [
    { artifact_type: 'detail_html', media_type: 'text/html', source_url_or_endpoint: input.url,
      content_hash: htmlHash, retention_mode: 'original_bytes', retention_state: 'durable_original',
      http_status: input.http_status, parser_hint: 'aqar/jsonld' },
    { artifact_type: 'jsonld', media_type: 'application/ld+json', content_hash: jsonldHash,
      retention_mode: 'original_bytes', retention_state: 'durable_original' },
  ];

  const offers = (listing?.['offers'] ?? {}) as Record<string, unknown>;
  const item = (offers['itemOffered'] ?? {}) as Record<string, unknown>;
  const address = (item['address'] ?? {}) as Record<string, unknown>;
  const geo = (item['geo'] ?? {}) as Record<string, unknown>;
  const floorSize = (item['floorSize'] ?? {}) as Record<string, unknown>;

  // images → external references (bytes mirrored later by the worker → existing_storage_ref)
  const images = Array.isArray(listing?.['image']) ? (listing!['image'] as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  images.forEach((imgUrl, i) => {
    artifacts.push({
      artifact_type: 'image', media_type: 'image/webp', source_url_or_endpoint: imgUrl,
      content_hash: null, retention_mode: 'source_url_metadata_only', retention_state: 'external_reference_only',
      order_index: i,
    });
  });
  // video → external reference only (Cloudflare Stream; never byte-mirrored)
  const videoUrl = str(video?.['contentUrl']);
  if (videoUrl) {
    artifacts.push({
      artifact_type: 'video', media_type: 'application/vnd.apple.mpegurl', source_url_or_endpoint: videoUrl,
      content_hash: null, retention_mode: 'source_url_metadata_only', retention_state: 'external_reference_only',
      media_metadata: { thumbnail: (video?.['thumbnailUrl'] as unknown) ?? null, uploadDate: video?.['uploadDate'] ?? null },
    });
  }

  // ── capture manifest (one row per expected section) ────────────────────────
  const iDetail = 0, iJsonld = 1, iImg0 = images.length ? 2 : null, iVideo = videoUrl ? 2 + images.length : null;
  const manifest: CaptureManifestEntry[] = [
    { section: 'detail_html', state: 'captured', why_expected: 'platform_contract', artifact_index: iDetail },
    { section: 'jsonld', state: listing ? 'captured' : 'missing_expected', why_expected: 'platform_contract', artifact_index: iJsonld },
    { section: 'images', state: images.length ? 'captured' : 'not_present', why_expected: 'source_reported_count', artifact_index: iImg0 },
    { section: 'videos', state: videoUrl ? 'captured' : 'not_present', why_expected: 'tab', artifact_index: iVideo },
    { section: 'features', state: Array.isArray(item['amenityFeature']) ? 'captured' : 'not_present', why_expected: 'embedded_identifier' },
    { section: 'geo', state: geo['latitude'] != null ? 'captured' : 'not_present', why_expected: 'embedded_identifier' },
    { section: 'floor_plans', state: 'not_present', why_expected: 'none' }, // Aqar listings carry none — optional-absent
  ];

  // ── canonical field values (publisher re-derives via source_field_mappings) ─
  const features = Array.isArray(item['amenityFeature'])
    ? (item['amenityFeature'] as Record<string, unknown>[]).filter((f) => f?.['value'] === true).map((f) => str(f['name'])).filter(Boolean)
    : [];
  const canonical: Record<string, unknown> = {
    external_id: input.external_id, source: 'aqar', listing_url: input.url,
    title: str(listing?.['name']), description: str(listing?.['description']),
    date_posted: str(listing?.['datePosted']),
    price: num(offers['price']), currency: str(offers['priceCurrency']),
    bedrooms: num(item['numberOfBedrooms']), bathrooms: num(item['numberOfBathroomsTotal']),
    rooms: num(item['numberOfRooms']), area: num(floorSize['value']), area_unit: str(floorSize['unitText']),
    city: urlParts.city ?? null, region: urlParts.region ?? null,
    district: str(address['addressLocality']) ?? urlParts.district ?? null,
    street: str(address['streetAddress']), country: str(address['addressCountry']),
    property_type: urlParts.category ? (CATEGORY_TYPE[urlParts.category] ?? null) : null,
    property_category: urlParts.category ?? null,
    latitude: num(geo['latitude']), longitude: num(geo['longitude']),
    image_urls: images, video_url: videoUrl, features,
  };

  // ── observed fields (discovery catalog) + gaps (captured-but-unmapped) ──────
  const observed: ObservedField[] = [];
  const gaps: SchemaGap[] = [];
  const observe = (source_path: string, value: unknown, extra: Partial<ObservedField> = {}) => {
    if (value == null || (Array.isArray(value) && value.length === 0)) return;
    observed.push({ source_path, example_values: [Array.isArray(value) ? value.slice(0, 3) : value], language: 'na', ...extra });
    if (!(source_path in FIELD_MAP)) {
      gaps.push({ source_path, suggested_type: Array.isArray(value) ? 'array' : typeof value, criticality: 'non_critical' });
    }
  };
  observe('jsonld.name', listing?.['name'], { language: 'ar', raw_data_type: 'string' });
  observe('jsonld.description', listing?.['description'], { language: 'ar', raw_data_type: 'string' });
  observe('jsonld.datePosted', listing?.['datePosted'], { raw_data_type: 'date' });
  observe('offers.price', offers['price'], { raw_data_type: 'number', unit: 'SAR' });
  observe('offers.priceCurrency', offers['priceCurrency'], { raw_data_type: 'string' });
  observe('offers.itemOffered.numberOfBedrooms', item['numberOfBedrooms'], { raw_data_type: 'number' });
  observe('offers.itemOffered.numberOfBathroomsTotal', item['numberOfBathroomsTotal'], { raw_data_type: 'number' });
  observe('offers.itemOffered.numberOfRooms', item['numberOfRooms'], { raw_data_type: 'number' });
  observe('offers.itemOffered.floorSize.value', floorSize['value'], { raw_data_type: 'number', unit: 'MTK' });
  observe('offers.itemOffered.address.addressLocality', address['addressLocality'], { language: 'ar' });
  observe('offers.itemOffered.geo.latitude', geo['latitude'], { raw_data_type: 'number' });
  observe('offers.itemOffered.amenityFeature', item['amenityFeature'], { raw_data_type: 'array', language: 'ar' });
  observe('jsonld.image', listing?.['image'], { raw_data_type: 'array' });
  observe('video.contentUrl', video?.['contentUrl'], { raw_data_type: 'url' });

  // Discover any structured itemOffered field we captured but do NOT map — these
  // become schema gaps (nothing captured is silently dropped). Fields Aqar simply
  // omits never reach here, so optional-absence never raises a gap.
  const KNOWN_ITEM_KEYS = new Set([
    '@type', 'name', 'url', 'numberOfBedrooms', 'numberOfBathroomsTotal',
    'numberOfRooms', 'floorSize', 'address', 'geo', 'amenityFeature',
  ]);
  for (const k of Object.keys(item)) {
    if (KNOWN_ITEM_KEYS.has(k)) continue;
    observe(`offers.itemOffered.${k}`, (item as Record<string, unknown>)[k],
      { raw_data_type: Array.isArray((item as Record<string, unknown>)[k]) ? 'array' : typeof (item as Record<string, unknown>)[k] });
  }

  const capture_class = deriveCaptureClass(manifest);
  const media_summary = {
    images: { source_count: images.length, captured_count: images.length },
    videos: { source_count: videoUrl ? 1 : 0, captured_count: videoUrl ? 1 : 0 },
  };

  // deterministic manifest_hash over the ordered artifacts + manifest
  const manifest_hash = sha256(JSON.stringify({ artifacts, manifest, media_summary }));

  const evidence: EvidencePackage = {
    external_id: input.external_id, adapter_id: AQAR_ADAPTER_ID, adapter_version: AQAR_ADAPTER_VERSION,
    manifest_hash, media_summary, blobs, artifacts, manifest,
  };

  return { external_id: input.external_id, contract_version: AQAR_CONTRACT_VERSION, evidence, observed, gaps, canonical, capture_class };
}

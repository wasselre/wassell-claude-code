/**
 * Client-preference chips for the Chats list + the client-page filters.
 *
 * Pure functions — the ChatList feeds them the linked client record, the
 * clients model (for multiselect option labels), and an id→name map for the
 * geography records (districts/cities), and gets back small display chips:
 *   • one chip per preferred unit type (نوع الوحدة المفضل)
 *   • one chip for the preferred area range (المساحة المفضلة)
 *   • ONE location chip: city · district · element (country/region omitted
 *     by design — the rep only cares where inside the city). Extra
 *     districts/elements collapse into a "+N" suffix.
 *
 * Also home to the client-chats filter predicates (interested / awaiting
 * reply) so ChatList stays presentational.
 */

import type { AppModel, AppRecord, ModelField } from '@/types';
import { parseLocationItems, describeLocationItem } from '@/lib/geo/locationItems';

export interface ClientPrefChip {
  key: string;
  kind: 'unit_type' | 'area' | 'location';
  text: string;
}

export interface ClientPrefDetailChip {
  key: string;
  kind:
    | 'unit_type'
    | 'budget'
    | 'area'
    | 'bedrooms'
    | 'direction'
    | 'amenities'
    | 'objective'
    | 'location'
    | 'distance'
    | 'setting'
    | 'notes';
  text: string;
  /** Full untruncated text for the title/tooltip. */
  title?: string;
}

/**
 * id → display name for the geography records (districts + cities), used to
 * resolve the location-cascade ids on a client into chip labels. Built from
 * the already-loaded store records — no fetch.
 */
export function buildGeoNameMap(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of ['districts', 'cities']) {
    const m = models.find((mm) => mm.name === name);
    if (!m) continue;
    for (const r of records[m.id] ?? []) {
      const dn = (r.data?.display_name ?? r.data?.name_ar ?? r.data?.name_en) as unknown;
      if (typeof dn === 'string' && dn.trim()) map[r.id] = dn.trim();
    }
  }
  return map;
}

/** Find a field by slug anywhere in the model schema. */
function fieldBySlug(model: AppModel | null | undefined, slug: string): ModelField | null {
  if (!model) return null;
  for (const section of model.schema.sections) {
    for (const f of section.fields) if (f.name === slug) return f;
  }
  return null;
}

/** Multiselect/dropdown API value → display label (falls back to the raw value). */
function optionLabel(field: ModelField | null, value: string, isAr: boolean): string {
  const opt = field?.options?.find((o) => o.value === value);
  if (!opt) return value;
  return (isAr ? opt.label_ar : opt.label_en) || value;
}

const stringList = (v: unknown): string[] => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return [];
};

/** Format a {min,max} range field value; null when empty/malformed. */
function formatRange(v: unknown, unit: string): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const min = Number(o.min);
  const max = Number(o.max);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (hasMin && hasMax) return `${fmt(min)}–${fmt(max)} ${unit}`;
  if (hasMin) return `${fmt(min)}+ ${unit}`;
  if (hasMax) return `≤${fmt(max)} ${unit}`;
  return null;
}

/**
 * Build the preference chips for one client. `geoNames` maps districts/cities
 * record ids → display name (built once by the caller from the loaded
 * geography records); `location_items` carry their own display labels so
 * they resolve even when the geography records aren't loaded.
 */
export function buildClientPrefChips(
  clientData: Record<string, unknown>,
  clientsModel: AppModel | null,
  geoNames: Record<string, string>,
  isAr: boolean,
): ClientPrefChip[] {
  const chips: ClientPrefChip[] = [];

  // ── Unit type(s) ──
  const unitField = fieldBySlug(clientsModel, 'preferred_unit_type');
  for (const v of stringList(clientData.preferred_unit_type)) {
    chips.push({ key: `unit:${v}`, kind: 'unit_type', text: optionLabel(unitField, v, isAr) });
  }

  // ── Area range ──
  const area = formatRange(clientData.preferred_area, isAr ? 'م²' : 'm²');
  if (area) chips.push({ key: 'area', kind: 'area', text: area });

  // ── Location: city · district · element (one chip) ──
  const loc = clientData.location && typeof clientData.location === 'object' && !Array.isArray(clientData.location)
    ? (clientData.location as Record<string, unknown>)
    : {};

  // City: the location cascade's city record id, else the legacy
  // preferred_city multiselect's first value (already a display label).
  const cityField = fieldBySlug(clientsModel, 'preferred_city');
  const city =
    stringList(loc.city).map((id) => geoNames[id]).find((n): n is string => !!n) ??
    stringList(clientData.preferred_city).map((v) => optionLabel(cityField, v, isAr)).find((n) => !!n) ??
    null;

  // Districts: include-polarity district items (labels stashed inline) +
  // legacy cascade district ids. Excludes are deliberately skipped — the
  // chip answers "where does the client want", not "where not".
  const districts: string[] = [];
  const elements: string[] = [];
  for (const item of parseLocationItems(clientData.location_items)) {
    if (item.polarity === 'exclude') continue;
    if (item.kind === 'district') {
      const name = item.district_label || geoNames[item.district_id];
      if (name && !districts.includes(name)) districts.push(name);
    } else if (item.kind === 'drawn_area') {
      const name = item.label || (isAr ? 'منطقة مرسومة' : 'Drawn area');
      if (!elements.includes(name)) elements.push(name);
    } else if (item.element_label && !elements.includes(item.element_label)) {
      elements.push(item.element_label);
    }
  }
  for (const id of stringList(loc.district)) {
    const name = geoNames[id];
    if (name && !districts.includes(name)) districts.push(name);
  }
  // Legacy multiselect fallback so pre-geo clients still show a district.
  if (districts.length === 0) {
    const nbField = fieldBySlug(clientsModel, 'preferred_neighborhoods');
    for (const v of stringList(clientData.preferred_neighborhoods)) {
      const name = optionLabel(nbField, v, isAr);
      if (!districts.includes(name)) districts.push(name);
    }
  }

  const parts = [city, districts[0] ?? null, elements[0] ?? null].filter((p): p is string => !!p);
  if (parts.length) {
    const extra = Math.max(0, districts.length - 1) + Math.max(0, elements.length - 1);
    chips.push({
      key: 'location',
      kind: 'location',
      text: parts.join(' · ') + (extra > 0 ? ` +${extra}` : ''),
    });
  }

  return chips;
}

const truncate = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Detailed preference chips for the conversation header — everything the
 * client-preferences surface knows about (unit type, budget, bedrooms, area,
 * location incl. excludes + radius rules, direction, amenities, purchase
 * objective, max distance, priority/language settings, notes). Slugs missing
 * from the live model or empty on the record simply produce no chip — nothing
 * here invents fields.
 */
export function buildDetailedClientPrefChips(
  clientData: Record<string, unknown>,
  clientsModel: AppModel | null,
  geoNames: Record<string, string>,
  isAr: boolean,
): ClientPrefDetailChip[] {
  const chips: ClientPrefDetailChip[] = [];

  // ── Unit type(s) — one chip each ──
  const unitField = fieldBySlug(clientsModel, 'preferred_unit_type');
  for (const v of stringList(clientData.preferred_unit_type)) {
    chips.push({ key: `unit:${v}`, kind: 'unit_type', text: optionLabel(unitField, v, isAr) });
  }

  // ── Unit age (عمر العقار) — dropdown of max-age buckets ──
  const ageField = fieldBySlug(clientsModel, 'preferred_max_unit_age');
  const ageV = clientData.preferred_max_unit_age;
  if (typeof ageV === 'string' && ageV.trim() !== '') {
    chips.push({ key: 'unit_age', kind: 'unit_type', text: optionLabel(ageField, ageV, isAr) });
  }

  // ── Budget range ──
  const budget = formatRange(clientData.budget, isAr ? 'ر.س' : 'SAR');
  if (budget) chips.push({ key: 'budget', kind: 'budget', text: budget });

  // ── Bedrooms range ──
  const bedrooms = formatRange(clientData.preferred_bedrooms, isAr ? 'غرف' : 'BR');
  if (bedrooms) chips.push({ key: 'bedrooms', kind: 'bedrooms', text: bedrooms });

  // ── Area range ──
  const area = formatRange(clientData.preferred_area, isAr ? 'م²' : 'm²');
  if (area) chips.push({ key: 'area', kind: 'area', text: area });

  // ── Location: city + every saved location item (includes, excludes, radius rules) ──
  const loc = clientData.location && typeof clientData.location === 'object' && !Array.isArray(clientData.location)
    ? (clientData.location as Record<string, unknown>)
    : {};
  const cityField = fieldBySlug(clientsModel, 'preferred_city');
  const city =
    stringList(loc.city).map((id) => geoNames[id]).find((n): n is string => !!n) ??
    stringList(clientData.preferred_city).map((v) => optionLabel(cityField, v, isAr)).find((n) => !!n) ??
    null;
  if (city) chips.push({ key: 'loc:city', kind: 'location', text: city });

  const seenLoc = new Set<string>();
  for (const item of parseLocationItems(clientData.location_items)) {
    const text = describeLocationItem(item, isAr);
    if (!text || seenLoc.has(text)) continue;
    seenLoc.add(text);
    chips.push({ key: `loc:item:${item.id}`, kind: 'location', text });
  }
  // Legacy cascade district ids + legacy preferred_neighborhoods multiselect.
  for (const id of stringList(loc.district)) {
    const name = geoNames[id];
    if (!name) continue;
    const text = isAr ? `حي ${name}` : name;
    if (seenLoc.has(text)) continue;
    seenLoc.add(text);
    chips.push({ key: `loc:district:${id}`, kind: 'location', text });
  }
  if (seenLoc.size === 0) {
    const nbField = fieldBySlug(clientsModel, 'preferred_neighborhoods');
    for (const v of stringList(clientData.preferred_neighborhoods)) {
      const name = optionLabel(nbField, v, isAr);
      const text = isAr ? `حي ${name}` : name;
      if (seenLoc.has(text)) continue;
      seenLoc.add(text);
      chips.push({ key: `loc:nb:${v}`, kind: 'location', text });
    }
  }

  // ── Max distance (km) ──
  const dist = Number(clientData.max_distance_km);
  if (Number.isFinite(dist) && dist > 0) {
    chips.push({ key: 'distance', kind: 'distance', text: isAr ? `≤ ${dist} كم` : `≤ ${dist} km` });
  }

  // ── Direction / amenities / purchase objective — one joined chip each ──
  const joined: Array<{ slug: string; kind: ClientPrefDetailChip['kind']; prefix: boolean }> = [
    { slug: 'preferred_direction', kind: 'direction', prefix: true },
    { slug: 'preferred_amenities', kind: 'amenities', prefix: false },
    { slug: 'purchase_objective', kind: 'objective', prefix: true },
    { slug: 'location_priority', kind: 'setting', prefix: true },
    { slug: 'preferred_language', kind: 'setting', prefix: true },
  ];
  for (const { slug, kind, prefix } of joined) {
    const field = fieldBySlug(clientsModel, slug);
    const values = stringList(clientData[slug]).map((v) => optionLabel(field, v, isAr));
    if (values.length === 0) continue;
    const body = values.join(' · ');
    const label = field ? (isAr ? field.label_ar : field.label_en) : '';
    const text = prefix && label ? `${label}: ${body}` : body;
    chips.push({ key: slug, kind, text: truncate(text), title: text });
  }

  // ── Free-text preference notes (truncated; full text in the tooltip) ──
  for (const slug of ['preference_notes', 'preferred_location_notes']) {
    const v = clientData[slug];
    if (typeof v !== 'string' || !v.trim()) continue;
    chips.push({ key: slug, kind: 'notes', text: truncate(v.trim(), 80), title: v.trim() });
  }

  return chips;
}

/** Interested client — client_status is one of the "interested" dropdown values. */
const INTERESTED_STATUSES = ['مهتم', 'مهتم جدًا'];
export function isInterestedClient(clientData: Record<string, unknown>): boolean {
  const status = typeof clientData.client_status === 'string' ? clientData.client_status : '';
  return INTERESTED_STATUSES.includes(status);
}

/**
 * The last word in the conversation is the customer's — we haven't replied.
 * `last_message_flow` is stamped by the webhook + the Realtime bump on every
 * new message; chats from before it existed fall back to the unread count.
 */
export function isAwaitingReply(chatData: Record<string, unknown>): boolean {
  if (chatData.last_message_flow === 'in') return true;
  const unread = typeof chatData.unread_count === 'number' ? chatData.unread_count : 0;
  return chatData.last_message_flow !== 'out' && unread > 0;
}

/**
 * Closed conversation — the Done button in the chat header sets 'resolved';
 * 'archived' (set via the status pill or Haberchat) counts as closed too.
 */
export function isClosedChat(chatData: Record<string, unknown>): boolean {
  return chatData.status === 'resolved' || chatData.status === 'archived';
}

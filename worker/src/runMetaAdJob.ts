/**
 * Auto Meta ad — the worker half (generation_jobs kind='meta-ad', 2026-09-10).
 *
 * The marketing manager approved the design of a paid creative. This job:
 *   1. reads the creative's two design slots (square 1:1 for the Instagram /
 *      Facebook feed, vertical 9:16 for stories / reels / WhatsApp status);
 *   2. writes the ad caption with DeepSeek from the PROJECT'S OWN facts (name,
 *      district, unit types, prices, areas, handover, features…) plus the
 *      writer's approved copy — every number in the output must exist in the
 *      facts, else the model is asked once more and then a deterministic
 *      caption built from the same facts is used instead;
 *   3. uploads the designs to the ad account (images by bytes, videos by a
 *      signed URL + processing poll);
 *   4. creates ONE creative with placement asset customization (square →
 *      feed positions, vertical → story/reels/status) and the ad set's
 *      Click-to-WhatsApp welcome message copied from a sibling ad;
 *   5. creates the ad in the target ad set and records platform ids, caption
 *      and state on the mos_execution_ads row; notifies the manager.
 *
 * Failure at any step patches `creative.auto_ad = {state:'failed', error}` on
 * the ad row and notifies `ad_failed` — the Placements tab offers a retry.
 *
 * Hard rules: never hold an HTTP request for this (the API only enqueues);
 * the Meta client here is the WORKER COPY (worker/src/marketing/
 * metaMarketingApi.ts); no number the facts do not contain may reach Meta.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { loadMetaConfig, MetaApiError, MetaMarketingClient, type MetaAdSetDetail } from './marketing/metaMarketingApi.js';

export interface MetaAdJob {
  id: string;
  /** generation_jobs.record_id = mos_content.id */
  recordId: string;
  userId: string;
  params: Record<string, unknown>;
  attempts: number;
}

export interface MetaAdJobResult {
  platform_ad_id: string;
  creative_id: string;
  caption_source: 'deepseek' | 'fallback';
  format: 'image' | 'video';
}

interface Deps {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: MetaAdJob;
  log: (msg: string, extra?: unknown) => void;
}

type Slot = 'square' | 'vertical';

interface SlotMedia {
  slot: Slot;
  assetId: string;
  kind: 'image' | 'video';
  mime: string | null;
  /** A URL Meta (or we) can fetch — public legacy url or a 1h signed url. */
  url: string;
  title: string;
}

interface ContentRow {
  id: string; ref: string | null; title: string; project_id: string | null; project_ids: unknown;
  campaign_id: string | null; approval_asset_id: string | null; data: Record<string, unknown> | null;
  angle: string | null; cta: string | null; audience: string | null; goal: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null));

/* ────────────────────────────────────────────────────────────────────────── */
/* Facts                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

interface ProjectFacts {
  name: string | null;
  district: string | null;
  city: string | null;
  unit_types: string[];
  price_min: number | null;
  price_max: number | null;
  area_min: number | null;
  area_max: number | null;
  bedrooms_min: number | null;
  bedrooms_max: number | null;
  available_units: number | null;
  construction_status: string | null;
  off_plan: boolean;
  handover: string | null;
  payment_plan: string | null;
  features: string[];
  landmarks: string[];
  guarantee_max_years: number | null;
}

interface SchemaField { name: string; type?: string; rollup_kind?: string; options?: Array<{ value?: string; id?: string; label_ar?: string; label_en?: string }> }

function fieldsOf(schema: unknown): SchemaField[] {
  const sections = (schema as { sections?: Array<{ fields?: SchemaField[] }> } | null)?.sections ?? [];
  return sections.flatMap((s) => s.fields ?? []);
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function handoverText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${AR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function optionLabel(field: SchemaField | undefined, value: unknown): string {
  const v = String(value);
  const opt = field?.options?.find((o) => o.value === v || o.id === v);
  return opt?.label_ar || opt?.label_en || v;
}

/** Years in a guarantee cell like «25 سنة» / «سنتان» / «سنة واحدة» / «10 سنوات». */
function yearsOf(text: string): number | null {
  const t = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = /(\d+)/.exec(t);
  if (m) return Number(m[1]);
  if (/سنتان|سنتين/.test(t)) return 2;
  if (/سنة/.test(t)) return 1;
  return null;
}

async function loadProjectFacts(sb: SupabaseClient, projectId: string | null): Promise<ProjectFacts | null> {
  if (!projectId) return null;
  const model = await sb.from('models').select('id, schema').eq('name', 'all_projects').maybeSingle();
  if (model.error) throw new Error(`all_projects model: ${model.error.message}`);
  const modelId = (model.data as { id?: string } | null)?.id;
  const fields = fieldsOf((model.data as { schema?: unknown } | null)?.schema);
  const rec = await sb.from('unified_records').select('data').eq('id', projectId).maybeSingle();
  if (rec.error) throw new Error(`project read: ${rec.error.message}`);
  const pd = ((rec.data as { data?: Record<string, unknown> } | null)?.data ?? null);
  if (!pd) return null;
  void modelId;

  const byKind = (k: string): string | null => fields.find((f) => f.rollup_kind === k)?.name ?? null;
  const range = (slug: string | null): { min: number | null; max: number | null } => {
    const r = slug ? pd[slug] : null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { min: null, max: null };
    const o = r as { min?: unknown; max?: unknown };
    return { min: num(o.min), max: num(o.max) };
  };
  const price = range(byKind('available_price_range') ?? 'available_price_range');
  const area = range(byKind('available_area_range') ?? 'available_area_range');
  const beds = range(byKind('bedroom_range') ?? 'bedroom_range');

  // Geography — the district / city rows carry authoritative Arabic names.
  const loc = (pd.location && typeof pd.location === 'object' && !Array.isArray(pd.location) ? pd.location : {}) as Record<string, unknown>;
  let district: string | null = null;
  let city: string | null = null;
  const districtId = str(loc.district);
  const cityId = str(loc.city);
  if (districtId) {
    const d = await sb.from('unified_records').select('data').eq('id', districtId).maybeSingle();
    const dd = (d.data as { data?: Record<string, unknown> } | null)?.data ?? {};
    district = str(dd.display_name) ? `حي ${String(dd.display_name)}`.replace(/^حي حي /, 'حي ') : str(dd.name_ar);
    city = str(dd.city_name_ar);
  }
  if (!city && cityId) {
    const c = await sb.from('unified_records').select('data').eq('id', cityId).maybeSingle();
    const cd = (c.data as { data?: Record<string, unknown> } | null)?.data ?? {};
    city = str(cd.name_ar) ?? str(cd.display_name);
  }

  const utField = fields.find((f) => f.name === 'unit_types');
  const utRaw = pd.unit_types;
  const utVals = Array.isArray(utRaw) ? utRaw : utRaw != null && utRaw !== '' ? [utRaw] : [];
  const csField = fields.find((f) => f.name === 'construction_status');
  const csRaw = str(pd.construction_status);
  const constructionStatus = csRaw ? optionLabel(csField, csRaw) : null;
  const offPlan = !!csRaw && !/مكتمل|جاهز|complete|ready|تم التسليم/i.test(`${csRaw} ${constructionStatus ?? ''}`);

  const features = (Array.isArray(pd.features) ? pd.features : [])
    .map((r) => str((r as { feature?: unknown })?.feature)).filter((x): x is string => !!x).slice(0, 8);
  const landmarks = (Array.isArray(pd.nearby_landmarks) ? pd.nearby_landmarks : [])
    .map((r) => {
      const o = r as { landmark?: unknown; duration?: unknown };
      const l = str(o.landmark); const d = str(o.duration);
      return l ? (d ? `${l} ${d}` : l) : null;
    }).filter((x): x is string => !!x).slice(0, 4);
  const guaranteeYears = (Array.isArray(pd.guarantees) ? pd.guarantees : [])
    .map((r) => yearsOf(str((r as { col_3?: unknown })?.col_3) ?? '')).filter((y): y is number => y != null);

  return {
    name: str(pd.project_name),
    district,
    city,
    unit_types: utVals.map((v) => optionLabel(utField, v)),
    price_min: price.min, price_max: price.max,
    area_min: area.min, area_max: area.max,
    bedrooms_min: beds.min, bedrooms_max: beds.max,
    available_units: num(pd.available_units),
    construction_status: constructionStatus,
    off_plan: offPlan,
    handover: handoverText(str(pd.handover_date)),
    payment_plan: str(pd.payment_plan_summary)?.split('\n')[0] ?? null,
    features,
    landmarks,
    guarantee_max_years: guaranteeYears.length ? Math.max(...guaranteeYears) : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Caption                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/** Digit runs of a text, Arabic-Indic normalized, thousands separators dropped. */
function numbersIn(text: string): Set<string> {
  const norm = text
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٬٦٧٨٩'.indexOf(d) >= 0 ? '٠١٢٣٤٥٦٧٨٩'.indexOf(d) : d))
    .replace(/(\d)[,٬،](?=\d{3}\b)/g, '$1');
  const out = new Set<string>();
  for (const m of norm.match(/\d+(?:\.\d+)?/g) ?? []) {
    out.add(m);
    if (m.includes('.')) out.add(m.split('.')[0]!);
  }
  return out;
}

const arDigits = (s: string): string => s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!);
const arNum = (n: number): string => arDigits(Math.round(n).toLocaleString('en-US').replace(/,/g, '٬'));
const arPlain = (n: number): string => arDigits(String(Math.round(n)));

function approvedCopy(content: ContentRow): { headline: string | null; lines: string[]; hashtags: string | null } {
  const d = content.data ?? {};
  const headlines = Array.isArray(d.headlines) ? d.headlines.map((h) => str(h)).filter((x): x is string => !!x) : [];
  const headline = str(d.approved_headline) ?? headlines[0] ?? null;
  const caption = str(d.caption);
  const lines = [...headlines, ...(caption ? [caption] : [])];
  return { headline, lines, hashtags: str(d.hashtags) };
}

function fallbackCaption(content: ContentRow, facts: ProjectFacts | null, campaignOffer: string | null): string {
  const copy = approvedCopy(content);
  const out: string[] = [];
  out.push((copy.headline ?? content.title).replace(/^["«]|["»]$/g, ''));
  if (facts?.name) out.push(`${facts.name}${facts.district ? ` — ${facts.district}` : ''}${facts.city ? `، ${facts.city}` : ''}`);
  out.push('');
  const unitLine: string[] = [];
  if (facts?.unit_types.length) unitLine.push(facts.unit_types.join(' • '));
  if (facts?.area_min != null && facts.area_max != null) unitLine.push(`بمساحات من ${arPlain(facts.area_min)} إلى ${arPlain(facts.area_max)} م²`);
  if (facts?.price_min != null) unitLine.push(`وأسعار تبدأ من ${arNum(facts.price_min)} ر.س`);
  if (unitLine.length) out.push(unitLine.join('، '));
  if (facts?.features.length) out.push(facts.features.slice(0, 4).join(' · '));
  if (campaignOffer) out.push(`🎁 ${campaignOffer}`);
  if (facts?.landmarks.length) out.push(`📍 ${facts.landmarks.slice(0, 2).join(' · ')}`);
  if (facts?.available_units != null) out.push(`✅ ${arPlain(facts.available_units)} وحدة متاحة اليوم`);
  if (facts?.off_plan) out.push(`📅 بيع على الخارطة${facts.handover ? `، التسليم المتوقع ${facts.handover}` : ''}${facts.payment_plan ? ' · خطط دفع مرنة' : ''}`);
  if (facts?.guarantee_max_years) out.push(`🛡️ ضمانات تصل إلى ${arPlain(facts.guarantee_max_years)} سنة`);
  out.push('');
  out.push('تواصل معنا على الواتساب الآن');
  out.push('');
  const tags = copy.hashtags ?? [
    '#وصل_العقارية',
    facts?.name ? `#${facts.name.replace(/\s+/g, '_')}` : null,
    facts?.city ? `#عقارات_${facts.city.replace(/\s+/g, '_')}` : null,
  ].filter(Boolean).join(' ');
  out.push(tags);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CAPTION_SYSTEM = `أنت كاتب إعلانات عقارية لشركة «وصل العقارية» في السعودية. تكتب كابشن إعلان ميتا (إنستقرام + واتساب) بالعربية السعودية الواضحة، لعملاء يبحثون عن سكن أو استثمار.

قواعد صارمة:
1. استخدم فقط المعلومات الموجودة في «حقائق المشروع». لا تخترع أي رقم أو سعر أو مساحة أو موقع أو ميزة أو خصم.
2. كل رقم تكتبه يجب أن يكون موجودًا حرفيًا في الحقائق (بالأرقام الغربية أو العربية). إن لم يوجد رقم لشيء، لا تذكره.
3. البنية: سطر افتتاحي جذّاب، ثم اسم المشروع والحي والمدينة، ثم سطر الوحدات (الأنواع، المساحات، السعر يبدأ من)، ثم ٢–٤ ميزات مختصرة، ثم سطر الموقع/المعالم القريبة إن وُجدت، ثم عدد الوحدات المتاحة إن وُجد، ثم (إن كان المشروع على الخارطة) سطر «بيع على الخارطة» مع موعد التسليم المتوقع، ثم الضمانات إن وُجدت، ثم دعوة: «تواصل معنا على الواتساب الآن»، ثم ٤–٦ وسوم.
4. إن كان المشروع على الخارطة يجب ذكر ذلك صراحة.
5. استخدم إيموجي قليلة مناسبة (🏡 📍 ✅ 📅 🛡️) في بداية بعض الأسطر.
6. لا تزيد عن ٨٠٠ حرف. لا عناوين ولا ترويسات ولا تنسيق ماركداون.
7. استلهم النبرة والزاوية من «النص المعتمد» إن وُجد، لكن لا تنسخه حرفيًا إذا كان طويلًا.

أعد الكابشن فقط، بلا أي مقدمة أو تعليق.`;

async function deepseekCaption(env: WorkerEnv, userContent: string, extraRule?: string): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set');
  const base = env.DEEPSEEK_BASE_URL.replace(/\/$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: 'system', content: extraRule ? `${CAPTION_SYSTEM}\n\n${extraRule}` : CAPTION_SYSTEM },
          { role: 'user', content: userContent },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    const text = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('deepseek returned an empty caption');
    if (body.choices?.[0]?.finish_reason === 'length') throw new Error('deepseek caption was cut off (finish_reason=length)');
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function writeCaption(
  env: WorkerEnv, content: ContentRow, facts: ProjectFacts | null, campaign: { name: string | null; offer: string | null },
  log: Deps['log'],
): Promise<{ caption: string; source: 'deepseek' | 'fallback' }> {
  const copy = approvedCopy(content);
  const factsBlock = JSON.stringify({
    project: facts ? {
      name: facts.name, district: facts.district, city: facts.city,
      unit_types: facts.unit_types,
      price_from_sar: facts.price_min, price_to_sar: facts.price_max,
      area_m2_from: facts.area_min, area_m2_to: facts.area_max,
      bedrooms_from: facts.bedrooms_min, bedrooms_to: facts.bedrooms_max,
      available_units: facts.available_units,
      construction_status: facts.construction_status, off_plan: facts.off_plan,
      expected_handover: facts.handover, payment_plan: facts.payment_plan,
      features: facts.features, nearby: facts.landmarks, guarantee_up_to_years: facts.guarantee_max_years,
    } : null,
    campaign: { name: campaign.name, offer: campaign.offer },
    content: { title: content.title, angle: content.angle, audience: content.audience, goal: content.goal, cta: content.cta },
  }, null, 1);
  const copyBlock = copy.lines.length
    ? `\n\nالنص المعتمد من الكاتب (للنبرة والزاوية):\n${copy.lines.join('\n')}${copy.hashtags ? `\nالوسوم: ${copy.hashtags}` : ''}`
    : '';
  const user = `حقائق المشروع (JSON):\n${factsBlock}${copyBlock}\n\nاكتب الكابشن الآن.`;

  // Numbers the model may use: anything in the facts + the approved copy.
  const allowed = numbersIn(`${factsBlock}\n${copy.lines.join('\n')}`);
  const offending = (text: string): string[] => [...numbersIn(text)].filter((n) => !allowed.has(n));

  if (env.DEEPSEEK_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const rule = attempt === 0 ? undefined
          : 'تنبيه: محاولتك السابقة احتوت أرقامًا غير موجودة في الحقائق. أعد الكتابة دون أي رقم غير موجود حرفيًا في الحقائق.';
        const text = await deepseekCaption(env, user, rule);
        const bad = offending(text);
        if (bad.length === 0 && text.length <= 1500) return { caption: text, source: 'deepseek' };
        log(`caption attempt ${attempt + 1} rejected — invented numbers: ${bad.join(', ') || 'none'} length=${text.length}`);
      } catch (e) {
        console.error(`[meta-ad] deepseek caption attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : e);
      }
    }
  } else {
    console.error('[meta-ad] DEEPSEEK_API_KEY unset — using the deterministic caption');
  }
  return { caption: fallbackCaption(content, facts, campaign.offer), source: 'fallback' };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Media                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function resolveSlots(sb: SupabaseClient, content: ContentRow): Promise<SlotMedia[]> {
  const links = await sb.from('mos_asset_links').select('asset_id, role').eq('content_id', content.id);
  if (links.error) throw new Error(`asset links: ${links.error.message}`);
  const rows = (links.data ?? []) as Array<{ asset_id: string; role: string }>;
  const byRole = (r: string): string | null => rows.find((x) => x.role === r)?.asset_id ?? null;
  let square = byRole('final_square');
  let vertical = byRole('final_vertical');
  if (!square && !vertical) {
    // Legacy: one approved file (or the file marked for approval) serves both.
    const one = byRole('final') ?? content.approval_asset_id ?? null;
    square = one; vertical = one;
  }
  const ids = [...new Set([square, vertical].filter((x): x is string => !!x))];
  if (ids.length === 0) throw new Error('no approved design on this creative — upload the square and vertical designs on the Materials tab');

  const assets = await sb.from('mos_assets').select('id, title, kind, mime_type, file_id, url').in('id', ids);
  if (assets.error) throw new Error(`assets: ${assets.error.message}`);
  const byId = new Map((assets.data ?? []).map((a) => [(a as { id: string }).id, a as {
    id: string; title: string; kind: string; mime_type: string | null; file_id: string | null; url: string | null;
  }]));

  const resolveUrl = async (a: { id: string; file_id: string | null; url: string | null }): Promise<string> => {
    if (a.url) return a.url;
    if (!a.file_id) throw new Error(`file bytes missing for design ${a.id}`);
    const fr = await sb.from('files').select('storage_bucket, storage_path').eq('id', a.file_id).maybeSingle();
    if (fr.error) throw new Error(fr.error.message);
    const file = fr.data as { storage_bucket: string; storage_path: string } | null;
    if (!file) throw new Error(`file row missing for design ${a.id}`);
    const signed = await sb.storage.from(file.storage_bucket).createSignedUrl(file.storage_path, 3600);
    if (signed.error || !signed.data?.signedUrl) throw new Error(signed.error?.message ?? 'sign failed');
    return signed.data.signedUrl;
  };

  const out: SlotMedia[] = [];
  for (const [slot, id] of [['square', square], ['vertical', vertical]] as Array<[Slot, string | null]>) {
    if (!id) continue;
    const a = byId.get(id);
    if (!a) throw new Error(`design ${id} not found`);
    const isVideo = a.kind === 'video' || (a.mime_type ?? '').startsWith('video/');
    out.push({ slot, assetId: a.id, kind: isVideo ? 'video' : 'image', mime: a.mime_type, url: await resolveUrl(a), title: a.title });
  }
  return out;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`design download failed (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error('design download was empty');
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error('design image is larger than 30 MB — Meta refuses it');
  return buf;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Placement rules                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

interface PlacementSpec {
  publisher_platforms: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  messenger_positions?: string[];
  whatsapp_positions?: string[];
  audience_network_positions?: string[];
}
type PositionKey = Exclude<keyof PlacementSpec, 'publisher_platforms'>;

const VERTICAL_POSITIONS: Record<string, Set<string>> = {
  facebook: new Set(['story', 'facebook_reels', 'facebook_reels_overlay', 'profile_reels']),
  instagram: new Set(['story', 'reels', 'profile_reels', 'ig_search']),
  messenger: new Set(['story']),
  whatsapp: new Set(['status']),
  audience_network: new Set([]),
};
const DEFAULT_POSITIONS: Record<string, string[]> = {
  facebook: ['feed', 'story', 'facebook_reels'],
  instagram: ['stream', 'explore', 'profile_feed', 'story', 'reels'],
  messenger: ['messenger_home', 'story'],
  whatsapp: ['status'],
  audience_network: ['classic'],
};
const POSITION_KEY: Record<string, PositionKey> = {
  facebook: 'facebook_positions', instagram: 'instagram_positions', messenger: 'messenger_positions',
  whatsapp: 'whatsapp_positions', audience_network: 'audience_network_positions',
};

/** Split the ad set's placements into the vertical (9:16) and square (1:1) buckets. */
function placementSplit(adSet: MetaAdSetDetail): { vertical: PlacementSpec | null; square: PlacementSpec | null } {
  const t = adSet.targeting ?? {};
  const platforms = (t.publisher_platforms && t.publisher_platforms.length > 0)
    ? t.publisher_platforms
    : ['facebook', 'instagram'];
  const vertical: PlacementSpec = { publisher_platforms: [] };
  const square: PlacementSpec = { publisher_platforms: [] };
  for (const p of platforms) {
    const key = POSITION_KEY[p];
    if (!key) continue;
    const explicit = (t as Record<string, unknown>)[key];
    const positions = Array.isArray(explicit) && explicit.length > 0 ? (explicit as string[]) : (DEFAULT_POSITIONS[p] ?? []);
    const v = positions.filter((x) => VERTICAL_POSITIONS[p]?.has(x));
    const s = positions.filter((x) => !VERTICAL_POSITIONS[p]?.has(x));
    if (v.length) { vertical.publisher_platforms.push(p); vertical[key] = v; }
    if (s.length) { square.publisher_platforms.push(p); square[key] = s; }
  }
  return {
    vertical: vertical.publisher_platforms.length ? vertical : null,
    square: square.publisher_platforms.length ? square : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Job                                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

async function readAdStatusSetting(sb: SupabaseClient): Promise<'ACTIVE' | 'PAUSED'> {
  const res = await sb.from('mos_settings').select('value').eq('key', 'meta_auto_ad').maybeSingle();
  if (res.error) console.error('[meta-ad] mos_settings.meta_auto_ad read failed:', res.error.message);
  const v = (res.data as { value?: { status?: unknown } } | null)?.value;
  return v?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
}

async function patchAdRow(sb: SupabaseClient, adRowId: string, patch: Record<string, unknown>, autoAd: Record<string, unknown>): Promise<void> {
  const prev = await sb.from('mos_execution_ads').select('creative').eq('id', adRowId).maybeSingle();
  if (prev.error) throw new Error(`ad row read: ${prev.error.message}`);
  const cr = ((prev.data as { creative?: Record<string, unknown> } | null)?.creative ?? {}) as Record<string, unknown>;
  const prevAuto = (cr.auto_ad && typeof cr.auto_ad === 'object' ? cr.auto_ad : {}) as Record<string, unknown>;
  const upd = await sb.from('mos_execution_ads')
    .update({ ...patch, creative: { ...cr, ...(patch.creative as Record<string, unknown> | undefined ?? {}), auto_ad: { ...prevAuto, ...autoAd } }, updated_at: new Date().toISOString() })
    .eq('id', adRowId);
  if (upd.error) throw new Error(`ad row update: ${upd.error.message}`);
}

async function notify(sb: SupabaseClient, args: {
  event: 'ad_created' | 'ad_failed'; users: string[]; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; url: string;
}): Promise<void> {
  const { error } = await sb.rpc('notify_emit', {
    p_workspace: 'marketing',
    p_event: args.event,
    p_role_keys: ['mos_marketing_manager'],
    p_user_ids: args.users,
    p_title_ar: args.titleAr,
    p_title_en: args.titleEn,
    p_body_ar: args.bodyAr,
    p_body_en: args.bodyEn,
    p_url: args.url,
  });
  if (error) console.error('[meta-ad] notify_emit failed', args.event, error.code, error.message);
}

/** Mark the ad row failed + notify. Called by the lane on ANY thrown error. */
export async function failMetaAdJob(sb: SupabaseClient, job: MetaAdJob, message: string): Promise<void> {
  const adRowId = str(job.params.ad_row_id);
  const approvedBy = str(job.params.approved_by_user_id);
  if (adRowId) {
    try {
      await patchAdRow(sb, adRowId, {}, { state: 'failed', error: message, failed_at: new Date().toISOString() });
    } catch (e) {
      console.error('[meta-ad] could not record the failure on the ad row:', e instanceof Error ? e.message : e);
    }
  }
  await notify(sb, {
    event: 'ad_failed',
    users: approvedBy ? [approvedBy] : [],
    titleAr: 'تعذّر إنشاء الإعلان في ميتا',
    titleEn: 'The Meta ad could not be created',
    bodyAr: message,
    bodyEn: message,
    url: `/m/content/${job.recordId}?tab=placements`,
  });
}

export async function runMetaAdJob({ supabase: sb, env, job, log }: Deps): Promise<MetaAdJobResult> {
  const cfg = loadMetaConfig();
  if (!cfg) throw new Error('Meta credentials are not configured on the worker (META_SYSTEM_USER_TOKEN / META_AD_ACCOUNT_ID)');
  if (!cfg.pageId) throw new Error('META_PAGE_ID is not set — every creative runs from a page');
  const meta = new MetaMarketingClient(cfg);

  const contentId = str(job.params.content_id) ?? job.recordId;
  const adRowId = str(job.params.ad_row_id);
  const adSetId = str(job.params.ad_set_id);
  const platformAdSetId = str(job.params.platform_adset_id);
  const approvedBy = str(job.params.approved_by_user_id);
  if (!adRowId || !adSetId || !platformAdSetId) throw new Error('meta-ad job is missing ad_row_id / ad_set_id / platform_adset_id');

  await patchAdRow(sb, adRowId, {}, { state: 'creating', started_at: new Date().toISOString(), error: null });

  // ── 1. content + campaign ────────────────────────────────────────────────
  const cRes = await sb.from('mos_content')
    .select('id, ref, title, project_id, project_ids, campaign_id, approval_asset_id, data, angle, cta, audience, goal')
    .eq('id', contentId).maybeSingle();
  if (cRes.error) throw new Error(`content read: ${cRes.error.message}`);
  const content = cRes.data as ContentRow | null;
  if (!content) throw new Error('content not found');

  const adRowRes = await sb.from('mos_execution_ads').select('id, execution_id, platform_ad_id').eq('id', adRowId).maybeSingle();
  if (adRowRes.error) throw new Error(`ad row read: ${adRowRes.error.message}`);
  const adRow = adRowRes.data as { id: string; execution_id: string; platform_ad_id: string | null } | null;
  if (!adRow) throw new Error('ad row not found');
  if (adRow.platform_ad_id) throw new Error(`this creative already has Meta ad ${adRow.platform_ad_id}`);

  const execRes = await sb.from('mos_campaign_executions').select('campaign_id, platform_settings')
    .eq('id', adRow.execution_id).maybeSingle();
  if (execRes.error) throw new Error(`execution read: ${execRes.error.message}`);
  const exec = execRes.data as { campaign_id: string; platform_settings: Record<string, unknown> | null } | null;
  const campRes = exec ? await sb.from('mos_campaigns').select('name, offer, destination_url, project_ids, project_id').eq('id', exec.campaign_id).maybeSingle() : null;
  const camp = (campRes?.data ?? null) as { name: string; offer: string | null; destination_url: string | null; project_ids: unknown; project_id: string | null } | null;

  const projectId = str(content.project_id)
    ?? (Array.isArray(content.project_ids) ? str(content.project_ids[0]) : null)
    ?? (Array.isArray(camp?.project_ids) ? str(camp?.project_ids[0]) : null)
    ?? str(camp?.project_id);

  // ── 2. facts + caption ───────────────────────────────────────────────────
  const facts = await loadProjectFacts(sb, projectId);
  if (!facts) log(`no project facts (project=${projectId ?? 'none'}) — caption from the approved copy only`);
  const { caption, source: captionSource } = await writeCaption(env, content, facts, { name: camp?.name ?? null, offer: camp?.offer ?? null }, log);
  log(`caption ready (${captionSource}, ${caption.length} chars)`);

  // ── 3. designs → Meta ────────────────────────────────────────────────────
  const slots = await resolveSlots(sb, content);
  const kinds = new Set(slots.map((s) => s.kind));
  if (kinds.size > 1) throw new Error('the square and vertical designs must be the same type (both images or both videos)');
  const format: 'image' | 'video' = slots[0]!.kind;
  const adName = `${content.ref ?? ''} · ${content.title}`.replace(/^ · /, '').slice(0, 120);

  const imageHashes: Partial<Record<Slot, string>> = {};
  const videoIds: Partial<Record<Slot, { id: string; thumb: string | null }>> = {};
  for (const s of slots) {
    if (s.kind === 'image') {
      const bytes = await fetchBytes(s.url);
      const up = await meta.uploadAdImage(bytes, `${adName} · ${s.slot}`);
      imageHashes[s.slot] = up.hash;
      log(`uploaded ${s.slot} image → ${up.hash}`);
    } else {
      const up = await meta.uploadAdVideo(s.url, `${adName} · ${s.slot}`);
      // Meta transcodes asynchronously; a creative on an unready video fails.
      let status = 'processing';
      let thumb: string | null = null;
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline) {
        const st = await meta.getVideoStatus(up.id);
        status = st.status; thumb = st.picture;
        if (status === 'ready') break;
        if (status === 'error') throw new Error(`Meta could not process the ${s.slot} video`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
      if (status !== 'ready') throw new Error(`the ${s.slot} video was still processing after 6 minutes`);
      videoIds[s.slot] = { id: up.id, thumb };
      log(`uploaded ${s.slot} video → ${up.id}`);
    }
  }

  // ── 4. ad set placements + sibling welcome message ───────────────────────
  const adSet = await meta.getAdSet(platformAdSetId);
  const split = placementSplit(adSet);
  const destination = String(exec?.platform_settings?.destination_type ?? adSet.destination_type ?? 'WHATSAPP').toUpperCase();
  const isWhatsapp = destination === 'WHATSAPP';
  const linkUrl = isWhatsapp ? 'https://api.whatsapp.com/send' : (str(camp?.destination_url) ?? 'https://wassel.re');
  const ctaType = isWhatsapp ? 'WHATSAPP_MESSAGE' : 'LEARN_MORE';
  const headline = isWhatsapp ? 'تواصل معنا على الواتساب' : 'اعرف المزيد';

  let welcome: string | null = null;
  try {
    const siblings = await meta.listAdSetAds(platformAdSetId, 5);
    welcome = siblings
      .map((a) => a.creative?.object_story_spec?.link_data?.page_welcome_message
        ?? a.creative?.asset_feed_spec?.additional_data?.page_welcome_message ?? null)
      .find((w): w is string => typeof w === 'string' && w.length > 0) ?? null;
    log(`welcome message ${welcome ? 'copied from a sibling ad' : 'not found on siblings — ad opens WhatsApp without a template'}`);
  } catch (e) {
    console.error('[meta-ad] sibling read failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  // ── 5. creative ──────────────────────────────────────────────────────────
  const oss: Record<string, unknown> = { page_id: cfg.pageId };
  if (cfg.instagramId) oss.instagram_user_id = cfg.instagramId;
  const cta = isWhatsapp ? { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } : { type: 'LEARN_MORE', value: { link: linkUrl } };

  const bothSlots = slots.length === 2 && split.square && split.vertical;
  const buildPlacementCreative = (): Record<string, unknown> => {
    const rules: Array<Record<string, unknown>> = [];
    const labelKey = format === 'image' ? 'image_label' : 'video_label';
    if (split.square) rules.push({ customization_spec: split.square, [labelKey]: { name: 'square' } });
    if (split.vertical) rules.push({ customization_spec: split.vertical, [labelKey]: { name: 'vertical' } });
    const afs: Record<string, unknown> = {
      bodies: [{ text: caption }],
      titles: [{ text: headline }],
      link_urls: [{ website_url: linkUrl }],
      call_to_action_types: [ctaType],
      ad_formats: [format === 'image' ? 'SINGLE_IMAGE' : 'SINGLE_VIDEO'],
      optimization_type: 'PLACEMENT',
      asset_customization_rules: rules,
    };
    if (format === 'image') {
      afs.images = (['square', 'vertical'] as Slot[]).filter((s) => imageHashes[s]).map((s) => ({ hash: imageHashes[s], adlabels: [{ name: s }] }));
    } else {
      afs.videos = (['square', 'vertical'] as Slot[]).filter((s) => videoIds[s]).map((s) => ({
        video_id: videoIds[s]!.id, ...(videoIds[s]!.thumb ? { thumbnail_url: videoIds[s]!.thumb } : {}), adlabels: [{ name: s }],
      }));
    }
    if (isWhatsapp && welcome) afs.additional_data = { is_click_to_message: true, page_welcome_message: welcome };
    return { name: adName, object_story_spec: oss, asset_feed_spec: afs };
  };
  const buildSingleCreative = (): Record<string, unknown> => {
    // One design for every placement — the shape the buyer's hand-made ads use.
    const pick: Slot = imageHashes.square || videoIds.square ? 'square' : 'vertical';
    if (format === 'image') {
      const link_data: Record<string, unknown> = { link: linkUrl, message: caption, name: headline, image_hash: imageHashes[pick], call_to_action: cta };
      if (isWhatsapp && welcome) link_data.page_welcome_message = welcome;
      return { name: adName, object_story_spec: { ...oss, link_data } };
    }
    const v = videoIds[pick]!;
    const video_data: Record<string, unknown> = { video_id: v.id, message: caption, title: headline, call_to_action: cta };
    if (v.thumb) video_data.image_url = v.thumb;
    if (isWhatsapp && welcome) video_data.page_welcome_message = welcome;
    return { name: adName, object_story_spec: { ...oss, video_data } };
  };

  let creativeId: string;
  let creativeShape: 'placement' | 'single' = bothSlots ? 'placement' : 'single';
  if (bothSlots) {
    try {
      creativeId = (await meta.createAdCreative(buildPlacementCreative())).id;
    } catch (e) {
      // Meta rejected the per-placement shape (a placement we did not cover, a
      // format rule…). Fall back to the single-design creative rather than
      // leaving the manager with nothing — the reason is kept on the row.
      const why = e instanceof MetaApiError ? `${e.message} (code ${e.code}/${e.subcode})` : (e instanceof Error ? e.message : String(e));
      console.error(`[meta-ad] placement creative refused — falling back to a single design: ${why}`);
      creativeShape = 'single';
      creativeId = (await meta.createAdCreative(buildSingleCreative())).id;
      await patchAdRow(sb, adRowId, {}, { placement_fallback: why });
    }
  } else {
    creativeId = (await meta.createAdCreative(buildSingleCreative())).id;
  }
  log(`creative ${creativeId} (${creativeShape})`);

  // ── 6. ad ────────────────────────────────────────────────────────────────
  const adStatus = await readAdStatusSetting(sb);
  const ad = await meta.createAd({ name: adName, adset_id: platformAdSetId, creative: { creative_id: creativeId }, status: adStatus });
  log(`ad ${ad.id} created ${adStatus} in ad set ${platformAdSetId}`);

  // ── 7. record + notify ───────────────────────────────────────────────────
  await patchAdRow(sb, adRowId, {
    platform_ad_id: ad.id,
    label: adName,
    status: adStatus === 'ACTIVE' ? 'running' : 'paused',
    creative: { primary_text: caption, message: caption, headline, cta: ctaType, destination_url: linkUrl },
  }, {
    state: 'created',
    creative_id: creativeId,
    creative_shape: creativeShape,
    format,
    image_hashes: imageHashes,
    video_ids: Object.fromEntries(Object.entries(videoIds).map(([k, v]) => [k, v.id])),
    caption_source: captionSource,
    ad_status: adStatus,
    created_at: new Date().toISOString(),
    error: null,
  });
  await notify(sb, {
    event: 'ad_created',
    users: approvedBy ? [approvedBy] : [],
    titleAr: adStatus === 'ACTIVE' ? 'أُنشئ الإعلان في ميتا وهو يعمل' : 'أُنشئ الإعلان في ميتا (متوقف)',
    titleEn: adStatus === 'ACTIVE' ? 'The Meta ad was created and is running' : 'The Meta ad was created (paused)',
    bodyAr: `«${content.title}» — ${adSet.name}`,
    bodyEn: `“${content.title}” — ${adSet.name}`,
    url: `/m/content/${contentId}?tab=placements`,
  });

  return { platform_ad_id: ad.id, creative_id: creativeId, caption_source: captionSource, format };
}

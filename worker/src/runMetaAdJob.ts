/**
 * Auto Meta ad — the worker half (generation_jobs kind='meta-ad', 2026-09-10;
 * two-phase + house rules 2026-09-13).
 *
 * ONE ad-creation path: both the manager's design approval (auto_meta_ad step)
 * and the buyer's manual «Create in Meta» push enqueue this job. It runs in
 * two phases, each its own queue row:
 *
 *   phase 'caption' — writes the ad caption with DeepSeek from the PROJECT'S
 *      OWN facts (name, district, unit types, prices, areas, handover,
 *      features…) plus the writer's approved copy — every number must exist in
 *      the facts, else one retry then a deterministic caption — and PARKS it on
 *      the mos_execution_ads row (`auto_ad.state='caption_review'`). The
 *      manager reads / edits / approves it on the Placements tab. NOTHING
 *      reaches Meta in this phase.
 *   phase 'create' — after `meta_auto_ad_approve_caption`: reads the APPROVED
 *      caption off the row, uploads the TWO design slots (square 1:1 → the
 *      Instagram feed; vertical 9:16 → stories, reels, WhatsApp status — both
 *      required, never one file for every placement), duplicates an existing
 *      Click-to-WhatsApp welcome template with the project name swapped,
 *      creates ONE creative with per-placement asset rules, every Advantage+
 *      enhancement OFF and multi-advertiser OFF, then the ad in the target ad
 *      set; records platform ids + state on the row; notifies the manager.
 *
 * Failure at any step patches `creative.auto_ad = {state:'failed', error}` on
 * the ad row and notifies `ad_failed` — the Placements tab offers a retry.
 *
 * Hard rules: never hold an HTTP request for this (the API only enqueues);
 * the Meta client here is the WORKER COPY (worker/src/marketing/
 * metaMarketingApi.ts); no number the facts do not contain may reach Meta; no
 * silent fallbacks (one design everywhere / no template / broad audience) —
 * every shortcut a buyer would have to undo by hand is a loud failure instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { loadMetaConfig, MetaApiError, MetaMarketingClient, type MetaAdSetDetail, type MetaSiblingAd } from './marketing/metaMarketingApi.js';

export interface MetaAdJob {
  id: string;
  /** generation_jobs.record_id = mos_content.id */
  recordId: string;
  userId: string;
  params: Record<string, unknown>;
  attempts: number;
}

export type MetaAdPhase = 'caption' | 'create';

export type MetaAdJobResult =
  | { phase: 'caption'; caption_source: 'deepseek' | 'fallback'; caption_chars: number }
  | { phase: 'create'; platform_ad_id: string; creative_id: string; caption_source: 'deepseek' | 'fallback'; format: 'image' | 'video' };

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
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    // Arabic decimal separator → '.', then thousands separators between digits dropped.
    .replace(/(\d)٫(?=\d)/g, '$1.')
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
8. اكتب كل الأرقام بأسلوب واحد: الأرقام العربية الهندية (٠١٢٣٤٥٦٧٨٩) مع الفاصلة العليا للآلاف (٥٧٦٬٢١٦) — لا تخلط بين النمطين.
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
  const square = byRole('final_square');
  const vertical = byRole('final_vertical');
  // BOTH slots are required (operator rule 2026-09-13). The old "one file
  // serves every placement" fallback put a 9:16 design in the Instagram feed
  // and is exactly what the buyer had to undo by hand — so a missing slot is a
  // loud failure, not a guess.
  if (!square || !vertical) {
    const missing = [!square ? 'square 1:1 (feed)' : null, !vertical ? 'vertical 9:16 (stories / reels / status)' : null].filter(Boolean).join(' and ');
    throw new Error(`the ${missing} design is missing — upload BOTH design slots on the Materials tab, then retry`);
  }
  const ids = [...new Set([square, vertical])];

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
  instagram_positions?: string[];
  whatsapp_positions?: string[];
}
type PositionKey = Exclude<keyof PlacementSpec, 'publisher_platforms'>;

/**
 * HOUSE RULE (operator, 2026-09-13): a Wassel ad runs on Instagram + WhatsApp
 * ONLY. The ad set decides delivery, but the creative's per-placement rules
 * cover exactly these two — a Facebook / Messenger / Audience Network /
 * Threads placement on the ad set is NOT covered and Meta refuses the
 * creative loudly, which is the intended signal to fix the ad set.
 */
const ALLOWED_PLATFORMS = new Set(['instagram', 'whatsapp']);
const VERTICAL_POSITIONS: Record<string, Set<string>> = {
  instagram: new Set(['story', 'reels', 'profile_reels', 'ig_search']),
  whatsapp: new Set(['status']),
};
const DEFAULT_POSITIONS: Record<string, string[]> = {
  instagram: ['stream', 'story', 'reels', 'profile_feed'],
  whatsapp: ['status'],
};
const POSITION_KEY: Record<string, PositionKey> = {
  instagram: 'instagram_positions', whatsapp: 'whatsapp_positions',
};

/** Split the ad set's placements into the vertical (9:16) and square (1:1)
 *  buckets. Square = Instagram feed/explore/profile feed; vertical = stories,
 *  reels and WhatsApp status. Returns the platforms the ad set carries that the
 *  house rule does NOT cover, so the caller can say so. */
function placementSplit(adSet: MetaAdSetDetail): { vertical: PlacementSpec | null; square: PlacementSpec | null; uncovered: string[] } {
  const t = adSet.targeting ?? {};
  const platforms = (t.publisher_platforms && t.publisher_platforms.length > 0)
    ? t.publisher_platforms
    : ['instagram', 'whatsapp'];
  const vertical: PlacementSpec = { publisher_platforms: [] };
  const square: PlacementSpec = { publisher_platforms: [] };
  const uncovered: string[] = [];
  for (const p of platforms) {
    if (!ALLOWED_PLATFORMS.has(p)) { uncovered.push(p); continue; }
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
    uncovered,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Creative enhancements — ALL OFF                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every Advantage+ creative enhancement Meta knows (music, overlays, visual
 * touch-ups, text improvements, animation, …) is switched OFF on every
 * creative we make, and the ad is opted OUT of multi-advertiser units.
 * Operator rule 2026-09-13. The key list is the one Meta itself returned on
 * the buyer's hand-corrected ad 120253385933010020 (83 keys, all OPT_OUT);
 * verified writable + read back with zero OPT_IN keys on 2026-09-13.
 */
const ENHANCEMENT_KEYS = [
  // NOT `standard_enhancements` — Meta rejects the umbrella key on create
  // (100/3858504 "Creative should not include standard enhancements …
  // deprecated, set individual features instead", measured 2026-09-13).
  'adapt_to_placement', 'add_text_overlay', 'ads_with_benefits', 'advantage_plus_creative', 'app_highlights',
  'audio', 'auto_promotion_tag', 'biz_ai', 'carousel_to_video', 'catalog_feed_tag', 'creative_stickers',
  'customize_product_recommendation', 'cv_transformation', 'description_automation', 'dha_optimization',
  'dynamic_cta_text', 'dynamic_partner_content', 'enable_ncs_testimonials', 'enhance_cta', 'fb_feed_tag',
  'fb_reels_tag', 'fb_story_tag', 'feed_caption_optimization', 'generate_cta', 'hide_price',
  'hyperlink_formatting', 'ig_feed_tag', 'ig_glados_feed', 'ig_reels_tag', 'ig_stream_tag',
  'ig_video_native_subtitle', 'image_animation', 'image_auto_crop', 'image_background_gen', 'image_banner',
  'image_brightness_and_contrast', 'image_end_card', 'image_enhancement', 'image_templates',
  'image_text_translation', 'image_touchups', 'image_uncrop', 'inline_comment', 'local_store_extension',
  'media_liquidity_animated_image', 'media_order', 'media_type_automation', 'multi_creative_post_carousel',
  'multi_photo_to_video', 'music_generation', 'pac_genai_recomposition', 'pac_recomposition', 'pac_relaxation',
  'product_browsing', 'product_extensions', 'product_metadata_automation', 'product_tags', 'profile_card',
  'profile_extension', 'replace_media_text', 'reveal_details_over_time', 'show_destination_blurbs',
  'show_summary', 'site_extensions', 'standard_enhancements_catalog', 'text_extraction_for_headline',
  'text_extraction_for_tap_target', 'text_formatting_optimization', 'text_generation', 'text_optimizations',
  'text_overlay_translation', 'text_translation', 'translate_voiceover', 'video_auto_crop', 'video_filtering',
  'video_highlight', 'video_highlights', 'video_to_image', 'video_uncrop', 'video_uncrop_9x16_to_9x18',
  'video_voiceover', 'wa_mm_image_filtering', 'wa_mm_text_truncation_length',
] as const;

export function noEnhancementsSpec(): Record<string, unknown> {
  const features: Record<string, { enroll_status: 'OPT_OUT' }> = {};
  for (const k of ENHANCEMENT_KEYS) features[k] = { enroll_status: 'OPT_OUT' };
  return { creative_features_spec: features };
}
export const NO_MULTI_ADVERTISER = { enroll_status: 'OPT_OUT' } as const;

/* ────────────────────────────────────────────────────────────────────────── */
/* WhatsApp welcome template                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const PROJECT_ICEBREAKER = /مهتم بمشروع\s+(.+?)\s*$/u;

function deepReplace(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return v.includes(from) ? v.split(from).join(to) : v;
  if (Array.isArray(v)) return v.map((x) => deepReplace(x, from, to));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepReplace(x, from, to);
    return out;
  }
  return v;
}

/**
 * Operator rule 2026-09-13: the Click-to-WhatsApp welcome template is always a
 * DUPLICATE of an existing project's template with the project name swapped
 * for this campaign's project. The source project is read off the template's
 * own «مهتم بمشروع <name>» ice-breaker; every occurrence of that name in the
 * template (greeting, ice-breaker titles, canned replies) becomes the target.
 * Returns the template unchanged (and says why) when the swap is impossible.
 */
export function retargetWelcomeTemplate(
  template: string, targetProject: string | null, log: (m: string) => void,
): string {
  if (!targetProject) { log('welcome template used verbatim — this campaign has no project name to swap in'); return template; }
  let parsed: unknown;
  try { parsed = JSON.parse(template); } catch (e) {
    // Meta returns the template as a JSON string; a non-JSON value is unknown
    // territory — keep it verbatim rather than corrupt it.
    console.error('[meta-ad] welcome template is not JSON — used verbatim:', e instanceof Error ? e.message : e);
    return template;
  }
  const titles: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.title === 'string') titles.push(o.title);
      Object.values(o).forEach(walk);
    }
  };
  walk(parsed);
  const source = titles.map((t) => PROJECT_ICEBREAKER.exec(t)?.[1]?.trim() ?? null).find((x): x is string => !!x) ?? null;
  if (!source) { log('welcome template has no «مهتم بمشروع …» line — used verbatim'); return template; }
  if (source === targetProject) { log(`welcome template already names «${targetProject}»`); return template; }
  log(`welcome template duplicated from «${source}» → «${targetProject}»`);
  return JSON.stringify(deepReplace(parsed, source, targetProject));
}

const welcomeOf = (a: MetaSiblingAd): string | null => {
  const c = a.creative;
  return c?.object_story_spec?.link_data?.page_welcome_message
    ?? c?.object_story_spec?.video_data?.page_welcome_message
    ?? c?.asset_feed_spec?.additional_data?.page_welcome_message
    ?? null;
};

/** The template to duplicate: a sibling in the same ad set first, else the
 *  newest Click-to-WhatsApp ad anywhere in the account. Throws when the account
 *  has none — an ad that opens WhatsApp with no template is not what the
 *  buyer wants, and silently shipping one hid exactly that. */
async function findWelcomeTemplate(meta: MetaMarketingClient, platformAdSetId: string, log: (m: string) => void): Promise<string> {
  const siblings = await meta.listAdSetAds(platformAdSetId, 10);
  const fromSibling = siblings.map(welcomeOf).find((w): w is string => typeof w === 'string' && w.length > 0);
  if (fromSibling) { log('welcome template source: a sibling ad in the same ad set'); return fromSibling; }
  const recent = await meta.listAccountAds(60);
  const fromAccount = recent.map(welcomeOf).find((w): w is string => typeof w === 'string' && w.length > 0);
  if (fromAccount) { log('welcome template source: the newest Click-to-WhatsApp ad in the account'); return fromAccount; }
  throw new Error('no WhatsApp welcome template found on any ad in the account — create one ad by hand in Ads Manager first, the automation duplicates it');
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
  event: 'ad_created' | 'ad_failed' | 'ad_caption_ready'; users: string[]; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; url: string;
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

/**
 * The caption task in «مهامي» (2026-09-13). A parked caption is a TASK for
 * the approver — it appears in their task list like every other task and
 * opens the review popup. One open task per ad row (a rewrite refreshes it);
 * the approval (API) or the ad's creation (below) closes it.
 */
async function openCaptionTask(sb: SupabaseClient, args: {
  adRowId: string; contentId: string; campaignId: string | null; projectId: string | null;
  assigneeUserId: string | null; title: string; adSetName: string | null;
}): Promise<void> {
  if (!args.assigneeUserId) {
    console.error('[meta-ad] caption task NOT opened — no approver user id on the job (the notification still went out)');
    return;
  }
  const now = new Date().toISOString();
  const title = `اعتماد كابشن إعلان ميتا: ${args.title}`.slice(0, 200);
  const details = args.adSetName ? `المجموعة الإعلانية: ${args.adSetName}` : null;
  const open = await sb.from('mos_manual_tasks').select('id')
    .eq('kind', 'caption_review').eq('ref_id', args.adRowId).eq('status', 'open').maybeSingle();
  if (open.error) { console.error('[meta-ad] caption task read failed:', open.error.message); return; }
  if (open.data) {
    const upd = await sb.from('mos_manual_tasks').update({ title, details, updated_at: now }).eq('id', (open.data as { id: string }).id);
    if (upd.error) console.error('[meta-ad] caption task refresh failed:', upd.error.message);
    return;
  }
  const ins = await sb.from('mos_manual_tasks').insert({
    kind: 'caption_review',
    ref_id: args.adRowId,
    title,
    details,
    assignee_user_id: args.assigneeUserId,
    created_by_user_id: args.assigneeUserId,
    content_id: args.contentId,
    campaign_id: args.campaignId,
    project_id: args.projectId,
    status: 'open',
    due_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
  });
  if (ins.error) console.error('[meta-ad] caption task insert failed:', ins.error.message);
}

async function closeCaptionTask(sb: SupabaseClient, adRowId: string, note: string): Promise<void> {
  const now = new Date().toISOString();
  const upd = await sb.from('mos_manual_tasks')
    .update({ status: 'done', done_note: note, closed_at: now, updated_at: now })
    .eq('kind', 'caption_review').eq('ref_id', adRowId).eq('status', 'open');
  if (upd.error) console.error('[meta-ad] caption task close failed:', upd.error.message);
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
  const phase: MetaAdPhase = job.params.phase === 'create' ? 'create' : 'caption';
  if (!adRowId || !adSetId || !platformAdSetId) throw new Error('meta-ad job is missing ad_row_id / ad_set_id / platform_adset_id');

  await patchAdRow(sb, adRowId, {}, { state: 'creating', phase, started_at: new Date().toISOString(), error: null });

  // ── 1. content + campaign ────────────────────────────────────────────────
  const cRes = await sb.from('mos_content')
    .select('id, ref, title, project_id, project_ids, campaign_id, approval_asset_id, data, angle, cta, audience, goal')
    .eq('id', contentId).maybeSingle();
  if (cRes.error) throw new Error(`content read: ${cRes.error.message}`);
  const content = cRes.data as ContentRow | null;
  if (!content) throw new Error('content not found');

  const adRowRes = await sb.from('mos_execution_ads').select('id, execution_id, platform_ad_id, creative').eq('id', adRowId).maybeSingle();
  if (adRowRes.error) throw new Error(`ad row read: ${adRowRes.error.message}`);
  const adRow = adRowRes.data as { id: string; execution_id: string; platform_ad_id: string | null; creative: Record<string, unknown> | null } | null;
  if (!adRow) throw new Error('ad row not found');
  if (adRow.platform_ad_id) throw new Error(`this creative already has Meta ad ${adRow.platform_ad_id}`);

  const execRes = await sb.from('mos_campaign_executions').select('campaign_id, platform_settings')
    .eq('id', adRow.execution_id).maybeSingle();
  if (execRes.error) throw new Error(`execution read: ${execRes.error.message}`);
  const exec = execRes.data as { campaign_id: string; platform_settings: Record<string, unknown> | null } | null;
  const campRes = exec ? await sb.from('mos_campaigns').select('name, offer, destination_url, project_ids, project_id').eq('id', exec.campaign_id).maybeSingle() : null;
  const camp = (campRes?.data ?? null) as { name: string; offer: string | null; destination_url: string | null; project_ids: unknown; project_id: string | null } | null;

  // The CAMPAIGN's project first — the ad belongs to the campaign, and the
  // welcome template is retargeted to the campaign's project.
  const projectId = (Array.isArray(camp?.project_ids) ? str(camp?.project_ids[0]) : null)
    ?? str(camp?.project_id)
    ?? str(content.project_id)
    ?? (Array.isArray(content.project_ids) ? str(content.project_ids[0]) : null);

  // ── 2. facts ─────────────────────────────────────────────────────────────
  const facts = await loadProjectFacts(sb, projectId);
  if (!facts) log(`no project facts (project=${projectId ?? 'none'}) — caption from the approved copy only`);

  /* ════════════ PHASE 1 — caption for the manager's approval ═══════════ */
  if (phase === 'caption') {
    const { caption, source: captionSource } = await writeCaption(env, content, facts, { name: camp?.name ?? null, offer: camp?.offer ?? null }, log);
    log(`caption ready (${captionSource}, ${caption.length} chars) — parked for approval`);
    await patchAdRow(sb, adRowId, {
      status: 'waiting',
      creative: { primary_text: caption, message: caption },
    }, {
      state: 'caption_review',
      phase: 'caption',
      caption_source: captionSource,
      caption_ready_at: new Date().toISOString(),
      error: null,
    });
    await openCaptionTask(sb, {
      adRowId, contentId, campaignId: exec?.campaign_id ?? null, projectId, assigneeUserId: approvedBy,
      title: content.title, adSetName: str(job.params.ad_set_name),
    });
    await notify(sb, {
      event: 'ad_caption_ready',
      users: approvedBy ? [approvedBy] : [],
      titleAr: 'كابشن الإعلان جاهز لاعتمادك',
      titleEn: 'The ad caption is ready for your approval',
      bodyAr: `«${content.title}» — راجع الكابشن واعتمده ليُنشأ الإعلان في ميتا.`,
      bodyEn: `“${content.title}” — review the caption and approve it to create the Meta ad.`,
      url: `/m/content/${contentId}?tab=placements`,
    });
    return { phase: 'caption', caption_source: captionSource, caption_chars: caption.length };
  }

  /* ════════════ PHASE 2 — build the ad with the APPROVED caption ═══════ */
  const cr = adRow.creative ?? {};
  const caption = str(cr.primary_text) ?? str(cr.message);
  if (!caption) throw new Error('no approved caption on the ad row — approve the caption on the Placements tab first');
  const captionSource: 'deepseek' | 'fallback' = ((cr.auto_ad as { caption_source?: unknown } | undefined)?.caption_source === 'fallback') ? 'fallback' : 'deepseek';

  // ── 3. designs → Meta (BOTH slots required) ──────────────────────────────
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
      const up = await meta.uploadImageBytes(bytes, `${adName} · ${s.slot}`);
      imageHashes[s.slot] = up.hash;
      log(`uploaded ${s.slot} image → ${up.hash}`);
    } else {
      const up = await meta.uploadVideoByUrl(s.url, `${adName} · ${s.slot}`);
      // Meta transcodes asynchronously; a creative on an unready video fails.
      let status = 'processing';
      let thumb: string | null = null;
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline) {
        const st = await meta.getVideoStatus(up.id);
        status = st.status ?? 'processing'; thumb = st.thumbnailUrl;
        if (st.ready) break;
        if (status === 'error') throw new Error(`Meta could not process the ${s.slot} video`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
      if (status !== 'ready') throw new Error(`the ${s.slot} video was still processing after 6 minutes`);
      videoIds[s.slot] = { id: up.id, thumb };
      log(`uploaded ${s.slot} video → ${up.id}`);
    }
  }

  // ── 4. ad set placements + welcome template ──────────────────────────────
  const adSet = await meta.getAdSet(platformAdSetId);
  const split = placementSplit(adSet);
  if (split.uncovered.length > 0) {
    throw new Error(`the Meta ad set «${adSet.name}» delivers on ${split.uncovered.join(', ')} — Wassel ads run on Instagram + WhatsApp only; remove those placements from the ad set in Ads Manager`);
  }
  if (!split.square || !split.vertical) {
    throw new Error(`the Meta ad set «${adSet.name}» has no ${!split.square ? 'feed' : 'story/reels/status'} placement — it needs both (Instagram feed + stories/reels, WhatsApp status)`);
  }
  const destination = String(exec?.platform_settings?.destination_type ?? adSet.destination_type ?? 'WHATSAPP').toUpperCase();
  const isWhatsapp = destination === 'WHATSAPP';
  const linkUrl = isWhatsapp ? 'https://api.whatsapp.com/send' : (str(camp?.destination_url) ?? 'https://wassel.re');
  const ctaType = isWhatsapp ? 'WHATSAPP_MESSAGE' : 'LEARN_MORE';
  const headline = isWhatsapp ? 'تواصل معنا على الواتساب' : 'اعرف المزيد';

  let welcome: string | null = null;
  if (isWhatsapp) {
    const template = await findWelcomeTemplate(meta, platformAdSetId, log);
    welcome = retargetWelcomeTemplate(template, facts?.name ?? null, log);
  }

  // ── 5. creative — one per ad, square → feed, vertical → stories/reels/status
  const oss: Record<string, unknown> = { page_id: cfg.pageId };
  if (cfg.instagramId) oss.instagram_user_id = cfg.instagramId;
  const labelKey = format === 'image' ? 'image_label' : 'video_label';
  const afs: Record<string, unknown> = {
    bodies: [{ text: caption }],
    titles: [{ text: headline }],
    link_urls: [{ website_url: linkUrl }],
    call_to_action_types: [ctaType],
    ad_formats: [format === 'image' ? 'SINGLE_IMAGE' : 'SINGLE_VIDEO'],
    optimization_type: 'PLACEMENT',
    asset_customization_rules: [
      { customization_spec: split.square, [labelKey]: { name: 'square' } },
      { customization_spec: split.vertical, [labelKey]: { name: 'vertical' } },
    ],
  };
  if (format === 'image') {
    afs.images = (['square', 'vertical'] as Slot[]).map((s) => ({ hash: imageHashes[s], adlabels: [{ name: s }] }));
  } else {
    afs.videos = (['square', 'vertical'] as Slot[]).map((s) => ({
      video_id: videoIds[s]!.id, ...(videoIds[s]!.thumb ? { thumbnail_url: videoIds[s]!.thumb } : {}), adlabels: [{ name: s }],
    }));
  }
  if (isWhatsapp && welcome) afs.additional_data = { is_click_to_message: true, page_welcome_message: welcome };

  let creativeId: string;
  try {
    creativeId = (await meta.createAdCreative({
      name: adName,
      object_story_spec: oss,
      asset_feed_spec: afs,
      degrees_of_freedom_spec: noEnhancementsSpec(),
      contextual_multi_ads: NO_MULTI_ADVERTISER,
    })).id;
  } catch (e) {
    // No silent "one design everywhere" fallback (that was the 2026-09-13
    // complaint) — the rejection reaches the manager as the failure reason.
    const userMsg = e instanceof MetaApiError
      ? (((e.raw as { error?: { error_user_title?: string; error_user_msg?: string } } | null)?.error?.error_user_msg)
        ?? (e.raw as { error?: { error_user_title?: string } } | null)?.error?.error_user_title ?? null)
      : null;
    const why = e instanceof MetaApiError
      ? `${userMsg ?? e.message} (code ${e.code}/${e.subcode})`
      : (e instanceof Error ? e.message : String(e));
    throw new Error(`Meta refused the per-placement creative: ${why}`);
  }
  log(`creative ${creativeId} (placement: square→feed, vertical→stories/reels/status; enhancements off; multi-advertiser off)`);

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
    phase: 'create',
    creative_id: creativeId,
    creative_shape: 'placement',
    format,
    image_hashes: imageHashes,
    video_ids: Object.fromEntries(Object.entries(videoIds).map(([k, v]) => [k, v.id])),
    caption_source: captionSource,
    welcome_template: welcome ? 'duplicated' : null,
    ad_status: adStatus,
    created_at: new Date().toISOString(),
    error: null,
  });
  await closeCaptionTask(sb, adRowId, `ad created on Meta (${ad.id})`);
  await notify(sb, {
    event: 'ad_created',
    users: approvedBy ? [approvedBy] : [],
    titleAr: adStatus === 'ACTIVE' ? 'أُنشئ الإعلان في ميتا وهو يعمل' : 'أُنشئ الإعلان في ميتا (متوقف)',
    titleEn: adStatus === 'ACTIVE' ? 'The Meta ad was created and is running' : 'The Meta ad was created (paused)',
    bodyAr: `«${content.title}» — ${adSet.name}`,
    bodyEn: `“${content.title}” — ${adSet.name}`,
    url: `/m/content/${contentId}?tab=placements`,
  });

  return { phase: 'create', platform_ad_id: ad.id, creative_id: creativeId, caption_source: captionSource, format };
}

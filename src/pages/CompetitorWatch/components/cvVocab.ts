/**
 * Visual library — controlled vocabulary + small formatters.
 *
 * The facet keys/values MUST stay identical to §6 of
 * docs/marketing-script-visual-contracts.md (worker `cv/vocab.ts` + Modal
 * `labels.py`). Tags are stored as `<facet>:<value>` strings on
 * mkt_cv_shots.tags / mkt_cv_frames.labels; the labels here are display-only.
 */

export interface FacetValue { v: string; ar: string; en: string }
export interface FacetDef { key: string; ar: string; en: string; values: FacetValue[] }

export const CV_FACETS: FacetDef[] = [
  {
    key: 'shot_size', ar: 'حجم اللقطة', en: 'Shot size',
    values: [
      { v: 'wide', ar: 'واسعة', en: 'Wide' },
      { v: 'medium', ar: 'متوسطة', en: 'Medium' },
      { v: 'close', ar: 'قريبة', en: 'Close' },
      { v: 'extreme_close', ar: 'قريبة جدًا', en: 'Extreme close' },
      { v: 'aerial', ar: 'جوية', en: 'Aerial' },
    ],
  },
  {
    key: 'setting', ar: 'المكان', en: 'Setting',
    values: [
      { v: 'exterior_facade', ar: 'واجهة خارجية', en: 'Exterior facade' },
      { v: 'interior_living', ar: 'صالة داخلية', en: 'Living room' },
      { v: 'kitchen', ar: 'مطبخ', en: 'Kitchen' },
      { v: 'bedroom', ar: 'غرفة نوم', en: 'Bedroom' },
      { v: 'bathroom', ar: 'دورة مياه', en: 'Bathroom' },
      { v: 'amenity_pool', ar: 'مسبح', en: 'Pool' },
      { v: 'gym', ar: 'نادي رياضي', en: 'Gym' },
      { v: 'lobby', ar: 'بهو', en: 'Lobby' },
      { v: 'street', ar: 'شارع', en: 'Street' },
      { v: 'map', ar: 'خريطة', en: 'Map' },
      { v: 'studio', ar: 'استوديو', en: 'Studio' },
      { v: 'render', ar: 'تصميم ثلاثي', en: 'Render' },
      { v: 'office', ar: 'مكتب', en: 'Office' },
    ],
  },
  {
    key: 'subject', ar: 'الموضوع', en: 'Subject',
    values: [
      { v: 'building', ar: 'مبنى', en: 'Building' },
      { v: 'unit', ar: 'وحدة', en: 'Unit' },
      { v: 'person', ar: 'شخص', en: 'Person' },
      { v: 'presenter', ar: 'مقدّم', en: 'Presenter' },
      { v: 'family', ar: 'عائلة', en: 'Family' },
      { v: 'vehicle', ar: 'مركبة', en: 'Vehicle' },
      { v: 'text_card', ar: 'بطاقة نص', en: 'Text card' },
      { v: 'logo', ar: 'شعار', en: 'Logo' },
      { v: 'map', ar: 'خريطة', en: 'Map' },
      { v: 'plan', ar: 'مخطط', en: 'Plan' },
    ],
  },
  {
    key: 'graphic', ar: 'الجرافيك', en: 'Graphic',
    values: [
      { v: 'none', ar: 'بدون', en: 'None' },
      { v: 'text_overlay', ar: 'نص فوق الصورة', en: 'Text overlay' },
      { v: 'animated_map', ar: 'خريطة متحركة', en: 'Animated map' },
      { v: '3d_render', ar: 'تصميم ثلاثي', en: '3D render' },
      { v: 'motion_graphic', ar: 'موشن جرافيك', en: 'Motion graphic' },
      { v: 'split_screen', ar: 'شاشة مقسومة', en: 'Split screen' },
      { v: 'slideshow', ar: 'عرض شرائح', en: 'Slideshow' },
    ],
  },
  {
    key: 'motion', ar: 'الحركة', en: 'Motion',
    values: [
      { v: 'static', ar: 'ثابتة', en: 'Static' },
      { v: 'pan', ar: 'أفقية', en: 'Pan' },
      { v: 'tilt', ar: 'رأسية', en: 'Tilt' },
      { v: 'dolly', ar: 'دوللي', en: 'Dolly' },
      { v: 'drone', ar: 'درون', en: 'Drone' },
      { v: 'handheld', ar: 'يدوية', en: 'Handheld' },
      { v: 'zoom', ar: 'زوم', en: 'Zoom' },
    ],
  },
  {
    key: 'light', ar: 'الإضاءة', en: 'Light',
    values: [
      { v: 'day', ar: 'نهار', en: 'Day' },
      { v: 'golden', ar: 'الساعة الذهبية', en: 'Golden hour' },
      { v: 'night', ar: 'ليل', en: 'Night' },
      { v: 'studio', ar: 'استوديو', en: 'Studio' },
    ],
  },
  {
    key: 'purpose', ar: 'الغرض', en: 'Purpose',
    values: [
      { v: 'hook', ar: 'خطّاف', en: 'Hook' },
      { v: 'location', ar: 'الموقع', en: 'Location' },
      { v: 'product', ar: 'المنتج', en: 'Product' },
      { v: 'feature', ar: 'ميزة', en: 'Feature' },
      { v: 'proof', ar: 'إثبات', en: 'Proof' },
      { v: 'offer', ar: 'عرض', en: 'Offer' },
      { v: 'cta', ar: 'دعوة لإجراء', en: 'CTA' },
      { v: 'brand', ar: 'هوية', en: 'Brand' },
    ],
  },
  {
    key: 'reproducibility', ar: 'قابلية التنفيذ', en: 'Reproducibility',
    values: [
      { v: 'easy', ar: 'سهل', en: 'Easy' },
      { v: 'moderate', ar: 'متوسط', en: 'Moderate' },
      { v: 'hard', ar: 'صعب', en: 'Hard' },
    ],
  },
];

const FACET_MAP = new Map(CV_FACETS.map((f) => [f.key, f]));

export function facetLabel(key: string, isAr: boolean): string {
  const f = FACET_MAP.get(key);
  return f ? (isAr ? f.ar : f.en) : key;
}

/** `"shot_size:wide"` → «واسعة» / "Wide". Unknown tags fall back to the raw value. */
export function tagLabel(tag: string, isAr: boolean): string {
  const idx = tag.indexOf(':');
  if (idx < 0) return tag;
  const key = tag.slice(0, idx);
  const val = tag.slice(idx + 1);
  const f = FACET_MAP.get(key);
  const fv = f?.values.find((x) => x.v === val);
  return fv ? (isAr ? fv.ar : fv.en) : val.replace(/_/g, ' ');
}

/** `"shot_size:wide"` → «حجم اللقطة: واسعة» (facet + value, for tooltips). */
export function tagTitle(tag: string, isAr: boolean): string {
  const idx = tag.indexOf(':');
  if (idx < 0) return tag;
  return `${facetLabel(tag.slice(0, idx), isAr)}: ${tagLabel(tag, isAr)}`;
}

export const CV_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'snapchat'];

export const DURATION_BUCKETS: Array<{ key: string; ar: string; en: string; min: number | null; max: number | null }> = [
  { key: 'lt2', ar: 'أقل من ثانيتين', en: '< 2s', min: null, max: 2000 },
  { key: '2to5', ar: '٢–٥ ثوانٍ', en: '2–5s', min: 2000, max: 5000 },
  { key: '5to15', ar: '٥–١٥ ثانية', en: '5–15s', min: 5000, max: 15000 },
  { key: 'gt15', ar: 'أطول من ١٥ ثانية', en: '> 15s', min: 15000, max: null },
];

export const REFERENCE_BADGE = { ar: 'مرجع منافس — للاطلاع فقط', en: 'Competitor reference — view only' };

/** 3200 → "3.2s"; 65000 → "1:05". */
export function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 65432 → "01:05.432" — the copy-timestamp format. */
export function fmtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const m = Math.floor(safe / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const r = safe % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

export function fmtDate(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The URL that opens the source video at the shot's exact start (§0). */
export function sourceAtUrl(sourceUrl: string | null | undefined, startMs: number): string | null {
  if (!sourceUrl) return null;
  const sec = Math.max(0, startMs / 1000);
  const base = sourceUrl.split('#')[0] ?? sourceUrl;
  return `${base}#t=${sec.toFixed(2)}`;
}

export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'info' | 'mute' {
  switch (status) {
    case 'analyzed': return 'ok';
    case 'frames_done': case 'analyzing': case 'processing': return 'info';
    case 'partial': case 'queued': return 'warn';
    case 'failed': return 'bad';
    default: return 'mute';
  }
}

export function statusLabel(status: string, isAr: boolean): string {
  const M: Record<string, [string, string]> = {
    queued: ['في الانتظار', 'Queued'],
    processing: ['يُعالج', 'Processing'],
    frames_done: ['الإطارات جاهزة', 'Frames done'],
    analyzing: ['يُحلَّل', 'Analyzing'],
    analyzed: ['مُحلَّل', 'Analyzed'],
    failed: ['فشل', 'Failed'],
    partial: ['جزئي', 'Partial'],
    pending: ['بانتظار التحليل', 'Pending'],
    done: ['مُحلَّل', 'Done'],
    running: ['يعمل', 'Running'],
    completed: ['مكتمل', 'Completed'],
  };
  const m = M[status];
  return m ? (isAr ? m[0] : m[1]) : status;
}

/** Stringify an unknown analysis value for display (arrays joined, objects skipped). */
export function asText(v: unknown, joiner = '، '): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => asText(x, joiner)).filter((x): x is string => Boolean(x));
    return parts.length ? parts.join(joiner) : null;
  }
  return null;
}

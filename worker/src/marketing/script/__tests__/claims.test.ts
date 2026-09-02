import { describe, expect, it, vi } from 'vitest';
import { classifyMention, extractMentions, gateByClass, verifyClaims, type GateInput } from '../claims.js';
import type { CallRole, Fact, MentionClass } from '../types.js';

const RULES = { forbidden_claim_classes: ['return', 'financing', 'yield'] };

/** Labelled corpus: text → expected class of (at least) one mention, plus optional value. */
const CORPUS: Array<[string, MentionClass, number?]> = [
  // prices
  ['تبدأ من ٦٧٤٬٤٩٧ ر.س', 'price', 674497],
  ['بسعر 850,000 ريال', 'price', 850000],
  ['٦٧٤ ألف ريال', 'price', 674000],
  ['1.2 مليون ريال', 'price', 1200000],
  ['السعر يبدأ من ٩٥٠٬٠٠٠', 'price', 950000],
  ['٧٥٠ ألف', 'price', 750000],
  ['خصم ١٠٪ لفترة محدودة', 'price', 10],
  ['٢٬٥٠٠٬٠٠٠ ر.س', 'price', 2500000],
  ['من ٩٩٠ ألف إلى ١٫٢ مليون', 'price', 990000],
  ['عشرة آلاف ريال', 'price', 10000],
  // areas
  ['مساحات من ١٢٠ م²', 'area', 120],
  ['مساحة ٣٠٠ متر مربع', 'area', 300],
  ['١٢٠ – ١٥٠ م²', 'area', 120],
  ['٢٥٠م٢', 'area', 250],
  ['المساحة ٤٠٠', 'area', 400],
  // unit counts / availability
  ['٥٠ وحدة سكنية', 'unit_count', 50],
  ['مشروع من ١٢٠ شقة', 'unit_count', 120],
  ['ست شقق', 'unit_count', 6],
  ['باقي ٣ فلل بس', 'availability', 3],
  ['آخر ٥ وحدات', 'availability', 5],
  ['متبقي ١٢ شقة', 'availability', 12],
  ['ثلاث وحدات متبقية', 'availability', 3],
  // dates
  ['التسليم ٢٠٢٦', 'date', 2026],
  ['تسليم خلال ١٨ شهر', 'date', 18],
  ['تستلم خلال ٦ أشهر', 'date', 6],
  ['2027', 'date', 2027],
  ['١٤٤٨هـ', 'date', 1448],
  // distance / duration
  ['٥ دقائق من الطريق الدائري', 'duration', 5],
  ['عشر دقائق', 'duration', 10],
  ['خمس دقائق', 'duration', 5],
  ['٢٠ دقيقة للمطار', 'duration', 20],
  ['على بعد ٣ كم من المطار', 'distance', 3],
  ['٥٠٠ متر من المسجد', 'distance', 500],
  // guarantee
  ['ضمان ١٠ سنوات هيكل', 'guarantee', 10],
  ['ضمان ٢٥ سنة على الهيكل', 'guarantee', 25],
  // payment
  ['دفعة أولى ٥٪', 'payment', 5],
  ['١٠٪ مقدم', 'payment', 10],
  ['تقسيط على ٣٦ شهر', 'payment', 36],
  ['٥٠٪ عند التسليم', 'payment', 50],
  // forbidden
  ['عائد ٨٪ سنوياً', 'return', 8],
  ['تمويل ٩٠٪', 'financing', 90],
  ['قسط شهري ٤٬٥٠٠ ريال', 'financing', 4500],
  ['فائدة ٤٪', 'financing', 4],
  // rhetorical enumeration
  ['ثلاث مزايا تخليك تختار', 'rhetorical_enumeration', 3],
  ['خمس أسباب', 'rhetorical_enumeration', 5],
  ['أربع خطوات', 'rhetorical_enumeration', 4],
  ['سبع نقاط', 'rhetorical_enumeration', 7],
  ['٣ أسباب تخليك تحجز', 'rhetorical_enumeration', 3],
  ['أول ميزة', 'rhetorical_enumeration'],
  ['ثاني سبب', 'rhetorical_enumeration'],
  ['كن أول من يحجز', 'rhetorical_enumeration'],
  ['الطابق الثالث', 'rhetorical_enumeration'],
  // scene numbering
  ['مشهد ٣', 'scene_numbering', 3],
  ['المشهد ٢', 'scene_numbering', 2],
  ['لقطة ٤', 'scene_numbering', 4],
  // rooms → other (descriptive)
  ['٤ غرف نوم', 'other', 4],
  ['ثلاث غرف', 'other', 3],
  ['٥ غرف وصالتين', 'other', 5],
  // ambiguous residue
  ['رقم ٧', 'other', 7],
  ['١٠٠٪ خصوصية', 'other', 100],
  ['٤٥ ثانية', 'other', 45],
];

describe('extractMentions + classifyMention (labelled corpus)', () => {
  it(`has ≥ 60 labelled mentions (${CORPUS.length})`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
  });
  for (const [text, cls, value] of CORPUS) {
    it(`«${text}» → ${cls}${value !== undefined ? ` (${value})` : ''}`, () => {
      const ms = extractMentions(text).map(classifyMention);
      expect(ms.length).toBeGreaterThan(0);
      const hit = ms.find((m) => m.class === cls && (value === undefined || m.value === value));
      expect(hit, JSON.stringify(ms)).toBeTruthy();
    });
  }
  it('ambiguous residue is marked confident=false', () => {
    for (const t of ['رقم ٧', '١٠٠٪ خصوصية', '٤٥ ثانية']) {
      const m = extractMentions(t).map(classifyMention)[0]!;
      expect(m.confident).toBe(false);
    }
  });
  it('phone numbers are NOT mentions (entity gate owns them)', () => {
    expect(extractMentions('اتصل 0501234567 أو 920016028')).toHaveLength(0);
  });
  it('parses a range', () => {
    const m = extractMentions('١٢٠ – ١٥٠ م²')[0]!;
    expect(m.value).toBe(120);
    expect(m.value2).toBe(150);
    expect(m.unit).toBe('m2');
  });
  it('unifies separators ٬ , and decimal ٫', () => {
    expect(extractMentions('٦٧٤٬٤٩٧')[0]!.value).toBe(674497);
    expect(extractMentions('674,497')[0]!.value).toBe(674497);
    expect(extractMentions('١٫٥ مليون')[0]!.value).toBe(1500000);
  });
});

const FACTS: Fact[] = [
  { id: 'F1', key: 'project_name', class: 'name', value: 'أكنان ٢٥', rendered_ar: 'أكنان ٢٥', source_field: 'project_name', verified_at: null, claimable: true },
  { id: 'F2', key: 'price_from', class: 'price', value: 674497, rendered_ar: 'تبدأ من 674,497 ر.س', source_field: 'available_price_range.min', verified_at: null, claimable: true },
  { id: 'F3', key: 'area_range', class: 'area', value: { min: 120, max: 150 }, rendered_ar: 'من 120 إلى 150 م²', source_field: 'available_area_range', verified_at: null, claimable: true },
  { id: 'F4', key: 'available_units', class: 'availability', value: 12, rendered_ar: '12 وحدة متاحة', source_field: 'available_units', verified_at: null, claimable: true },
  { id: 'F5', key: 'handover_date', class: 'date', value: '2026-09-01', rendered_ar: 'التسليم 2026-09', source_field: 'handover_date', verified_at: null, claimable: true },
  { id: 'F6', key: 'duration:المطار', class: 'duration', value: 5, rendered_ar: '5 دقائق إلى المطار', source_field: 'nearby_landmarks.duration', verified_at: null, claimable: true },
  { id: 'F7', key: 'guarantee:هيكل', class: 'guarantee', value: 'هيكل — 10 سنوات', rendered_ar: 'ضمان: هيكل — 10 سنوات', source_field: 'guarantees', verified_at: null, claimable: false, note: 'needs_labeling' },
  { id: 'F8', key: 'bedrooms', class: 'other', value: { min: 3, max: 4 }, rendered_ar: 'من 3 إلى 4 غرف نوم', source_field: 'bedroom_range', verified_at: null, claimable: true },
];

function gate(text: string): ReturnType<typeof gateByClass>[number] {
  const items: GateInput[] = extractMentions(text).map((m) => ({ scene: 1, field: 'voiceover', mention: classifyMention(m) }));
  return gateByClass(items, FACTS, RULES)[0]!;
}

describe('gateByClass', () => {
  it('exact price passes with the fact id', () => {
    const v = gate('تبدأ من ٦٧٤٬٤٩٧ ر.س');
    expect(v.verdict).toBe('pass');
    expect(v.fact_id).toBe('F2');
  });
  it('rounded price with ألف passes (approximate tolerance)', () => {
    expect(gate('٦٧٤ ألف ريال').verdict).toBe('pass');
  });
  it('a different price FAILS', () => {
    expect(gate('٧٠٠ ألف ريال').verdict).toBe('fail');
  });
  it('area bound passes, unknown area fails, in-range range passes', () => {
    expect(gate('١٢٠ م²').verdict).toBe('pass');
    expect(gate('٢٠٠ م²').verdict).toBe('fail');
    expect(gate('١٢٠ – ١٥٠ م²').verdict).toBe('pass');
  });
  it('availability must equal the stored count', () => {
    expect(gate('باقي ١٢ شقة').verdict).toBe('pass');
    expect(gate('باقي ٣ فلل').verdict).toBe('fail');
  });
  it('handover year passes, other year fails', () => {
    expect(gate('التسليم ٢٠٢٦').verdict).toBe('pass');
    expect(gate('التسليم ٢٠٢٧').verdict).toBe('fail');
  });
  it('duration → pass when matched, review otherwise', () => {
    expect(gate('٥ دقائق للمطار').verdict).toBe('pass');
    expect(gate('١٠ دقائق للمطار').verdict).toBe('review');
  });
  it('rhetorical enumeration and scene numbering pass', () => {
    expect(gate('ثلاث مزايا').verdict).toBe('pass');
    expect(gate('مشهد ٣').verdict).toBe('pass');
  });
  it('forbidden classes always fail', () => {
    expect(gate('عائد ٨٪').verdict).toBe('fail');
    expect(gate('تمويل ٩٠٪').verdict).toBe('fail');
  });
  it('guarantee numbers fail because guarantee facts are not claimable numbers', () => {
    const v = gate('ضمان ١٠ سنوات');
    expect(v.verdict).toBe('fail');
    expect(v.reason).toMatch(/not claimable/);
  });
  it('room counts pass when a bedrooms fact carries them, else review', () => {
    expect(gate('٤ غرف نوم').verdict).toBe('pass');
    expect(gate('٧ غرف نوم').verdict).toBe('review');
  });
  it('ambiguous residue stays review without a classifier', () => {
    expect(gate('رقم ٧').verdict).toBe('review');
  });
});

describe('verifyClaims — batched classifier', () => {
  it('sends the residue in ONE call and gates the answer', async () => {
    const callRole = vi.fn(async (_role: string, input: { user: string }) => {
      const req = JSON.parse(input.user) as { items: Array<{ id: number }> };
      return {
        output: { items: req.items.map((it) => ({ id: it.id, class: 'scene_numbering' })) },
        usage: { in: 10, out: 5 }, cost_usd: 0.0001, provider: 'anthropic', model: 'x', version: null, latency_ms: 1,
      };
    });
    const scenes = [
      { order: 1, voiceover: 'رقم ٧ في القائمة', on_screen_text: '١٠٠٪ خصوصية' },
      { order: 2, voiceover: 'تبدأ من ٦٧٤٬٤٩٧ ر.س', on_screen_text: '' },
    ];
    const r = await verifyClaims(scenes, FACTS, RULES, callRole as unknown as CallRole);
    expect(callRole).toHaveBeenCalledTimes(1);
    expect(r.verdicts.filter((v) => v.verdict === 'pass')).toHaveLength(3);
    expect(r.cost_usd).toBe(0.0001);
  });
  it('makes no call when nothing is ambiguous', async () => {
    const callRole = vi.fn();
    const r = await verifyClaims([{ order: 1, voiceover: 'تبدأ من ٦٧٤٬٤٩٧ ر.س', on_screen_text: '' }], FACTS, RULES, callRole as unknown as CallRole);
    expect(callRole).not.toHaveBeenCalled();
    expect(r.verdicts[0]!.verdict).toBe('pass');
  });
});

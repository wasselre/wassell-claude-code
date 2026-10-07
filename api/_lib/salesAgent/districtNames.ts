/**
 * Plain district names in the customer's own words → Riyadh district ids.
 *
 * The geography reader (geoGate.ts) handles the hard cases — road sides, a
 * district on one side of a road, distances. It failed on the EASY case: a
 * customer who just wrote «المصيف», «الصفا و الفاروق» or «الملقاء» got «area →
 * not understood» and a clarifying question (review 2026-10-07, three chats),
 * because its lookup folds no trailing hamza and caps candidates. This is the
 * fallback geoGate uses ONLY when the reader understood nothing usable: an
 * exact whole-word match of a district's own name, after the same folds reps'
 * spelling needs. It never widens what the reader did understand.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Fold a name or a message: hamza/ya/ta-marbuta, tatweel, diacritics, «حي », a trailing hamza after alef. */
export function foldPlace(s: string): string {
  return String(s ?? '')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/اء(?=$|[^؀-ۿ])/g, 'ا')
    .replace(/(^|\s)حي\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Named { key: string; ids: string[]; label: string }

const CACHE_MS = 60 * 60_000;
let cache: { at: number; city: string; value: Promise<Named[]> } | null = null;

/** City districts as match keys. «أم الحمام الشرقي/الغربي» also answer to «أم الحمام». */
async function loadNames(svc: SupabaseClient, cityId: string): Promise<Named[]> {
  if (cache && cache.city === cityId && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = (async () => {
    const { data, error } = await svc.from('districts').select('id, name_ar, display_name').eq('city_id', cityId).limit(2000);
    if (error) throw new Error(`district names read failed: ${error.message}`);
    const byKey = new Map<string, Named>();
    const add = (key: string, id: string, label: string) => {
      if (key.length < 3) return;
      const cur = byKey.get(key) ?? { key, ids: [], label };
      if (!cur.ids.includes(id)) cur.ids.push(id);
      byKey.set(key, cur);
    };
    for (const r of (data ?? []) as Array<{ id: string; name_ar: string | null; display_name: string | null }>) {
      const label = (r.display_name ?? r.name_ar ?? '').trim();
      for (const n of [r.name_ar, r.display_name]) {
        if (!n) continue;
        const k = foldPlace(n);
        add(k, r.id, label);
        const base = k.replace(/\s+(الشرقي|الغربي|الشمالي|الجنوبي)$/, '');
        if (base !== k) add(base, r.id, base);
      }
    }
    // Longest first, so «ام الحمام الشرقي» wins over «ام الحمام».
    return [...byKey.values()].sort((a, b) => b.key.length - a.key.length);
  })();
  cache = { at: Date.now(), city: cityId, value };
  value.catch(() => { cache = null; });
  return value;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** PURE — which of `names` the text names as a whole word (with «و/ب/في» glued on). */
export function matchDistrictNames(text: string, names: Named[]): Array<{ id: string; label: string }> {
  // Greetings that contain a district's name (حي السلام, حي النور) are not places.
  let t = ` ${foldPlace(text).replace(/(وعليكم\s+)?السلام\s+عليكم|وعليكم\s+السلام|(صباح|مساء|مسا)\s+النور/g, ' ')} `;
  const out: Array<{ id: string; label: string }> = [];
  for (const n of names) {
    const re = new RegExp(`(^|[\\s،,.؟?!/(-])(?:و|ب|وب|ف|في )?${esc(n.key)}(?=$|[\\s،,.؟?!/)-])`);
    if (!re.test(t)) continue;
    for (const id of n.ids) if (!out.some((o) => o.id === id)) out.push({ id, label: n.label });
    // Consume it so a shorter name inside it («الملقا» in «شمال الملقا») is not matched twice.
    t = t.replace(re, '$1 ');
  }
  return out;
}

/** The customer's own recent messages → districts named in them (Riyadh by default). */
export async function districtsInText(svc: SupabaseClient, texts: string[], cityId = '3'): Promise<Array<{ id: string; label: string }>> {
  const text = texts.filter(Boolean).join(' \n ');
  if (!text.trim()) return [];
  return matchDistrictNames(text, await loadNames(svc, cityId));
}

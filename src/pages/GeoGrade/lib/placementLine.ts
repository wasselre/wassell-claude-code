import type { DistrictInfo, Placement, VerifierVerdict } from './shared';
import { toArabicDigits } from '@/pages/Marketing/lib/format';

/**
 * "What did the AI put on the map for this mention?" — one bilingual line.
 *
 * Shared by the conversation grader (`ConversationGrader.tsx`) and the chat's
 * location card (`src/pages/Chats/components/GeoPrefCard.tsx`) so a rep and a
 * grader read the same sentence for the same placement. The server-side twin
 * the verifier reads is `placementSentence` in
 * `api/_lib/geoPreference/placementText.ts` — keep the two in step (sides,
 * distances, the side-clip wording and when a clip saves nothing). PURE — no IO.
 */

export type PlacementTone = 'ok' | 'none' | 'warn';

const SIDE_AR: Record<string, string> = { north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب' };
const SIDE_EN: Record<string, string> = { north: 'North of', south: 'South of', east: 'East of', west: 'West of' };
/** «الجزء الشمالي من طريق …» — the part of a district on one side of a road. */
const SIDE_PART_AR: Record<string, string> = { north: 'الشمالي', south: 'الجنوبي', east: 'الشرقي', west: 'الغربي' };

const count = (n: number, isAr: boolean): string => (isAr ? toArabicDigits(String(n)) : String(n));

/** Metres → km for display: one decimal under 10 km, whole km from 10 up; Arabic digits and «٫» in Arabic. */
export function kmLabel(m: number, isAr: boolean): string {
  const v = m / 1000;
  let s: string;
  if (v >= 10) s = String(Math.round(v));
  else {
    const r = Math.round(v * 10) / 10;
    s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  return isAr ? toArabicDigits(s).replace('.', '٫') : s;
}

/** « · ٥ كم» / « · 5 km», or '' when no distance is known. */
function kmSuffix(m: number | undefined, isAr: boolean): string {
  if (typeof m !== 'number' || !Number.isFinite(m)) return '';
  return isAr ? ` · ${kmLabel(m, true)} كم` : ` · ${kmLabel(m, false)} km`;
}

/**
 * The side of a road side (directional_band). The SERVER decides it
 * (`bandSide` in api/_lib/geoPreference/placementText.ts — the recipe's side,
 * else a legacy band's leading direction word) and ships it as `side`; review.ts
 * saves by the same function. The card never re-guesses it from the label: a
 * second copy of that reading drifted (it had no English branch) and showed a
 * side the save did not use.
 */
function bandSideOf(p: Placement): string | null {
  return p.side && SIDE_AR[p.side] ? p.side : null;
}

/** «الجزء الشمالي من طريق الملك سلمان» / «the part north of King Salman Road». */
function sidePart(side: string, road: string, isAr: boolean): string {
  if (isAr) return SIDE_PART_AR[side] ? `الجزء ${SIDE_PART_AR[side]} من ${road}` : `${side} ${road}`;
  return `the part ${side} of ${road}`;
}

/**
 * What a side clip's computed shape holds — the server's `clip_state`, else
 * derived the same way from the parts (every part dropped → 'empty'; no parts
 * at all → never computed, 'missing').
 */
export function sideClipStateOf(p: Placement): 'ok' | 'empty' | 'missing' {
  if (p.clip_state) return p.clip_state;
  const parts = p.clip_parts ?? null;
  if (parts && parts.length > 0 && !parts.some((c) => c.kept)) return 'empty';
  return parts ? 'ok' : 'missing';
}

/**
 * Can this placement be saved to the client? An unresolved mention never; a
 * side clip only when part of the district lies on that side — review.ts saves
 * nothing for the others, so the card must not offer them.
 */
export function placementSavable(p: Placement): boolean {
  if (!p.resolved) return false;
  if (p.operation === 'district_side_clip') return sideClipStateOf(p) === 'ok';
  // A road side with no side (a legacy diagonal band) saves nothing either.
  if (p.operation === 'directional_band') return bandSideOf(p) !== null;
  return true;
}

/**
 * @param p      the mention's placement (undefined = nothing on the map)
 * @param role   the mention's preference_role ('none'/'exploratory' = not a preference)
 * @param names  district / road / landmark names keyed by id
 */
export function placementLine(
  p: Placement | undefined,
  role: string,
  names: Record<string, DistrictInfo>,
  isAr: boolean,
): { text: string; tone: PlacementTone } {
  if (!p) {
    return role === 'none' || role === 'exploratory'
      ? { text: isAr ? 'ليس تفضيلًا — لا شيء على الخريطة' : 'not a preference — nothing on the map', tone: 'none' }
      : { text: isAr ? 'لم يُوضع على الخريطة' : 'not placed on the map', tone: 'warn' };
  }
  const sep = isAr ? '، ' : ', ';
  const plainName = (id: string): string => {
    const d = names[id];
    return d ? (isAr ? d.name_ar : (d.name_en || d.name_ar)) : id;
  };
  const labels = p.element_ids.map((id) => {
    const d = names[id];
    return d ? `${isAr ? d.name_ar : (d.name_en || d.name_ar)}${d.city ? ` (${d.city})` : ''}` : id;
  });
  if (!p.resolved) return { text: isAr ? `لم يُحدَّد حي حقيقي لـ «${labels.join('، ')}» — يحتاج تأكيدًا` : `no real district picked for “${labels.join(', ')}” — needs confirmation`, tone: 'warn' };
  const verb = p.polarity === 'exclude' ? (isAr ? 'استبعد' : 'excluded') : (isAr ? 'حدّد' : 'selected');
  // A zone (or any big district list) is summarised, not listed — 30+ names is noise.
  if (p.operation === 'zone_union' || (p.operation === 'district_union' && p.element_ids.length > 6)) {
    const n = p.element_ids.length;
    return { text: isAr ? `${verb}: ${p.label || 'منطقة'} — ${n} حيًا` : `${verb}: ${p.label || 'zone'} — ${n} districts`, tone: 'ok' };
  }
  if (p.operation === 'district_side_clip' && p.side) {
    const roadName = plainName(p.element_ids[p.element_ids.length - 1]!);
    const side = sidePart(p.side, roadName, isAr);
    const districts = (p.clip_parts ?? []).length
      ? (p.clip_parts ?? []).map((c) => c.name).join(sep)
      : p.element_ids.slice(0, -1).map(plainName).join(sep);
    const state = sideClipStateOf(p);
    if (state === 'empty') {
      return { text: isAr ? `لا يقع جزء من الحي على هذا الجانب: ${districts} — ${side}` : `no part of the district lies on this side: ${districts} — ${side}`, tone: 'warn' };
    }
    if (state === 'missing') {
      return { text: isAr ? `تعذّر حساب الجزء: ${districts} — ${side}` : `the part could not be computed: ${districts} — ${side}`, tone: 'warn' };
    }
    const parts = (p.clip_parts ?? []).map((c) => c.kept
      ? `${c.name}${c.crossed && c.kept_km2 != null && c.total_km2 != null ? (isAr ? ` (${c.kept_km2} من ${c.total_km2} كم²)` : ` (${c.kept_km2} of ${c.total_km2} km²)`) : ''}`
      : `${c.name} ${isAr ? '(كله على الجهة الأخرى — أُسقط)' : '(entirely on the other side — dropped)'}`);
    return { text: `${verb}: ${parts.length ? parts.join(sep) : districts} — ${side}`, tone: 'ok' };
  }
  if (p.operation === 'directional_band') {
    const side = bandSideOf(p);
    const roads = p.element_ids.map(plainName).join(sep);
    if (side) {
      return { text: `${verb}: ${isAr ? SIDE_AR[side] : SIDE_EN[side]} ${roads}${kmSuffix(p.radius_m, isAr)}`, tone: 'ok' };
    }
    return {
      text: isAr ? `تعذّر تحديد جهة الطريق: ${roads} — لن يُحفظ` : `the side of the road is unknown: ${roads} — will not be saved`,
      tone: 'warn',
    };
  }
  if (p.operation === 'within_radius' || p.operation === 'within_distance') {
    return { text: `${verb}: ${isAr ? 'قرب' : 'Near'} ${p.element_ids.map(plainName).join(sep)}${kmSuffix(p.radius_m, isAr)}`, tone: 'ok' };
  }
  return { text: `${verb}: ${labels.join(sep)}`, tone: 'ok' };
}

/**
 * The PLACE of a placement as a short title for a tile — «الربوة»,
 * «جنوب الرياض · ٢٠ حيًا», «غرب طريق الملك فهد · ٥ كم», «قرب الرياض بارك · ٣ كم»,
 * «النرجس — الجزء الشمالي من طريق الملك سلمان», or the bare name of an
 * unresolved mention. Built from the placement data (never by parsing the
 * {@link placementLine} sentence), so the two can't drift apart silently:
 * the tile shows this title, and the full sentence rides in its tooltip.
 * PURE.
 */
export function placementTitle(
  p: Placement,
  names: Record<string, DistrictInfo>,
  isAr: boolean,
): string {
  const sep = isAr ? '، ' : ', ';
  const nameOf = (id: string): string => {
    const d = names[id];
    return d ? (isAr ? d.name_ar : (d.name_en || d.name_ar)) : id;
  };
  const summarize = (labels: string[]): string => (labels.length <= 3
    ? labels.join(sep)
    : `${labels.slice(0, 2).join(sep)} +${count(labels.length - 2, isAr)}`);
  // Unresolved: element_ids are the bare names the customer used, not ids.
  if (!p.resolved) return p.element_ids.join(sep) || p.label;
  const n = p.element_ids.length;
  if (p.operation === 'zone_union' || (p.operation === 'district_union' && n > 6)) {
    const zone = p.label || (isAr ? 'منطقة' : 'zone');
    return isAr ? `${zone} · ${count(n, true)} حيًا` : `${zone} · ${n} districts`;
  }
  if (p.operation === 'district_side_clip' && p.side && n > 0) {
    const part = sidePart(p.side, nameOf(p.element_ids[n - 1]!), isAr);
    const districts = summarize(p.element_ids.slice(0, -1).map(nameOf));
    return districts ? `${districts} — ${part}` : part;
  }
  if (p.operation === 'directional_band') {
    const side = bandSideOf(p);
    if (side) return `${isAr ? SIDE_AR[side] : SIDE_EN[side]} ${summarize(p.element_ids.map(nameOf))}${kmSuffix(p.radius_m, isAr)}`;
    return summarize(p.element_ids.map(nameOf));
  }
  if (p.operation === 'within_radius' || p.operation === 'within_distance') {
    return `${isAr ? 'قرب' : 'Near'} ${summarize(p.element_ids.map(nameOf))}${kmSuffix(p.radius_m, isAr)}`;
  }
  return summarize(p.element_ids.map(nameOf));
}

/** Short label for a verifier verdict other than 'right'. */
const VERIFIER_VERDICT_AR: Record<Exclude<VerifierVerdict, 'right'>, string> = {
  wrong_place: 'مكان خاطئ', not_a_preference: 'ليس تفضيلًا', not_a_place: 'ليس مكانًا', wrong_polarity: 'الاتجاه معكوس', unsure: 'غير متأكد',
};
const VERIFIER_VERDICT_EN: Record<Exclude<VerifierVerdict, 'right'>, string> = {
  wrong_place: 'wrong place', not_a_preference: 'not a preference', not_a_place: 'not a place', wrong_polarity: 'polarity flipped', unsure: 'unsure',
};

/** The advisory verifier's per-mention line: agreement, or its doubt + reason. */
export function verifierMentionLine(
  v: { verdict: VerifierVerdict; reason: string },
  isAr: boolean,
): { text: string; tone: 'ok' | 'warn' } {
  if (v.verdict === 'right') return { text: isAr ? '✓ المراجع يوافق' : '✓ reviewer agrees', tone: 'ok' };
  const kind = isAr ? VERIFIER_VERDICT_AR[v.verdict] : VERIFIER_VERDICT_EN[v.verdict];
  return { text: `${isAr ? `⚠ المراجع يشكّ (${kind})` : `⚠ reviewer doubts (${kind})`}${v.reason ? `: ${v.reason}` : ''}`, tone: 'warn' };
}

/** The verifier's overall badge for a whole conversation's map. */
export function verifierOverallLabel(overall: 'agree' | 'doubt' | 'unknown', isAr: boolean): string {
  return overall === 'agree'
    ? (isAr ? '✓ المراجع يوافق' : '✓ reviewer agrees')
    : overall === 'doubt'
      ? (isAr ? '⚠ المراجع يشكّ' : '⚠ reviewer doubts')
      : (isAr ? 'المراجع لم يعمل' : 'reviewer did not run');
}

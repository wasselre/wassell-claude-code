import type { DistrictInfo, Placement, VerifierVerdict } from './shared';

/**
 * "What did the AI put on the map for this mention?" — one bilingual line.
 *
 * Shared by the conversation grader (`ConversationGrader.tsx`) and the chat's
 * location card (`src/pages/Chats/components/GeoPrefCard.tsx`) so a rep and a
 * grader read the same sentence for the same placement. The server-side twin
 * the verifier reads is `placementSentence` in
 * `api/_lib/geoPreference/placementText.ts`. PURE — no IO.
 */

export type PlacementTone = 'ok' | 'none' | 'warn';

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
    const SIDE_AR: Record<string, string> = { north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب' };
    const roadId = p.element_ids[p.element_ids.length - 1]!;
    const road = names[roadId];
    const roadName = road ? (isAr ? road.name_ar : (road.name_en || road.name_ar)) : roadId;
    const parts = (p.clip_parts ?? []).map((c) => c.kept
      ? `${c.name}${c.crossed && c.kept_km2 != null && c.total_km2 != null ? (isAr ? ` (${c.kept_km2} من ${c.total_km2} كم²)` : ` (${c.kept_km2} of ${c.total_km2} km²)`) : ''}`
      : `${c.name} ${isAr ? '(كله على الجهة الأخرى — أُسقط)' : '(entirely on the other side — dropped)'}`);
    const sideTxt = isAr ? `${SIDE_AR[p.side] ?? p.side} ${roadName}` : `${p.side} of ${roadName}`;
    return { text: `${verb}: ${parts.length ? parts.join(isAr ? '، ' : ', ') : labels.join(', ')} — ${sideTxt}`, tone: 'ok' };
  }
  return { text: `${verb}: ${labels.join(isAr ? '، ' : ', ')}`, tone: 'ok' };
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

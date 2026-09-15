import { describe, it, expect } from 'vitest';
import { savedMessageMatchesCurrentFacts } from '../projectMessage/factsMatch';
import type { ProjectMessageFacts } from '../projectMessage/compose';
import { resolveProjectDelivery } from '../projectMessage/delivery';

// Facts for الماجدية 163, mirroring the live record used in the 7-minute
// incident (available price 559,000; area 90.07–180.22; beds 1–3; baths 2–3).
function majdiyaFacts(overrides: Partial<ProjectMessageFacts> = {}): ProjectMessageFacts {
  return {
    ourProjectId: 'op',
    allProjectId: 'ap',
    name: 'الماجدية 163',
    city: { ar: 'الرياض', en: 'Riyadh' },
    district: { ar: 'الفاروق', en: 'Al-Farouq' },
    unitTypes: [{ ar: 'شقة', en: 'Apartment' }],
    bedrooms: { min: 1, max: 3 },
    bathrooms: { min: 2, max: 3 },
    areaRange: { min: 90.07, max: 180.22 },
    minPrice: { ar: '559,000 ر.س', en: 'SAR 559,000' },
    delivery: resolveProjectDelivery({ project_status: 'available', construction_status: 'ready' }),
    brochureLink: null,
    locationLink: null,
    websiteUnitsLink: 'https://wassel.re/project?id=ap#units',
    imageFileIds: [],
    missing: [],
    ...overrides,
  };
}

// The actual AI-generated Arabic message that was sent (decimal areas, «إلى»
// separators, grouped price).
const SENT_AR = `✨ الماجدية 163 ✨

مجتمع سكني أنيق بتصميم نيو كلاسيكي يمنحك الراحة والخصوصية 🌿

📍 المدينة: الرياض
🏘️ الحي: الفاروق
🏠 نوع الوحدة: شقة
🛏️ الغرف: من 1 إلى 3 غرف نوم
📐 المساحات: من 90.07 إلى 180.22 م²
🛁 دورات المياه: من 2 إلى 3
💰 الأسعار تبدأ من: 559,000 ر.س

🔗 https://wassel.re/project?id=ap#units`;

const SENT_EN = `✨ Al-Majdiyah 163 ✨

📍 City: Riyadh
🏘️ District: Al-Farouq
🏠 Unit Type: Apartment
🛏️ Bedrooms: 1 to 3
📐 Area: 90.07 to 180.22 m²
🛁 Bathrooms: 2 to 3
💰 Prices start from: SAR 559,000

🔗 https://wassel.re/project?id=ap#units`;

describe('savedMessageMatchesCurrentFacts', () => {
  it('skips when the saved message already reflects the current numbers (decimal areas + إلى)', () => {
    expect(savedMessageMatchesCurrentFacts(majdiyaFacts(), SENT_AR, SENT_EN)).toBe(true);
  });

  it('skips the deterministic composer form (rounded areas + "min - max")', () => {
    const ar = `الماجدية 163\n\nغرف النوم: 1 - 3\nالمساحة: 90 - 180 م²\nدورات المياه: 2 - 3\nالأسعار تبدأ من: 559,000 ر.س`;
    const en = `Al-Majdiyah 163\n\nBedrooms: 1 - 3\nArea: 90 - 180 m²\nBathrooms: 2 - 3\nPrices start from: SAR 559,000`;
    expect(savedMessageMatchesCurrentFacts(majdiyaFacts(), ar, en)).toBe(true);
  });

  it('folds Arabic-Indic digits before comparing', () => {
    const ar = `الماجدية 163\n\nغرف النوم: ١ - ٣\nالمساحة: ٩٠ - ١٨٠ م²\nدورات المياه: ٢ - ٣\nالأسعار تبدأ من: ٥٥٩٬٠٠٠ ر.س`;
    expect(savedMessageMatchesCurrentFacts(majdiyaFacts(), ar, '')).toBe(true);
  });

  it('does NOT skip when the price drifted (the high-harm case)', () => {
    const facts = majdiyaFacts({ minPrice: { ar: '575,000 ر.س', en: 'SAR 575,000' } });
    expect(savedMessageMatchesCurrentFacts(facts, SENT_AR, SENT_EN)).toBe(false);
  });

  it('does NOT skip when a range shrank even if the new endpoints appear elsewhere', () => {
    // Baths now 2–2, but the saved copy still says "2 إلى 3". The contiguous
    // range "2 - 2" is absent, so we must fact-check.
    const facts = majdiyaFacts({ bathrooms: { min: 2, max: 2 } });
    expect(savedMessageMatchesCurrentFacts(facts, SENT_AR, SENT_EN)).toBe(false);
  });

  it('does NOT skip a now-sold-out project whose saved message still quotes a price', () => {
    const facts = majdiyaFacts({ minPrice: null });
    expect(savedMessageMatchesCurrentFacts(facts, SENT_AR, SENT_EN)).toBe(false);
  });

  it('skips a genuinely price-less project when the saved message quotes none', () => {
    const facts = majdiyaFacts({ minPrice: null, areaRange: null, bedrooms: null, bathrooms: null });
    const ar = `الماجدية 163\n\nالمدينة: الرياض\nالحي: الفاروق`;
    expect(savedMessageMatchesCurrentFacts(facts, ar, '')).toBe(true);
  });

  it('does not treat a bedroom count as a bathroom match (bounded single value)', () => {
    // Baths now single "5"; body has no 5 anywhere → no skip.
    const facts = majdiyaFacts({ bathrooms: { min: 5, max: 5 } });
    expect(savedMessageMatchesCurrentFacts(facts, SENT_AR, SENT_EN)).toBe(false);
  });

  it('returns false when nothing is saved', () => {
    expect(savedMessageMatchesCurrentFacts(majdiyaFacts(), '', '')).toBe(false);
  });

  // ── OFF-PLAN DISCLOSURE ──────────────────────────────────────────────
  // A saved message written before the disclosure rule existed (or while the
  // project was still marked ready) must NOT be sent verbatim: skipping the
  // fact-check is what would put an undisclosed off-plan project in front of a
  // customer. Every case below keeps the numbers current, so ONLY the delivery
  // rule decides the outcome.
  const offPlan = (handover?: string) =>
    majdiyaFacts({
      delivery: resolveProjectDelivery({
        project_status: 'available_on_map',
        construction_status: 'تحت-التطوير',
        ...(handover ? { handover_date: handover } : {}),
      }),
    });

  it('does NOT skip an off-plan project whose saved message never says so', () => {
    expect(savedMessageMatchesCurrentFacts(offPlan(), SENT_AR, SENT_EN)).toBe(false);
  });

  it('skips an off-plan project whose saved message already discloses it', () => {
    const ar = `${SENT_AR}

الحالة: على الخارطة`;
    const en = `${SENT_EN}

Status: Off-plan`;
    expect(savedMessageMatchesCurrentFacts(offPlan(), ar, en)).toBe(true);
  });

  it('does NOT skip when the disclosure is there but the handover year is missing', () => {
    const ar = `${SENT_AR}

الحالة: على الخارطة`;
    const en = `${SENT_EN}

Status: Off-plan`;
    expect(savedMessageMatchesCurrentFacts(offPlan('2028-08-01'), ar, en)).toBe(false);
  });

  it('skips when the disclosure carries the right handover year, in either digit script', () => {
    const ar = `${SENT_AR}

الحالة: على الخارطة — التسليم المتوقع أغسطس ٢٠٢٨`;
    const en = `${SENT_EN}

Status: Off-plan — expected handover August 2028`;
    expect(savedMessageMatchesCurrentFacts(offPlan('2028-08-01'), ar, en)).toBe(true);
  });

  it('does NOT skip when the saved copy quotes the WRONG handover year', () => {
    const ar = `${SENT_AR}

الحالة: على الخارطة — التسليم المتوقع أغسطس 2027`;
    const en = `${SENT_EN}

Status: Off-plan — expected handover August 2027`;
    expect(savedMessageMatchesCurrentFacts(offPlan('2028-08-01'), ar, en)).toBe(false);
  });

  it('checks only the language that is actually saved (one-language templates)', () => {
    const ar = `${SENT_AR}

الحالة: على الخارطة`;
    expect(savedMessageMatchesCurrentFacts(offPlan(), ar, '')).toBe(true);
  });

  it('requires nothing extra for a ready or unknown-status project', () => {
    expect(savedMessageMatchesCurrentFacts(majdiyaFacts(), SENT_AR, SENT_EN)).toBe(true);
    const unknown = majdiyaFacts({ delivery: resolveProjectDelivery({ project_status: 'sold_out' }) });
    expect(savedMessageMatchesCurrentFacts(unknown, SENT_AR, SENT_EN)).toBe(true);
  });
});

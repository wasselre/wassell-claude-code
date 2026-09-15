import { describe, it, expect } from 'vitest';
import { looksLikeUnitPlan } from '../runSocialFileJob';

// Real OCR text from the live corpus (2026-09-15). The operator found a plain
// floor plan filed as «تصميم»; these pin the discriminator that fixed it.
describe('looksLikeUnitPlan — a floor plan inside a competitor carousel', () => {
  it('recognises the plan the operator caught (ريفا / ركم 11)', () => {
    expect(looksLikeUnitPlan(
      'رقم الوحدة 01 المساحة الإجمالية 115.85 م المساحة الخاصة 27 م الدور الأرضي GROUND FLOOR غرفة خادمة دورات مياه مطبخ صالة غرفة نوم رئيسية',
    )).toBe(true);
  });
  it('recognises a villa plan even when the OCR mangles «الفيلا» to «الغيلا»', () => {
    expect(looksLikeUnitPlan('NAKHIL VESTA رقم الغيلا 04 312,5م المساحة الإجمالية الملحق الدور الاول الدور الارضي')).toBe(true);
  });
  it('matches the English floor labels case-insensitively', () => {
    expect(looksLikeUnitPlan('Unit 12 — ground floor — first floor')).toBe(true);
  });

  it('does NOT treat a spec creative as a plan, though it lists rooms', () => {
    expect(looksLikeUnitPlan(
      'ادوار فيورا هيبة السكن تبدأ من تفاصيله مساحات رحبة بتوزيع ذكي 272م إلى 286م تشطيبات فاخرة غرفة خادمة غرفة سائق ضمانات لسنوات طويلة تكييف مخفي',
    )).toBe(false);
  });
  it('does NOT treat an amenities poster as a plan', () => {
    expect(looksLikeUnitPlan(
      'LUXURIOUS SPECIFICATIONS مواصفات فاخرة دخول ذكي كراسي معلقة ارضيات بورسلان غرفتين نوم غرفة غسيل مداخل مكيفة مطبخ وصالة واسعة',
    )).toBe(false);
  });
  it('handles a post with no OCR at all', () => {
    expect(looksLikeUnitPlan(null)).toBe(false);
    expect(looksLikeUnitPlan('')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  resolveProjectDelivery,
  handoverMonthLabel,
  handoverYear,
  deliveryKindLabel,
  bodyDisclosesOffPlan,
  ensureOffPlanDisclosed,
  MONTH_NAMES_AR,
} from '../delivery';
import { MONTH_NAMES_AR as DATE_FORMAT_MONTHS_AR } from '@/lib/dateFormat';

/**
 * The shared ready-vs-off-plan resolver. The status values exercised here are
 * the REAL live `all_projects` values (the seven `construction_status` options,
 * the six `project_status` options, and the legacy free-text Arabic statuses
 * that predate the dropdown).
 */
describe('resolveProjectDelivery', () => {
  it('reads construction_status=ready as Ready', () => {
    expect(resolveProjectDelivery({ construction_status: 'ready' }).kind).toBe('ready');
  });

  it('reads every pre-completion construction stage as off-plan', () => {
    for (const s of ['excavation', 'foundations', 'structure', 'finishing', 'facade_installation', 'تحت-التطوير']) {
      expect(resolveProjectDelivery({ construction_status: s }).kind).toBe('off_plan');
    }
  });

  it('lets construction_status win over a conflicting project_status', () => {
    expect(resolveProjectDelivery({ construction_status: 'ready', project_status: 'available_on_map' }).kind).toBe('ready');
    expect(resolveProjectDelivery({ construction_status: 'تحت-التطوير', project_status: 'available' }).kind).toBe('off_plan');
  });

  it('falls back to project_status when construction_status is absent', () => {
    for (const s of ['under_construction', 'available_on_map', 'upcoming', 'قريبا']) {
      expect(resolveProjectDelivery({ project_status: s }).kind).toBe('off_plan');
    }
    for (const s of ['منجز', 'تم الانتهاء']) {
      expect(resolveProjectDelivery({ project_status: s }).kind).toBe('ready');
    }
  });

  it('NEVER guesses Ready from an ambiguous or unrelated status', () => {
    for (const s of ['available', 'sold_out', 'unknown', 'للتاجير', 'للبيع', 'مشاريع حالية', 'مكتمل']) {
      const d = resolveProjectDelivery({ project_status: s });
      expect(d.kind).toBe('unknown');
      // Unknown says NOTHING — it must never leak a readiness claim into a message.
      expect(d.phrase).toBeNull();
    }
  });
});

describe('the customer-facing phrase', () => {
  it('states off-plan AND the handover month when a date is stored', () => {
    // ستون الملقا, live: available_on_map + تحت-التطوير, handover 2028-08-01.
    const d = resolveProjectDelivery({
      project_status: 'available_on_map',
      construction_status: 'تحت-التطوير',
      handover_date: '2028-08-01',
    });
    expect(d.kind).toBe('off_plan');
    expect(d.phrase?.ar).toBe('على الخارطة — التسليم المتوقع أغسطس 2028');
    expect(d.phrase?.en).toBe('Off-plan — expected handover August 2028');
  });

  it('states off-plan with NO date when the date is unknown — never a guess', () => {
    // صفا 96, live: off-plan with no handover_date at all.
    const d = resolveProjectDelivery({ project_status: 'available_on_map', construction_status: 'تحت-التطوير' });
    expect(d.phrase?.ar).toBe('على الخارطة');
    expect(d.phrase?.en).toBe('Off-plan');
    expect(d.handoverLabel).toBeNull();
    // No digits at all — nothing a customer could read as a delivery promise.
    expect(d.phrase?.ar).not.toMatch(/\d/);
    expect(d.phrase?.en).not.toMatch(/\d/);
  });

  it('drops an unparseable handover date rather than printing it raw', () => {
    const d = resolveProjectDelivery({ project_status: 'available_on_map', handover_date: 'soon' });
    expect(d.handoverLabel).toBeNull();
    expect(d.phrase?.ar).toBe('على الخارطة');
  });

  it('says Ready for a finished project, and ignores its stale handover date', () => {
    const d = resolveProjectDelivery({ construction_status: 'ready', handover_date: '2024-01-31' });
    expect(d.phrase?.ar).toBe('جاهز');
    expect(d.phrase?.en).toBe('Ready');
  });
});

describe('handoverMonthLabel / handoverYear', () => {
  it('formats month + year in both languages', () => {
    expect(handoverMonthLabel('2027-09-30', true)).toBe('سبتمبر 2027');
    expect(handoverMonthLabel('2027-09-30', false)).toBe('September 2027');
    expect(handoverMonthLabel('2027-09', true)).toBe('سبتمبر 2027');
  });

  it('returns null for empty, malformed, or out-of-range input', () => {
    for (const bad of [null, '', 'nope', '2027-13-01', '2027-00-01']) {
      expect(handoverMonthLabel(bad, true)).toBeNull();
    }
  });

  it('extracts the year the AI guard checks', () => {
    expect(handoverYear('2028-08-01')).toBe('2028');
    expect(handoverYear(null)).toBeNull();
    expect(handoverYear('soon')).toBeNull();
  });
});

describe('deliveryKindLabel', () => {
  it('is bilingual for all three kinds', () => {
    expect(deliveryKindLabel('ready', true)).toBe('جاهز');
    expect(deliveryKindLabel('off_plan', true)).toBe('على الخارطة');
    expect(deliveryKindLabel('off_plan', false)).toBe('Off-plan');
    expect(deliveryKindLabel('unknown', false)).toBe('Not specified');
  });
});

describe('bodyDisclosesOffPlan (the AI output guard)', () => {
  it('accepts the phrasings a rep or the model actually writes', () => {
    expect(bodyDisclosesOffPlan('المشروع على الخارطة، التسليم أغسطس 2028', 'ar')).toBe(true);
    expect(bodyDisclosesOffPlan('الوحدات تحت الإنشاء حالياً', 'ar')).toBe(true);
    expect(bodyDisclosesOffPlan('Sold off-plan, handover August 2028', 'en')).toBe(true);
    expect(bodyDisclosesOffPlan('Off Plan project', 'en')).toBe(true);
    expect(bodyDisclosesOffPlan('Currently UNDER CONSTRUCTION', 'en')).toBe(true);
  });

  it('rejects a message that never says it', () => {
    expect(bodyDisclosesOffPlan('مشروع سكني فاخر في النرجس، الأسعار تبدأ من 559,000 ر.س', 'ar')).toBe(false);
    expect(bodyDisclosesOffPlan('A luxury residential project in An-Narjis', 'en')).toBe(false);
    expect(bodyDisclosesOffPlan('', 'ar')).toBe(false);
  });
});

describe('ensureOffPlanDisclosed (the rep flow floor)', () => {
  const offPlanDated = resolveProjectDelivery({
    project_status: 'available_on_map', construction_status: 'تحت-التطوير', handover_date: '2028-08-01',
  });
  const ready = resolveProjectDelivery({ construction_status: 'ready' });
  const unknown = resolveProjectDelivery({ project_status: 'sold_out' });

  it('appends the status line to a saved message that never disclosed it', () => {
    const out = ensureOffPlanDisclosed('صفا 96\n\nالمدينة: الرياض', 'ar', offPlanDated);
    expect(out).toContain('الحالة: على الخارطة — التسليم المتوقع أغسطس 2028');
    expect(out.startsWith('صفا 96')).toBe(true); // the original copy is untouched
    expect(ensureOffPlanDisclosed('Safa 96\n\nCity: Riyadh', 'en', offPlanDated))
      .toContain('Status: Off-plan — expected handover August 2028');
  });

  it('leaves a message that already discloses it completely alone', () => {
    const body = 'صفا 96\n\nالمشروع على الخارطة والتسليم أغسطس 2028';
    expect(ensureOffPlanDisclosed(body, 'ar', offPlanDated)).toBe(body);
  });

  it('never touches a ready, unknown-status, or empty message', () => {
    expect(ensureOffPlanDisclosed('أكنان 25', 'ar', ready)).toBe('أكنان 25');
    expect(ensureOffPlanDisclosed('الماجدية 163', 'ar', unknown)).toBe('الماجدية 163');
    expect(ensureOffPlanDisclosed('x', 'ar', null)).toBe('x');
    expect(ensureOffPlanDisclosed('', 'ar', offPlanDated)).toBe('');
  });

  it('adds no date when the project has none', () => {
    const d = resolveProjectDelivery({ project_status: 'available_on_map' });
    const out = ensureOffPlanDisclosed('صفا 96', 'ar', d);
    const appended = out.slice('صفا 96'.length);
    expect(appended.trim()).toBe('الحالة: على الخارطة');
    // No digits in the line we added — nothing a customer reads as a date.
    expect(appended).not.toMatch(/\d/);
  });
});

describe('month-name parity with dateFormat.ts', () => {
  it('is identical — delivery.ts restates the list only to stay import-free', () => {
    // delivery.ts must not import anything (Vercel Node-ESM bundles it into the
    // api functions). This test is what stops the copy from drifting.
    expect(MONTH_NAMES_AR).toEqual(DATE_FORMAT_MONTHS_AR);
  });
});

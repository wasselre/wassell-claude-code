import { describe, it, expect } from 'vitest';
import type { AppModel, SalesProcessOverride } from '@/types';
import { DEFAULT_SALES_PROCESS, applyOverridesToConfig, collectConfigEnumRefs, getFollowUpTypeConfig } from '../config';
import { OUTCOME_VALUES } from '../outcomes';
import { CLIENT_STAGE_VALUES, CLIENT_STATUS_VALUES } from '../arabicEnums.generated';
import { checkSalesProcessEnums } from '../assertEnums';
import { validateFollowUpCompletion, isOutcomeFieldVisible } from '../validators';

describe('DEFAULT_SALES_PROCESS integrity', () => {
  const refs = collectConfigEnumRefs(DEFAULT_SALES_PROCESS);

  it('every referenced stage is a live client_stage value', () => {
    const stageSet = new Set<string>(CLIENT_STAGE_VALUES);
    expect(refs.stages.filter((s) => !stageSet.has(s))).toEqual([]);
  });

  it('every referenced status is a live client_status value', () => {
    const statusSet = new Set<string>(CLIENT_STATUS_VALUES);
    expect(refs.statuses.filter((s) => !statusSet.has(s))).toEqual([]);
  });

  it('every referenced outcome is in the OUTCOME_CATALOG', () => {
    const outcomeSet = new Set<string>(OUTCOME_VALUES);
    expect(refs.outcomes.filter((o) => !outcomeSet.has(o))).toEqual([]);
  });

  it('every allowed_outcome on every type is a catalog value', () => {
    const outcomeSet = new Set<string>(OUTCOME_VALUES);
    const bad: string[] = [];
    for (const t of DEFAULT_SALES_PROCESS.followup_types) {
      for (const o of t.allowed_outcomes) if (!outcomeSet.has(o.value)) bad.push(`${t.type}:${o.value}`);
    }
    expect(bad).toEqual([]);
  });

  it('after-visit type covers the expanded outcome set', () => {
    const t = DEFAULT_SALES_PROCESS.followup_types.find((x) => x.type === 'follow_up_call_after_visit');
    const vals = new Set((t?.allowed_outcomes ?? []).map((o) => o.value));
    for (const v of ['requested_another_visit', 'visited_other_project', 'recontact_later', 'invalid_number']) {
      expect(vals.has(v)).toBe(true);
    }
    // "Visited another project" must never be terminal/auto-lost.
    const vop = t?.allowed_outcomes.find((o) => o.value === 'visited_other_project');
    expect(vop?.is_terminal).toBeFalsy();
  });

  it('passes the runtime enum guard against live-shaped models', () => {
    const clients = {
      name: 'clients',
      schema: { sections: [{ fields: [
        { name: 'client_stage', options: CLIENT_STAGE_VALUES.map((v) => ({ value: v })) },
        { name: 'client_status', options: CLIENT_STATUS_VALUES.map((v) => ({ value: v })) },
      ] }] },
    } as unknown as AppModel;
    const followups = {
      name: 'followups',
      schema: { sections: [{ fields: [{ name: 'call_result', options: OUTCOME_VALUES.map((v) => ({ value: v })) }] }] },
    } as unknown as AppModel;
    expect(checkSalesProcessEnums([clients, followups], refs)).toEqual([]);
  });
});

describe('applyOverridesToConfig', () => {
  const T = 'appointment_booking_call';
  const base = getFollowUpTypeConfig(T, DEFAULT_SALES_PROCESS)!;

  it('returns the base unchanged when there are no overrides', () => {
    expect(applyOverridesToConfig([])).toBe(DEFAULT_SALES_PROCESS);
    expect(applyOverridesToConfig(undefined)).toBe(DEFAULT_SALES_PROCESS);
  });

  it('overrides the objective and parses script newlines into bullet lines', () => {
    const overrides: SalesProcessOverride[] = [{
      id: T,
      objective_ar: 'هدف معدّل',
      objective_en: 'Edited goal',
      script_ar: 'سطر ١\n سطر ٢ \n\n',
      script_en: 'line 1\nline 2',
    }];
    const t = getFollowUpTypeConfig(T, applyOverridesToConfig(overrides))!;
    expect(t.objective_ar).toBe('هدف معدّل');
    expect(t.objective_en).toBe('Edited goal');
    expect(t.script?.ar).toEqual(['سطر ١', 'سطر ٢']); // trimmed, blank lines dropped
    expect(t.script?.en).toEqual(['line 1', 'line 2']);
  });

  it('falls back to the default for blank override fields (never blanks)', () => {
    const overrides: SalesProcessOverride[] = [{
      id: T, objective_ar: '   ', objective_en: null, script_ar: '', script_en: null,
    }];
    const t = getFollowUpTypeConfig(T, applyOverridesToConfig(overrides))!;
    expect(t.objective_ar).toBe(base.objective_ar);
    expect(t.objective_en).toBe(base.objective_en);
    expect(t.script?.ar).toEqual(base.script?.ar);
    expect(t.script?.en).toEqual(base.script?.en);
  });

  it('overriding only the Arabic script keeps the English default', () => {
    const overrides: SalesProcessOverride[] = [{
      id: T, objective_ar: null, objective_en: null, script_ar: 'إرشاد جديد', script_en: null,
    }];
    const t = getFollowUpTypeConfig(T, applyOverridesToConfig(overrides))!;
    expect(t.script?.ar).toEqual(['إرشاد جديد']);
    expect(t.script?.en).toEqual(base.script?.en);
  });
});

describe('validateFollowUpCompletion', () => {
  const T = 'appointment_booking_call';

  it('blocks when no outcome chosen', () => {
    const r = validateFollowUpCompletion({ followupType: T, selectedOutcome: '', draft: {} });
    expect(r.ok).toBe(false);
  });

  it('blocks wrong_time without reschedule_contact_date', () => {
    const r = validateFollowUpCompletion({ followupType: T, selectedOutcome: 'wrong_time', draft: { actual_datetime: '2026-06-16T10:00:00Z' } });
    expect(r.ok).toBe(false);
    expect(r.hardErrors.some((e) => e.field === 'reschedule_contact_date')).toBe(true);
  });

  it('passes wrong_time with reschedule_contact_date', () => {
    const r = validateFollowUpCompletion({
      followupType: T, selectedOutcome: 'wrong_time',
      draft: { actual_datetime: '2026-06-16T10:00:00Z', reschedule_contact_date: '2026-06-18T10:00:00Z' },
    });
    expect(r.ok).toBe(true);
  });

  it('blocks not_interested without lost_reason', () => {
    const r = validateFollowUpCompletion({ followupType: T, selectedOutcome: 'not_interested', draft: { actual_datetime: 'x', outcome_notes: 'n' } });
    expect(r.hardErrors.some((e) => e.field === 'lost_reason')).toBe(true);
  });

  it('blocks appointment_booked without a linked appointment', () => {
    const r = validateFollowUpCompletion({ followupType: T, selectedOutcome: 'appointment_booked', draft: { actual_datetime: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.hardErrors.some((e) => e.field === 'appointment_id')).toBe(true);
  });

  it('warns when a call outcome has no attached call', () => {
    const r = validateFollowUpCompletion({ followupType: T, selectedOutcome: 'no_answer', draft: { actual_datetime: 'x' } });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.field === 'completed_by_call_id')).toBe(true);
  });
});

describe('isOutcomeFieldVisible', () => {
  it('reveals reschedule_contact_date for wrong_time, hides it for interested', () => {
    expect(isOutcomeFieldVisible('reschedule_contact_date', 'appointment_booking_call', 'wrong_time')).toBe(true);
    expect(isOutcomeFieldVisible('reschedule_contact_date', 'appointment_booking_call', 'interested')).toBe(false);
  });

  it('reveals new_appointment_datetime only for rescheduled', () => {
    expect(isOutcomeFieldVisible('new_appointment_datetime', 'appointment_confirmation_call', 'rescheduled')).toBe(true);
    expect(isOutcomeFieldVisible('new_appointment_datetime', 'appointment_confirmation_call', 'attendance_confirmed')).toBe(false);
  });
});

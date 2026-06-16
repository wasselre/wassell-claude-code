import { describe, it, expect } from 'vitest';
import type { AppModel } from '@/types';
import { checkSalesProcessEnums } from '../assertEnums';
import { OUTCOME_VALUES } from '../outcomes';
import { CLIENT_STAGE_VALUES, CLIENT_STATUS_VALUES } from '../arabicEnums.generated';

/** Build a throwaway model exposing one dropdown field with the given option values. */
function modelWithOptions(name: string, fieldSlug: string, values: readonly string[]): AppModel {
  return {
    name,
    schema: {
      sections: [
        {
          fields: [
            { name: fieldSlug, options: values.map((v) => ({ value: v })) },
          ],
        },
      ],
    },
  } as unknown as AppModel;
}

const clients = modelWithOptions('clients', 'client_stage', CLIENT_STAGE_VALUES);
// clients needs both client_stage and client_status — give it two fields.
const clientsFull = {
  name: 'clients',
  schema: {
    sections: [
      {
        fields: [
          { name: 'client_stage', options: CLIENT_STAGE_VALUES.map((v) => ({ value: v })) },
          { name: 'client_status', options: CLIENT_STATUS_VALUES.map((v) => ({ value: v })) },
        ],
      },
    ],
  },
} as unknown as AppModel;

const followups = modelWithOptions('followups', 'call_result', OUTCOME_VALUES);

describe('checkSalesProcessEnums', () => {
  it('passes when every referenced stage/status/outcome exists', () => {
    const problems = checkSalesProcessEnums([clientsFull, followups], {
      stages: ['جديد', 'موعد زيارة', 'خاسر', 'مغلق ناجح'],
      statuses: ['مهتم', 'رقم خاطئ', 'تم رفض العرض', 'بارد'],
      outcomes: OUTCOME_VALUES,
    });
    expect(problems).toEqual([]);
  });

  it('every OUTCOME_CATALOG value is present in the call_result option set (superset guarantee)', () => {
    const problems = checkSalesProcessEnums([clientsFull, followups]); // defaults outcomes to the full catalog
    // No outcome problems (clients-related problems are irrelevant here since we pass no stage/status refs).
    expect(problems.filter((p) => p.includes('call_result'))).toEqual([]);
  });

  it('flags a stage that is not an option', () => {
    const problems = checkSalesProcessEnums([clientsFull, followups], { stages: ['مرحلة وهمية'] });
    expect(problems.some((p) => p.includes('client_stage') && p.includes('مرحلة وهمية'))).toBe(true);
  });

  it('flags an outcome missing from call_result', () => {
    const partial = modelWithOptions('followups', 'call_result', ['interested', 'no_answer']);
    const problems = checkSalesProcessEnums([clientsFull, partial], { outcomes: ['interested', 'offer_accepted'] });
    expect(problems.some((p) => p.includes('call_result') && p.includes('offer_accepted'))).toBe(true);
  });

  it('reports when a required model is not loaded', () => {
    const problems = checkSalesProcessEnums([clients], {}); // no followups model
    expect(problems.some((p) => p.includes('followups model not loaded'))).toBe(true);
  });
});

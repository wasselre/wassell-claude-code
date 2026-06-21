// Verification suite for the Sales Studio 2.0 pure core: the process overlay
// (the engine seam), experiment assignment, and the funnel analytics. These are
// the highest-risk pieces — they decide what the workflow engine runs and what
// numbers the manager sees. Run: npx vitest run src/lib/salesStudio
import { describe, it, expect } from 'vitest';
import type { Workflow, AppRecord, SalesProcessVersion, ClientSalesProcessAssignment, SalesExperiment } from '@/types';
import {
  applyProcessOverlayToWorkflow,
  buildProcessOverlayResolver,
  deterministicGroup,
  clientMatchesRules,
  resolveExperimentAssignments,
  computeSalesFunnel,
  compareExperiment,
  buildWorkflowCard,
  type SalesFunnelResult,
} from '@/lib/salesStudio';
import { DEFAULT_SALES_PROCESS } from '@/lib/salesProcess';

// ── fixtures ──────────────────────────────────────────────────────────────────
function wf(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf1', label_ar: 'سير', label_en: 'WF', trigger_model_id: 'followups', trigger_event: 'update',
    conditions: [], actions: [], is_active: true, created_at: '', updated_at: '',
    branches: [
      {
        id: 'b_booked',
        conditions: [{ id: 'c1', field_id: 'call_result', operator: 'equals', value: 'appointment_booked' }],
        actions: [
          {
            id: 'a_create', type: 'create_record', target_model_id: 'followups',
            field_mappings: [
              { id: 'm1', target_field_id: 'followup_type', source_type: 'static', static_value: 'appointment_confirmation_call' },
              { id: 'm2', target_field_id: 'scheduled_datetime', source_type: 'date_expression', date_base: 'current_date', date_expression: '+1d' },
              { id: 'm3', target_field_id: 'sales_rep', source_type: 'current_user' },
            ],
          },
          { id: 'a_wa', type: 'send_whatsapp_message', body_template: 'Default body', to_field_id: 'phone' },
        ],
      },
      { id: 'b_else', is_else: true, conditions: [], actions: [] },
    ],
    ...over,
  };
}
function rec(data: Record<string, unknown>, over: Partial<AppRecord> = {}): AppRecord {
  return { id: data.id as string ?? 'r1', model_id: 'clients', data, created_at: '2026-01-01T00:00:00Z', updated_at: '', ...over };
}

describe('applyProcessOverlayToWorkflow', () => {
  it('returns the same workflow when overlay is empty', () => {
    const w = wf();
    expect(applyProcessOverlayToWorkflow(w, undefined)).toBe(w);
    expect(applyProcessOverlayToWorkflow(w, {})).toBe(w);
  });

  it('overrides the next-action timing (date_expression)', () => {
    const out = applyProcessOverlayToWorkflow(wf(), { timings: { a_create: '+3d @09:00' } });
    const dm = out.branches![0]!.actions[0] as { field_mappings: { target_field_id: string; date_expression?: string }[] };
    expect(dm.field_mappings.find((m) => m.target_field_id === 'scheduled_datetime')!.date_expression).toBe('+3d @09:00');
  });

  it('drops a disabled branch', () => {
    const out = applyProcessOverlayToWorkflow(wf(), { branches: { b_booked: { enabled: false } } });
    expect(out.branches!.map((b) => b.id)).toEqual(['b_else']);
  });

  it('overrides the WhatsApp body and assignment strategy', () => {
    const out = applyProcessOverlayToWorkflow(wf(), {
      messages: { a_wa: { ar: 'مرحبا', en: 'Hello there' } },
      assignments: { a_create: { strategy: 'same_sales_rep' } },
    });
    const acts = out.branches![0]!.actions as Array<Record<string, unknown>>;
    expect((acts[1] as { body_template: string }).body_template).toBe('مرحبا');
    const rep = (acts[0] as { field_mappings: { target_field_id: string; source_type: string; trigger_field_id?: string }[] })
      .field_mappings.find((m) => m.target_field_id === 'sales_rep')!;
    expect(rep.source_type).toBe('trigger_field');
    expect(rep.trigger_field_id).toBe('sales_rep');
  });

  it('drops a retry create_record once the max-attempts cap is hit', () => {
    const out = applyProcessOverlayToWorkflow(wf(), { max_attempts: { a_create: 3 } }, { attemptNumber: 3 });
    expect(out.branches![0]!.actions.find((a) => a.id === 'a_create')).toBeUndefined();
    // below the cap → kept
    const kept = applyProcessOverlayToWorkflow(wf(), { max_attempts: { a_create: 3 } }, { attemptNumber: 1 });
    expect(kept.branches![0]!.actions.find((a) => a.id === 'a_create')).toBeDefined();
  });
});

describe('buildProcessOverlayResolver', () => {
  const version: SalesProcessVersion = {
    id: 'v1', sales_process_id: 'p1', version_number: 1, status: 'active',
    config_json: { steps: [], workflows: { wf1: { timings: { a_create: '+5d' } } } },
    created_at: '', updated_at: '',
  };
  const assignment: ClientSalesProcessAssignment = {
    id: 'as1', client_id: 'c1', sales_process_id: 'p1', sales_process_version_id: 'v1',
    is_active: true, assigned_at: '', created_at: '',
  };
  const resolver = buildProcessOverlayResolver({
    assignmentsByClient: new Map([['c1', assignment]]),
    versionsById: new Map([['v1', version]]),
  });

  it('overlays for an assigned client', () => {
    const trigger = rec({ client_id: 'c1', followup_number: 1 }, { model_id: 'followups' });
    const out = resolver(wf(), trigger);
    const dm = out.branches![0]!.actions[0] as { field_mappings: { target_field_id: string; date_expression?: string }[] };
    expect(dm.field_mappings.find((m) => m.target_field_id === 'scheduled_datetime')!.date_expression).toBe('+5d');
  });

  it('leaves the workflow unchanged for an unassigned client (legacy path)', () => {
    // Same reference back → the engine runs the built-in behavior untouched.
    const w = wf();
    expect(resolver(w, rec({ client_id: 'unknown' }, { model_id: 'followups' }))).toBe(w);
    // No client_id at all → also unchanged.
    expect(resolver(w, rec({}, { model_id: 'followups' }))).toBe(w);
  });
});

describe('experiment assignment', () => {
  it('deterministicGroup is stable and respects the split', () => {
    const g1 = deterministicGroup('client-a', 'exp-1', 50);
    const g2 = deterministicGroup('client-a', 'exp-1', 50);
    expect(g1).toBe(g2); // stable
    expect(deterministicGroup('x', 'e', 0)).toBe('control');   // 0% variant
    expect(deterministicGroup('x', 'e', 100)).toBe('variant'); // 100% variant
  });

  it('clientMatchesRules honors source, budget, and empty=match-all', () => {
    const c = rec({ lead_source: 'instagram', budget: 800000 });
    expect(clientMatchesRules(c, {})).toBe(true);
    expect(clientMatchesRules(c, { source: ['instagram'] })).toBe(true);
    expect(clientMatchesRules(c, { source: ['google'] })).toBe(false);
    expect(clientMatchesRules(c, { budget_min: 500000, budget_max: 1000000 })).toBe(true);
    expect(clientMatchesRules(c, { budget_min: 900000 })).toBe(false);
  });

  it('resolveExperimentAssignments routes random_split deterministically', () => {
    const exp: SalesExperiment = {
      id: 'e1', name_ar: 'ت', name_en: 'E', status: 'active', target_rules_json: {},
      control_process_version_id: 'cv', variant_process_version_id: 'vv',
      guardrail_metrics_json: [], assignment_mode: 'random_split', split_percentage: 100,
      created_at: '', updated_at: '',
    };
    const clients = [rec({ id: 'c1' }), rec({ id: 'c2' })];
    const out = resolveExperimentAssignments(exp, clients);
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.group === 'variant')).toBe(true); // 100% → all variant
    expect(out.every((a) => a.versionId === 'vv')).toBe(true);
  });

  it('manual mode resolves to no auto-assignments', () => {
    const exp = { id: 'e', name_ar: '', name_en: '', status: 'active', target_rules_json: {}, guardrail_metrics_json: [], assignment_mode: 'manual', split_percentage: 50, created_at: '', updated_at: '' } as SalesExperiment;
    expect(resolveExperimentAssignments(exp, [rec({ id: 'c1' })])).toEqual([]);
  });
});

describe('computeSalesFunnel', () => {
  const followups: AppRecord[] = [
    rec({ client_id: 'c1', followup_type: ['appointment_booking_call'], followup_status: 'completed', call_result: 'no_answer' }, { model_id: 'followups', id: 'f1' }),
    rec({ client_id: 'c1', followup_type: ['whatsapp_follow_up'], followup_status: 'completed', call_result: 'interested', whatsapp_state: 'message_sent' }, { model_id: 'followups', id: 'f2' }),
  ];

  it('computes reach via stage order and rates', () => {
    const cohort = [
      rec({ id: 'c1', client_stage: 'عرض سعر' }),   // reached offer (order 5) → counts for booking/visit/offer
      rec({ id: 'c2', client_stage: 'جديد' }),       // new only
      rec({ id: 'c3', client_stage: 'مغلق ناجح' }),  // closed won
    ];
    const f = computeSalesFunnel(cohort, { followups, now: Date.parse('2026-02-01T00:00:00Z') });
    expect(f.lead_count.value).toBe(3);
    // c1 (offer) + c3 (closed won, order 9) reached the appointment milestone → 2/3
    expect(f.appointment_booking_rate.value).toBeCloseTo(2 / 3, 5);
    expect(f.closed_won_rate.value).toBeCloseTo(1 / 3, 5);
    expect(f.offer_request_rate.value).toBeCloseTo(2 / 3, 5); // c1 + c3
  });

  it('marks unavailable metrics honestly', () => {
    const f = computeSalesFunnel([], { followups: [], now: Date.now() });
    expect(f.lead_count.value).toBe(0);
    expect(f.appointment_booking_rate.available).toBe(false);   // no leads
    expect(f.time_to_appointment.available).toBe(false);        // no downstream records
    expect(f.whatsapp_response_rate.available).toBe(false);
  });

  it('counts downstream-linked records as reaching the milestone', () => {
    const cohort = [rec({ id: 'c9', client_stage: 'جديد' })]; // stage says new...
    const f = computeSalesFunnel(cohort, {
      followups: [],
      downstream: { offers: [rec({ client_id: 'c9' }, { model_id: 'offer_prices' })] }, // ...but has an offer
      now: Date.now(),
    });
    expect(f.offer_request_rate.value).toBe(1); // linked offer → reached
  });
});

describe('buildWorkflowCard — editor pre-fill', () => {
  // A "kickoff" workflow like First Follow-up: one condition-only branch on
  // client_stage, a create_record that assigns a fixed user via a static mapping.
  const kickoff = wf({
    trigger_event: 'create',
    branches: [{
      id: 'b1',
      conditions: [{ id: 'c', field_id: 'client_stage', operator: 'equals', value: 'جديد' }],
      actions: [{
        id: 'a_create', type: 'create_record', target_model_id: 'followups',
        field_mappings: [
          { id: 'm_type', target_field_id: 'followup_type', source_type: 'static', static_value: 'appointment_booking_call' },
          { id: 'm_rep', target_field_id: 'sales_rep', source_type: 'static', static_value: 'user-42' },
          { id: 'm_date', target_field_id: 'scheduled_datetime', source_type: 'date_expression', date_base: 'current_date', date_expression: '' },
        ],
      }],
    }],
  });

  it('surfaces the workflow\'s fixed assignee (not a blank dropdown)', () => {
    const card = buildWorkflowCard('appointment_booking_call', 'جديد', kickoff, undefined, DEFAULT_SALES_PROCESS);
    const a = card.assignments.find((x) => x.action_id === 'a_create');
    expect(a?.current_strategy).toBe('fixed_user');
    expect(a?.current_fixed_user_id).toBe('user-42');
  });

  it('describes a condition-only branch instead of a blank label', () => {
    const card = buildWorkflowCard('appointment_booking_call', 'جديد', kickoff, undefined, DEFAULT_SALES_PROCESS);
    const b = card.branches.find((x) => x.branch_id === 'b1');
    expect(b?.summary.en).toContain('When:');
    expect(b?.summary.en).toContain('Stage');
    expect(b?.summary.ar).toContain('المرحلة');
  });

  it('fills the objective from the sales config', () => {
    const card = buildWorkflowCard('appointment_booking_call', 'جديد', kickoff, undefined, DEFAULT_SALES_PROCESS);
    expect(card.objective_en).toBeTruthy();
    expect(card.objective_ar).toBeTruthy();
  });
});

describe('compareExperiment', () => {
  const mk = (lead: number, booking: number): SalesFunnelResult => {
    const base = computeSalesFunnel(
      Array.from({ length: lead }, (_, i) => rec({ id: `x${i}`, client_stage: i < Math.round(lead * booking) ? 'موعد زيارة' : 'جديد' })),
      { followups: [], now: Date.now() },
    );
    return base;
  };

  it('recommends promote when variant wins with enough sample and no guardrail breach', () => {
    const control = mk(100, 0.3);
    const variant = mk(100, 0.45);
    const cmp = compareExperiment(control, variant, 'appointment_booking_rate', []);
    expect(cmp.low_sample).toBe(false);
    expect(cmp.recommendation).toBe('promote_variant');
    expect(cmp.winner).toBe('variant');
  });

  it('flags low sample as inconclusive', () => {
    const cmp = compareExperiment(mk(5, 0.4), mk(5, 0.6), 'appointment_booking_rate', []);
    expect(cmp.low_sample).toBe(true);
    expect(cmp.recommendation).toBe('inconclusive');
  });

  it('rejects when the variant is clearly worse', () => {
    const cmp = compareExperiment(mk(100, 0.5), mk(100, 0.3), 'appointment_booking_rate', []);
    expect(cmp.recommendation).toBe('reject_variant');
    expect(cmp.winner).toBe('control');
  });
});

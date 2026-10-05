import { describe, expect, it } from 'vitest';
import {
  failureCategory, isResolvedFailure, countsByPortal, pairKey,
} from '../portalsOverview';
import type { OverviewRegistration, OverviewRun, OverviewPortal } from '@/lib/portalRegistration/client';

// Real messages on file in portal_registration_jobs (2026-10-05).
const REAL: [string, string | null, string][] = [
  ['هذا العميل مسجّل بالفعل في بوابة ريفا — لا يمكن إرسال الطلب.\nThis client is already registered in the Riva portal — the request cannot be sent.', null, 'already_in_portal'],
  ["فشلت الخطوة 6 (wait_for (input[wire\\:model='name'])): locator.waitFor: Timeout 30000ms exceeded.\nStep 6 (wait_for (input[wire\\:model='name'])) failed: locator.waitFor: Timeout 30000ms exceeded.", null, 'portal_slow'],
  ["لم يُسجَّل العميل تلقائياً — حقول ناقصة: المشروع (باسم الرمز)\nAutomatic registration skipped — missing fields: Project (Al Ramz's name)", null, 'missing_fields'],
  ['انتهت مهلة انتظار الرمز — لم يُدخل خلال الوقت المحدد.\nTimed out waiting for the code — it was not entered in time.', null, 'code_not_entered'],
  ['watchdog: the worker stopped responding (no heartbeat for 5 minutes)', null, 'worker_stopped'],
  ['لم يُسجَّل العميل — المشروع «ريا النخيل» غير موجود في قائمة مشاريع بوابة الرمز — بوابة الوسطاء\nNot registered — project "ريا النخيل" is not on the الرمز — بوابة الوسطاء project list', null, 'project_not_listed'],
  ['فشلت الخطوة 2 (goto): page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://riva.sa/broker/login\nStep 2 (goto) failed: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://riva.sa/broker/login', null, 'connection'],
  ['لم أجد قائمة العملاء في props.clients.data\nNo row array at props.clients.data', null, 'other'],
  ['لم يُسجَّل العميل تلقائياً — لا يوجد مندوب مسؤول عن العميل.\nAutomatic registration skipped — the client has no sales rep assigned.', 'no_owner', 'no_owner'],
];

function run(p: Partial<OverviewRun>): OverviewRun {
  return {
    id: 'r', kind: 'register', portal_record_id: 'P', client_record_id: 'C', project_name: null,
    status: 'failed', phase_ar: null, phase_en: null, error_message: null, origin: 'auto', attempts: 1,
    skip_reason: null, screenshot_count: 0, created_at: '2026-10-01T00:00:00Z', started_at: null,
    finished_at: null, parked_at: null, owner_name: null, ...p,
  };
}

function reg(p: Partial<OverviewRegistration>): OverviewRegistration {
  return {
    id: 'g', client_record_id: 'C', portal_record_id: 'P', our_status: 'failed', portal_status: null,
    portal_status_code: null, portal_status_changed_at: null, portal_ref: null, project_names: [],
    registered_as: [], registered_at: null, registered_via: null, last_checked_at: null, notes: null,
    updated_at: '2026-10-01T00:00:00Z', ...p,
  };
}

describe('failureCategory', () => {
  it.each(REAL)('classifies a real failure message', (msg, skip, expected) => {
    expect(failureCategory({ error_message: msg, skip_reason: skip })).toBe(expected);
  });
});

describe('isResolvedFailure', () => {
  it('a registration failure is resolved once the client is registered in that portal', () => {
    const failed = run({});
    expect(isResolvedFailure(failed, new Map([[pairKey('C', 'P'), reg({ our_status: 'failed' })]]), [failed])).toBe(false);
    expect(isResolvedFailure(failed, new Map([[pairKey('C', 'P'), reg({ our_status: 'registered' })]]), [failed])).toBe(true);
    expect(isResolvedFailure(failed, new Map([[pairKey('C', 'P'), reg({ our_status: 'already_registered' })]]), [failed])).toBe(true);
  });

  it('a status-check failure is resolved by a LATER finished check of the same portal', () => {
    const failed = run({ kind: 'status_check', client_record_id: null, created_at: '2026-10-02T00:00:00Z' });
    const earlier = run({ id: 'e', kind: 'status_check', client_record_id: null, status: 'done', created_at: '2026-10-01T00:00:00Z' });
    const later = run({ id: 'l', kind: 'status_check', client_record_id: null, status: 'done', created_at: '2026-10-03T00:00:00Z' });
    expect(isResolvedFailure(failed, new Map(), [failed, earlier])).toBe(false);
    expect(isResolvedFailure(failed, new Map(), [later, failed, earlier])).toBe(true);
  });
});

describe('countsByPortal', () => {
  it('counts statuses, open failures, live runs and the latest check', () => {
    const portals: OverviewPortal[] = [{ id: 'P', name: 'Riva', is_active: true, auto_register: true, otp_channel: 'none', otp_whatsapp_relay: false, can_check_status: true }];
    const regs = [
      reg({ id: '1', client_record_id: 'A', our_status: 'registered' }),
      reg({ id: '2', client_record_id: 'B', our_status: 'failed' }),
      reg({ id: '3', client_record_id: 'C', our_status: 'registering' }),
    ];
    const byPair = new Map(regs.map((r) => [pairKey(r.client_record_id, r.portal_record_id), r]));
    const runs = [
      run({ id: 'x', client_record_id: 'C', status: 'queued', created_at: '2026-10-05T00:00:00Z' }),
      run({ id: 'chk', kind: 'status_check', client_record_id: null, status: 'done', created_at: '2026-10-04T00:00:00Z' }),
      run({ id: 'y', client_record_id: 'B', status: 'failed', created_at: '2026-10-03T00:00:00Z' }),
      run({ id: 'z', client_record_id: 'A', status: 'failed', created_at: '2026-10-02T00:00:00Z' }), // A registered since
    ];
    const c = countsByPortal(portals, regs, runs, byPair).get('P')!;
    expect(c).toMatchObject({ total: 3, registered: 1, failed: 1, registering: 1, open_failures: 1, live_runs: 1 });
    expect(c.last_check?.id).toBe('chk');
  });
});

/**
 * Pure helpers for the Sales Workspace «البوابات» tab (PortalsSection.tsx):
 * why a run failed (in words a rep can act on), whether a failure has since
 * been resolved, and the per-portal counts. No React, no fetching — tested in
 * __tests__/portalsOverview.test.ts against the real failure messages on file.
 */
import type {
  OverviewRegistration, OverviewRun, OverviewPortal, RegistrationOurStatus,
} from '@/lib/portalRegistration/client';

export const LIVE_RUN = new Set(['queued', 'running', 'awaiting_input']);

export type FailureCategory =
  | 'already_in_portal'
  | 'missing_fields'
  | 'project_not_listed'
  | 'no_owner'
  | 'code_not_entered'
  | 'portal_slow'
  | 'connection'
  | 'worker_stopped'
  | 'other';

export const FAILURE_META: Record<FailureCategory, { ar: string; en: string; hint_ar: string; hint_en: string }> = {
  already_in_portal: {
    ar: 'البوابة تعرف العميل مسبقاً', en: 'Portal already had the client',
    hint_ar: 'البوابة رفضت لأن رقم العميل مسجّل لديها. لا تُعِد المحاولة.',
    hint_en: 'The portal refused because it already holds this phone number. Do not retry.',
  },
  missing_fields: {
    ar: 'بيانات ناقصة', en: 'Missing details',
    hint_ar: 'أكمل الحقول الناقصة في ملف العميل ثم سجّله من زر «التسجيل في البوابة».',
    hint_en: 'Fill the missing fields on the client, then register from the button.',
  },
  project_not_listed: {
    ar: 'المشروع ليس في قائمة البوابة', en: 'Project not on the portal',
    hint_ar: 'البوابة لا تعرض هذا المشروع للوسطاء — لم يُرسل تحت مشروع آخر.',
    hint_en: 'The portal does not offer this project to brokers — it was not sent under another one.',
  },
  no_owner: {
    ar: 'لا يوجد مندوب', en: 'No sales rep',
    hint_ar: 'عيّن مندوباً للعميل ثم سجّله يدوياً.',
    hint_en: 'Assign a rep to the client, then register manually.',
  },
  code_not_entered: {
    ar: 'لم يُدخل رمز التحقق', en: 'Code not entered',
    hint_ar: 'انتهى الوقت قبل إدخال الرمز. أعد المحاولة عندما يكون جوال الدخول متاحاً.',
    hint_en: 'Time ran out before the code was entered. Retry when the sign-in phone is at hand.',
  },
  portal_slow: {
    ar: 'صفحة البوابة لم تستجب', en: 'Portal page did not respond',
    hint_ar: 'البوابة بطيئة أو تغيّر شكل نموذجها. أعد المحاولة؛ إن تكرر فالخطوات تحتاج تعديلاً.',
    hint_en: 'The portal was slow or its form changed. Retry; if it repeats, the recipe needs fixing.',
  },
  connection: {
    ar: 'تعذّر الوصول للبوابة', en: 'Could not reach the portal',
    hint_ar: 'مشكلة اتصال مؤقتة. أعد المحاولة.',
    hint_en: 'A temporary connection problem. Retry.',
  },
  worker_stopped: {
    ar: 'توقّف خادمنا أثناء التسجيل', en: 'Our worker stopped mid-run',
    hint_ar: 'المشكلة عندنا لا عند البوابة. أعد المحاولة.',
    hint_en: 'Our side, not the portal. Retry.',
  },
  other: {
    ar: 'سبب آخر', en: 'Other',
    hint_ar: 'افتح الصور لمعرفة ما ظهر في البوابة.',
    hint_en: 'Open the screenshots to see what the portal showed.',
  },
};

/** Map a failed run to a reason a rep can act on. Reads the English line
 *  (the worker always stores "<ar>\n<en>"; watchdog messages are English only). */
export function failureCategory(run: Pick<OverviewRun, 'error_message' | 'skip_reason'>): FailureCategory {
  if (run.skip_reason === 'no_owner') return 'no_owner';
  const m = run.error_message ?? '';
  if (/already registered|بالفعل/i.test(m)) return 'already_in_portal';
  if (/missing fields|حقول ناقصة/i.test(m)) return 'missing_fields';
  if (/not on the .*project list|غير موجود في قائمة مشاريع/i.test(m)) return 'project_not_listed';
  if (/waiting for the code|code (was )?not|otp relay|مهلة انتظار الرمز/i.test(m)) return 'code_not_entered';
  if (/watchdog|stopped responding|killed by|heartbeat/i.test(m)) return 'worker_stopped';
  if (/net::ERR_|ECONN|ENOTFOUND|tunnel/i.test(m)) return 'connection';
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) return 'portal_slow';
  return 'other';
}

export function pairKey(clientId: string, portalId: string): string {
  return `${clientId}:${portalId}`;
}

export function isRegisteredStatus(s: RegistrationOurStatus | null | undefined): boolean {
  return s === 'registered' || s === 'already_registered';
}

/**
 * A failure is RESOLVED when something later settled it:
 *  - registration run → the client is now registered (or the portal says
 *    another broker's) in that portal;
 *  - status check     → a later check of the same portal finished.
 * Resolved failures stay in the log but drop out of the "needs attention" view.
 */
export function isResolvedFailure(
  run: OverviewRun,
  regByPair: Map<string, OverviewRegistration>,
  runs: OverviewRun[],
): boolean {
  if (run.kind === 'register') {
    if (!run.client_record_id) return false;
    return isRegisteredStatus(regByPair.get(pairKey(run.client_record_id, run.portal_record_id))?.our_status);
  }
  return runs.some((r) =>
    r.kind === 'status_check' && r.portal_record_id === run.portal_record_id
    && r.status === 'done' && r.created_at > run.created_at);
}

export interface PortalCounts {
  total: number;
  registered: number;
  already_registered: number;
  registering: number;
  failed: number;
  not_registered: number;
  /** Failed runs not yet resolved (see isResolvedFailure). */
  open_failures: number;
  live_runs: number;
  last_check: OverviewRun | null;
}

export function countsByPortal(
  portals: OverviewPortal[],
  registrations: OverviewRegistration[],
  runs: OverviewRun[],
  regByPair: Map<string, OverviewRegistration>,
): Map<string, PortalCounts> {
  const out = new Map<string, PortalCounts>();
  for (const p of portals) {
    out.set(p.id, {
      total: 0, registered: 0, already_registered: 0, registering: 0, failed: 0, not_registered: 0,
      open_failures: 0, live_runs: 0, last_check: null,
    });
  }
  for (const r of registrations) {
    const c = out.get(r.portal_record_id);
    if (!c) continue;
    c.total += 1;
    c[r.our_status] += 1;
  }
  for (const run of runs) {
    const c = out.get(run.portal_record_id);
    if (!c) continue;
    if (LIVE_RUN.has(run.status)) c.live_runs += 1;
    if (run.status === 'failed' && !isResolvedFailure(run, regByPair, runs)) c.open_failures += 1;
    // runs arrive newest first → the first status check seen is the latest.
    if (run.kind === 'status_check' && !c.last_check) c.last_check = run;
  }
  return out;
}

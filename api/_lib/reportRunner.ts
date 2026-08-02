/**
 * Scheduled Reports runner — the one place a report is executed.
 *
 * Reused by /api/internal/run-report (worker, shared-secret) and
 * /api/scheduled-reports/run-now (admin, user JWT). Runs the SAME analytics
 * engine as dashboards (via analyticsRun), scoped to the report OWNER by minting
 * a short-lived owner JWT — PostgREST validates the signature locally so
 * unified_records reads apply the owner's RLS (rule 4). Snapshots never include
 * record ids. Delivers via Resend if configured, else stores a draft.
 */
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { makeServiceClient } from './serviceClient.js';
import { effectiveQuery, effectiveViz } from '../../src/lib/analytics/widgetAdapter.js';
import { prepareContext, runQueryWithClient } from './analyticsRun.js';
import { renderReportEmail, type ReportSection, type RenderedEmail } from './reportEmail.js';
import type { AnalyticsQuery } from '../../src/lib/analytics/types.js';
import type { Dashboard, DashboardWidget, MetricDefinition, WidgetViz } from '../../src/types/index.js';

export interface ScheduledReport {
  id: string;
  title: string;
  owner_auth_uid: string | null;
  frequency: string;
  hour_of_day: number;
  day_of_week: number | null;
  day_of_month: number | null;
  recipients: unknown;
  source_type: 'dashboard' | 'widget' | 'metric' | 'custom';
  dashboard_id: string | null;
  widget_id: string | null;
  metric_id: string | null;
  query: AnalyticsQuery | null;
  /** Bilingual W4: the language the email renders in (chrome + labels). */
  language?: string | null;
}

export interface RunReportResult {
  status: 'sent' | 'draft' | 'failed' | 'partial';
  delivery: 'sent' | 'draft' | 'skipped';
  sections: number;
  recipients: string[];
  error?: string;
  email?: RenderedEmail;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Mint a short-lived (5 min) Supabase user JWT for the owner. PostgREST accepts
 *  it (HS256 signature verified against the project JWT secret) and applies RLS
 *  as auth.uid() = sub. NOT usable with auth.getUser — data-plane only. */
function mintOwnerJwt(authUid: string, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const nowS = Math.floor(Date.now() / 1000);
  const payload = b64url(
    Buffer.from(JSON.stringify({ sub: authUid, role: 'authenticated', aud: 'authenticated', iat: nowS, exp: nowS + 300 })),
  );
  const data = `${header}.${payload}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function vizNumberFormat(viz: WidgetViz | undefined): ReportSection['numberFormat'] {
  if (viz && 'number_format' in viz && viz.number_format) return viz.number_format;
  return undefined;
}

function recipientsArray(r: unknown): string[] {
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string' && x.includes('@')) : [];
}

async function deliver(to: string[], email: RenderedEmail): Promise<'sent' | 'draft' | 'skipped'> {
  if (to.length === 0) return 'skipped';
  const key = process.env.RESEND_API_KEY;
  if (!key) return 'draft'; // no provider configured — the rendered email is stored as a draft
  const from = process.env.REPORTS_FROM_EMAIL ?? 'Wassel Reports <reports@wassel.re>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: email.subject, html: email.html, text: email.text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return 'sent';
}

interface ResolvedSection {
  title: string;
  query: AnalyticsQuery;
  numberFormat: ReportSection['numberFormat'];
}

/** Resolve a report's source into one or more (title, query) sections. */
async function resolveSections(service: SupabaseClient, report: ScheduledReport): Promise<ResolvedSection[]> {
  // W4: section titles follow the report's language.
  const isAr = report.language !== 'en';
  const pickLabel = (ar: string | undefined, en: string | undefined) =>
    (isAr ? ar || en : en || ar) ?? '';
  switch (report.source_type) {
    case 'custom': {
      if (!report.query) throw new Error('custom report has no query');
      return [{ title: report.title, query: report.query, numberFormat: undefined }];
    }
    case 'metric': {
      if (!report.metric_id) throw new Error('metric report has no metric_id');
      const { data, error } = await service.from('metric_definitions').select('*').eq('id', report.metric_id).maybeSingle();
      if (error) throw new Error(`load metric: ${error.message}`);
      if (!data) throw new Error('metric not found');
      const m = data as unknown as MetricDefinition;
      return [{ title: pickLabel(m.label_ar, m.label_en), query: m.query, numberFormat: m.format ?? undefined }];
    }
    case 'widget':
    case 'dashboard': {
      if (!report.dashboard_id) throw new Error(`${report.source_type} report has no dashboard_id`);
      const { data, error } = await service.from('dashboards').select('*').eq('id', report.dashboard_id).maybeSingle();
      if (error) throw new Error(`load dashboard: ${error.message}`);
      if (!data) throw new Error('dashboard not found');
      const dash = data as unknown as Dashboard;
      const widgets = (dash.widgets ?? []) as DashboardWidget[];
      const eligible = widgets.filter((w) => w.type !== 'table'); // record-list isn't an AnalyticsResult
      const chosen =
        report.source_type === 'widget'
          ? eligible.filter((w) => w.id === report.widget_id)
          : eligible;
      if (chosen.length === 0) throw new Error('no engine-backed widget found for this report');
      return chosen.map((w) => ({
        title: pickLabel(w.title_ar, w.title_en) || (isAr ? 'عنصر' : 'Widget'),
        query: effectiveQuery(w),
        numberFormat: vizNumberFormat(effectiveViz(w)),
      }));
    }
    default:
      throw new Error(`unknown source_type: ${report.source_type}`);
  }
}

/**
 * Run one report end-to-end and persist the outcome. Always returns a result
 * (never throws) — failures are recorded on the report + a runs row so nothing
 * fails silently. `triggeredBy` distinguishes scheduled vs manual ("Run now").
 */
export async function runReportById(reportId: string, triggeredBy: 'schedule' | 'manual'): Promise<RunReportResult> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!url || !serviceKey || !anonKey) throw new Error('Supabase env missing (URL / service / anon)');

  // T2: identity-tagged service-role client (x-wassel-service='api:reports').
  // serviceKey presence is already asserted above; makeServiceClient reads the
  // same env, so the non-null assertion is safe.
  const service = makeServiceClient('api:reports')!;
  const startedAt = new Date();
  const dataAsOf = startedAt.toISOString();

  // Load the report (service-role — config read; the DATA is owner-scoped below).
  const { data: reportRow, error: repErr } = await service.from('scheduled_reports').select('*').eq('id', reportId).maybeSingle();
  if (repErr) throw new Error(`load report: ${repErr.message}`);
  if (!reportRow) throw new Error('report not found');
  const report = reportRow as unknown as ScheduledReport;
  const recipients = recipientsArray(report.recipients);

  // Compute the next run (Riyadh, via the SQL function — single source of truth).
  const { data: nextRunData } = await service.rpc('scheduled_report_next_run', {
    p_frequency: report.frequency,
    p_hour: report.hour_of_day,
    p_dow: report.day_of_week,
    p_dom: report.day_of_month,
    p_after: dataAsOf,
  });
  const nextRunAt = (nextRunData as string | null) ?? null;

  // Open a runs row.
  const { data: runRow } = await service
    .from('scheduled_report_runs')
    .insert({ report_id: report.id, started_at: dataAsOf, status: 'running', triggered_by: triggeredBy, recipients })
    .select('id')
    .maybeSingle();
  const runId = (runRow as { id: string } | null)?.id ?? null;

  const finish = async (
    status: RunReportResult['status'],
    delivery: 'sent' | 'draft' | 'skipped',
    snapshot: unknown,
    warnings: unknown,
    error: string | null,
  ): Promise<void> => {
    const finishedAt = new Date().toISOString();
    if (runId) {
      await service
        .from('scheduled_report_runs')
        .update({ finished_at: finishedAt, status, data_as_of: dataAsOf, result_snapshot: snapshot, warnings, delivery, error_message: error })
        .eq('id', runId);
    }
    await service
      .from('scheduled_reports')
      .update({
        status: 'active',
        worker_id: null,
        running_since: null,
        last_run_at: dataAsOf,
        next_run_at: nextRunAt,
        last_status: status,
        last_result_snapshot: snapshot,
        error_message: error,
      })
      .eq('id', report.id);
  };

  try {
    if (!report.owner_auth_uid) throw new Error('report has no owner_auth_uid (cannot scope to owner)');

    // Choose the owner-scoped read client (rule: never run unrestricted):
    //  A. SUPABASE_JWT_SECRET present → mint the owner's JWT; PostgREST applies
    //     the owner's EXACT RLS (works for any owner incl. non-admins). Preferred.
    //  B. No secret → allowed ONLY when the owner is an ADMIN, whose scope is full,
    //     so a service-role read EQUALS the owner's scope. Verified via
    //     wassell_is_admin. A non-admin owner is REFUSED (fail safe). Auto-upgrades
    //     to (A) the moment SUPABASE_JWT_SECRET is set.
    let scopedClient: SupabaseClient;
    let scopeMode: 'minted_jwt' | 'admin_service_role';
    if (jwtSecret) {
      const ownerJwt = mintOwnerJwt(report.owner_auth_uid, jwtSecret);
      scopedClient = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${ownerJwt}` } } });
      scopeMode = 'minted_jwt';
    } else {
      const { data: isAdmin, error: adminErr } = await service.rpc('wassell_is_admin', { auth_user_id: report.owner_auth_uid });
      if (adminErr) throw new Error(`admin check failed: ${adminErr.message}`);
      if (!isAdmin) {
        throw new Error('SUPABASE_JWT_SECRET is not set and the report owner is not an admin — refusing to run with an unscoped service-role read (fail safe). Set SUPABASE_JWT_SECRET to enable owner-scoped reports for non-admins.');
      }
      scopedClient = service;
      scopeMode = 'admin_service_role';
    }

    const resolved = await resolveSections(service, report);
    const prepared = await prepareContext(scopedClient);
    const sections: ReportSection[] = [];
    const allWarnings: unknown[] = [];
    for (const s of resolved) {
      const result = await runQueryWithClient(scopedClient, s.query, prepared, { includeRecordIds: false });
      sections.push({ title: s.title, result, numberFormat: s.numberFormat });
      if (result.warnings.length) allWarnings.push({ section: s.title, warnings: result.warnings });
    }

    const link =
      report.dashboard_id && (report.source_type === 'dashboard' || report.source_type === 'widget')
        ? `${process.env.APP_URL ?? 'https://app.wassel.re'}/dashboards/${report.dashboard_id}`
        : null;
    const email = renderReportEmail({
      reportTitle: report.title, sections, dataAsOf, link,
      lang: report.language === 'en' ? 'en' : 'ar',
    });

    const delivery = await deliver(recipients, email);
    const status: RunReportResult['status'] = delivery === 'sent' ? 'sent' : delivery === 'draft' ? 'draft' : 'partial';

    // Snapshot: results WITHOUT record ids (engine ran with includeRecordIds:false) + the rendered email.
    const snapshot = { data_as_of: dataAsOf, delivery, scope_mode: scopeMode, sections: sections.map((s) => ({ title: s.title, result: s.result })), email };
    await finish(status, delivery, snapshot, allWarnings, null);
    return { status, delivery, sections: sections.length, recipients, email };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finish('failed', 'skipped', { data_as_of: dataAsOf, error: msg }, null, msg);
    return { status: 'failed', delivery: 'skipped', sections: 0, recipients, error: msg };
  }
}

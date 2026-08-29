/**
 * /m/performance — the manager desk (surface: performance, cap: manage_performance).
 *
 * Everything a manager decides in the performance system, one screen:
 *   • pending discipline actions (approve / reject; deductions blocked while
 *     observe mode / deductions are off — the SQL refuses, the UI says why)
 *   • pending leave requests + reward claims
 *   • blocked / late open tasks (+ mark blocked / unblock)
 *   • the team: XP totals + this-month late counters
 *   • the load heatmap: capacity vs tasks opened today, per role × bucket
 *   • KPI bonus goals for this month (+ add / delete) with live status
 *   • the global toggles (observe mode, deductions, ratings…)
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  PerfBucket, PerfDesk, PerfKpiGoal, PerfSettings, blockPerfTask, decidePerfDiscipline,
  decidePerfLeave, decidePerfReward, deletePerfKpiGoal, fetchPerfDesk, savePerfKpiGoal,
  savePerfSettings,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Skeleton } from './components/kit';
import { num } from './lib/format';
import { computeDemand, type CapacityRow, type DemandLine } from './lib/coverage';

const BUCKETS: readonly PerfBucket[] = ['post', 'video'];

const ROLE_AR: Record<string, string> = {
  ceo: 'الرئيس التنفيذي', marketing_manager: 'مدير التسويق', ops_supervisor: 'مشرف العمليات',
  writer: 'الكاتب', montage: 'المونتاج',
};

const fmtDate = (iso: string | null | undefined, isAr: boolean): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export default function PerformanceDeskPage() {
  const { isAr, can } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const allowed = can('manage_performance');

  const [desk, setDesk] = useState<PerfDesk | null>(null);
  const [settings, setSettings] = useState<PerfSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [blockId, setBlockId] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [goalOpen, setGoalOpen] = useState(false);
  const [gMetric, setGMetric] = useState<'cpl' | 'ctr'>('cpl');
  const [gTarget, setGTarget] = useState('');
  const [gBonus, setGBonus] = useState('50');
  const [gRoleIds, setGRoleIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchPerfDesk();
      setDesk(d);
      // Settings ride on perf_me for employees; the desk reads them via the
      // config read the toggles PATCH returns. Fetch lazily from the desk's
      // own settings surface: reuse perf_settings via savePerfSettings only
      // on change; initial value comes from a tiny extra call.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Toggles: read once via the config endpoint (RLS lets any reader see them).
  const loadSettings = useCallback(async () => {
    try {
      const { fetchPerfConfig } = await import('@/lib/marketingOS/client');
      const cfg = await fetchPerfConfig();
      setSettings(cfg.settings);
    } catch (e) {
      console.error('[perf-desk] settings read failed', e);
    }
  }, []);

  useEffect(() => { void load(); void loadSettings(); }, [load, loadSettings]);

  const act = async (fn: () => Promise<unknown>, doneAr: string, doneEn: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      addToast(isAr ? doneAr : doneEn, 'success');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (key: keyof PerfSettings): Promise<void> => {
    if (!settings) return;
    try {
      const res = await savePerfSettings({ [key]: !settings[key] });
      setSettings(res.settings);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const saveWorkingDays = async (raw: number): Promise<void> => {
    const days = Math.max(1, Math.min(7, Math.floor(raw)));
    if (!Number.isFinite(days)) return;
    try {
      const res = await savePerfSettings({ production_days_per_week: days });
      setSettings(res.settings);
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const personName = (userId: string): string => {
    const p = desk?.people.find((x) => x.user_id === userId);
    if (!p) return userId.slice(0, 8);
    return (isAr ? p.name_ar : p.name_en) ?? p.name_en ?? p.name_ar ?? userId.slice(0, 8);
  };

  const openedToday = (roleKey: string, bucket: PerfBucket): number => {
    if (!desk) return 0;
    const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    return desk.open_tasks.filter((t) => t.role_key === roleKey && t.bucket === bucket
      && t.opened_at && new Date(new Date(t.opened_at).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10) === today).length;
  };

  const capacityOf = (roleId: string, bucket: PerfBucket): number =>
    desk?.role_load.find((l) => l.role_id === roleId && l.bucket === bucket)?.daily_new_tasks ?? 0;

  const roleKeyById = (roleId: string): string =>
    (desk?.roles.find((r) => r.id === roleId)?.key ?? '').replace(/^mos_/, '');
  const roleLabel = (k: string | null): string => (k && isAr ? (ROLE_AR[k] ?? k) : (k ?? ''));

  // Distribution demand (placements, Σ platforms) vs PRODUCTION demand (unique
  // creatives, max across platforms — content is reused) vs production capacity
  // (slowest producer stage × working days). Shared with the coverage report so
  // the two surfaces never disagree.
  const demandLines: DemandLine[] = desk
    ? computeDemand(
      desk.posting_targets,
      desk.role_load.map((l): CapacityRow => ({
        role_key: roleKeyById(l.role_id), bucket: l.bucket, per_day: l.daily_new_tasks,
      })).filter((c) => c.role_key && c.per_day > 0),
      desk.production_days_per_week,
    )
    : [];

  const saveGoal = async (): Promise<void> => {
    const target = Number(gTarget);
    const bonus = Number(gBonus);
    if (!Number.isFinite(target) || !Number.isFinite(bonus) || bonus <= 0) {
      addToast(isAr ? 'حدد الهدف ونسبة المكافأة.' : 'Set the target and the bonus percent.', 'error');
      return;
    }
    setBusy(true);
    try {
      await savePerfKpiGoal(
        {
          metric: gMetric,
          comparator: gMetric === 'cpl' ? 'lte' : 'gte',
          target: gMetric === 'ctr' ? target / 100 : target,
          bonus_pct: bonus,
        },
        gRoleIds.map((id) => ({ subject_kind: 'role', subject_id: id })),
      );
      addToast(isAr ? 'حُفظ الهدف.' : 'Goal saved.', 'success');
      setGoalOpen(false);
      setGTarget('');
      setGRoleIds([]);
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const goalStatus = (g: PerfKpiGoal): string => {
    if (!g.result) return isAr ? 'لم يُقيَّم' : 'not evaluated';
    if (g.result.hit) return isAr ? 'محقّق ✓' : 'Hit ✓';
    if (g.result.actual === null) return isAr ? 'لا بيانات' : 'no data';
    const shown = g.metric === 'ctr'
      ? `${num(Math.round(g.result.actual * 10000) / 100, isAr)}%`
      : num(Math.round(g.result.actual * 100) / 100, isAr);
    return `${isAr ? 'حاليًا' : 'now'} ${shown}`;
  };

  if (!allowed) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'هذه الشاشة لمن يملك صلاحية إدارة الأداء.' : 'This screen needs the manage_performance capability.'}</div>
      </div>
    );
  }

  const deductionsLive = settings ? (!settings.discipline_observe && settings.deductions_enabled) : false;

  return (
    <>
      <PageHead
        title={isAr ? 'مكتب الأداء' : 'Performance desk'}
        sub={isAr
          ? 'القرارات المعلّقة، وحمل الفريق، وأهداف المكافآت — في مكان واحد.'
          : 'Pending decisions, the team\'s load, and bonus goals — one place.'}
      >
        <button type="button" className="btn btn-p" onClick={() => setGoalOpen(true)}>
          {isAr ? 'هدف مكافأة جديد' : 'New bonus goal'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={7} />}

        {!loading && desk && (
          <>
            {settings && (settings.discipline_observe || !settings.deductions_enabled) && (
              <div className="notice" style={{ marginBottom: 16 }}>
                {isAr
                  ? 'وضع المراقبة: التأخيرات تُسجَّل لكن الخصومات لا يمكن اعتمادها حتى يُفعَّل النظام من المفاتيح أدناه.'
                  : 'Observe mode: lateness is recorded, but deductions cannot be approved until the toggles below switch the system on.'}
              </div>
            )}

            {/* ── pending decisions ───────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h">
                <h4>
                  {isAr ? 'قرارات معلّقة' : 'Pending decisions'}
                  {' '}
                  <span className="tag">{num(desk.pending_actions.length + desk.pending_leaves.length + desk.pending_claims.length, isAr)}</span>
                </h4>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 8 }}>
                {desk.pending_actions.length === 0 && desk.pending_leaves.length === 0 && desk.pending_claims.length === 0 && (
                  <Empty title={isAr ? 'لا شيء بانتظارك' : 'Nothing waiting on you'} />
                )}
                {desk.pending_actions.map((a) => (
                  <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', borderBottom: '1px solid var(--line, #eee)', paddingBottom: 8 }}>
                    <div>
                      <b style={{ fontSize: 13 }}>
                        {a.kind === 'deduction'
                          ? (isAr ? `خصم يوم — ${personName(a.user_id)}` : `Day deduction — ${personName(a.user_id)}`)
                          : (isAr ? `إنذار ${num(a.ordinal, isAr)} — ${personName(a.user_id)}` : `Warning #${a.ordinal} — ${personName(a.user_id)}`)}
                      </b>
                      <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                        {a.month_key}
                        {a.status === 'disputed' && a.dispute_note && ` · ${isAr ? 'اعتراض:' : 'dispute:'} ${a.dispute_note}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button" className="btn btn-p btn-sm"
                        disabled={busy || (a.kind === 'deduction' && !deductionsLive)}
                        title={a.kind === 'deduction' && !deductionsLive
                          ? (isAr ? 'الخصومات غير مفعّلة' : 'Deductions are off') : undefined}
                        onClick={() => void act(() => decidePerfDiscipline(a.id, true), 'اعتُمد.', 'Approved.')}
                      >
                        {isAr ? 'اعتماد' : 'Approve'}
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy}
                        onClick={() => void act(() => decidePerfDiscipline(a.id, false), 'رُفض.', 'Rejected.')}>
                        {isAr ? 'رفض' : 'Reject'}
                      </button>
                    </div>
                  </div>
                ))}
                {desk.pending_leaves.map((l) => (
                  <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', borderBottom: '1px solid var(--line, #eee)', paddingBottom: 8 }}>
                    <div>
                      <b style={{ fontSize: 13 }}>{isAr ? `إجازة — ${personName(l.user_id)}` : `Leave — ${personName(l.user_id)}`}</b>
                      <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                        {fmtDate(l.start_at, isAr)} ← {fmtDate(l.end_at, isAr)}{l.note ? ` · ${l.note}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-p btn-sm" disabled={busy}
                        onClick={() => void act(() => decidePerfLeave(l.id, true), 'اعتُمدت الإجازة ومُدّدت المواعيد.', 'Leave approved; due dates shifted.')}>
                        {isAr ? 'اعتماد' : 'Approve'}
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy}
                        onClick={() => void act(() => decidePerfLeave(l.id, false), 'رُفضت الإجازة.', 'Leave rejected.')}>
                        {isAr ? 'رفض' : 'Reject'}
                      </button>
                    </div>
                  </div>
                ))}
                {desk.pending_claims.map((c) => (
                  <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div>
                      <b style={{ fontSize: 13 }}>{isAr ? `مكافأة — ${personName(c.user_id)}` : `Reward — ${personName(c.user_id)}`}</b>
                      <div style={{ fontSize: 11, color: 'var(--mute)' }}>{num(c.cost_xp, isAr)} XP</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-p btn-sm" disabled={busy}
                        onClick={() => void act(() => decidePerfReward(c.id, true), 'اعتُمدت المكافأة.', 'Reward approved.')}>
                        {isAr ? 'اعتماد' : 'Approve'}
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy}
                        onClick={() => void act(() => decidePerfReward(c.id, false), 'رُفضت المكافأة.', 'Reward rejected.')}>
                        {isAr ? 'رفض' : 'Reject'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── load heatmap + structural gap ───────────────────────── */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h"><h4>{isAr ? 'حمل اليوم مقابل الطاقة' : 'Today\'s load vs capacity'}</h4></div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'الدور' : 'Role'}</th>
                      {BUCKETS.map((b) => (
                        <th key={b} style={{ width: 160 }}>
                          {b === 'post' ? (isAr ? 'منشورات' : 'Posts') : (isAr ? 'فيديوهات' : 'Videos')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {desk.roles.map((r) => {
                      const key = r.key.replace(/^mos_/, '');
                      return (
                        <tr key={r.id}>
                          <td className="ttl">{isAr ? r.label_ar : r.label_en}</td>
                          {BUCKETS.map((b) => {
                            const cap = capacityOf(r.id, b);
                            const used = openedToday(key, b);
                            const over = cap > 0 && used >= cap;
                            return (
                              <td key={b} style={{ fontSize: 12, color: over ? 'var(--bad, #b3261e)' : undefined }}>
                                {cap > 0 ? `${num(used, isAr)} / ${num(cap, isAr)}` : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="card-b" style={{ fontSize: 11.5, color: 'var(--mute)', display: 'grid', gap: 8 }}>
                {demandLines.map((d) => {
                  const bl = d.bucket === 'post' ? (isAr ? 'منشورات' : 'Posts') : (isAr ? 'فيديوهات' : 'Videos');
                  return (
                    <div key={d.bucket} style={{ display: 'grid', gap: 2 }}>
                      <div style={{ fontWeight: 700, color: 'var(--ink)' }}>
                        {bl}
                        {d.short && (
                          <b style={{ color: 'var(--bad, #b3261e)', marginInlineStart: 8 }}>
                            {isAr ? `— عجز إنتاج ${num(d.productionGapPerWeek, isAr)}/أسبوع` : `— production gap ${d.productionGapPerWeek}/week`}
                          </b>
                        )}
                      </div>
                      <div>
                        {isAr
                          ? `احتياج النشر ${num(d.distributionPerWeek, isAr)}/أسبوع (${num(d.distributionPerDay, isAr)}/يوم موضِعًا)`
                          : `distribution demand ${d.distributionPerWeek}/week (${d.distributionPerDay}/day placements)`}
                      </div>
                      <div style={{ fontWeight: 700, color: 'var(--ink)' }}>
                        {isAr
                          ? `احتياج الإنتاج الفعلي ${num(d.productionPerWeek, isAr)}/أسبوع (${num(d.productionPerDay, isAr)}/يوم فريد)`
                          : `actual production demand ${d.productionPerWeek}/week (${d.productionPerDay}/day unique)`}
                      </div>
                      <div style={d.short ? { color: 'var(--bad, #b3261e)', fontWeight: 700 } : { color: 'var(--go, #3f6b52)' }}>
                        {d.capacityPerWorkingDay > 0
                          ? (isAr
                            ? `طاقة الإنتاج ${num(d.capacityPerWeek, isAr)}/أسبوع (${num(d.capacityPerWorkingDay, isAr)}/يوم عمل${d.bottleneckRole ? ` — اختناق: ${roleLabel(d.bottleneckRole)}` : ''})`
                            : `production capacity ${d.capacityPerWeek}/week (${d.capacityPerWorkingDay}/working-day${d.bottleneckRole ? ` — bottleneck: ${d.bottleneckRole}` : ''})`)
                          : (isAr ? 'لا طاقة إنتاج مُعدّة' : 'no production capacity set')}
                      </div>
                    </div>
                  );
                })}
                <div style={{ fontSize: 10.5 }}>
                  {isAr
                    ? 'الطاقة تُقارَن بالإنتاج الفريد لا بالنشر. القطعة الواحدة تُنشر على عدة منصات وإعلانات لكنها تُنتَج مرة واحدة.'
                    : 'Capacity is compared to unique production, not distribution. One creative is placed on many platforms and ads but produced once.'}
                </div>
              </div>
            </div>

            {/* ── flagged tasks ───────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h"><h4>{isAr ? 'مهام متأخرة أو معلّقة' : 'Late or blocked tasks'}</h4></div>
              {desk.flagged_tasks.length === 0
                ? <div className="card-b"><Empty title={isAr ? 'لا شيء متعثّر' : 'Nothing stuck'} /></div>
                : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>{isAr ? 'الخطوة' : 'Step'}</th>
                          <th style={{ width: 140 }}>{isAr ? 'المكلّف' : 'Assignee'}</th>
                          <th style={{ width: 150 }}>{isAr ? 'الموعد' : 'Due'}</th>
                          <th style={{ width: 100 }}>{isAr ? 'الحالة' : 'State'}</th>
                          <th style={{ width: 110 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {desk.flagged_tasks.map((t) => (
                          <tr key={t.id}>
                            <td className="ttl">{t.step_key} <span className="tag">{t.role_key}</span></td>
                            <td style={{ fontSize: 12 }}>{t.assignee_user_id ? personName(t.assignee_user_id) : '—'}</td>
                            <td style={{ fontSize: 12 }}>{fmtDate(t.due_at, isAr)}</td>
                            <td>
                              {t.blocked
                                ? <span className="tag">{isAr ? 'معلّقة' : 'Blocked'}</span>
                                : <span className="tag" style={{ color: 'var(--bad, #b3261e)' }}>{isAr ? 'متأخرة' : 'Late'}</span>}
                            </td>
                            <td>
                              {t.blocked
                                ? (
                                  <button type="button" className="btn btn-sm" disabled={busy}
                                    onClick={() => void act(
                                      () => blockPerfTask({ task_id: t.id, blocked: false }),
                                      'أُلغي التعليق ومُدّد الموعد.', 'Unblocked; due extended.',
                                    )}>
                                    {isAr ? 'إلغاء التعليق' : 'Unblock'}
                                  </button>
                                )
                                : (
                                  <button type="button" className="btn btn-sm" disabled={busy}
                                    onClick={() => { setBlockId(t.id); setBlockReason(''); }}>
                                    {isAr ? 'تعليق' : 'Block'}
                                  </button>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>

            {/* ── team + goals + toggles ──────────────────────────────── */}
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'الفريق' : 'The team'}</h4></div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{isAr ? 'الشخص' : 'Person'}</th>
                        <th style={{ width: 80 }}>XP</th>
                        <th style={{ width: 110 }}>{isAr ? 'تأخيرات الشهر' : 'Late (month)'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {desk.people.map((p) => (
                        <tr key={p.user_id}>
                          <td className="ttl">
                            {(isAr ? p.name_ar : p.name_en) ?? p.name_en ?? p.name_ar}
                            <div style={{ fontSize: 10.5, color: 'var(--mute)', fontWeight: 400 }}>
                              {p.roles.map((r) => r.replace(/^mos_/, '')).join(' · ')}
                            </div>
                          </td>
                          <td>{num(p.xp_total, isAr)}</td>
                          <td style={p.late_this_month >= 3 ? { color: 'var(--bad, #b3261e)', fontWeight: 700 } : undefined}>
                            {num(p.late_this_month, isAr)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? `أهداف ${desk.month}` : `${desk.month} goals`}</h4></div>
                <div className="card-b" style={{ display: 'grid', gap: 8 }}>
                  {desk.kpi_goals.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--mute)' }}>
                      {isAr ? 'لا أهداف بعد — أضف CPL أو CTR بهدفٍ ونسبة مكافأة.' : 'No goals yet — add CPL or CTR with a target and a bonus percent.'}
                    </div>
                  )}
                  {desk.kpi_goals.map((g) => (
                    <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--line, #eee)', paddingBottom: 6 }}>
                      <div>
                        <b style={{ fontSize: 13 }}>
                          {g.metric.toUpperCase()} {g.comparator === 'lte' ? '≤' : '≥'}{' '}
                          {g.metric === 'ctr' ? `${num(g.target * 100, isAr)}%` : num(g.target, isAr)}
                        </b>
                        <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                          +{num(g.bonus_pct, isAr)}% · {goalStatus(g)}
                        </div>
                      </div>
                      <button type="button" className="btn btn-sm" disabled={busy}
                        onClick={() => void act(() => deletePerfKpiGoal(g.id), 'حُذف الهدف.', 'Goal deleted.')}>
                        {isAr ? 'حذف' : 'Delete'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {settings && (
                <div className="card">
                  <div className="card-h"><h4>{isAr ? 'مفاتيح النظام' : 'System toggles'}</h4></div>
                  <div className="card-b" style={{ display: 'grid', gap: 10 }}>
                    {([
                      ['ratings_enabled', 'التقييمات', 'Ratings'],
                      ['xp_rewards_enabled', 'النقاط والمكافآت', 'XP & rewards'],
                      ['discipline_observe', 'وضع المراقبة (بلا عواقب)', 'Observe mode (no consequences)'],
                      ['deductions_enabled', 'الخصومات', 'Deductions'],
                      ['kpi_bonus_enabled', 'مكافآت المؤشرات', 'KPI bonuses'],
                      ['cadence_enabled', 'إيقاع النشر', 'Posting cadence'],
                    ] as Array<[keyof PerfSettings, string, string]>).map(([key, ar, en]) => (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13 }}>{isAr ? ar : en}</span>
                        <button
                          type="button"
                          className={`sw${settings[key] ? ' on' : ''}`}
                          aria-label={isAr ? ar : en}
                          onClick={() => void toggle(key)}
                        />
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                      <span style={{ fontSize: 13 }}>
                        {isAr ? 'أيام العمل في الأسبوع' : 'Working days / week'}
                        <span style={{ fontSize: 10.5, color: 'var(--mute)', display: 'block' }}>
                          {isAr ? 'الإنتاج ٦ · النشر ٧ — تُقسِّم الطاقة الأسبوعية' : 'production 6 · publishing 7 — divides weekly capacity'}
                        </span>
                      </span>
                      <input
                        type="number" min={1} max={7} className="inp ltr" style={{ width: 64 }}
                        defaultValue={settings.production_days_per_week}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== settings.production_days_per_week) void saveWorkingDays(v);
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                      {isAr
                        ? 'لتفعيل الخصومات فعليًا: أطفئ وضع المراقبة وفعّل الخصومات.'
                        : 'To make deductions real: switch observe mode OFF and deductions ON.'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {blockId && (
        <Modal
          title={isAr ? 'تعليق المهمة' : 'Block this task'}
          sub={isAr ? 'المهمة المعلّقة لا تُحتسب متأخرة، ويُمدَّد موعدها بمدة التعليق.' : 'A blocked task never counts late; its due extends by the block\'s duration.'}
          onClose={() => setBlockId(null)}
          footer={(
            <>
              <button type="button" className="btn btn-p" disabled={busy || !blockReason.trim()}
                onClick={() => void act(
                  () => blockPerfTask({ task_id: blockId, blocked: true, reason: blockReason.trim() })
                    .finally(() => setBlockId(null)),
                  'عُلّقت المهمة.', 'Task blocked.',
                )}>
                {isAr ? 'تعليق' : 'Block'}
              </button>
              <button type="button" className="btn" onClick={() => setBlockId(null)}>{isAr ? 'إلغاء' : 'Cancel'}</button>
            </>
          )}
        >
          <Field label={isAr ? 'سبب التعليق' : 'Why it is blocked'}>
            <textarea className="inp" rows={3} value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
          </Field>
        </Modal>
      )}

      {goalOpen && (
        <Modal
          title={isAr ? 'هدف مكافأة جديد' : 'New bonus goal'}
          sub={isAr ? 'يُقاس على أرقام الشهر الحالي من إعلانات ميتا.' : 'Measured on this month\'s Meta ad numbers.'}
          onClose={() => setGoalOpen(false)}
          footer={(
            <>
              <button type="button" className="btn btn-p" disabled={busy} onClick={() => void saveGoal()}>
                {isAr ? 'حفظ' : 'Save'}
              </button>
              <button type="button" className="btn" onClick={() => setGoalOpen(false)}>{isAr ? 'إلغاء' : 'Cancel'}</button>
            </>
          )}
        >
          <div style={{ display: 'grid', gap: 13 }}>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'المؤشر' : 'Metric'}</div>
              <div className="seg">
                <button type="button" className={gMetric === 'cpl' ? 'on' : ''} onClick={() => setGMetric('cpl')}>
                  CPL ({isAr ? 'الأقل أفضل' : 'lower is better'})
                </button>
                <button type="button" className={gMetric === 'ctr' ? 'on' : ''} onClick={() => setGMetric('ctr')}>
                  CTR ({isAr ? 'الأكثر أفضل' : 'higher is better'})
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
              <Field label={gMetric === 'cpl' ? (isAr ? 'الهدف (ريال/عميل)' : 'Target (SAR/lead)') : (isAr ? 'الهدف (%)' : 'Target (%)')}>
                <input className="inp ltr" type="number" min={0} step="any" value={gTarget} onChange={(e) => setGTarget(e.target.value)} />
              </Field>
              <Field label={isAr ? 'المكافأة (% من الراتب)' : 'Bonus (% of salary)'}>
                <input className="inp ltr" type="number" min={1} value={gBonus} onChange={(e) => setGBonus(e.target.value)} />
              </Field>
            </div>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'المستفيدون (أدوار)' : 'Recipients (roles)'}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(desk?.roles ?? []).map((r) => {
                  const on = gRoleIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`btn btn-sm${on ? ' btn-p' : ''}`}
                      onClick={() => setGRoleIds((ids) => (on ? ids.filter((x) => x !== r.id) : [...ids, r.id]))}
                    >
                      {isAr ? r.label_ar : r.label_en}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

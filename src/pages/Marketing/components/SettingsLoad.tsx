/**
 * Settings → Load & SLA (the capacity engine's config).
 *
 * Three grids over the perf config (spec: docs/marketing-task-load-plan.md):
 *   1. Daily load  — per (role × bucket): how many NEW tasks may land in one
 *      person's queue per day. 0 = the role is not a producer of that bucket.
 *   2. SLA hours   — per (role × bucket): how long a stage-task gets from the
 *      moment it OPENS. Empty = fall back to the workflow step's due_days.
 *   3. Buckets     — which load bucket each content type draws from.
 *
 * Placement runs in the database (mos_perf_place_open_task); this screen only
 * edits the numbers it reads. Writes are RLS-gated on manage_roles.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  PerfBucket, PerfConfig, fetchPerfConfig, savePerfLoad,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';

const BUCKETS: readonly PerfBucket[] = ['post', 'video'];

export default function SettingsLoad({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { contentTypes } = useWorkspace();
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [config, setConfig] = useState<PerfConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Draft copies of the three grids, keyed for O(1) edits.
  const [load, setLoad] = useState<Map<string, number>>(new Map());
  const [sla, setSla] = useState<Map<string, string>>(new Map());
  const [buckets, setBuckets] = useState<Map<string, PerfBucket>>(new Map());

  const loadKey = (roleId: string, bucket: string): string => `${roleId}|${bucket}`;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await fetchPerfConfig();
      setConfig(cfg);
      const l = new Map<string, number>();
      for (const r of cfg.role_load) l.set(loadKey(r.role_id, r.bucket), r.daily_new_tasks);
      setLoad(l);
      const s = new Map<string, string>();
      // The grid edits the (role × bucket) any-step rows; finer per-step rows
      // stay untouched (they exist only if written by hand).
      for (const r of cfg.role_sla) {
        if (r.step_key === '*') s.set(loadKey(r.role_id, r.bucket), String(r.sla_hours));
      }
      setSla(s);
      const b = new Map<string, PerfBucket>();
      for (const r of cfg.buckets) b.set(r.content_type_id, r.bucket);
      setBuckets(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const save = async (): Promise<void> => {
    if (!config) return;
    setBusy(true);
    try {
      const roleLoad = config.roles.flatMap((r) => BUCKETS.map((b) => ({
        role_id: r.id, bucket: b,
        daily_new_tasks: load.get(loadKey(r.id, b)) ?? 0,
      })));
      const roleSla = config.roles.flatMap((r) => {
        const rows: Array<{ role_id: string; bucket: PerfBucket | '*'; step_key: string; sla_hours: number }> = [];
        for (const b of [...BUCKETS, '*'] as Array<PerfBucket | '*'>) {
          const raw = sla.get(loadKey(r.id, b));
          if (raw === undefined) continue;
          // Blank = delete the rule (the API deletes non-positive rows).
          rows.push({ role_id: r.id, bucket: b, step_key: '*', sla_hours: Number(raw) || 0 });
        }
        return rows;
      });
      const bucketRows = Array.from(buckets.entries()).map(([content_type_id, bucket]) => ({
        content_type_id, bucket,
      }));
      await savePerfLoad({ role_load: roleLoad, role_sla: roleSla, buckets: bucketRows });
      addToast(isAr ? 'حُفظت إعدادات الطاقة.' : 'Load settings saved.', 'success');
      void reload();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (key: string, ar: string, en: string): string => (isAr ? ar : en) || key;

  return (
    <>
      <PageHead
        title={isAr ? 'طاقة العمل والمُهَل' : 'Load & SLA'}
        sub={isAr
          ? 'كم مهمة جديدة تصل لكل دور يوميًا، وكم ساعة تُمهَل كل مهمة قبل اعتبارها متأخرة.'
          : 'How many new tasks land per role per day, and how many hours each task gets before it counts as late.'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && (
          <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy || loading}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void reload()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}

        {!loading && config && (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h">
                <h4>{isAr ? 'الحمل اليومي — مهام جديدة لكل شخص' : 'Daily load — new tasks per person'}</h4>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'الدور' : 'Role'}</th>
                      <th style={{ width: 140 }}>{isAr ? 'منشورات / يوم' : 'Posts / day'}</th>
                      <th style={{ width: 140 }}>{isAr ? 'فيديوهات / يوم' : 'Videos / day'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.roles.map((r) => (
                      <tr key={r.id}>
                        <td className="ttl">{roleLabel(r.key, r.label_ar, r.label_en)}</td>
                        {BUCKETS.map((b) => (
                          <td key={b}>
                            <input
                              className="inp ltr"
                              type="number"
                              min={0}
                              style={{ width: 90 }}
                              disabled={!canManage}
                              value={load.get(loadKey(r.id, b)) ?? 0}
                              onChange={(e) => {
                                const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                                setLoad((m) => new Map(m).set(loadKey(r.id, b), v));
                              }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h">
                <h4>{isAr ? 'المُهَل — ساعات لكل مهمة من لحظة فتحها' : 'SLA — hours per task from the moment it opens'}</h4>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'الدور' : 'Role'}</th>
                      <th style={{ width: 140 }}>{isAr ? 'منشور (ساعات)' : 'Post (hours)'}</th>
                      <th style={{ width: 140 }}>{isAr ? 'فيديو (ساعات)' : 'Video (hours)'}</th>
                      <th style={{ width: 160 }}>{isAr ? 'أي مهمة (ساعات)' : 'Any task (hours)'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.roles.map((r) => (
                      <tr key={r.id}>
                        <td className="ttl">{roleLabel(r.key, r.label_ar, r.label_en)}</td>
                        {([...BUCKETS, '*'] as Array<PerfBucket | '*'>).map((b) => (
                          <td key={b}>
                            <input
                              className="inp ltr"
                              type="number"
                              min={0}
                              step={0.5}
                              style={{ width: 90 }}
                              placeholder={isAr ? '—' : '—'}
                              disabled={!canManage}
                              value={sla.get(loadKey(r.id, b)) ?? ''}
                              onChange={(e) => {
                                setSla((m) => new Map(m).set(loadKey(r.id, b), e.target.value));
                              }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-b" style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr
                  ? 'كل مهمة تُمهَل يوم عمل واحد كحد أقصى (٢٤ ساعة)، والساعة تتوقف يوم الجمعة (يوم العطلة) والإجازة المعتمدة — فلا تُحتسب مهمة متأخرة في وقت لا يعمل فيه أحد. القيم هنا لا تتجاوز ٢٤. الأولوية: مهلة النوع المحدد ثم «أي مهمة».'
                  : 'Every task gets at most one working day (24h); the clock pauses on Friday (the day off) and during approved leave, so nothing counts late in off-hours. Values here are capped at 24. Precedence: the bucket-specific hours, then "any task".'}
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'أنواع المحتوى وأوعية الحمل' : 'Content types → load buckets'}</h4>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'النوع' : 'Type'}</th>
                      <th style={{ width: 220 }}>{isAr ? 'الوعاء' : 'Bucket'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contentTypes.map((t) => (
                      <tr key={t.id}>
                        <td className="ttl">{isAr ? t.label_ar : t.label_en}</td>
                        <td>
                          <div className="seg">
                            {BUCKETS.map((b) => (
                              <button
                                key={b}
                                type="button"
                                className={(buckets.get(t.id) ?? (t.key === 'video' ? 'video' : 'post')) === b ? 'on' : ''}
                                disabled={!canManage}
                                onClick={() => setBuckets((m) => new Map(m).set(t.id, b))}
                              >
                                {b === 'post' ? (isAr ? 'منشور' : 'Post') : (isAr ? 'فيديو' : 'Video')}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

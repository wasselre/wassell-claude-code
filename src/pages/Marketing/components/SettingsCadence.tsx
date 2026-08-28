/**
 * Settings → Posting cadence (the demand engine's config).
 *
 * Per platform × bucket: how many pieces we WANT out per day, with optional
 * per-weekday overrides. The coverage calendar (/m/calendar) reads these as
 * its targets; nothing here auto-publishes anything.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  PerfBucket, PerfPostingTarget, deletePerfTarget, fetchPerfConfig, savePerfTarget,
} from '@/lib/marketingOS/client';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num } from '../lib/format';

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'website'];
const WEEKDAYS_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function SettingsCadence({
  canManage, isAr,
}: {
  canManage: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [targets, setTargets] = useState<PerfPostingTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-row draft.
  const [dPlatform, setDPlatform] = useState('instagram');
  const [dBucket, setDBucket] = useState<PerfBucket>('post');
  const [dPerDay, setDPerDay] = useState(1);
  const [dWeekday, setDWeekday] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await fetchPerfConfig();
      setTargets(cfg.posting_targets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const add = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await savePerfTarget({
        platform: dPlatform, bucket: dBucket, per_day: dPerDay,
        weekday: dWeekday, active: true,
      });
      setTargets((t) => [...t, res.target]);
      addToast(isAr ? 'أُضيف الهدف.' : 'Target added.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (t: PerfPostingTarget, p: Partial<PerfPostingTarget>): Promise<void> => {
    try {
      const res = await savePerfTarget({ ...t, ...p });
      setTargets((ts) => ts.map((x) => (x.id === t.id ? res.target : x)));
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const remove = async (t: PerfPostingTarget): Promise<void> => {
    try {
      await deletePerfTarget(t.id);
      setTargets((ts) => ts.filter((x) => x.id !== t.id));
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const perDayTotal = (platform: string): number =>
    targets.filter((t) => t.platform === platform && t.active && t.weekday === null)
      .reduce((s, t) => s + t.per_day, 0);

  return (
    <>
      <PageHead
        title={isAr ? 'إيقاع النشر' : 'Posting cadence'}
        sub={isAr
          ? 'كم منشورًا وفيديو نريد يوميًا على كل منصة — تقويم التغطية يقيس الفعلي على هذه الأهداف.'
          : 'How many posts and videos we want per platform per day — the coverage calendar measures actuals against these.'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      />

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void reload()} isAr={isAr} />}
        {loading && <Skeleton rows={5} />}

        {!loading && (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'المنصة' : 'Platform'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'النوع' : 'Bucket'}</th>
                      <th style={{ width: 120 }}>{isAr ? 'يوميًا' : 'Per day'}</th>
                      <th style={{ width: 130 }}>{isAr ? 'اليوم' : 'Weekday'}</th>
                      <th style={{ width: 60 }}>{isAr ? 'نشط' : 'Active'}</th>
                      <th style={{ width: 70 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {targets.map((t) => (
                      <tr key={t.id} style={t.active ? undefined : { opacity: 0.55 }}>
                        <td className="ttl">{t.platform}</td>
                        <td style={{ fontSize: 12 }}>
                          {t.bucket === 'post' ? (isAr ? 'منشور' : 'Post') : (isAr ? 'فيديو' : 'Video')}
                        </td>
                        <td>
                          <input
                            className="inp ltr"
                            type="number"
                            min={0}
                            style={{ width: 76 }}
                            disabled={!canManage}
                            value={t.per_day}
                            onChange={(e) => void patch(t, {
                              per_day: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                            })}
                          />
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {t.weekday === null
                            ? (isAr ? 'كل يوم' : 'Every day')
                            : (isAr ? WEEKDAYS_AR[t.weekday] : WEEKDAYS_EN[t.weekday])}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`sw${t.active ? ' on' : ''}`}
                            disabled={!canManage}
                            aria-label={isAr ? 'تفعيل الهدف' : 'Toggle the target'}
                            onClick={() => void patch(t, { active: !t.active })}
                          />
                        </td>
                        <td>
                          {canManage && (
                            <button type="button" className="btn btn-sm" onClick={() => void remove(t)}>
                              {isAr ? 'حذف' : 'Delete'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-b" style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {PLATFORMS.filter((p) => perDayTotal(p) > 0).map((p) => (
                  <span key={p} className="tag" style={{ marginInlineEnd: 6 }}>
                    {p}: {num(perDayTotal(p), isAr)}/{isAr ? 'يوم' : 'day'}
                  </span>
                ))}
              </div>
            </div>

            {canManage && (
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'هدف جديد' : 'New target'}</h4></div>
                <div className="card-b" style={{ display: 'flex', gap: 13, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'المنصة' : 'Platform'}</div>
                    <select className="inp" value={dPlatform} onChange={(e) => setDPlatform(e.target.value)}>
                      {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'النوع' : 'Bucket'}</div>
                    <div className="seg">
                      <button type="button" className={dBucket === 'post' ? 'on' : ''} onClick={() => setDBucket('post')}>
                        {isAr ? 'منشور' : 'Post'}
                      </button>
                      <button type="button" className={dBucket === 'video' ? 'on' : ''} onClick={() => setDBucket('video')}>
                        {isAr ? 'فيديو' : 'Video'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'يوميًا' : 'Per day'}</div>
                    <input
                      className="inp ltr"
                      type="number"
                      min={0}
                      style={{ width: 80 }}
                      value={dPerDay}
                      onChange={(e) => setDPerDay(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    />
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'اليوم' : 'Weekday'}</div>
                    <select
                      className="inp"
                      value={dWeekday === null ? '' : String(dWeekday)}
                      onChange={(e) => setDWeekday(e.target.value === '' ? null : Number(e.target.value))}
                    >
                      <option value="">{isAr ? 'كل يوم' : 'Every day'}</option>
                      {WEEKDAYS_EN.map((d, i) => (
                        <option key={d} value={i}>{isAr ? WEEKDAYS_AR[i] : d}</option>
                      ))}
                    </select>
                  </div>
                  <button type="button" className="btn btn-p" onClick={() => void add()} disabled={busy}>
                    {busy ? (isAr ? 'جارٍ الإضافة…' : 'Adding…') : isAr ? 'إضافة' : 'Add'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

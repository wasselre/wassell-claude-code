/**
 * Weekly numbers — design screen 49.
 *
 * One screen, one sitting: every published post, oldest reading first, with the
 * three boxes right there. This exists because manual entry was a deliberate
 * decision (answer 3: «نعم سندخل الأرقام يدويًا في البداية») and a decision like
 * that only survives if the entry takes ten minutes, not an afternoon.
 *
 * Empty is not zero. A row left blank simply records nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosPublication, MosTitleRef, PLATFORM_LABELS, fetchMetricsQueue, recordMetrics,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Skeleton } from './components/kit';
import { daysAgo, num, shortDate } from './lib/format';

interface Draft { views: string; engagement: string; enquiries: string }

export default function NumbersPage() {
  const { isAr, can } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [rows, setRows] = useState<MosPublication[]>([]);
  const [titles, setTitles] = useState<MosTitleRef[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [staleOnly, setStaleOnly] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMetricsQueue();
      setRows(res.publications);
      setTitles(res.titles);
      setDrafts({});
      setSaved(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const isStale = (p: MosPublication): boolean =>
    !p.latest_captured_at || new Date(p.latest_captured_at).getTime() < weekAgo;

  const visible = staleOnly ? rows.filter(isStale) : rows;
  const parse = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  const set = (id: string, key: keyof Draft, value: string): void => {
    setDrafts((d) => ({
      ...d,
      [id]: { views: '', engagement: '', enquiries: '', ...(d[id] ?? {}), [key]: value },
    }));
  };

  const filled = Object.entries(drafts).filter(([, d]) =>
    parse(d.views) !== null || parse(d.engagement) !== null || parse(d.enquiries) !== null);

  const saveAll = async (): Promise<void> => {
    if (filled.length === 0) return;
    setBusy(true);
    const ok = new Set(saved);
    const failures: string[] = [];
    // Sequential on purpose: each row is its own append, and a failure part-way
    // must leave the rows that DID save recorded rather than rolled back.
    for (const [id, d] of filled) {
      try {
        await recordMetrics(id, {
          views: parse(d.views),
          engagement: parse(d.engagement),
          enquiries: parse(d.enquiries),
        });
        ok.add(id);
      } catch (e) {
        console.error('[marketing] metric row failed', id, e);
        failures.push(id);
      }
    }
    setSaved(ok);
    setBusy(false);
    if (failures.length === 0) {
      addToast(
        isAr ? `سُجِّلت ${num(filled.length, true)} قراءة.` : `Recorded ${filled.length} readings.`,
        'success',
      );
    } else {
      // Partial success is reported as partial — never as success.
      addToast(
        isAr
          ? `سُجِّلت ${num(filled.length - failures.length, true)} قراءة، وفشلت ${num(failures.length, true)}.`
          : `Recorded ${filled.length - failures.length}, ${failures.length} failed.`,
        'error',
      );
    }
  };

  const titleOf = (contentId: string): MosTitleRef | undefined => titles.find((t) => t.id === contentId);

  return (
    <>
      <PageHead
        title={isAr ? 'أرقام الأسبوع' : 'Weekly numbers'}
        sub={isAr
          ? `${num(visible.length, true)} منشورًا بحاجة لقراءة`
          : `${visible.length} posts need a reading`}
      >
        <div className="seg">
          <button type="button" className={staleOnly ? 'on' : ''} onClick={() => setStaleOnly(true)}>
            {isAr ? 'المتأخرة' : 'Needs a reading'}
          </button>
          <button type="button" className={!staleOnly ? 'on' : ''} onClick={() => setStaleOnly(false)}>
            {isAr ? 'الكل' : 'All published'}
          </button>
        </div>
        {can('enter_metrics') && (
          <button type="button" className="btn btn-p" disabled={busy || filled.length === 0} onClick={() => void saveAll()}>
            {busy
              ? isAr ? 'جارٍ الحفظ…' : 'Saving…'
              : isAr ? `تسجيل ${num(filled.length, true)}` : `Record ${filled.length}`}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={6} />}

        {!loading && visible.length === 0 && !error && (
          <Empty
            title={rows.length === 0
              ? isAr ? 'لا منشورات بعد' : 'Nothing published yet'
              : isAr ? 'كل شيء مقروء' : 'Everything is up to date'}
            body={rows.length === 0
              ? isAr
                ? 'تظهر الصفوف هنا بعد أن يُعلَّم صف نشر «منشور».'
                : 'Rows appear here once a publication is marked published.'
              : isAr
                ? 'كل منشور لديه قراءة خلال آخر سبعة أيام.'
                : 'Every post has a reading from the last seven days.'}
          />
        )}

        {visible.length > 0 && (
          <>
            <div className="notice" style={{ marginBottom: 12 }}>
              {isAr
                ? 'اترك أي خانة فارغة إن لم تُقس — الفارغ ليس صفرًا، والقراءات تُضاف ولا تُستبدل.'
                : 'Leave a box empty if it was not measured — empty is not zero, and readings are appended, never replaced.'}
            </div>
            <div className="card">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                      <th>{isAr ? 'المنشور' : 'Post'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                      <th style={{ width: 120 }}>{isAr ? 'نُشر' : 'Published'}</th>
                      <th style={{ width: 120 }}>{isAr ? 'آخر قراءة' : 'Last read'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'مشاهدات' : 'Views'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'تفاعل' : 'Engagement'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'استفسارات' : 'Enquiries'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => {
                      const t = titleOf(p.content_id);
                      const d = drafts[p.id] ?? { views: '', engagement: '', enquiries: '' };
                      const isSaved = saved.has(p.id);
                      return (
                        <tr key={p.id} className={isSaved ? 'hl' : undefined}>
                          <td className="id">
                            <button
                              type="button"
                              className="btn btn-d btn-sm"
                              onClick={() => navigate(`/m/content/${p.content_id}`)}
                            >
                              {t?.ref ?? '—'}
                            </button>
                          </td>
                          <td className="ttl">{t?.title ?? p.content_id.slice(0, 8)}</td>
                          <td>
                            <span className="tag">
                              {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
                            </span>
                          </td>
                          <td style={{ color: 'var(--mute)', fontSize: 11.5 }}>
                            {shortDate(p.published_at, isAr)}
                            <div>{daysAgo(p.published_at, isAr)}</div>
                          </td>
                          <td style={{ color: p.latest_captured_at ? 'var(--mute)' : 'var(--late)', fontSize: 11.5 }}>
                            {p.latest_captured_at
                              ? shortDate(p.latest_captured_at, isAr)
                              : isAr ? 'لا قراءة' : 'never'}
                          </td>
                          {(['views', 'engagement', 'enquiries'] as const).map((k) => (
                            <td key={k} style={{ padding: 6 }}>
                              <input
                                className="inp"
                                inputMode="numeric"
                                disabled={!can('enter_metrics') || busy}
                                style={{ padding: '5px 8px', fontSize: 12 }}
                                value={d[k]}
                                onChange={(e) => set(p.id, k, e.target.value)}
                                placeholder={
                                  k === 'views' && p.latest_views !== null
                                    ? num(p.latest_views, isAr)
                                    : ''
                                }
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
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

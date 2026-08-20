/**
 * Publishing Board — the organic command center (/m/publishing).
 *
 * Publishing used to be reachable only one content item at a time, inside that
 * item's «النشر» tab. This is the cross-platform queue: every publication across
 * ALL content in one place — what is scheduled, in flight, published, or FAILED —
 * so the daily triage question ("what's going out, what's stuck?") has one
 * answer instead of a tour through every content item.
 *
 * Failures come first by design: a post that errored on the platform is the one
 * thing that needs a human, so it sits at the top with its error text and a
 * one-click republish. Everything else can be filtered by state.
 *
 * Actions reuse the exact bundle.social wrappers the per-item tab uses —
 * publishPublication (post/schedule for real) and syncPublication (reconcile
 * status). No new server behavior; one place to reach it across the whole queue.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  PLATFORM_LABELS,
  fetchAllPublications, publishPublication, syncPublication, syncAllPublications,
  type MosPublication,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Pill, Skeleton, type Tone } from './components/kit';
import { num, dateTimeShort } from './lib/format';
import './styles/pages-remaining.css';

const PLATFORM_COLORS: Record<string, string> = {
  instagram: '#C13584',
  tiktok: 'var(--ink)',
  snapchat: '#C8B400',
  x: 'var(--ink)',
  youtube: '#C4302B',
};

const BUNDLE_PLATFORMS = new Set(['instagram', 'tiktok', 'snapchat']);

/** The triage buckets. 'attention' (failed/retrying) is the reason this exists. */
type Bucket = 'attention' | 'inflight' | 'published' | 'draft';

/** Which bucket a publication falls in — bundle's fine status wins over coarse. */
function bucketOf(p: MosPublication): Bucket {
  const b = (p.bundle_status ?? '').toUpperCase();
  if (b === 'ERROR' || b === 'RETRYING') return 'attention';
  if (p.status === 'published' || b === 'POSTED') return 'published';
  if (p.status === 'scheduled' || b === 'SCHEDULED' || b === 'PROCESSING' || b === 'REVIEW') return 'inflight';
  return 'draft';
}

/** A bilingual status chip + tone, from bundle's lifecycle when present. */
function statusChip(p: MosPublication): { ar: string; en: string; tone: Tone } {
  const b = (p.bundle_status ?? '').toUpperCase();
  switch (b) {
    case 'ERROR':      return { ar: 'فشل', en: 'Failed', tone: 'late' };
    case 'RETRYING':   return { ar: 'إعادة محاولة', en: 'Retrying', tone: 'wait' };
    case 'PROCESSING': return { ar: 'قيد المعالجة', en: 'Processing', tone: 'now' };
    case 'REVIEW':     return { ar: 'قيد المراجعة', en: 'In review', tone: 'wait' };
    case 'SCHEDULED':  return { ar: 'مجدول', en: 'Scheduled', tone: 'wait' };
    case 'POSTED':     return { ar: 'منشور', en: 'Posted', tone: 'live' };
    default:           break;
  }
  // No bundle status → the coarse status carries it.
  switch (p.status) {
    case 'published': return { ar: 'منشور', en: 'Published', tone: 'live' };
    case 'scheduled': return { ar: 'مجدول', en: 'Scheduled', tone: 'wait' };
    case 'cancelled': return { ar: 'ملغى', en: 'Cancelled', tone: 'idle' };
    default:          return { ar: 'مسودة', en: 'Draft', tone: 'idle' };
  }
}

/**
 * 'active' (the default) is everything EXCEPT drafts — the board opens on what's
 * actually moving so a backlog of captionless draft slots doesn't bury the rows
 * that need a human. Drafts stay one click away under the مسودة chip, and 'all'
 * still shows the true total.
 */
type Filter = Bucket | 'all' | 'active';

const FILTERS: Array<{ key: Filter; ar: string; en: string }> = [
  { key: 'active',     ar: 'النشِط', en: 'Active' },
  { key: 'all',        ar: 'الكل', en: 'All' },
  { key: 'attention',  ar: 'يحتاج انتباه', en: 'Needs attention' },
  { key: 'inflight',   ar: 'قيد النشر', en: 'In flight' },
  { key: 'published',  ar: 'منشور', en: 'Published' },
  { key: 'draft',      ar: 'مسودة', en: 'Draft' },
];

export default function PublishingBoardPage() {
  const { isAr, can } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [pubs, setPubs] = useState<MosPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('active');
  /** Publication ids with an action in flight, so their buttons disable. */
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAllPublications(500);
      setPubs(r.publications);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // On open (publish-capable users): reconcile every in-flight bundle post with
  // the platform FIRST, then re-read — so the board shows current truth, not the
  // last synced state. The 10-min server cron does the same in the background;
  // this makes it immediate when a human is looking. Once per mount ([] deps —
  // the workspace bootstrap resolves capabilities before pages render, so
  // can('publish') is stable here). Non-fatal: a sweep failure still leaves the
  // DB view (logged, never swallowed).
  useEffect(() => {
    if (!can('publish')) return;
    void (async () => {
      try {
        const { summary } = await syncAllPublications();
        const touched = Number(summary.published ?? 0) + Number(summary.failed ?? 0)
          + Number(summary.deleted ?? 0);
        if (touched > 0) await load();
      } catch (e) {
        console.error('[publishing-board] status sweep on open failed', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((s) => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  const doPublish = useCallback(async (p: MosPublication) => {
    setBusy(p.id, true);
    try {
      const { publications } = await publishPublication(p.id);
      // The action returns the refreshed rows for that content item — merge them.
      const byId = new Map(publications.map((x) => [x.id, x]));
      setPubs((all) => all.map((x) => byId.get(x.id) ?? x));
      addToast(isAr ? 'أُرسل إلى المنصة' : 'Handed to the platform', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(p.id, false);
    }
  }, [addToast, isAr]);

  const doSync = useCallback(async (p: MosPublication) => {
    setBusy(p.id, true);
    try {
      const { publications } = await syncPublication(p.id);
      const byId = new Map(publications.map((x) => [x.id, x]));
      setPubs((all) => all.map((x) => byId.get(x.id) ?? x));
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(p.id, false);
    }
  }, [addToast]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { attention: 0, inflight: 0, published: 0, draft: 0 };
    for (const p of pubs) c[bucketOf(p)] += 1;
    return c;
  }, [pubs]);

  /** Attention first, then in-flight, then the rest; newest schedule within. */
  const rows = useMemo(() => {
    const rank: Record<Bucket, number> = { attention: 0, inflight: 1, published: 2, draft: 3 };
    const when = (p: MosPublication) =>
      Date.parse(p.published_at ?? p.scheduled_at ?? '') || 0;
    return pubs
      .filter((p) => {
        if (filter === 'all') return true;
        if (filter === 'active') return bucketOf(p) !== 'draft';
        return bucketOf(p) === filter;
      })
      .sort((a, b) => {
        const ra = rank[bucketOf(a)];
        const rb = rank[bucketOf(b)];
        if (ra !== rb) return ra - rb;
        return when(b) - when(a);
      });
  }, [pubs, filter]);

  const label = (p: string) => (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;

  /** Eligible to auto-post: a connected bundle platform, not already posted. */
  const canPublishNow = (p: MosPublication): boolean =>
    can('publish')
    && BUNDLE_PLATFORMS.has(p.platform)
    && !!p.account_can_publish
    && p.status !== 'published'
    && (p.bundle_status ?? '').toUpperCase() !== 'POSTED';

  const canSync = (p: MosPublication): boolean =>
    !!p.bundle_post_id && p.status !== 'published';

  return (
    <>
      <PageHead
        title={isAr ? 'لوحة النشر' : 'Publishing board'}
        sub={isAr
          ? 'كل عمليات النشر عبر المنصات في مكان واحد — المجدول، قيد النشر، المنشور، والمتعثّر.'
          : 'Every publication across the platforms in one place — scheduled, in flight, published, and stuck.'}
      >
        <button type="button" className="btn btn-d" disabled={loading} onClick={() => void load()}>
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && pubs.length === 0 && <Skeleton rows={6} />}

        {!loading && pubs.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا عمليات نشر بعد' : 'Nothing to publish yet'}
            body={isAr
              ? 'تظهر هنا صفوف النشر بمجرد إنشائها داخل عنصر محتوى.'
              : 'Publications appear here as soon as they’re created inside a content item.'}
          />
        )}

        {pubs.length > 0 && (
          <>
            {/* filter segmented control with live counts */}
            <div className="seg" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
              {FILTERS.map((f) => {
                const n = f.key === 'all' ? pubs.length
                  : f.key === 'active' ? (pubs.length - counts.draft)
                  : counts[f.key];
                return (
                  <button
                    key={f.key}
                    type="button"
                    className={filter === f.key ? 'on' : ''}
                    onClick={() => setFilter(f.key)}
                  >
                    {(isAr ? f.ar : f.en)}
                    <span style={{ marginInlineStart: 6, opacity: 0.7 }}>{num(n, isAr)}</span>
                  </button>
                );
              })}
            </div>

            {counts.attention > 0 && (filter === 'all' || filter === 'active') && (
              <div className="notice bad" style={{ marginBottom: 14 }} role="alert">
                {isAr
                  ? `${num(counts.attention, true)} عملية نشر متعثّرة تحتاج إجراء — في أعلى القائمة.`
                  : `${counts.attention} publication(s) stuck and need action — at the top of the list.`}
              </div>
            )}

            {rows.length === 0 ? (
              <div className="card">
                <div className="card-b" style={{ fontSize: 13, color: 'var(--mute)', padding: '18px 16px', lineHeight: 1.9 }}>
                  {filter === 'active'
                    ? (isAr
                        ? `لا شيء قيد النشر الآن. لديك ${num(counts.draft, true)} مسودة بلا نص أو موعد — افتحها من تبويب «مسودة» أعلاه لكتابتها وجدولتها.`
                        : `Nothing in flight right now. You have ${counts.draft} draft(s) with no caption or date — open the «Draft» tab above to write and schedule them.`)
                    : (isAr ? 'لا صفوف في هذا التصنيف.' : 'No rows in this filter.')}
                </div>
              </div>
            ) : (
            <div className="card">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 96 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                      <th>{isAr ? 'المنشور' : 'Post'}</th>
                      <th style={{ width: 150 }}>{isAr ? 'الموعد' : 'When'}</th>
                      <th style={{ width: 120 }}>{isAr ? 'الحالة' : 'Status'}</th>
                      <th style={{ width: 210 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const chip = statusChip(p);
                      const busy = busyIds.has(p.id);
                      const err = (p.bundle_status ?? '').toUpperCase() === 'ERROR' ? p.bundle_error : null;
                      const whenIso = p.published_at ?? p.scheduled_at;
                      return (
                        <tr key={p.id}>
                          <td>
                            <span className="pdot" style={{ background: PLATFORM_COLORS[p.platform] ?? 'var(--copper)', marginInlineEnd: 6 }} />
                            {label(p.platform)}
                          </td>
                          <td className="ttl" style={{ maxWidth: 340 }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.caption || (isAr ? 'بلا نص' : 'No caption')}
                            </div>
                            {err && (
                              <div style={{ fontSize: 11, color: 'var(--bad, #b3261e)', marginTop: 2, whiteSpace: 'normal' }}>
                                {err}
                              </div>
                            )}
                          </td>
                          <td style={{ color: 'var(--mute)' }}>
                            {whenIso ? dateTimeShort(whenIso, isAr) : (isAr ? 'بلا موعد' : 'No date')}
                          </td>
                          <td><Pill tone={chip.tone}>{isAr ? chip.ar : chip.en}</Pill></td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                              {p.external_url && (
                                <a href={p.external_url} target="_blank" rel="noreferrer" className="btn btn-d btn-sm">
                                  {isAr ? 'فتح' : 'Open'}
                                </a>
                              )}
                              {canSync(p) && (
                                <button type="button" className="btn btn-d btn-sm" disabled={busy} onClick={() => void doSync(p)}>
                                  {busy ? (isAr ? '…' : '…') : (isAr ? 'تحديث الحالة' : 'Sync')}
                                </button>
                              )}
                              {canPublishNow(p) && (
                                <button type="button" className="btn btn-p btn-sm" disabled={busy} onClick={() => void doPublish(p)}>
                                  {busy
                                    ? (isAr ? 'جارٍ…' : 'Working…')
                                    : (p.bundle_status ?? '').toUpperCase() === 'ERROR'
                                      ? (isAr ? 'إعادة النشر' : 'Republish')
                                      : p.scheduled_at
                                        ? (isAr ? 'جدولة' : 'Schedule')
                                        : (isAr ? 'انشر الآن' : 'Publish now')}
                                </button>
                              )}
                              <Link to={`/m/content/${p.content_id}`} className="btn btn-d btn-sm">
                                {isAr ? 'العنصر' : 'Item'}
                              </Link>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

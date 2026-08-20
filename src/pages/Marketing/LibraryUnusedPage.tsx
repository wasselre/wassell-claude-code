/**
 * Unused material — design screen 41 (/m/library/unused).
 *
 * Thirty-one items no content has ever referenced: either material worth
 * using, or a shoot that wasn't needed — and the difference is a human call,
 * not a machine's. The job: turn dead material into content, or into archive.
 *
 * «إنشاء محتوى منها» flips the direction — content usually starts from an
 * idea and then asks for material; here it starts from material already paid
 * for. And there is NO delete button: archiving is enough, and real delete is
 * reserved for assets never used and a full year old — recovery is cheaper
 * than regret.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { marketingLibraryHref } from '@/lib/files/libraryUrl';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_KIND_LABELS, MosAsset, bulkAssets, fetchAssets, fetchUnusedAssets,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Skeleton } from './components/kit';
import { IconPlus } from './components/icons';
import { num, toArabicDigits } from './lib/format';
import { formatBytes } from './lib/upload';
import { useAssetUrls } from './lib/assetUrls';
import './styles/pages-remaining.css';

/** mm:ss badge on video thumbs — Arabic-Indic in Arabic. */
function mmss(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  const out = `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
  return isAr ? toArabicDigits(out) : out;
}

/** «رُفعت قبل ٤٦ يومًا» — the card's age line. */
function uploadedAgo(iso: string, isAr: boolean): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (isAr) {
    if (days === 0) return 'رُفعت اليوم';
    if (days === 1) return 'رُفعت قبل يوم';
    if (days === 2) return 'رُفعت قبل يومين';
    if (days <= 10) return `رُفعت قبل ${num(days, true)} أيام`;
    return `رُفعت قبل ${num(days, true)} يومًا`;
  }
  return days === 0 ? 'uploaded today' : `uploaded ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const THUMB_GRADIENTS = [
  'linear-gradient(140deg,#4A3A2A,#9A7A5A)',
  'linear-gradient(140deg,#5C4530,#D9B57F)',
  'linear-gradient(140deg,#3A2A1E,#8A6A4A)',
  'linear-gradient(140deg,#6B4226,#A6482A)',
  'linear-gradient(140deg,#8A6A4A,#E8D9C0)',
];

export default function LibraryUnusedPage() {
  const { isAr, can, projectName, contentTypes } = useWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projectId = params.get('project');

  const [rows, setRows] = useState<MosAsset[]>([]);
  /** Whole-library index, for the shoot-cost framing card. Secondary. */
  const [allAssets, setAllAssets] = useState<MosAsset[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projectOnly, setProjectOnly] = useState(Boolean(projectId));
  const [olderThan30, setOlderThan30] = useState(true);
  const [kindFilter, setKindFilter] = useState<'all' | 'photo' | 'video'>('all');
  const [shootOnly, setShootOnly] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchUnusedAssets();
      setRows(res.rows);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The framing card compares unused-from-a-shoot against that shoot's total
  // delivery. Losing it must not fail the page — but the failure stays visible.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchAssets();
        if (alive) setAllAssets(res.assets);
      } catch (e) {
        console.error('[marketing] library index unavailable for the shoot-cost framing', e);
      }
    })();
    return () => { alive = false; };
  }, []);

  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;

  const scoped = useMemo(
    () => (projectOnly && projectId ? rows.filter((a) => a.project_id === projectId) : rows),
    [rows, projectOnly, projectId],
  );

  const filtered = useMemo(() => scoped.filter((a) => {
    if (olderThan30 && new Date(a.created_at).getTime() > thirtyDaysAgo) return false;
    if (kindFilter === 'photo' && a.kind !== 'photo' && a.kind !== 'design') return false;
    if (kindFilter === 'video' && a.kind !== 'video') return false;
    if (shootOnly && !a.shoot_request_id && a.source !== 'shoot') return false;
    return true;
  }), [scoped, olderThan30, kindFilter, shootOnly, thirtyDaysAgo]);

  // Legacy assets keep their stored URL; file-backed ones sign in one batch.
  const { thumbFor, error: urlError, retry: retryUrls } = useAssetUrls(filtered);

  const totalBytes = useMemo(
    () => scoped.reduce((s, a) => s + (a.size_bytes ?? 0), 0),
    [scoped],
  );

  /**
   * The shoot-cost framing: the dominant shoot among the unused, its total
   * delivery, and what fraction of that delivery never got used.
   */
  const framing = useMemo(() => {
    const byShoot = new Map<string, number>();
    for (const a of scoped) {
      if (a.shoot_request_id) byShoot.set(a.shoot_request_id, (byShoot.get(a.shoot_request_id) ?? 0) + 1);
    }
    let top: { shootId: string; unused: number } | null = null;
    for (const [shootId, unused] of byShoot) {
      if (!top || unused > top.unused) top = { shootId, unused };
    }
    if (!top || !allAssets) return null;
    const total = allAssets.filter((a) => a.shoot_request_id === top.shootId).length;
    if (total === 0) return null;
    return { unused: top.unused, total, pct: Math.round((top.unused / total) * 100) };
  }, [scoped, allAssets]);

  const toggleSelect = (id: string): void => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const ids = Array.from(selected);

  const archiveSelected = async (): Promise<void> => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await bulkAssets(ids, 'archive');
      const failed = res.results.filter((r) => !r.ok).length;
      if (failed > 0) {
        // Partial success is reported as partial — never as success.
        addToastRef(
          isAr
            ? `أُرشفت ${num(ids.length - failed, true)} وفشلت ${num(failed, true)}.`
            : `Archived ${ids.length - failed}, ${failed} failed.`,
          'error',
        );
      } else {
        addToastRef(
          isAr
            ? `أُرشفت ${num(ids.length, true)} مادة — تبقى قابلة للاسترجاع.`
            : `Archived ${ids.length} items — always recoverable.`,
          'success',
        );
      }
      void load();
    } catch (e) {
      addToastRef(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  // One store accessor so the async handlers above don't each subscribe.
  const addToastRef = useAppStore((s) => s.addToast);

  return (
    <>
      <PageHead
        title={isAr ? 'المواد غير المستخدمة' : 'Unused material'}
        crumb={
          <>
            <button type="button" onClick={() => navigate(marketingLibraryHref())}>
              {isAr ? 'مكتبة المواد' : 'Asset library'}
            </button>
            <span className="sep">/</span>
            <span>{isAr ? 'غير المستخدمة' : 'Unused'}</span>
          </>
        }
        sub={isAr
          ? `${num(scoped.length, true)} مادة${projectOnly && projectId ? ` في ${projectName(projectId)}` : ''} · ${num(rows.length, true)} في كل المشاريع · ${formatBytes(totalBytes, true)}`
          : `${scoped.length} items${projectOnly && projectId ? ` in ${projectName(projectId)}` : ''} · ${rows.length} across all projects · ${formatBytes(totalBytes, false)}`}
      >
        {projectId && (
          <div className="seg">
            <button type="button" className={projectOnly ? 'on' : ''} onClick={() => setProjectOnly(true)}>
              {projectName(projectId)}
            </button>
            <button type="button" className={!projectOnly ? 'on' : ''} onClick={() => setProjectOnly(false)}>
              {isAr ? 'كل المشاريع' : 'All projects'}
            </button>
          </div>
        )}
        {can('manage_assets') && (
          <button type="button" className="btn btn-d" disabled={busy || ids.length === 0} onClick={() => void archiveSelected()}>
            {isAr ? 'أرشفة المحدد' : 'Archive selected'}
          </button>
        )}
        {can('write_content') && (
          <button type="button" className="btn btn-p" disabled={busy || ids.length === 0} onClick={() => setCreating(true)}>
            {isAr ? 'إنشاء محتوى منها' : 'Create content from them'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}
        {!error && urlError && (
          <div className="notice bad" role="alert">
            <div style={{ overflowWrap: 'anywhere' }}>
              {isAr
                ? 'تعذّر تحميل بعض المعاينات — قد تظهر مربّعات فارغة.'
                : 'Some previews could not be loaded — you may see blank tiles.'}
            </div>
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={retryUrls}>
              {isAr ? 'إعادة المحاولة' : 'Try again'}
            </button>
          </div>
        )}

        {!loading && !error && (
          <div className="filt">
            <button
              type="button"
              className={`fbtn${olderThan30 ? ' on' : ''}`}
              onClick={() => setOlderThan30((v) => !v)}
            >
              {isAr ? 'أقدم من ٣٠ يومًا' : 'Older than 30 days'}
              {olderThan30 && <span className="x">×</span>}
            </button>
            <button
              type="button"
              className={`fbtn${kindFilter === 'photo' ? ' on' : ''}`}
              onClick={() => setKindFilter((k) => (k === 'photo' ? 'all' : 'photo'))}
            >
              {isAr ? 'صور' : 'Photos'}
            </button>
            <button
              type="button"
              className={`fbtn${kindFilter === 'video' ? ' on' : ''}`}
              onClick={() => setKindFilter((k) => (k === 'video' ? 'all' : 'video'))}
            >
              {isAr ? 'فيديو' : 'Video'}
            </button>
            <button
              type="button"
              className={`fbtn${shootOnly ? ' on' : ''}`}
              onClick={() => setShootOnly((v) => !v)}
            >
              {isAr ? 'من تصوير مُكلَّف' : 'From a commissioned shoot'}
            </button>
            <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
              {isAr ? `${num(ids.length, true)} محددة` : `${ids.length} selected`}
            </span>
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا مواد غير مستخدمة' : 'Nothing is unused'}
            body={isAr
              ? 'كل مادة في المكتبة مُشار إليها من محتوى واحد على الأقل.'
              : 'Every item in the library is referenced by at least one content record.'}
          />
        )}

        {filtered.length > 0 && (
          <div className="agrid" style={{ marginBottom: 18 }}>
            {filtered.map((a, i) => {
              const picked = selected.has(a.id);
              const thumb = thumbFor(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`ass${picked ? ' pick' : ''}`}
                  onClick={() => toggleSelect(a.id)}
                  aria-pressed={picked}
                >
                  <div
                    className="im"
                    style={thumb ? undefined : { background: THUMB_GRADIENTS[i % THUMB_GRADIENTS.length] }}
                  >
                    {thumb && <img src={thumb} alt="" />}
                    {picked && <span className="bd badge" style={{ background: 'var(--copper)' }}>{isAr ? 'محددة' : 'Selected'}</span>}
                    {a.kind === 'video' && a.duration_seconds != null && a.duration_seconds > 0 && (
                      <span className="dur">{mmss(a.duration_seconds, isAr)}</span>
                    )}
                    {!thumb && a.kind !== 'video' && (
                      (isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? ''
                    )}
                  </div>
                  <div className="mt2">
                    <b>{a.title}</b>
                    {uploadedAgo(a.created_at, isAr)}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {!loading && rows.length > 0 && !error && (
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {/* ── على المحدد ─────────────────────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'على المحدد' : 'On the selection'}</h4>
                <span className="r">{isAr ? `${num(ids.length, true)} مواد` : `${ids.length} items`}</span>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 9 }}>
                <div className="pr-act">
                  <button
                    type="button"
                    className="btn btn-p btn-sm"
                    disabled={busy || ids.length === 0 || !can('write_content')}
                    onClick={() => setCreating(true)}
                  >
                    {isAr ? 'إنشاء محتوى' : 'Create content'}
                  </button>
                  <div className="tx">
                    {isAr
                      ? 'يفتح «محتوى جديد» مع هذه المواد مربوطة مسبقًا. الأسرع لتحويل تصوير مدفوع إلى منشور.'
                      : 'Opens “New content” with these items already linked. The fastest way to turn a paid shoot into a post.'}
                  </div>
                </div>
                <div className="pr-act">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || ids.length === 0 || !can('manage_assets')}
                    onClick={() => void archiveSelected()}
                  >
                    {isAr ? 'أرشفة' : 'Archive'}
                  </button>
                  <div className="tx">
                    {isAr
                      ? <>تخرج من البحث والمكتبة وتبقى قابلة للاسترجاع. <b>لا حذف</b> — الحذف متاح فقط لمواد لم تُستخدم قط ومضى عليها عام.</>
                      : <>Out of search and the library, always recoverable. <b>No delete</b> — real delete is only for items never used and a full year old.</>}
                  </div>
                </div>
                <div className="pr-act">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || ids.length === 0 || !can('manage_assets')}
                    onClick={() => setTagging(true)}
                  >
                    {isAr ? 'وسم' : 'Tag'}
                  </button>
                  <div className="tx">
                    {isAr
                      ? 'غالبًا سبب عدم الاستخدام أن أحدًا لم يجدها. الوسم أرخص من إعادة التصوير.'
                      : 'The usual reason nothing used it is that nobody found it. Tagging is cheaper than reshooting.'}
                  </div>
                </div>
              </div>
            </div>

            {/* ── لماذا يهم هذا الرقم ────────────────────────────────── */}
            <div className="card">
              <div className="card-h"><h4>{isAr ? 'لماذا يهم هذا الرقم' : 'Why this number matters'}</h4></div>
              <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                {framing ? (
                  <>
                    {isAr
                      ? <>أكبر مصدر للمواد غير المستخدمة هنا <b>تصوير مُكلَّف واحد</b>.</>
                      : <>The biggest source of unused material here is <b>one commissioned shoot</b>.</>}
                    <div style={{ marginTop: 10 }}>
                      {isAr
                        ? <>{num(framing.unused, true)} من {num(framing.total, true)} مادة لم تُستخدم — أي أن نحو <b>{num(framing.pct, true)}٪ من كلفة ذلك التصوير</b> لم يُستفد منها بعد.</>
                        : <>{framing.unused} of {framing.total} items were never used — roughly <b>{framing.pct}% of that shoot’s cost</b> is still unrealised.</>}
                    </div>
                  </>
                ) : (
                  isAr
                    ? <>المواد هنا لم يُشر إليها أي محتوى قط — إما مادة تستحق الاستخدام أو تصوير لم يكن ضروريًا، والفرق بين الحالتين قرار بشري لا آلي.</>
                    : <>Nothing here has ever been referenced by content — either material worth using or a shoot that wasn't needed, and telling those apart is a human call, not a machine's.</>
                )}
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
                  {isAr
                    ? 'هذا ليس عتابًا على أحد. إنه المدخل الوحيد لكتابة موجز تصوير أفضل في المرة القادمة — وهو رقم لم يكن ممكنًا رؤيته في مجلد.'
                    : 'This is not a reproach. It is the only input for writing a better shoot brief next time — and a number a folder could never show.'}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {tagging && (
        <TagModal
          isAr={isAr}
          count={ids.length}
          busy={busy}
          onClose={() => setTagging(false)}
          onSubmit={async (tag) => {
            setBusy(true);
            try {
              await bulkAssets(ids, 'tag', { tag });
              addToastRef(
                isAr ? `وُسمت ${num(ids.length, true)} مادة بـ«${tag}».` : `Tagged ${ids.length} items with “${tag}”.`,
                'success',
              );
              setTagging(false);
              void load();
            } catch (e) {
              addToastRef(e instanceof Error ? e.message : String(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {creating && (
        <CreateContentModal
          isAr={isAr}
          count={ids.length}
          busy={busy}
          contentTypes={contentTypes.filter((t) => t.is_active).map((t) => ({ key: t.key, label_ar: t.label_ar, label_en: t.label_en }))}
          onClose={() => setCreating(false)}
          onSubmit={async (typeKey, title) => {
            setBusy(true);
            try {
              const res = await bulkAssets(ids, 'create_content', { content_type_key: typeKey, title });
              if (!res.content_id) throw new Error(isAr ? 'لم يُنشأ المحتوى.' : 'The content was not created.');
              navigate(`/m/content/${res.content_id}`);
            } catch (e) {
              addToastRef(e instanceof Error ? e.message : String(e), 'error');
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}

function TagModal({
  isAr, count, busy, onClose, onSubmit,
}: {
  isAr: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (tag: string) => Promise<void>;
}) {
  const [tag, setTag] = useState('');
  return (
    <Modal
      title={isAr ? 'وسم المحدد' : 'Tag the selection'}
      sub={isAr ? `${num(count, true)} مادة ستحمل هذا الوسم.` : `${count} items will carry this tag.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || !tag.trim()}
            onClick={() => void onSubmit(tag.trim())}
          >
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'وسم' : 'Tag'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'الوسم' : 'The tag'}>
        <input className="inp" value={tag} autoFocus onChange={(e) => setTag(e.target.value)} />
      </Field>
    </Modal>
  );
}

function CreateContentModal({
  isAr, count, busy, contentTypes, onClose, onSubmit,
}: {
  isAr: boolean;
  count: number;
  busy: boolean;
  contentTypes: Array<{ key: string; label_ar: string; label_en: string }>;
  onClose: () => void;
  onSubmit: (typeKey: string, title: string) => Promise<void>;
}) {
  const [typeKey, setTypeKey] = useState(contentTypes[0]?.key ?? '');
  const [title, setTitle] = useState('');
  return (
    <Modal
      title={isAr ? 'إنشاء محتوى منها' : 'Create content from them'}
      sub={isAr
        ? `${num(count, true)} مادة ستُربط بالمحتوى الجديد مسبقًا.`
        : `${count} items will arrive on the new content already linked.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || !typeKey || !title.trim()}
            onClick={() => void onSubmit(typeKey, title.trim())}
          >
            <IconPlus />
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'إنشاء المحتوى' : 'Create the content'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'النوع' : 'Type'}>
        <select className="inp" value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
          {contentTypes.map((t) => (
            <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
          ))}
        </select>
      </Field>
      <Field label={isAr ? 'العنوان' : 'Title'}>
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
    </Modal>
  );
}

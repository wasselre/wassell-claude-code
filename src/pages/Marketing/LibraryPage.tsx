/**
 * Asset library — design screen 16 (مكتبة المواد).
 *
 * Material is an object in its own right, not a file bolted to one post. That
 * is what makes "shot in March, used twice, never used" answerable — usage is
 * a LEFT JOIN on the link table rather than a counter anyone maintains, and
 * the «لم تُستخدم قط» banner is that JOIN rendered as a number.
 *
 * Cards open the asset page (screen 22, /m/library/:assetId); the unused
 * banner's CTA opens screen 41 (/m/library/unused). Both routes land with
 * their own screens — link anyway per the design.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ASSET_KIND_LABELS, ASSET_SOURCE_LABELS, MosAsset, MosAssetLink, fetchAssets,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Skeleton } from './components/kit';
import { IconSearch } from './components/icons';
import { num, shortDate, toArabicDigits } from './lib/format';
import { formatBytes } from './lib/upload';
import { useAssetUrls } from './lib/assetUrls';

const KIND_BG: Record<string, string> = {
  photo: 'linear-gradient(135deg,#8E6A4F,#B8734F)',
  video: 'linear-gradient(135deg,#4A4E54,#6B4226)',
  design: 'linear-gradient(135deg,#7A5C86,#A6482A)',
  audio: 'linear-gradient(135deg,#3F6B52,#5A6570)',
  document: 'linear-gradient(135deg,#5A6570,#8A7F72)',
};

/** Section order follows the mockup: الفيديو first, then الصور, then the rest. */
const KIND_ORDER = ['video', 'photo', 'design', 'audio', 'document'];

/** Filter chips are plural («صور»); section titles are definite («الصور»). */
const KIND_SECTION: Record<string, { ar: string; en: string; unitAr: string; unitEn: string; chipAr: string; chipEn: string }> = {
  video:    { ar: 'الفيديو',   en: 'Videos',    unitAr: 'مقطعًا',  unitEn: 'clips',    chipAr: 'فيديو',   chipEn: 'Videos' },
  photo:    { ar: 'الصور',     en: 'Photos',    unitAr: 'صورة',    unitEn: 'photos',   chipAr: 'صور',     chipEn: 'Photos' },
  design:   { ar: 'التصاميم',  en: 'Designs',   unitAr: 'تصميمًا', unitEn: 'designs',  chipAr: 'تصاميم',  chipEn: 'Designs' },
  audio:    { ar: 'الصوتيات',  en: 'Audio',     unitAr: 'مقطعًا',  unitEn: 'tracks',   chipAr: 'صوتيات',  chipEn: 'Audio' },
  document: { ar: 'المستندات', en: 'Documents', unitAr: 'مستندًا', unitEn: 'documents', chipAr: 'مستندات', chipEn: 'Documents' },
};

/** mm:ss with the screen's digit shape — Arabic-Indic in Arabic («٠٠:٢٢»). */
function duration(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  const out = `${mm}:${ss}`;
  return isAr ? toArabicDigits(out) : out;
}

export default function LibraryPage() {
  const { isAr, can, projectName, projects } = useWorkspace();
  const navigate = useNavigate();

  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [projectId, setProjectId] = useState('');
  const [tag, setTag] = useState('');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const a = await fetchAssets({ limit: 500 });
      setAssets(a.assets);
      setLinks(a.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** asset_id → number of content items using it. Unused is a fact, not a counter. */
  const useCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of links) m.set(l.asset_id, (m.get(l.asset_id) ?? 0) + 1);
    return m;
  }, [links]);

  /** Assets linked as a content item's final cut wear «نسخة معتمدة». */
  const finalSet = useMemo(() => {
    const s = new Set<string>();
    for (const l of links) if (l.role === 'final') s.add(l.asset_id);
    return s;
  }, [links]);

  /** Parent asset → children count, for the «مجموعة ن» badge. */
  const childCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) {
      if (a.parent_asset_id) m.set(a.parent_asset_id, (m.get(a.parent_asset_id) ?? 0) + 1);
    }
    return m;
  }, [assets]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const a of assets) for (const t of a.tags ?? []) s.add(t);
    return Array.from(s).sort();
  }, [assets]);

  const term = q.trim().toLowerCase();
  const filtered = assets.filter((a) => {
    if (kind && a.kind !== kind) return false;
    if (projectId && a.project_id !== projectId) return false;
    if (tag && !(a.tags ?? []).includes(tag)) return false;
    if (unusedOnly && (useCount.get(a.id) ?? 0) > 0) return false;
    if (term) {
      const hay = `${a.title} ${a.ref ?? ''} ${(a.tags ?? []).join(' ')} ${projectName(a.project_id)}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });

  // Legacy assets return their stored public URL untouched; file-backed ones
  // get a batched signed URL. A signing failure is rendered, never swallowed.
  const { thumbFor, error: urlError, retry: retryUrls } = useAssetUrls(filtered);

  const unusedInView = filtered.filter((a) => (useCount.get(a.id) ?? 0) === 0).length;

  /** Group by project × kind, exactly the mockup's sections. Unfiled («بدون مشروع») last. */
  const groups = useMemo(() => {
    const byKey = new Map<string, MosAsset[]>();
    for (const a of filtered) {
      const k = `${a.project_id ?? ''}::${a.kind}`;
      const arr = byKey.get(k);
      if (arr) arr.push(a); else byKey.set(k, [a]);
    }
    const projectOrder: string[] = [];
    for (const p of projects) projectOrder.push(p.id);
    for (const a of filtered) {
      const pid = a.project_id ?? '';
      if (pid && !projectOrder.includes(pid)) projectOrder.push(pid);
    }
    projectOrder.push(''); // unfiled last
    const out: { projectId: string; kind: string; items: MosAsset[] }[] = [];
    for (const pid of projectOrder) {
      for (const k of KIND_ORDER) {
        const items = byKey.get(`${pid}::${k}`);
        if (items && items.length > 0) out.push({ projectId: pid, kind: k, items });
      }
    }
    return out;
  }, [filtered, projects]);

  const projectCount = useMemo(() => {
    const s = new Set<string>();
    for (const a of assets) if (a.project_id) s.add(a.project_id);
    return s.size;
  }, [assets]);

  const totalBytes = useMemo(
    () => assets.reduce((sum, a) => sum + (a.size_bytes ?? 0), 0),
    [assets],
  );

  /** The thumb badge, in the mockup's priority: unused → approved → set → kind/source. */
  const badgeFor = (a: MosAsset): { text: string; bad: boolean } => {
    const uses = useCount.get(a.id) ?? 0;
    if (uses === 0) return { text: isAr ? 'لم تُستخدم' : 'Never used', bad: true };
    if (finalSet.has(a.id)) return { text: isAr ? 'نسخة معتمدة' : 'Approved cut', bad: false };
    const kids = childCount.get(a.id) ?? 0;
    if (kids > 0) return { text: isAr ? `مجموعة ${num(kids, true)}` : `Set of ${kids}`, bad: false };
    if (a.kind === 'video') return { text: isAr ? 'فيديو خام' : 'Raw video', bad: false };
    const src = ASSET_SOURCE_LABELS[a.source];
    return { text: (isAr ? src?.ar : src?.en) ?? a.source, bad: false };
  };

  /** The meta line under the title: «مستخدمة في ٥ · ١٢ مارس». */
  const metaFor = (a: MosAsset): string => {
    const uses = useCount.get(a.id) ?? 0;
    const usage = uses === 0
      ? isAr ? 'لم تُستخدم' : 'never used'
      : isAr
        ? a.kind === 'photo' ? `مستخدمة في ${num(uses, true)}` : `مستخدم في ${num(uses, true)}`
        : `used in ${uses}`;
    return a.shot_on ? `${usage} · ${shortDate(a.shot_on, isAr)}` : usage;
  };

  const uploadIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
    </svg>
  );

  return (
    <>
      <PageHead
        title={isAr ? 'مكتبة المواد' : 'Asset library'}
        sub={isAr
          ? `${num(assets.length, true)} مادة · ${num(projectCount, true)} مشروعًا · ${toArabicDigits(formatBytes(totalBytes, true))}`
          : `${num(assets.length, false)} items · ${num(projectCount, false)} projects · ${formatBytes(totalBytes, false)}`}
      >
        <div className="search">
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث بالمشروع أو الوسم' : 'Search by project or tag'}
          />
        </div>
        <div className="seg" role="group" aria-label={isAr ? 'طريقة العرض' : 'View'}>
          <button type="button" className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}>
            {isAr ? 'شبكة' : 'Grid'}
          </button>
          <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
            {isAr ? 'قائمة' : 'List'}
          </button>
        </div>
        {can('manage_assets') && (
          <button type="button" className="btn btn-p" onClick={() => navigate('/m/library/upload')}>
            {uploadIcon}
            {isAr ? 'رفع' : 'Upload'}
          </button>
        )}
      </PageHead>

      <div className={`body${can('manage_assets') ? ' m4-cta-pad' : ''}`}>
        <div className="filt">
          {KIND_ORDER.filter((k) => KIND_SECTION[k]).map((k) => (
            <button
              key={k}
              type="button"
              className={`fbtn${kind === k ? ' on' : ''}`}
              onClick={() => setKind((cur) => (cur === k ? '' : k))}
            >
              {isAr ? KIND_SECTION[k]?.chipAr : KIND_SECTION[k]?.chipEn}
              {kind === k && <span className="x">×</span>}
            </button>
          ))}
          <button
            type="button"
            className={`fbtn${unusedOnly ? ' on' : ''}`}
            onClick={() => setUnusedOnly((v) => !v)}
          >
            {isAr ? 'غير مستخدمة' : 'Unused'}
            {unusedOnly && <span className="x">×</span>}
          </button>
          <select className="fsel" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'المشروع: الكل' : 'Project: all'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
          {allTags.length > 0 && (
            <select className="fsel fsel-dashed" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{isAr ? '+ وسم' : '+ tag'}</option>
              {allTags.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? `${num(filtered.length, true)} مادة${projectId ? ` في ${projectName(projectId)}` : ''} · ${num(unusedInView, true)} لم تُستخدم قط`
              : `${num(filtered.length, false)} items${projectId ? ` in ${projectName(projectId)}` : ''} · ${num(unusedInView, false)} never used`}
          </span>
        </div>

        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {/* Thumbnails that could not be signed would otherwise be blank tiles
            with only a console line — say so, and offer the retry. */}
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
        {loading && assets.length === 0 && <Skeleton rows={5} />}

        {!loading && unusedInView > 0 && !error && (
          <div className="unused-banner">
            <div>
              <div className="lbl">{isAr ? 'لم تُستخدم قط' : 'Never used'}</div>
              <div className="ub-n">{num(unusedInView, isAr)}</div>
            </div>
            <div className="ub-t">
              {isAr
                ? `${num(unusedInView, true)} مادة${projectId ? ' في هذا المشروع' : ''} لم يشر إليها أي محتوى قط. إما مادة تستحق الاستخدام، أو تصوير لم يكن ضروريًا — وهو رقم لم تستطع شجرة المجلدات إظهاره أبدًا.`
                : `${num(unusedInView, false)} items${projectId ? ' in this project' : ''} no content has ever referenced. Either material worth using, or a shoot that wasn't needed — a number a folder tree could never show.`}
            </div>
            <button
              type="button"
              className="btn btn-p btn-sm"
              onClick={() => navigate('/m/library/unused')}
            >
              {isAr ? 'مراجعة غير المستخدمة' : 'Review unused'}
            </button>
          </div>
        )}

        {!loading && filtered.length === 0 && !error && (
          <Empty
            title={assets.length === 0
              ? isAr ? 'المكتبة فارغة' : 'The library is empty'
              : isAr ? 'لا نتائج' : 'Nothing matches'}
            body={assets.length === 0
              ? isAr
                ? 'المادة كائن قائم بذاته، لا ملف ملحق بمنشور واحد. هذا ما يجعل «صُوِّرت في مارس، استُخدمت مرتين» سؤالًا له جواب.'
                : 'Material is an object in its own right, not a file bolted to one post. That is what makes "shot in March, used twice" answerable.'
              : isAr ? 'جرّب تغيير التصفية.' : 'Try changing the filters.'}
          >
            {assets.length === 0 && can('manage_assets') && (
              <button type="button" className="btn btn-p" onClick={() => navigate('/m/library/upload')}>
                {uploadIcon}
                {isAr ? 'رفع أول الملفات' : 'Upload the first files'}
              </button>
            )}
          </Empty>
        )}

        {!loading && groups.map((g) => {
          const sec = KIND_SECTION[g.kind];
          const projLabel = g.projectId
            ? projectName(g.projectId)
            : isAr ? 'بدون مشروع' : 'No project';
          return (
            <div key={`${g.projectId}-${g.kind}`} className="agroup">
              <div className="lbl" style={{ margin: '4px 0 9px' }}>
                {projLabel}
                {' · '}
                {isAr ? sec?.ar : sec?.en}
                {' '}
                <span style={{ fontWeight: 400, color: 'var(--mute)' }}>
                  — {isAr
                    ? `${num(g.items.length, true)} ${sec?.unitAr ?? ''}`
                    : `${num(g.items.length, false)} ${sec?.unitEn ?? ''}`}
                </span>
              </div>

              {view === 'grid' ? (
                <div className="agrid">
                  {g.items.map((a) => {
                    const badge = badgeFor(a);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className="ass"
                        onClick={() => navigate(`/m/library/${a.id}`)}
                      >
                        <div className="im" style={{ background: KIND_BG[a.kind] ?? 'var(--sand)' }}>
                          {thumbFor(a)
                            ? <img src={thumbFor(a) ?? undefined} alt="" />
                            : (isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
                          <span className={`bd badge${badge.bad ? ' b-bad' : ''}`}>{badge.text}</span>
                          {a.kind === 'video' && a.duration_seconds != null && a.duration_seconds > 0 && (
                            <span className="dur">{duration(a.duration_seconds, isAr)}</span>
                          )}
                        </div>
                        <div className="mt2">
                          <b>{a.title}</b>
                          {metaFor(a)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="alist">
                  {g.items.map((a) => {
                    const badge = badgeFor(a);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className="arow"
                        onClick={() => navigate(`/m/library/${a.id}`)}
                      >
                        <span className="ath" style={{ background: KIND_BG[a.kind] ?? 'var(--sand)' }}>
                          {thumbFor(a)
                            ? <img src={thumbFor(a) ?? undefined} alt="" />
                            : (isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
                          {a.kind === 'video' && a.duration_seconds != null && a.duration_seconds > 0 && (
                            <span className="dur">{duration(a.duration_seconds, isAr)}</span>
                          )}
                        </span>
                        <span className="am">
                          <b>{a.title}</b>
                          {metaFor(a)}
                        </span>
                        <span className={`badge${badge.bad ? ' b-bad' : ''}`}>{badge.text}</span>
                        <span className="ad">{shortDate(a.shot_on, isAr)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* s51 phone2 — the fixed upload CTA. Phone photos are the library's
          main intake, so the action floats above the grid instead of hiding
          in the header. */}
      {can('manage_assets') && (
        <div className="m4-mob m4-fixcta">
          <button
            type="button"
            className="btn btn-p m4-fixbtn"
            onClick={() => navigate('/m/library/upload')}
          >
            {uploadIcon}
            {isAr ? 'رفع من الجوال' : 'Upload from the phone'}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Content inventory — how much content we hold for each of OUR projects.
 *
 * A planning view, not a task queue: for every marketed project (the is_public
 * all_projects set) it shows the files we have, broken down by media kind
 * (images / videos / documents), by asset nature (real photography vs
 * AI/CGI renders vs graphic design), by link role (gallery / marketing / main /
 * developer), the storage each project consumes, and the recurring subject tags
 * (kitchens, bedrooms, interiors, floor plans…). Projects with NO content are
 * shown on purpose — a content gap is exactly what this screen is for.
 *
 * The numbers come from `file_links` → `files` server-side (api/marketing-os
 * `content_inventory`), read with the service client so the totals are complete
 * regardless of the caller's own file RLS. This page is read-only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ContentInventoryProject,
  ContentInventoryTotals,
  fetchContentInventory,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Skeleton } from './components/kit';
import { num, toArabicDigits } from './lib/format';

/* Storage size with Arabic-Indic digits (the shared formatBytes keeps Latin
 * digits; the workspace shows Arabic digits everywhere). */
function storage(bytes: number, isAr: boolean): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return isAr ? '٠' : '0';
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  const fmt = (n: number, unitAr: string, unitEn: string, dp: number): string => {
    const s = n.toFixed(dp);
    return `${isAr ? toArabicDigits(s) : s} ${isAr ? unitAr : unitEn}`;
  };
  if (bytes >= GB) return fmt(bytes / GB, 'جيجابايت', 'GB', 2);
  if (bytes >= MB) return fmt(bytes / MB, 'ميجابايت', 'MB', 1);
  if (bytes >= KB) return fmt(bytes / KB, 'كيلوبايت', 'KB', 0);
  return fmt(bytes, 'بايت', 'B', 0);
}

/* Nature colours — real photography, AI/CGI, graphic design, everything else. */
const NATURE = {
  real: 'var(--copper)',
  ai: '#5B8DEF',
  graphic: '#C09B5F',
  other: '#9AA0A6',
} as const;

type SortKey = 'files' | 'storage' | 'name';

export default function ContentInventoryPage() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ContentInventoryProject[]>([]);
  const [totals, setTotals] = useState<ContentInventoryTotals | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('files');
  const [hideEmpty, setHideEmpty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchContentInventory();
      setProjects(res.projects);
      setTotals(res.totals);
      setModelId(res.model_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Open the Files library filtered to ONE project, segmented by document type.
   * `business_files_search` needs model_id + record_id, so both are passed;
   * `group=document_type` makes the results segment by content type. Extra
   * params (kind / nature / role) narrow it further. Client-side nav so the
   * marketing shell is not re-booted.
   */
  const openFiles = useCallback(
    (projectId: string, extra: Record<string, string> = {}): void => {
      const sp = new URLSearchParams();
      sp.set('model', 'all_projects');
      if (modelId) sp.set('mid', modelId);
      sp.set('rid', projectId);
      sp.set('group', 'document_type');
      for (const [k, v] of Object.entries(extra)) sp.set(k, v);
      navigate(`/m/library?${sp.toString()}`);
    },
    [modelId, navigate],
  );

  const emptyCount = useMemo(() => projects.filter((p) => p.files === 0).length, [projects]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = projects;
    if (term) rows = rows.filter((p) => p.name.toLowerCase().includes(term));
    if (hideEmpty) rows = rows.filter((p) => p.files > 0);
    const sorted = [...rows];
    if (sort === 'files') sorted.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
    else if (sort === 'storage') sorted.sort((a, b) => b.storage_bytes - a.storage_bytes || a.name.localeCompare(b.name));
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [projects, q, sort, hideEmpty]);

  const sub = totals
    ? isAr
      ? `${num(totals.projects, true)} مشروعًا · ${num(totals.projects_with_content, true)} به محتوى · ${num(totals.files, true)} ملفًا · ${storage(totals.storage_bytes, true)}`
      : `${totals.projects} projects · ${totals.projects_with_content} with content · ${totals.files} files · ${storage(totals.storage_bytes, false)}`
    : isAr ? 'المحتوى المتوفّر لكل مشروع من مشاريعنا' : 'The content we hold for each of our projects';

  return (
    <>
      <PageHead title={isAr ? 'جرد المحتوى' : 'Content inventory'} sub={sub}>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && projects.length === 0 && <Skeleton rows={6} />}

        {totals && projects.length > 0 && <SummaryStrip totals={totals} isAr={isAr} />}

        {projects.length > 0 && (
          <div
            className="filt"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '14px 0' }}
          >
            <input
              className="inp"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={isAr ? 'ابحث عن مشروع…' : 'Search a project…'}
              style={{ maxWidth: 240 }}
            />
            <div className="seg">
              <button type="button" className={sort === 'files' ? 'on' : ''} onClick={() => setSort('files')}>
                {isAr ? 'الأكثر ملفات' : 'Most files'}
              </button>
              <button type="button" className={sort === 'storage' ? 'on' : ''} onClick={() => setSort('storage')}>
                {isAr ? 'الأكبر تخزينًا' : 'Largest storage'}
              </button>
              <button type="button" className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>
                {isAr ? 'الاسم' : 'Name'}
              </button>
            </div>
            {emptyCount > 0 && (
              <button
                type="button"
                className={`fbtn${hideEmpty ? ' on' : ''}`}
                style={{ marginInlineStart: 'auto' }}
                onClick={() => setHideEmpty((v) => !v)}
              >
                {isAr
                  ? `إخفاء بلا محتوى (${num(emptyCount, true)})`
                  : `Hide empty (${emptyCount})`}
              </button>
            )}
          </div>
        )}

        {!loading && projects.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا مشاريع' : 'No projects'}
            body={isAr
              ? 'لا توجد مشاريع معروضة (is_public) لعرض محتواها بعد.'
              : 'There are no marketed (is_public) projects to inventory yet.'}
          />
        )}

        {visible.length === 0 && projects.length > 0 && (
          <Empty
            title={isAr ? 'لا نتائج' : 'Nothing matches'}
            body={isAr ? 'جرّب مصطلح بحث آخر أو أظهر المشاريع بلا محتوى.' : 'Try another search, or show empty projects.'}
          />
        )}

        {visible.length > 0 && (
          <div
            className="grid"
            style={{ gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}
          >
            {visible.map((p) => (
              <ProjectCard key={p.id} p={p} isAr={isAr} open={openFiles} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ── Summary strip ─────────────────────────────────────────────────────── */

function SummaryStrip({ totals, isAr }: { totals: ContentInventoryTotals; isAr: boolean }) {
  const tiles: Array<{ k: string; v: string }> = [
    { k: isAr ? 'إجمالي الملفات' : 'Total files', v: num(totals.files, isAr) },
    { k: isAr ? 'التخزين' : 'Storage', v: storage(totals.storage_bytes, isAr) },
    { k: isAr ? 'صور' : 'Images', v: num(totals.images, isAr) },
    { k: isAr ? 'فيديو' : 'Videos', v: num(totals.videos, isAr) },
    { k: isAr ? 'ملفات PDF' : 'PDFs', v: num(totals.pdfs, isAr) },
    { k: isAr ? 'صور حقيقية' : 'Real photos', v: num(totals.real, isAr) },
    { k: isAr ? 'ذكاء اصطناعي' : 'AI / CGI', v: num(totals.ai, isAr) },
    { k: isAr ? 'تصاميم' : 'Graphics', v: num(totals.graphic, isAr) },
  ];
  return (
    <div className="grid" style={{ gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
      {tiles.map((t) => (
        <div key={t.k} className="stat">
          <div className="k">{t.k}</div>
          <div className="v">{t.v}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Per-project card ──────────────────────────────────────────────────── */

function ProjectCard({
  p, isAr, open,
}: {
  p: ContentInventoryProject;
  isAr: boolean;
  /** Open the Files library filtered to this project (+ optional extra filters). */
  open: (projectId: string, extra?: Record<string, string>) => void;
}) {
  // Each nature bucket carries the asset_nature value(s) the Files library
  // filters on, so a click opens exactly those files.
  const natureSegs = [
    { key: 'real', n: p.by_nature.real, color: NATURE.real, label: isAr ? 'حقيقية' : 'Real', filter: 'real' },
    { key: 'ai', n: p.by_nature.ai, color: NATURE.ai, label: isAr ? 'ذكاء اصطناعي' : 'AI / CGI', filter: 'ai_generated,ai_edited,cgi_render' },
    { key: 'graphic', n: p.by_nature.graphic, color: NATURE.graphic, label: isAr ? 'تصاميم' : 'Graphics', filter: 'graphic_design' },
    { key: 'other', n: p.by_nature.screenshot + p.by_nature.unknown, color: NATURE.other, label: isAr ? 'أخرى' : 'Other', filter: 'screenshot' },
  ].filter((s) => s.n > 0);
  const natureTotal = natureSegs.reduce((s, x) => s + x.n, 0);

  // [label, count, filter-param] — the param opens the library narrowed to it.
  const kinds: Array<[string, number, Record<string, string>]> = [
    [isAr ? 'صور' : 'Images', p.by_kind.image, { kind: 'image' }],
    [isAr ? 'فيديو' : 'Videos', p.by_kind.video, { kind: 'video' }],
    [isAr ? 'PDF' : 'PDFs', p.by_kind.pdf, { kind: 'pdf' }],
    [isAr ? 'مستندات' : 'Docs', p.by_kind.document, { kind: 'document,wassel_doc' }],
    [isAr ? 'أخرى' : 'Other', p.by_kind.other, { kind: 'audio,archive,other' }],
  ];
  const roles: Array<[string, number, Record<string, string>]> = [
    [isAr ? 'المعرض' : 'Gallery', p.by_role.gallery, { role: 'gallery_image' }],
    [isAr ? 'تسويقية' : 'Marketing', p.by_role.marketing, { role: 'marketing_asset' }],
    [isAr ? 'رئيسية' : 'Main', p.by_role.main, { role: 'main_image' }],
    [isAr ? 'من المطوّر' : 'Developer', p.by_role.developer, { role: 'developer_content' }],
  ];

  const empty = p.files === 0;

  return (
    <div
      className="card"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, opacity: empty ? 0.62 : 1 }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <b style={{ fontSize: 14.5, flex: 1, minWidth: 0 }}>{p.name || (isAr ? 'مشروع بلا اسم' : 'Untitled project')}</b>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{num(p.files, isAr)}</span>
        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>{isAr ? 'ملف' : 'files'}</span>
      </div>

      {empty ? (
        <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>
          {isAr ? 'لا يوجد محتوى مرتبط بهذا المشروع بعد.' : 'No content linked to this project yet.'}
        </div>
      ) : (
        <>
          {/* storage + media kinds (each kind opens the library filtered to it) */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Chip strong>{storage(p.storage_bytes, isAr)}</Chip>
            {kinds.filter(([, n]) => n > 0).map(([label, n, f]) => (
              <Chip
                key={label}
                onClick={() => open(p.id, f)}
                title={isAr ? `افتح ${label} (${num(n, isAr)})` : `Open ${label} (${n})`}
              >
                {label} · {num(n, isAr)}
              </Chip>
            ))}
          </div>

          {/* nature split — the AI-vs-real question, as a bar + legend. Hover a
              segment for the exact count; click it to open those files. */}
          {natureTotal > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'color-mix(in srgb, var(--ink, #4A4E54) 8%, transparent)' }}
              >
                {natureSegs.map((s) => (
                  <span
                    key={s.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => open(p.id, { nature: s.filter })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(p.id, { nature: s.filter }); }}
                    title={`${s.label}: ${num(s.n, isAr)} (${Math.round((s.n / natureTotal) * 100)}%)`}
                    style={{ width: `${(s.n / natureTotal) * 100}%`, background: s.color, cursor: 'pointer' }}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {natureSegs.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => open(p.id, { nature: s.filter })}
                    title={isAr ? `افتح ${s.label} (${num(s.n, isAr)})` : `Open ${s.label} (${s.n})`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
                      color: 'var(--mute)', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    }}
                  >
                    <i style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: 'inline-block' }} />
                    {s.label} · {num(s.n, isAr)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* role split (each role opens the library filtered to it) */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {roles.filter(([, n]) => n > 0).map(([label, n, f]) => (
              <Chip
                key={label}
                tone="soft"
                onClick={() => open(p.id, f)}
                title={isAr ? `افتح ${label} (${num(n, isAr)})` : `Open ${label} (${n})`}
              >
                {label} · {num(n, isAr)}
              </Chip>
            ))}
          </div>

          {/* top subject tags */}
          {p.top_tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
              {p.top_tags.map((t) => (
                <span
                  key={t.tag}
                  style={{
                    fontSize: 11, color: 'var(--mute)',
                    border: '1px solid color-mix(in srgb, var(--ink, #4A4E54) 14%, transparent)',
                    borderRadius: 999, padding: '2px 8px',
                  }}
                  title={`${t.tag} · ${num(t.n, isAr)}`}
                >
                  {t.tag}
                </span>
              ))}
            </div>
          )}

          {/* open the project's files, segmented by type */}
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 2, alignSelf: 'flex-start' }}
            onClick={() => open(p.id)}
          >
            {isAr ? 'عرض الملفات حسب النوع ←' : 'View files by type →'}
          </button>
        </>
      )}
    </div>
  );
}

function Chip({
  children, strong, tone, onClick, title,
}: {
  children: React.ReactNode;
  strong?: boolean;
  tone?: 'soft';
  onClick?: () => void;
  title?: string;
}) {
  const style: React.CSSProperties = {
    fontSize: 11.5,
    fontWeight: strong ? 700 : 500,
    padding: '3px 9px',
    borderRadius: 8,
    background: tone === 'soft'
      ? 'color-mix(in srgb, var(--copper) 8%, transparent)'
      : 'color-mix(in srgb, var(--ink, #4A4E54) 6%, transparent)',
    color: tone === 'soft' ? 'var(--copper)' : 'inherit',
    whiteSpace: 'nowrap',
    border: 'none',
    cursor: onClick ? 'pointer' : 'default',
  };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} style={style}>
        {children}
      </button>
    );
  }
  return <span style={style} title={title}>{children}</span>;
}

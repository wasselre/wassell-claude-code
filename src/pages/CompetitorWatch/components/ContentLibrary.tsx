/**
 * Content Library — "the shelves". Surfaces the labels the enrichment AI already
 * computed (gathered by the mkt_content_library RPC): one entry per competitor
 * post, organised by purpose shelf, filterable and searchable.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchContentLibrary, type LibraryResult, type LibraryRow, fetchDesignRead } from '@/lib/competitorWatch/client';
import { setDesignExample } from '@/lib/marketingOS/creativeClient';
import type { PostRead, SlideRead, VisualDesignReadRow } from '@/lib/creative/contracts';
import { useAppStore } from '@/stores/appStore';
import { resolveEffectiveProfile } from '@/lib/permissions';

const SHELVES: Array<{ key: string; ar: string; en: string; color: string }> = [
  { key: 'brand', ar: 'هوية', en: 'Brand', color: 'var(--cw-plum)' },
  { key: 'project_launch', ar: 'إطلاق مشروع', en: 'Project launch', color: 'var(--cw-copper)' },
  { key: 'event', ar: 'مناسبة', en: 'Event', color: 'var(--cw-info)' },
  { key: 'walkthrough', ar: 'جولة', en: 'Walkthrough', color: 'var(--cw-gold)' },
  { key: 'offer', ar: 'عرض', en: 'Offer', color: 'var(--cw-warn)' },
  { key: 'teaser', ar: 'تشويق', en: 'Teaser', color: 'var(--cw-ok)' },
  { key: 'testimonial', ar: 'شهادة', en: 'Testimonial', color: 'var(--cw-bad)' },
];
const SHELF_MAP = new Map(SHELVES.map((s) => [s.key, s]));
const FORMATS: Array<{ key: string; ar: string; en: string }> = [
  { key: 'reel', ar: 'ريل', en: 'Reel' },
  { key: 'video', ar: 'فيديو', en: 'Video' },
  { key: 'image', ar: 'صورة', en: 'Image' },
  { key: 'carousel', ar: 'ألبوم', en: 'Carousel' },
];
const PLATFORMS = ['instagram', 'tiktok', 'youtube'];

function fmtDate(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}
function shelfLabel(key: string, isAr: boolean): string {
  if (key === '') return isAr ? 'غير مصنّف' : 'Unclassified';
  const s = SHELF_MAP.get(key);
  return s ? (isAr ? s.ar : s.en) : key;
}

export default function ContentLibrary({ isAr }: { isAr: boolean }) {
  const { currentUserId, users, profiles, previewProfileId } = useAppStore();
  const currentUser = users.find((u) => u.id === currentUserId);
  // Admins see the «مثال للدراسة» action (it writes mos_design_examples).
  const isAdmin = !!resolveEffectiveProfile(currentUser, profiles, previewProfileId)?.is_admin;
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [shelf, setShelf] = useState<string | null>(null);
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [hasOffer, setHasOffer] = useState(false);
  const [data, setData] = useState<LibraryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const reqRef = useRef(0);
  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    fetchContentLibrary({
      shelf, org: org?.id ?? null, format, platform,
      has_offer: hasOffer ? true : null, q: debouncedQ || null, limit: 40,
    })
      .then((r) => { if (id === reqRef.current) setData(r); })
      .catch((e) => { if (id === reqRef.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (id === reqRef.current) setLoading(false); });
  }, [shelf, org, format, platform, hasOffer, debouncedQ]);

  const shelfCounts = data?.shelves ?? {};
  const allCount = useMemo(
    () => Object.values(shelfCounts).reduce((a, b) => a + b, 0),
    [shelfCounts],
  );
  const unclassified = shelfCounts[''] ?? 0;
  const hasActiveFilter = Boolean(org || shelf !== null || format || platform || hasOffer);

  return (
    <div className="cw-lib">
      <aside className="cw-shelves">
        <div className="cw-cap">{isAr ? 'الرفوف — حسب الغرض' : 'Shelves — by purpose'}</div>
        <button type="button" className={`cw-shelf${shelf === null ? ' on' : ''}`} onClick={() => setShelf(null)}>
          <span className="cw-sw" style={{ background: 'var(--cw-ink3)' }} />
          <span className="cw-t">{isAr ? 'كل المحتوى' : 'All content'}</span>
          <span className="cw-n">{allCount.toLocaleString()}</span>
        </button>
        {SHELVES.map((s) => (
          <button key={s.key} type="button" className={`cw-shelf${shelf === s.key ? ' on' : ''}`} onClick={() => setShelf(s.key)}>
            <span className="cw-sw" style={{ background: s.color }} />
            <span className="cw-t">{isAr ? s.ar : s.en}</span>
            <span className="cw-n">{(shelfCounts[s.key] ?? 0).toLocaleString()}</span>
          </button>
        ))}
        {unclassified > 0 && (
          <button type="button" className={`cw-shelf${shelf === '' ? ' on' : ''}`} onClick={() => setShelf('')}>
            <span className="cw-sw" style={{ background: 'var(--cw-line)' }} />
            <span className="cw-t">{isAr ? 'غير مصنّف' : 'Unclassified'}</span>
            <span className="cw-n">{unclassified.toLocaleString()}</span>
          </button>
        )}
        <div className="cw-note">
          {isAr
            ? 'هذه الرفوف هي قراءة الذكاء لغرض كل منشور — مثبتة مسبقاً على كل المنشورات.'
            : "These shelves are the AI's own read of what each post is for — already stamped on every post."}
        </div>
      </aside>

      <div className="cw-main">
        <div className="cw-filters">
          <div className="cw-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={isAr ? 'ابحث في النص… مثل تقسيط أو أوشن' : 'Search the words… e.g. تقسيط, payment plan'}
            />
          </div>
          {FORMATS.map((f) => (
            <button key={f.key} type="button" className={`cw-chip${format === f.key ? ' on' : ''}`} onClick={() => setFormat(format === f.key ? null : f.key)}>
              {isAr ? f.ar : f.en}
            </button>
          ))}
          {PLATFORMS.map((p) => (
            <button key={p} type="button" className={`cw-chip${platform === p ? ' on' : ''}`} onClick={() => setPlatform(platform === p ? null : p)}>
              {p}
            </button>
          ))}
          <button type="button" className={`cw-chip${hasOffer ? ' on' : ''}`} onClick={() => setHasOffer((v) => !v)}>
            {isAr ? 'فيه عرض' : 'Has an offer'}
          </button>
        </div>

        {hasActiveFilter && (
          <div className="cw-active">
            {org && (
              <button type="button" className="cw-clear" onClick={() => setOrg(null)}>
                {isAr ? 'المنافس' : 'Competitor'}: {org.name} ✕
              </button>
            )}
            {shelf !== null && (
              <button type="button" className="cw-clear" onClick={() => setShelf(null)}>
                {isAr ? 'الرف' : 'Shelf'}: {shelfLabel(shelf, isAr)} ✕
              </button>
            )}
            {format && (
              <button type="button" className="cw-clear" onClick={() => setFormat(null)}>
                {isAr ? 'الصيغة' : 'Format'}: {format} ✕
              </button>
            )}
            {platform && (
              <button type="button" className="cw-clear" onClick={() => setPlatform(null)}>
                {platform} ✕
              </button>
            )}
            {hasOffer && (
              <button type="button" className="cw-clear" onClick={() => setHasOffer(false)}>
                {isAr ? 'فيه عرض' : 'Has an offer'} ✕
              </button>
            )}
          </div>
        )}

        <div className="cw-count">
          {loading
            ? (isAr ? 'جارٍ التحميل…' : 'Loading…')
            : error
              ? ''
              : data
                ? `${data.total.toLocaleString()} ${isAr ? 'عنصرًا · عرض' : 'items · showing'} ${data.rows.length}`
                : ''}
        </div>

        {error && (
          <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>
        )}

        {!error && data?.rows.map((row) => (
          <Entry
            key={row.id}
            row={row}
            isAr={isAr}
            isAdmin={isAdmin}
            open={openId === row.id}
            onToggle={() => setOpenId(openId === row.id ? null : row.id)}
            onOrg={() => { if (row.organization_id) setOrg({ id: row.organization_id, name: row.org_name ?? '' }); }}
          />
        ))}

        {!loading && !error && data && data.rows.length === 0 && (
          <div className="cw-empty">{isAr ? 'لا نتائج لهذا التصفية.' : 'No results for this filter.'}</div>
        )}
      </div>
    </div>
  );
}

/** A one-line summary of a visual design read (slide- or post-level). */
function designReadSummary(read: VisualDesignReadRow, isAr: boolean): string {
  if (read.status === 'failed') {
    return isAr ? 'فشلت القراءة' : 'Read failed';
  }
  if (read.level === 'slide') {
    const r = read.read as SlideRead;
    const bits = [
      r.layout.replace(/_/g, ' '),
      isAr ? `كثافة ${r.density}` : `${r.density} density`,
      r.palette_family,
      isAr ? `هوية ${r.branding_intensity}/٣` : `branding ${r.branding_intensity}/3`,
    ];
    return bits.join(' · ');
  }
  const r = read.read as PostRead;
  const bits = [
    r.format === 'carousel' ? (isAr ? `كاروسيل · ${r.slide_count} شرائح` : `carousel · ${r.slide_count} slides`) : (isAr ? 'صورة واحدة' : 'single'),
    r.recurring_layout.layout_family.replace(/_/g, ' '),
    isAr ? `هوية ${r.branding_intensity}/٣` : `branding ${r.branding_intensity}/3`,
  ];
  return bits.join(' · ');
}

function Entry({ row, isAr, isAdmin, open, onToggle, onOrg }: {
  row: LibraryRow; isAr: boolean; isAdmin: boolean; open: boolean; onToggle: () => void; onOrg: () => void;
}) {
  const shelfDef = SHELF_MAP.get(row.shelf ?? '');
  // Visual design read — fetched lazily on first expand (Post Creative
  // Director, 2026-09-02). 'none' = no read exists for this post yet.
  const [reads, setReads] = useState<VisualDesignReadRow[] | null>(null);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  // «مثال للدراسة» — admin-only registration into mos_design_examples.
  const [exOpen, setExOpen] = useState(false);
  const [exStrengths, setExStrengths] = useState('');
  const [exCaveats, setExCaveats] = useState('');
  const [exNote, setExNote] = useState('');
  const [exBusy, setExBusy] = useState(false);
  const [exDone, setExDone] = useState(false);
  const [exError, setExError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || reads !== null || readFailed !== null) return;
    let alive = true;
    fetchDesignRead('competitor_post', row.id)
      .then((r) => { if (alive) setReads(r); })
      .catch((e: unknown) => { if (alive) setReadFailed(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [open, reads, readFailed, row.id]);

  const saveExample = async (): Promise<void> => {
    setExBusy(true);
    setExError(null);
    try {
      await setDesignExample({
        subject_kind: 'competitor_post',
        subject_id: row.id,
        example_kind: 'study_only',
        strengths: exStrengths.split(/[،,]/).map((s) => s.trim()).filter(Boolean),
        caveats: exCaveats.split(/[،,]/).map((s) => s.trim()).filter(Boolean),
        note: exNote.trim() || null,
      });
      setExDone(true);
      setExOpen(false);
    } catch (e) {
      setExError(e instanceof Error ? e.message : String(e));
    } finally {
      setExBusy(false);
    }
  };

  const facts: Array<{ k: string; v: string; hot?: boolean }> = [];
  if (row.unit_types && row.unit_types.length) facts.push({ k: isAr ? 'الوحدة' : 'Unit', v: row.unit_types.join('، ') });
  if (row.offer) facts.push({ k: isAr ? 'عرض' : 'Offer', v: row.offer, hot: true });
  if (row.price) facts.push({ k: isAr ? 'السعر' : 'Price', v: row.price });
  if (row.payment_plan) facts.push({ k: isAr ? 'سداد' : 'Payment', v: row.payment_plan });
  if (row.district) facts.push({ k: isAr ? 'الحي' : 'District', v: row.district });
  if (row.ctas && row.ctas.length && row.ctas[0]) facts.push({ k: 'CTA', v: row.ctas[0] });

  const likes = row.engagement?.likes;
  const views = row.engagement?.views;
  const canExpand = Boolean(
    (row.caption && row.caption.length > 0)
    || (row.selling_points && row.selling_points.length)
    || (row.amenities && row.amenities.length)
    || row.has_transcript,
  );

  return (
    <div className="cw-entry">
      <div className="cw-top">
        <div className="cw-thumb">
          {row.thumb_url
            ? <img className="cw-thumbimg" src={row.thumb_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : row.is_video
              ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>}
          {row.is_video && row.thumb_url && <span className="cw-playbadge" aria-hidden="true">▶</span>}
          {row.format && <span className="cw-fmt">{row.format}</span>}
        </div>
        <div className="cw-body">
          <div className="cw-metaline">
            <button className="cw-co" type="button" onClick={onOrg}>{row.org_name ?? '—'}</button>
            {row.developer_record_id && (
              <a
                className="cw-devlink"
                href={`/model/developers/${row.developer_record_id}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={isAr ? 'افتح سجل المطوّر' : 'Open developer record'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01" /></svg>
                {isAr ? 'المطوّر' : 'developer'}
                <span aria-hidden="true">↗</span>
              </a>
            )}
            {row.platform && <span>· {row.platform}</span>}
            {row.project_name && (
              row.project_record_id
                ? (
                  <a
                    className="cw-projlink"
                    href={`/model/all_projects/${row.project_record_id}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title={isAr ? 'افتح سجل المشروع' : 'Open project record'}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                    <span dir="rtl">{row.project_name}</span>
                    <span aria-hidden="true">↗</span>
                  </a>
                )
                : <span dir="rtl">· {row.project_name}</span>
            )}
            {shelfDef && <span className="cw-pill" style={{ background: shelfDef.color, color: '#fff' }}>{isAr ? shelfDef.ar : shelfDef.en}</span>}
          </div>
          {row.summary && <p className="cw-desc" dir="auto">{row.summary}</p>}
          {facts.length > 0 && (
            <div className="cw-facts">
              {facts.map((f, i) => (
                <span key={i} className={`cw-fact${f.hot ? ' hot' : ''}`} dir="auto"><span>{f.k}</span>: <b>{f.v}</b></span>
              ))}
            </div>
          )}
          <div className="cw-eng">
            {typeof likes === 'number' && <span className="cw-mono">♥ {likes.toLocaleString()}</span>}
            {typeof views === 'number' && <span className="cw-mono">▷ {views.toLocaleString()}</span>}
            {row.published_at && <span className="cw-mono">{fmtDate(row.published_at, isAr)}</span>}
            {row.has_transcript && <span className="cw-tx">{isAr ? 'مُفرّغ' : 'transcript'}</span>}
            {reads && reads.length > 0 && (
              <span className="cw-tx" title={reads.map((r) => designReadSummary(r, isAr)).join('\n')}>
                {isAr ? 'قراءة تصميم' : 'design read'}
              </span>
            )}
            {exDone && <span className="cw-tx">{isAr ? 'في سجل الأمثلة' : 'In examples'}</span>}
            {canExpand && (
              <button className="cw-expand" type="button" onClick={onToggle}>
                {open ? (isAr ? 'إخفاء' : 'Hide') : (isAr ? 'اقرأ الكامل' : 'Read full')}
              </button>
            )}
            {isAdmin && !exDone && (
              <button
                className="cw-expand"
                type="button"
                onClick={(e) => { e.stopPropagation(); if (!open) onToggle(); setExOpen((v) => !v); }}
              >
                {isAr ? 'مثال للدراسة' : 'Study example'}
              </button>
            )}
          </div>
        </div>
      </div>

      {open && (
        <div className="cw-detail">
          {row.media && row.media.length > 0 && (
            <div className="cw-dblock">
              <div className="cw-k">{isAr ? 'الوسائط' : 'Media'}</div>
              <div className="cw-media">
                {row.media.slice(0, 8).map((m, i) => (
                  m.kind === 'video'
                    ? <video key={i} className="cw-mv" controls preload="none" poster={row.thumb_url ?? undefined} src={m.url} />
                    : <img key={i} className="cw-mi" src={m.url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                ))}
              </div>
            </div>
          )}
          {row.caption && (
            <div className="cw-dblock">
              <div className="cw-k">{isAr ? 'التعليق' : 'Caption'}</div>
              <div className="cw-v" dir="auto">{row.caption}</div>
            </div>
          )}
          {row.selling_points && row.selling_points.length > 0 && (
            <div className="cw-dblock">
              <div className="cw-k">{isAr ? 'نقاط البيع' : 'Selling points'}</div>
              <div className="cw-sp">{row.selling_points.map((s, i) => <span key={i} dir="auto">{s}</span>)}</div>
            </div>
          )}
          {row.amenities && row.amenities.length > 0 && (
            <div className="cw-dblock">
              <div className="cw-k">{isAr ? 'المرافق' : 'Amenities'}</div>
              <div className="cw-sp">{row.amenities.map((s, i) => <span key={i} dir="auto">{s}</span>)}</div>
            </div>
          )}
          {row.has_transcript && (
            <div className="cw-txnote">
              {isAr
                ? 'يوجد تفريغ صوتي لهذا المقطع (النص الكامل يُعرض في تحديث قادم).'
                : 'A spoken transcript exists for this clip (full text shown in a coming update).'}
            </div>
          )}
          {reads && reads.length > 0 && (
            <div className="cw-dblock">
              <div className="cw-k">{isAr ? 'قراءة التصميم' : 'Design read'}</div>
              {reads.map((r) => (
                <div key={r.id} className="cw-v" dir="auto" style={{ marginBottom: 4 }}>
                  <b>{r.level === 'slide' ? (isAr ? 'شريحة' : 'Slide') : (isAr ? 'منشور' : 'Post')}: </b>
                  {designReadSummary(r, isAr)}
                  {r.level === 'post' && (r.read as PostRead).summary && (
                    <div style={{ marginTop: 2 }}>{(r.read as PostRead).summary}</div>
                  )}
                  {r.level === 'slide' && (r.read as SlideRead).notes && (
                    <div style={{ marginTop: 2 }}>{(r.read as SlideRead).notes}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {readFailed && (
            <div className="cw-txnote">{isAr ? `تعذّر جلب قراءة التصميم: ${readFailed}` : `Design read unavailable: ${readFailed}`}</div>
          )}
          {exOpen && (
            <div className="cw-dblock">
              <div className="cw-k">{isAr ? 'تسجيل كمثال للدراسة' : 'Register as a study example'}</div>
              <div style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
                {([
                  [exStrengths, setExStrengths, isAr ? 'نقاط القوة (مفصولة بفاصلة) — ما الذي يُحتذى؟' : 'Strengths (comma-separated) — what is worth copying?'],
                  [exCaveats, setExCaveats, isAr ? 'محاذير (مفصولة بفاصلة) — ما الذي لا يُنسخ؟' : 'Caveats (comma-separated) — what must not be copied?'],
                  [exNote, setExNote, isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'],
                ] as Array<[string, (v: string) => void, string]>).map(([val, setter, ph], i) => (
                  <input
                    key={i}
                    value={val}
                    onChange={(e) => setter(e.target.value)}
                    placeholder={ph}
                    style={{
                      border: '1px solid var(--cw-line)', background: 'var(--cw-card)',
                      borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit',
                      color: 'inherit', width: '100%',
                    }}
                  />
                ))}
                {exError && <div className="cw-error">{exError}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="cw-rvbtn ok" type="button" disabled={exBusy} onClick={() => void saveExample()}>
                    {exBusy ? (isAr ? 'يُحفظ…' : 'Saving…') : (isAr ? 'حفظ المثال' : 'Save example')}
                  </button>
                  <button className="cw-rvbtn" type="button" disabled={exBusy} onClick={() => setExOpen(false)}>
                    {isAr ? 'إلغاء' : 'Cancel'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {row.post_url && (
            <a className="cw-link" href={row.post_url} target="_blank" rel="noreferrer">
              {isAr ? 'فتح المنشور الأصلي ↗' : 'Open original post ↗'}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

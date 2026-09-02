/**
 * Visual library (المكتبة البصرية) — search competitor video SHOTS and FRAMES
 * by meaning, words or look, filtered by the controlled vocabulary (§6).
 *
 * Top: a health strip from cv_health (videos by status, shots, frames, jobs,
 * today's cost vs budget, the enabled flag) with an admin-only "process video"
 * input (cv_enqueue). Below: search box + facet chips + organization /
 * platform / duration filters + shots|frames mode, then a grid of ShotCard.
 * A card opens ShotDetailDrawer; «عرض الفيديو» opens VideoFilmstrip.
 *
 * Reference-only material (§0): every card and drawer carries the badge.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Search } from 'lucide-react';
import { useIsAdmin } from '@/hooks/usePermission';
import {
  cvBackfillStatus, cvEnqueue, cvHealth, cvSearch, fetchCompanyRoster,
  type CvBackfillStatus, type CvHealth, type CvSearchFilters, type CvSearchMode, type CvSearchResult, type CompanyRow,
} from '@/lib/competitorWatch/client';
import ShotCard from './ShotCard';
import ShotDetailDrawer from './ShotDetailDrawer';
import VideoFilmstrip from './VideoFilmstrip';
import { CV_FACETS, CV_PLATFORMS, DURATION_BUCKETS, facetLabel, statusLabel, statusTone, tagLabel } from './cvVocab';
import { num } from './surfaceData';

type Overlay = { kind: 'shot'; id: string } | { kind: 'video'; id: string } | null;

const VIDEO_STATUSES = ['queued', 'processing', 'frames_done', 'analyzing', 'analyzed', 'partial', 'failed'];

function HealthStrip({ isAr, isAdmin, tick, onEnqueued }: { isAr: boolean; isAdmin: boolean; tick: number; onEnqueued: () => void }) {
  const [health, setHealth] = useState<CvHealth | null>(null);
  const [backfill, setBackfill] = useState<CvBackfillStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mediaId, setMediaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [enqueueMsg, setEnqueueMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    Promise.all([
      cvHealth(),
      // Backfill status is informational — its failure must not hide the health strip.
      cvBackfillStatus().catch((e: unknown) => { console.error('[visual-library] cv_backfill_status failed', e); return null; }),
    ])
      .then(([h, b]) => { if (alive) { setHealth(h); setBackfill(b); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tick]);

  const enqueue = async () => {
    const id = mediaId.trim();
    if (!id) return;
    setBusy(true); setEnqueueMsg(null);
    try {
      const r = await cvEnqueue(id);
      setEnqueueMsg({ tone: 'ok', text: isAr ? `تمت الجدولة — فيديو ${r.video_id ?? ''}` : `Queued — video ${r.video_id ?? ''}` });
      setMediaId('');
      onEnqueued();
    } catch (e) {
      setEnqueueMsg({ tone: 'bad', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !health) return <div className="cw-count">{isAr ? 'جارٍ قراءة حالة النظام البصري…' : 'Reading the visual system health…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر قراءة الحالة: ' : 'Failed to read health: '}{error}</div>;
  if (!health) return null;

  const jobs = Object.entries(health.jobs ?? {});
  const jobTotals = jobs.reduce<Record<string, number>>((acc, [k, n]) => {
    const st = k.split(':')[1] ?? k;
    acc[st] = (acc[st] ?? 0) + n;
    return acc;
  }, {});
  const budgetPct = health.budget_usd > 0 ? Math.min(100, Math.round((health.cost_today_usd / health.budget_usd) * 100)) : 0;
  const totalVideos = Object.values(health.videos ?? {}).reduce((a, b) => a + b, 0);
  const shotsDone = health.shots?.done ?? 0;
  const shotsTotal = Object.values(health.shots ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div className="cw-vl-health">
      <div className="cw-vl-hcell">
        <div className="cw-vl-hk">{isAr ? 'النظام' : 'System'}</div>
        <div className="cw-vl-hv">
          <span className={`cw-tag ${health.enabled && !health.paused ? 'ok' : 'warn'}`}>
            <span className="cw-d" /> {health.enabled ? (health.paused ? (isAr ? 'متوقف مؤقتًا' : 'Paused') : (isAr ? 'يعمل' : 'Enabled')) : (isAr ? 'مُعطَّل' : 'Disabled')}
          </span>
          {!health.budget_ok && <span className="cw-tag bad">{isAr ? 'تجاوز الميزانية' : 'Over budget'}</span>}
        </div>
      </div>
      <div className="cw-vl-hcell">
        <div className="cw-vl-hk">{isAr ? 'الفيديوهات' : 'Videos'} · {num(totalVideos)}</div>
        <div className="cw-vl-hv">
          {VIDEO_STATUSES.filter((s) => (health.videos?.[s] ?? 0) > 0).map((s) => (
            <span key={s} className={`cw-tag ${statusTone(s)}`}>{statusLabel(s, isAr)} <b className="cw-mono">{num(health.videos[s])}</b></span>
          ))}
          {totalVideos === 0 && <span className="cw-muted">{isAr ? 'لا فيديوهات بعد' : 'No videos yet'}</span>}
        </div>
      </div>
      <div className="cw-vl-hcell">
        <div className="cw-vl-hk">{isAr ? 'اللقطات والإطارات' : 'Shots & frames'}</div>
        <div className="cw-vl-hv">
          <span className="cw-mono">{num(shotsDone)}/{num(shotsTotal)} {isAr ? 'لقطة مُحلَّلة' : 'shots analyzed'}</span>
          <span className="cw-mono">· {num(health.frames)} {isAr ? 'إطار' : 'frames'}</span>
          <span className="cw-mono">· {num(health.keyframes_described)} {isAr ? 'موصوف' : 'described'}</span>
        </div>
      </div>
      <div className="cw-vl-hcell">
        <div className="cw-vl-hk">{isAr ? 'المهام' : 'Jobs'}</div>
        <div className="cw-vl-hv">
          {Object.entries(jobTotals).map(([st, n]) => (
            <span key={st} className={`cw-tag ${st === 'failed' ? 'bad' : st === 'running' ? 'info' : st === 'queued' ? 'warn' : 'mute'}`}>{statusLabel(st, isAr)} <b className="cw-mono">{num(n)}</b></span>
          ))}
          {jobs.length === 0 && <span className="cw-muted">{isAr ? 'لا مهام' : 'No jobs'}</span>}
          {health.oldest_running_s > 900 && <span className="cw-tag bad">{isAr ? `أقدم مهمة تعمل منذ ${Math.round(health.oldest_running_s / 60)} د` : `oldest running ${Math.round(health.oldest_running_s / 60)} min`}</span>}
        </div>
      </div>
      <div className="cw-vl-hcell">
        <div className="cw-vl-hk">{isAr ? 'تكلفة اليوم' : 'Cost today'}</div>
        <div className="cw-meter" style={{ margin: '4px 0 0' }}>
          <span className="cw-track"><span className={`cw-fill ${budgetPct >= 100 ? 'bad' : budgetPct >= 80 ? 'warn' : 'ok'}`} style={{ width: `${Math.max(1, budgetPct)}%` }} /></span>
          <span className="cw-meterval cw-mono">${health.cost_today_usd.toFixed(2)} / ${health.budget_usd.toFixed(0)}</span>
        </div>
        <div className="cw-vl-hsub cw-mono">{isAr ? 'هذا الشهر' : 'this month'} ${health.cost_month_usd.toFixed(2)}</div>
      </div>
      {backfill && (
        <div className="cw-vl-hcell">
          <div className="cw-vl-hk">{isAr ? 'تغطية الأرشيف' : 'Backfill coverage'}</div>
          <div className="cw-meter" style={{ margin: '4px 0 0' }}>
            <span className="cw-track">
              <span className="cw-fill info" style={{ width: `${backfill.stored_videos > 0 ? Math.max(1, Math.round((backfill.indexed_videos / backfill.stored_videos) * 100)) : 0}%` }} />
            </span>
            <span className="cw-meterval cw-mono">{num(backfill.indexed_videos)} / {num(backfill.stored_videos)}</span>
          </div>
          <div className="cw-vl-hsub cw-mono">{num(backfill.not_indexed)} {isAr ? 'فيديو غير مفهرس' : 'videos not indexed'}</div>
        </div>
      )}
      {isAdmin && (
        <div className="cw-vl-hcell admin">
          <div className="cw-vl-hk">{isAr ? 'عالج فيديو (مسؤول)' : 'Process a video (admin)'}</div>
          <div className="cw-vl-enq">
            <input
              value={mediaId}
              onChange={(e) => setMediaId(e.target.value)}
              placeholder={isAr ? 'معرّف الوسيط content_media_id' : 'content_media_id'}
              className="cw-mono"
              onKeyDown={(e) => { if (e.key === 'Enter') void enqueue(); }}
            />
            <button type="button" className="cw-rvbtn ok" disabled={busy || !mediaId.trim()} onClick={() => void enqueue()}>
              {busy ? '…' : (isAr ? 'جدولة' : 'Queue')}
            </button>
          </div>
          {enqueueMsg && <div className={`cw-vl-hsub ${enqueueMsg.tone === 'bad' ? 'cw-vl-bad' : 'cw-vl-ok'}`}>{enqueueMsg.text}</div>}
        </div>
      )}
    </div>
  );
}

export default function VisualLibrarySurface({ isAr }: { isAr: boolean }) {
  const isAdmin = useIsAdmin();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [mode, setMode] = useState<CvSearchMode>('shot');
  const [facets, setFacets] = useState<Record<string, string>>({});   // facet key → value
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [duration, setDuration] = useState<string | null>(null);
  const [perVideo, setPerVideo] = useState(false);
  const [openFacet, setOpenFacet] = useState<string | null>(null);

  const [results, setResults] = useState<CvSearchResult[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [healthTick, setHealthTick] = useState(0);

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companiesError, setCompaniesError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let alive = true;
    fetchCompanyRoster()
      .then((r) => { if (alive) setCompanies(r.companies.filter((c) => c.name)); })
      .catch((e) => { if (alive) setCompaniesError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const tags = useMemo(() => Object.entries(facets).map(([k, v]) => `${k}:${v}`), [facets]);
  const bucket = DURATION_BUCKETS.find((b) => b.key === duration) ?? null;
  const hasFilter = tags.length > 0 || Boolean(org) || Boolean(platform) || Boolean(bucket);
  // With a query, cv_search embeds it (SigLIP-2 + bge-m3) and fuses visual +
  // text + lexical channels. With NO query it BROWSES the newest shots — still
  // narrowed by any facet / org / platform / duration filter. So the library
  // shows something the moment it opens; it is a library, not a blank search
  // box. (The browse branch lives in the mkt_cv_search SQL, migration _17.)
  const browse = debouncedQ.length === 0;

  const reqRef = useRef(0);
  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true); setError(null);
    const filters: CvSearchFilters = {
      organization_id: org?.id ?? null,
      platform,
      min_duration_ms: bucket?.min ?? null,
      max_duration_ms: bucket?.max ?? null,
      tags: tags.length ? tags : null,
      per_video: perVideo || null,
    };
    cvSearch({ q: debouncedQ, filters, mode, limit: 48 })
      .then((r) => {
        if (id !== reqRef.current) return;
        setUnavailable(r.unavailable === true);
        // Platform lives on the post, not in the SQL filter set — apply it
        // client-side too so a mismatch can never leak through.
        setResults(platform ? r.results.filter((x) => !x.platform || x.platform === platform) : r.results);
      })
      .catch((e) => { if (id === reqRef.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (id === reqRef.current) setLoading(false); });
  }, [debouncedQ, mode, tags, org, platform, bucket, perVideo]);

  const setFacet = (key: string, value: string | null) => {
    setFacets((prev) => {
      const next = { ...prev };
      if (value === null || prev[key] === value) delete next[key]; else next[key] = value;
      return next;
    });
    setOpenFacet(null);
  };

  const clearAll = () => { setFacets({}); setOrg(null); setPlatform(null); setDuration(null); setPerVideo(false); };

  return (
    <div className="cw-surface cw-vl">
      <HealthStrip isAr={isAr} isAdmin={isAdmin} tick={healthTick} onEnqueued={() => setHealthTick((t) => t + 1)} />

      <div className="cw-filters">
        <div className="cw-search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث بالمعنى أو الكلمات… مثل: لقطة درون للواجهة عند الغروب' : 'Search by meaning or words… e.g. drone shot of the facade at sunset'}
          />
        </div>
        <div className="cw-vl-mode" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'shot'} className={`cw-chip${mode === 'shot' ? ' on' : ''}`} onClick={() => setMode('shot')}>{isAr ? 'لقطات' : 'Shots'}</button>
          <button type="button" role="tab" aria-selected={mode === 'frame'} className={`cw-chip${mode === 'frame' ? ' on' : ''}`} onClick={() => setMode('frame')}>{isAr ? 'إطارات' : 'Frames'}</button>
        </div>
        <button type="button" className={`cw-chip${perVideo ? ' on' : ''}`} onClick={() => setPerVideo((v) => !v)} title={isAr ? 'اسمح بأكثر من لقطة من الفيديو نفسه' : 'Allow more than one shot per video'}>
          {isAr ? 'كل اللقطات' : 'All shots'}
        </button>
      </div>

      <div className="cw-vl-facets">
        {CV_FACETS.map((f) => {
          const sel = facets[f.key];
          const selDef = sel ? f.values.find((v) => v.v === sel) : undefined;
          return (
            <div className="cw-vl-facet" key={f.key}>
              <button
                type="button"
                className={`cw-chip${sel ? ' on' : ''}`}
                onClick={() => setOpenFacet(openFacet === f.key ? null : f.key)}
                aria-expanded={openFacet === f.key}
              >
                {isAr ? f.ar : f.en}{selDef ? `: ${isAr ? selDef.ar : selDef.en}` : ''} ▾
              </button>
              {openFacet === f.key && (
                <div className="cw-vl-menu" onMouseLeave={() => setOpenFacet(null)}>
                  {f.values.map((v) => (
                    <button key={v.v} type="button" className={`cw-vl-mitem${sel === v.v ? ' on' : ''}`} onClick={() => setFacet(f.key, v.v)}>
                      {isAr ? v.ar : v.en}
                    </button>
                  ))}
                  {sel && <button type="button" className="cw-vl-mitem clear" onClick={() => setFacet(f.key, null)}>{isAr ? 'إزالة' : 'Clear'}</button>}
                </div>
              )}
            </div>
          );
        })}
        <select
          className="cw-vl-select"
          value={org?.id ?? ''}
          onChange={(e) => {
            const c = companies.find((x) => x.id === e.target.value);
            setOrg(c ? { id: c.id, name: c.name ?? '' } : null);
          }}
          title={companiesError ? `${isAr ? 'تعذّر تحميل الشركات: ' : 'Failed to load companies: '}${companiesError}` : undefined}
        >
          <option value="">{isAr ? 'كل الشركات' : 'All companies'}</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {CV_PLATFORMS.map((p) => (
          <button key={p} type="button" className={`cw-chip${platform === p ? ' on' : ''}`} onClick={() => setPlatform(platform === p ? null : p)}>{p}</button>
        ))}
        {DURATION_BUCKETS.map((b) => (
          <button key={b.key} type="button" className={`cw-chip${duration === b.key ? ' on' : ''}`} onClick={() => setDuration(duration === b.key ? null : b.key)}>{isAr ? b.ar : b.en}</button>
        ))}
      </div>

      {hasFilter && (
        <div className="cw-active">
          {tags.map((t) => (
            <button key={t} type="button" className="cw-clear" onClick={() => setFacet(t.split(':')[0] ?? '', null)}>
              {facetLabel(t.split(':')[0] ?? '', isAr)}: {tagLabel(t, isAr)} ✕
            </button>
          ))}
          {org && <button type="button" className="cw-clear" onClick={() => setOrg(null)}>{isAr ? 'الشركة' : 'Company'}: {org.name} ✕</button>}
          {platform && <button type="button" className="cw-clear" onClick={() => setPlatform(null)}>{platform} ✕</button>}
          {bucket && <button type="button" className="cw-clear" onClick={() => setDuration(null)}>{isAr ? bucket.ar : bucket.en} ✕</button>}
          <button type="button" className="cw-clear" onClick={clearAll}>{isAr ? 'مسح الكل' : 'Clear all'}</button>
        </div>
      )}

      {companiesError && <div className="cw-error">{isAr ? 'تعذّر تحميل قائمة الشركات: ' : 'Failed to load the company list: '}{companiesError}</div>}

      <div className="cw-count">
        {loading
          ? (isAr ? 'جارٍ البحث…' : 'Searching…')
          : results
            ? (browse
                ? `${isAr ? 'أحدث اللقطات' : 'Newest shots'} · ${results.length.toLocaleString()}`
                : `${results.length.toLocaleString()} ${isAr ? (mode === 'shot' ? 'لقطة' : 'إطار') : (mode === 'shot' ? 'shots' : 'frames')}`)
            : ''}
        {browse && !loading && results && results.length > 0 && (
          <span className="cw-muted" style={{ marginInlineStart: 8 }}>
            {isAr ? '— اكتب في صندوق البحث للبحث بالمعنى' : '— type in the search box to search by meaning'}
          </span>
        )}
        {results && results.length > 0 && (
          <span className="cw-muted" style={{ marginInlineStart: 8 }}>{isAr ? 'مرجع للاطلاع فقط' : 'reference only'}</span>
        )}
      </div>
      {error && <div className="cw-error">{isAr ? 'تعذّر البحث: ' : 'Search failed: '}{error}</div>}
      {unavailable && !error && (
        <div className="cw-error" style={{ background: 'var(--cw-warn-bg)', color: 'var(--cw-warn)' }}>
          {isAr ? 'النظام البصري متوقف حاليًا (cv.enabled = false) — النتائج قد تكون قديمة أو فارغة.' : 'The visual system is currently off (cv.enabled = false) — results may be stale or empty.'}
        </div>
      )}

      {!loading && !error && results && results.length === 0 && (
        <div className="cw-empty cw-vl-start">
          <Film size={28} />
          <div>
            {browse
              ? (hasFilter
                  ? (isAr ? 'لا لقطات تطابق هذه التصفية.' : 'No shots match these filters.')
                  : (isAr ? 'المكتبة فارغة بعد — لا توجد فيديوهات معالَجة.' : 'The library is empty — no processed videos yet.'))
              : (isAr ? 'لا لقطات تطابق هذا البحث.' : 'No shots match this search.')}
          </div>
          <div className="cw-muted">{isAr ? 'كل ما هنا مرجع للاطلاع فقط — لا يُستخدم كأصل من أصول وصل.' : 'Everything here is a reference only — never a Wassel asset.'}</div>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="cw-vl-grid">
          {results.map((r) => (
            <ShotCard
              key={`${r.shot_id}:${r.frame_id ?? ''}`}
              r={r}
              isAr={isAr}
              // Frame hits may belong to no shot (shot_id null) — fall back to the video view.
              onOpen={() => setOverlay(r.shot_id ? { kind: 'shot', id: r.shot_id } : { kind: 'video', id: r.video_id })}
              onVideo={() => setOverlay({ kind: 'video', id: r.video_id })}
              onOrg={r.organization_id ? () => setOrg({ id: r.organization_id ?? '', name: r.org_name ?? '' }) : undefined}
            />
          ))}
        </div>
      )}

      {overlay?.kind === 'shot' && (
        <ShotDetailDrawer
          shotId={overlay.id}
          isAr={isAr}
          onClose={() => setOverlay(null)}
          onOpenShot={(id) => setOverlay({ kind: 'shot', id })}
          onOpenVideo={(id) => setOverlay({ kind: 'video', id })}
        />
      )}
      {overlay?.kind === 'video' && (
        <VideoFilmstrip
          videoId={overlay.id}
          isAr={isAr}
          onClose={() => setOverlay(null)}
          onOpenShot={(id) => setOverlay({ kind: 'shot', id })}
        />
      )}
    </div>
  );
}

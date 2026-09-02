/**
 * ShotDetailDrawer — a shot opened from the Visual library grid.
 *
 * Plays the segment in the stored (public) source video — seeks to start_ms
 * on load and pauses at end_ms — with «افتح الفيديو من هذه اللحظة» (source
 * URL + `#t=`) and copy-timestamp, then the shot analysis, tags, the aligned
 * transcript segment, OCR text, the frame strip (keyframes marked; click a
 * frame → cv_frame → analysis or «describing…»), the neighbour shots and a
 * "similar shots" list (cv_search with the shot's summary as the query).
 *
 * Competitor material is reference-only (§0) — the badge is always visible.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Film, RotateCcw, X } from 'lucide-react';
import {
  cvFrame, cvSearch, cvShot,
  type CvFrame, type CvSearchResult, type CvShot, type CvShotAnalysis, type CvTranscriptSegment,
} from '@/lib/competitorWatch/client';
import ShotCard from './ShotCard';
import {
  REFERENCE_BADGE, asText, fmtDate, fmtMs, fmtTimestamp, sourceAtUrl, statusLabel, statusTone, tagLabel, tagTitle,
} from './cvVocab';

interface Props {
  shotId: string;
  isAr: boolean;
  onClose: () => void;
  onOpenShot: (shotId: string) => void;
  onOpenVideo: (videoId: string) => void;
}

/** Transcript segments arrive either as {start_ms,end_ms,text} or {start,end,text} seconds. */
function segRange(s: CvTranscriptSegment): { start: number; end: number } | null {
  if (typeof s.start_ms === 'number' && typeof s.end_ms === 'number') return { start: s.start_ms, end: s.end_ms };
  if (typeof s.start === 'number' && typeof s.end === 'number') return { start: s.start * 1000, end: s.end * 1000 };
  return null;
}

function AnalysisFacts({ a, isAr }: { a: CvShotAnalysis; isAr: boolean }) {
  const rows: Array<{ ar: string; en: string; v: string | null }> = [
    { ar: 'الغرض', en: 'Purpose', v: asText(a.purpose) },
    { ar: 'الزاوية', en: 'Angle', v: asText(a.angle) },
    { ar: 'حركة الكاميرا', en: 'Camera movement', v: asText(a.camera_movement ?? a.motion) },
    { ar: 'الإيقاع', en: 'Pace', v: asText(a.pace) },
    { ar: 'الانتقالات', en: 'Transitions', v: asText(a.transitions) },
    { ar: 'طريقة الإنتاج', en: 'Production method', v: asText(a.production_method ?? a.production?.method) },
    { ar: 'صعوبة الإنتاج', en: 'Difficulty', v: asText(a.production_difficulty ?? a.production?.difficulty) },
    { ar: 'الموارد المطلوبة', en: 'Resources', v: asText(a.production_resources ?? a.production?.resources) },
    { ar: 'قابلية التنفيذ', en: 'Reproducibility', v: asText(a.reproducibility) },
    { ar: 'المنصات المناسبة', en: 'Suitable platforms', v: asText(a.suitable_platforms) },
    { ar: 'المزاج', en: 'Mood', v: asText(a.mood) },
  ].filter((r) => r.v);
  if (rows.length === 0) return null;
  return (
    <div className="cw-ffacts">
      {rows.map((r) => (
        <div key={r.en}><span>{isAr ? r.ar : r.en}</span><b dir="auto">{r.v}</b></div>
      ))}
    </div>
  );
}

export default function ShotDetailDrawer({ shotId, isAr, onClose, onOpenShot, onOpenVideo }: Props) {
  const [data, setData] = useState<CvShot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [frame, setFrame] = useState<CvFrame | null>(null);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);

  const [similar, setSimilar] = useState<CvSearchResult[] | null>(null);
  const [similarError, setSimilarError] = useState<string | null>(null);

  const [copied, setCopied] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [segmentEnded, setSegmentEnded] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ── load the shot ────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setData(null);
    setFrame(null); setFrameId(null); setFrameError(null);
    setSimilar(null); setSimilarError(null); setSegmentEnded(false); setNeedsTap(false);
    cvShot(shotId)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [shotId]);

  // ── similar shots (the shot's own summary as the query) ──────────────────
  useEffect(() => {
    if (!data?.shot.summary) return;
    let alive = true;
    cvSearch({ q: data.shot.summary, limit: 9, mode: 'shot' })
      .then((r) => { if (alive) setSimilar(r.results.filter((x) => x.shot_id !== shotId).slice(0, 6)); })
      .catch((e) => { if (alive) setSimilarError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [data?.shot.summary, shotId]);

  // ── frame detail + "describing…" polling ─────────────────────────────────
  useEffect(() => {
    if (!frameId) return;
    let alive = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      setFrameLoading(true); setFrameError(null);
      cvFrame(frameId)
        .then((f) => {
          if (!alive) return;
          setFrame(f);
          // The API kicks off an on-demand describe job; poll while it runs (bounded).
          if (f.describing && !f.analysis && attempts < 12) { attempts += 1; timer = setTimeout(load, 3000); }
        })
        .catch((e) => { if (alive) setFrameError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (alive) setFrameLoading(false); });
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [frameId]);

  // ── escape closes ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startSec = data ? data.shot.start_ms / 1000 : 0;
  const endSec = data ? data.shot.end_ms / 1000 : 0;

  const playSegment = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = startSec;
    setSegmentEnded(false);
    v.play().then(() => setNeedsTap(false)).catch((e: unknown) => {
      // Browsers refuse programmatic play without a user gesture (NotAllowedError)
      // — show a "tap to play" hint rather than failing silently.
      console.error('[visual-library] autoplay refused', e);
      setNeedsTap(true);
    });
  }, [startSec]);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !data) return;
    if (v.currentTime >= endSec && !v.paused) { v.pause(); setSegmentEnded(true); }
  };

  const seekTo = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    setSegmentEnded(false);
    v.play().catch((e: unknown) => { console.error('[visual-library] play refused', e); setNeedsTap(true); });
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    } catch (e) {
      // Clipboard is blocked outside secure contexts / without focus — surface it.
      console.error('[visual-library] clipboard write failed', e);
      setCopied('error');
      setTimeout(() => setCopied(null), 2500);
    }
  };

  const openAt = data ? (sourceAtUrl(data.video.source_url, data.shot.start_ms) ?? data.post?.post_url ?? null) : null;

  // The transcript segments that overlap the shot window.
  const alignedSegments = (data?.shot.transcript_segments ?? []).filter((s) => {
    const r = segRange(s);
    if (!r || !data) return false;
    return r.end > data.shot.start_ms && r.start < data.shot.end_ms;
  });

  return (
    <div className="cw-vl-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cw-vl-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="cw-vl-dhead">
          <div className="cw-vl-dtitle">
            <span className="cw-tag warn">{isAr ? REFERENCE_BADGE.ar : REFERENCE_BADGE.en}</span>
            {data && (
              <span className="cw-vl-dmeta">
                <b>{data.video.org_name ?? '—'}</b>
                {data.post?.platform && <span> · {data.post.platform}</span>}
                {data.post?.published_at && <span> · {fmtDate(data.post.published_at, isAr)}</span>}
                <span className="cw-mono"> · {isAr ? 'لقطة' : 'shot'} #{data.shot.shot_no + 1} · {fmtMs(data.shot.start_ms)} → {fmtMs(data.shot.end_ms)} ({fmtMs(data.shot.duration_ms)})</span>
              </span>
            )}
          </div>
          <button type="button" className="cw-vl-x" onClick={onClose} aria-label={isAr ? 'إغلاق' : 'Close'}><X size={18} /></button>
        </div>

        {loading && <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}
        {error && <div className="cw-error">{isAr ? 'تعذّر تحميل اللقطة: ' : 'Failed to load the shot: '}{error}</div>}

        {data && (
          <div className="cw-vl-dbody">
            {/* ── player ── */}
            <div className="cw-vl-player">
              {data.video.source_url ? (
                <video
                  ref={videoRef}
                  src={data.video.source_url}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={playSegment}
                  onTimeUpdate={onTimeUpdate}
                />
              ) : (
                <div className="cw-vl-noplayer">
                  <Film size={26} />
                  <span>{isAr ? 'لا يوجد فيديو مخزّن لهذه اللقطة.' : 'No stored video for this shot.'}</span>
                </div>
              )}
              {needsTap && <div className="cw-vl-hint">{isAr ? 'اضغط تشغيل لبدء المقطع من لحظة اللقطة.' : 'Press play to start at the shot.'}</div>}
              {segmentEnded && (
                <button type="button" className="cw-vl-replay" onClick={playSegment}>
                  <RotateCcw size={14} /> {isAr ? 'أعد اللقطة' : 'Replay shot'}
                </button>
              )}
            </div>
            <div className="cw-vl-actions">
              {openAt && (
                <a className="cw-rvbtn ok cw-vl-abtn" href={openAt} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> {isAr ? 'افتح الفيديو من هذه اللحظة' : 'Open the video at this moment'}
                </a>
              )}
              <button type="button" className="cw-rvbtn cw-vl-abtn" onClick={() => void copy(fmtTimestamp(data.shot.start_ms), 'ts')}>
                <Copy size={14} /> {copied === 'ts' ? (isAr ? 'نُسخ' : 'Copied') : `${isAr ? 'انسخ الوقت' : 'Copy timestamp'} ${fmtTimestamp(data.shot.start_ms)}`}
              </button>
              {data.post?.post_url && (
                <a className="cw-rvbtn cw-vl-abtn" href={data.post.post_url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> {isAr ? 'المنشور الأصلي' : 'Original post'}
                </a>
              )}
              <button type="button" className="cw-rvbtn cw-vl-abtn" onClick={() => onOpenVideo(data.video.id)}>
                <Film size={14} /> {isAr ? 'كل لقطات الفيديو' : 'All shots of this video'}
              </button>
              {copied === 'error' && <span className="cw-error" style={{ margin: 0, padding: '4px 10px' }}>{isAr ? 'تعذّر النسخ' : 'Copy failed'}</span>}
            </div>

            {/* ── analysis ── */}
            <section className="cw-vl-sec">
              <div className="cw-vl-sechead">
                <h4>{isAr ? 'تحليل اللقطة' : 'Shot analysis'}</h4>
                <span className={`cw-tag ${statusTone(data.shot.analysis_status)}`}>{statusLabel(data.shot.analysis_status, isAr)}</span>
              </div>
              {data.shot.analysis_status === 'failed' && data.shot.analysis_error && (
                <div className="cw-error">{data.shot.analysis_error}</div>
              )}
              {data.shot.analysis_status === 'pending' && (
                <p className="cw-note" style={{ padding: 0 }}>{isAr ? 'لم يُحلَّل هذا المقطع بعد — ستظهر القراءة عند اكتمال الدور.' : 'Not analyzed yet — the read appears when the analyzer lane reaches it.'}</p>
              )}
              {(data.shot.analysis?.summary_ar || data.shot.analysis?.summary_en || data.shot.summary) && (
                <div className="cw-dblock">
                  {isAr
                    ? <p className="cw-ftext" dir="auto">{data.shot.analysis?.summary_ar ?? data.shot.summary}</p>
                    : <p className="cw-ftext" dir="auto">{data.shot.analysis?.summary_en ?? data.shot.summary}</p>}
                  {data.shot.analysis?.summary_ar && data.shot.analysis?.summary_en && (
                    <p className="cw-fread" dir="auto">{isAr ? data.shot.analysis.summary_en : data.shot.analysis.summary_ar}</p>
                  )}
                </div>
              )}
              {data.shot.analysis && <AnalysisFacts a={data.shot.analysis} isAr={isAr} />}
              {(data.shot.tags ?? []).length > 0 && (
                <div className="cw-vl-tags" style={{ marginTop: 12 }}>
                  {(data.shot.tags ?? []).map((t) => <span key={t} className="cw-vl-tag" title={tagTitle(t, isAr)}>{tagLabel(t, isAr)}</span>)}
                </div>
              )}
              <div className="cw-vl-techline cw-mono">
                {data.shot.transition_in && <span>{isAr ? 'دخول' : 'in'}: {data.shot.transition_in}</span>}
                {data.shot.transition_out && <span>{isAr ? 'خروج' : 'out'}: {data.shot.transition_out}</span>}
                {data.shot.is_static && <span>{isAr ? 'ثابتة' : 'static'}</span>}
                {data.shot.is_micro && <span>{isAr ? 'لقطة خاطفة' : 'micro'}</span>}
                {typeof data.shot.edit_pace_local === 'number' && <span>{isAr ? 'إيقاع المونتاج' : 'edit pace'}: {data.shot.edit_pace_local.toFixed(2)}</span>}
              </div>
            </section>

            {/* ── transcript / OCR ── */}
            {(alignedSegments.length > 0 || data.shot.transcript_text) && (
              <section className="cw-vl-sec">
                <div className="cw-vl-sechead"><h4>{isAr ? 'ما يُقال في هذه اللقطة' : 'What is said in this shot'}</h4></div>
                {alignedSegments.length > 0
                  ? alignedSegments.map((s, i) => {
                    const r = segRange(s);
                    return (
                      <div key={i} className="cw-vl-seg">
                        {r && <button type="button" className="cw-vl-segts cw-mono" onClick={() => seekTo(r.start)}>{fmtMs(r.start)}</button>}
                        <span dir="auto">{s.text ?? ''}</span>
                      </div>
                    );
                  })
                  : <div className="cw-v" dir="auto">{data.shot.transcript_text}</div>}
              </section>
            )}
            {data.shot.ocr_text && (
              <section className="cw-vl-sec">
                <div className="cw-vl-sechead"><h4>{isAr ? 'النص على الشاشة' : 'On-screen text'}</h4></div>
                <div className="cw-v" dir="auto">{data.shot.ocr_text}</div>
              </section>
            )}

            {/* ── frame strip ── */}
            <section className="cw-vl-sec">
              <div className="cw-vl-sechead">
                <h4>{isAr ? 'الإطارات' : 'Frames'}</h4>
                <span className="cw-muted">{data.frames.length} · {isAr ? 'الإطارات المفتاحية معلّمة' : 'keyframes marked'}</span>
              </div>
              {data.frames.length === 0
                ? <div className="cw-empty">{isAr ? 'لا إطارات مخزّنة لهذه اللقطة.' : 'No stored frames for this shot.'}</div>
                : (
                  <div className="cw-vl-strip">
                    {data.frames.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`cw-vl-frame${f.is_keyframe ? ' key' : ''}${frameId === f.id ? ' on' : ''}`}
                        onClick={() => setFrameId(f.id)}
                        title={`${fmtTimestamp(f.ts_ms)}${f.is_keyframe ? (isAr ? ' · مفتاحي' : ' · keyframe') : ''}`}
                      >
                        {f.public_url ? <img src={f.public_url} alt="" loading="lazy" /> : <span className="cw-vl-noimg"><Film size={14} /></span>}
                        <span className="cw-vl-fts cw-mono">{fmtMs(f.ts_ms)}</span>
                        {f.is_keyframe && <span className="cw-vl-fkey">★</span>}
                        {f.has_analysis && <span className="cw-vl-fdesc" aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              {frameId && (
                <div className="cw-vl-framedetail">
                  {frameLoading && !frame && <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}
                  {frameError && <div className="cw-error">{isAr ? 'تعذّر تحميل الإطار: ' : 'Failed to load the frame: '}{frameError}</div>}
                  {frame && (
                    <div className="cw-vl-framegrid">
                      {frame.public_url && <img className="cw-vl-frameimg" src={frame.public_url} alt="" />}
                      <div>
                        <div className="cw-vl-techline cw-mono">
                          <span>{fmtTimestamp(frame.ts_ms)}</span>
                          {frame.is_keyframe && <span>{isAr ? 'مفتاحي' : 'keyframe'}</span>}
                          {frame.width && frame.height && <span>{frame.width}×{frame.height}</span>}
                          {frame.quality && typeof frame.quality.blur === 'number' && <span>{isAr ? 'ضبابية' : 'blur'} {Math.round(frame.quality.blur * 100)}%</span>}
                        </div>
                        {(frame.labels ?? []).length > 0 && (
                          <div className="cw-vl-tags" style={{ marginTop: 8 }}>
                            {(frame.labels ?? []).map((t) => <span key={t} className="cw-vl-tag" title={tagTitle(t, isAr)}>{tagLabel(t, isAr)}</span>)}
                          </div>
                        )}
                        {frame.ocr?.text && <div className="cw-v" dir="auto" style={{ marginTop: 8 }}>{frame.ocr.text}</div>}
                        {frame.analysis
                          ? (
                            <div className="cw-ffacts" style={{ marginTop: 10 }}>
                              {Object.entries(frame.analysis).map(([k, v]) => {
                                const t = asText(v);
                                return t ? <div key={k}><span>{k.replace(/_/g, ' ')}</span><b dir="auto">{t}</b></div> : null;
                              })}
                            </div>
                          )
                          : frame.describing
                            ? <div className="cw-tag info" style={{ marginTop: 10 }}><span className="cw-d" /> {isAr ? 'يُوصَف الآن…' : 'Describing…'}</div>
                            : <div className="cw-muted" style={{ marginTop: 10 }}>{isAr ? 'لا وصف لهذا الإطار (مطابق لإطار سابق أو غير مفتاحي).' : 'No description for this frame (duplicate of an earlier frame, or not a keyframe).'}</div>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* ── neighbours ── */}
            {data.neighbours.length > 0 && (
              <section className="cw-vl-sec">
                <div className="cw-vl-sechead"><h4>{isAr ? 'اللقطات المجاورة' : 'Neighbouring shots'}</h4></div>
                <div className="cw-vl-neigh">
                  {data.neighbours.map((n) => (
                    <button
                      key={n.shot_no}
                      type="button"
                      className="cw-vl-neighbtn"
                      onClick={() => { if (n.id) onOpenShot(n.id); else seekTo(n.start_ms); }}
                      title={n.id ? (isAr ? 'افتح اللقطة' : 'Open shot') : (isAr ? 'انتقل إليها في المشغّل' : 'Seek the player to it')}
                    >
                      <span className="cw-mono">{n.shot_no < data.shot.shot_no ? '‹' : '›'} #{n.shot_no + 1} · {fmtMs(n.start_ms)}</span>
                      <span dir="auto">{n.summary ?? (isAr ? '(غير مُحلَّلة)' : '(not analyzed)')}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* ── similar ── */}
            <section className="cw-vl-sec">
              <div className="cw-vl-sechead"><h4>{isAr ? 'لقطات مشابهة' : 'Similar shots'}</h4></div>
              {!data.shot.summary && <div className="cw-muted">{isAr ? 'تتطلب المشابهة تحليل اللقطة أولًا.' : 'Similarity needs the shot analyzed first.'}</div>}
              {similarError && <div className="cw-error">{similarError}</div>}
              {data.shot.summary && !similar && !similarError && <div className="cw-count">{isAr ? 'جارٍ البحث…' : 'Searching…'}</div>}
              {similar && similar.length === 0 && <div className="cw-empty">{isAr ? 'لا لقطات مشابهة بعد.' : 'No similar shots yet.'}</div>}
              {similar && similar.length > 0 && (
                <div className="cw-vl-grid compact">
                  {similar.map((r) => (
                    <ShotCard key={r.shot_id} r={r} isAr={isAr} compact onOpen={() => onOpenShot(r.shot_id)} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

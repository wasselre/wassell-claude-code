/**
 * VideoFilmstrip — one competitor video, shot by shot: the stored (public)
 * video on top, every shot in order underneath with its representative frame
 * and duration. Clicking a shot seeks the player; the shot under the playhead
 * is highlighted. «تفاصيل» opens the ShotDetailDrawer for that shot.
 */
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Film, X } from 'lucide-react';
import { cvVideo, type CvVideo } from '@/lib/competitorWatch/client';
import { REFERENCE_BADGE, fmtDate, fmtMs, fmtTimestamp, sourceAtUrl, statusLabel, statusTone, tagLabel, tagTitle } from './cvVocab';

interface Props {
  videoId?: string;
  contentMediaId?: string;
  isAr: boolean;
  onClose: () => void;
  onOpenShot: (shotId: string) => void;
}

export default function VideoFilmstrip({ videoId, contentMediaId, isAr, onClose, onOpenShot }: Props) {
  const [data, setData] = useState<CvVideo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setData(null);
    cvVideo(videoId ? { video_id: videoId } : { content_media_id: contentMediaId })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [videoId, contentMediaId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shots = data?.shots ?? [];
  const activeIdx = shots.findIndex((s) => nowMs >= s.start_ms && nowMs < s.end_ms);

  // Keep the active thumbnail in view while the video plays.
  useEffect(() => {
    if (activeIdx < 0 || !stripRef.current) return;
    const el = stripRef.current.children[activeIdx];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    v.play().catch((e: unknown) => {
      // Programmatic play can be refused without a gesture — the seek still landed.
      console.error('[visual-library] play refused', e);
    });
  };

  const openAt = data ? (sourceAtUrl(data.source_url, nowMs) ?? data.post?.post_url ?? null) : null;

  return (
    <div className="cw-vl-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cw-vl-drawer wide" onClick={(e) => e.stopPropagation()}>
        <div className="cw-vl-dhead">
          <div className="cw-vl-dtitle">
            <span className="cw-tag warn">{isAr ? REFERENCE_BADGE.ar : REFERENCE_BADGE.en}</span>
            {data && (
              <span className="cw-vl-dmeta">
                <b>{data.org_name ?? '—'}</b>
                {data.post?.platform && <span> · {data.post.platform}</span>}
                {data.post?.published_at && <span> · {fmtDate(data.post.published_at, isAr)}</span>}
                <span className="cw-mono"> · {fmtMs(data.duration_ms)} · {data.shot_count} {isAr ? 'لقطة' : 'shots'} · {data.frame_count} {isAr ? 'إطار' : 'frames'}</span>
                <span className={`cw-tag ${statusTone(data.status)}`} style={{ marginInlineStart: 8 }}>{statusLabel(data.status, isAr)}</span>
              </span>
            )}
          </div>
          <button type="button" className="cw-vl-x" onClick={onClose} aria-label={isAr ? 'إغلاق' : 'Close'}><X size={18} /></button>
        </div>

        {loading && <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}
        {error && <div className="cw-error">{isAr ? 'تعذّر تحميل الفيديو: ' : 'Failed to load the video: '}{error}</div>}

        {data && (
          <div className="cw-vl-dbody">
            {data.error && data.status === 'failed' && <div className="cw-error">{data.error}</div>}
            <div className="cw-vl-player">
              {data.source_url ? (
                <video
                  ref={videoRef}
                  src={data.source_url}
                  controls
                  playsInline
                  preload="metadata"
                  onTimeUpdate={(e) => setNowMs(Math.round(e.currentTarget.currentTime * 1000))}
                />
              ) : (
                <div className="cw-vl-noplayer"><Film size={26} /><span>{isAr ? 'لا يوجد فيديو مخزّن.' : 'No stored video.'}</span></div>
              )}
            </div>
            <div className="cw-vl-actions">
              <span className="cw-mono cw-muted">{fmtTimestamp(nowMs)}</span>
              {openAt && (
                <a className="cw-rvbtn ok cw-vl-abtn" href={openAt} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> {isAr ? 'افتح الفيديو من هذه اللحظة' : 'Open the video at this moment'}
                </a>
              )}
              {data.post?.post_url && (
                <a className="cw-rvbtn cw-vl-abtn" href={data.post.post_url} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> {isAr ? 'المنشور الأصلي' : 'Original post'}
                </a>
              )}
            </div>

            <section className="cw-vl-sec">
              <div className="cw-vl-sechead">
                <h4>{isAr ? 'اللقطات بالترتيب' : 'Shots in order'}</h4>
                <span className="cw-muted">{isAr ? 'اضغط لقطة للانتقال إليها' : 'Click a shot to seek'}</span>
              </div>
              {shots.length === 0
                ? <div className="cw-empty">{isAr ? 'لم تُقسَّم لقطات هذا الفيديو بعد.' : 'This video has no detected shots yet.'}</div>
                : (
                  <div className="cw-vl-film" ref={stripRef}>
                    {shots.map((s, i) => (
                      <div key={s.id} className={`cw-vl-filmshot${i === activeIdx ? ' on' : ''}${s.is_micro ? ' micro' : ''}`}>
                        <button type="button" className="cw-vl-filmfig" onClick={() => seek(s.start_ms)} title={`${fmtTimestamp(s.start_ms)} → ${fmtTimestamp(s.end_ms)}`}>
                          {s.representative_frame_url
                            ? <img src={s.representative_frame_url} alt="" loading="lazy" />
                            : <span className="cw-vl-noimg"><Film size={16} /></span>}
                          <span className="cw-vl-dur cw-mono">{fmtMs(s.duration_ms)}</span>
                        </button>
                        <div className="cw-vl-filmmeta">
                          <span className="cw-mono">#{s.shot_no + 1} · {fmtMs(s.start_ms)}</span>
                          {s.summary
                            ? <span className="cw-vl-filmsum" dir="auto">{s.summary}</span>
                            : <span className="cw-vl-filmsum cw-muted">{statusLabel(s.analysis_status, isAr)}</span>}
                          {(s.tags ?? []).length > 0 && (
                            <span className="cw-vl-tags">
                              {(s.tags ?? []).slice(0, 2).map((t) => <span key={t} className="cw-vl-tag" title={tagTitle(t, isAr)}>{tagLabel(t, isAr)}</span>)}
                            </span>
                          )}
                          <button type="button" className="cw-expand" style={{ marginInlineStart: 0 }} onClick={() => onOpenShot(s.id)}>
                            {isAr ? 'التفاصيل' : 'Details'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </section>

            {data.structure && Object.keys(data.structure).length > 0 && (
              <section className="cw-vl-sec">
                <div className="cw-vl-sechead"><h4>{isAr ? 'بنية الفيديو' : 'Video structure'}</h4></div>
                <div className="cw-ffacts">
                  {Object.entries(data.structure).map(([k, v]) => {
                    const t = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
                      ? String(v)
                      : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('، ') : null;
                    return t ? <div key={k}><span>{k.replace(/_/g, ' ')}</span><b dir="auto">{t}</b></div> : null;
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ShotCard — one search hit in the Visual library grid: representative frame,
 * who/where/when, duration, vocabulary tags, the summary one-liner, the
 * three-channel "why" bars (visual / text / lexical) and the reference-only badge.
 */
import { Film, Play } from 'lucide-react';
import type { CvSearchResult } from '@/lib/competitorWatch/client';
import { REFERENCE_BADGE, fmtDate, fmtMs, tagLabel, tagTitle } from './cvVocab';

interface Props {
  r: CvSearchResult;
  isAr: boolean;
  onOpen: () => void;
  onVideo?: () => void;
  onOrg?: () => void;
  compact?: boolean;
}

export function WhyBars({ why, isAr }: { why: CvSearchResult['why']; isAr: boolean }) {
  const rows: Array<{ k: 'visual' | 'text' | 'lexical'; ar: string; en: string; tone: string }> = [
    { k: 'visual', ar: 'بصري', en: 'visual', tone: 'copper' },
    { k: 'text', ar: 'معنى', en: 'text', tone: 'info' },
    { k: 'lexical', ar: 'كلمات', en: 'words', tone: 'gold' },
  ];
  return (
    <div className="cw-vl-why" title={isAr ? 'لماذا ظهرت هذه النتيجة' : 'Why this result matched'}>
      {rows.map((row) => {
        const v = why?.[row.k];
        const pct = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 100))) : 0;
        return (
          <div className="cw-vl-whyrow" key={row.k}>
            <span className="cw-vl-whyk">{isAr ? row.ar : row.en}</span>
            <span className="cw-track"><span className={`cw-fill ${row.tone}`} style={{ width: `${pct}%` }} /></span>
            <span className="cw-vl-whyv cw-mono">{typeof v === 'number' ? `${pct}%` : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function ShotCard({ r, isAr, onOpen, onVideo, onOrg, compact }: Props) {
  const tags = (r.tags ?? []).slice(0, compact ? 3 : 5);
  return (
    <article className={`cw-vl-card${compact ? ' compact' : ''}`}>
      <button type="button" className="cw-vl-fig" onClick={onOpen} title={isAr ? 'افتح اللقطة' : 'Open shot'}>
        {r.representative_frame_url
          ? <img src={r.representative_frame_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
          : <span className="cw-vl-noimg"><Film size={22} /></span>}
        <span className="cw-vl-play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
        <span className="cw-vl-dur cw-mono">{r.duration_ms > 0 ? fmtMs(r.duration_ms) : `@ ${fmtMs(r.start_ms)}`}</span>
        {r.owner === 'wassel'
          ? <span className="cw-vl-ref" style={{ background: 'var(--cw-ok-bg, #e6f4ea)', color: 'var(--cw-ok, #2f855a)' }}>{isAr ? 'محتوانا' : 'Our content'}</span>
          : <span className="cw-vl-ref">{isAr ? REFERENCE_BADGE.ar : REFERENCE_BADGE.en}</span>}
      </button>
      <div className="cw-vl-body">
        <div className="cw-metaline">
          {r.owner === 'wassel'
            ? <span className="cw-co" style={{ cursor: 'default' }}>{isAr ? 'من مكتبة وصل' : 'Wassel library'}</span>
            : onOrg
              ? <button className="cw-co" type="button" onClick={onOrg}>{r.org_name ?? '—'}</button>
              : <span className="cw-co" style={{ cursor: 'default' }}>{r.org_name ?? '—'}</span>}
          {r.platform && <span>· {r.platform}</span>}
          {r.published_at && <span className="cw-mono">· {fmtDate(r.published_at, isAr)}</span>}
        </div>
        {r.summary
          ? <p className="cw-vl-sum" dir="auto">{r.summary}</p>
          : <p className="cw-vl-sum cw-muted">{isAr ? 'لم تُحلَّل هذه اللقطة بعد.' : 'This shot is not analyzed yet.'}</p>}
        {tags.length > 0 && (
          <div className="cw-vl-tags">
            {tags.map((t) => <span key={t} className="cw-vl-tag" title={tagTitle(t, isAr)}>{tagLabel(t, isAr)}</span>)}
          </div>
        )}
        {!compact && r.why && <WhyBars why={r.why} isAr={isAr} />}
        <div className="cw-vl-cardfoot">
          <span className="cw-mono cw-muted">
            {r.duration_ms > 0 ? `${fmtMs(r.start_ms)} → ${fmtMs(r.end_ms)}` : `${isAr ? 'إطار عند' : 'frame at'} ${fmtMs(r.start_ms)}`}
          </span>
          {onVideo && (
            <button type="button" className="cw-expand" onClick={onVideo}>
              {isAr ? 'عرض الفيديو' : 'View video'}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

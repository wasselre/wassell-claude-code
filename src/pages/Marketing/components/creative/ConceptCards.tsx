/**
 * ConceptCards — stage 1 of the Creative Director: 2–3 concept cards, pick ONE.
 *
 * A concept is a direction (title + angle + format + one-line design idea), not
 * copy — the full package is generated only after a human picks. A custom
 * concept («اكتب فكرتك») is always offered so the writer can overrule the AI's
 * menu entirely.
 */
import { useState } from 'react';
import type { ConceptsOutput, PostFormat, RefAspect, RefKind } from '@/lib/creative/contracts';
import { REF_ASPECT_LABELS, REF_KIND_LABELS, platformLabel, pick } from './labels';

export default function ConceptCards({
  concepts, busy, isAr,
  onSelect,
}: {
  concepts: ConceptsOutput;
  busy: boolean;
  isAr: boolean;
  onSelect: (conceptId: string | null, custom?: { title: string; angle: string; format: PostFormat }) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [cTitle, setCTitle] = useState('');
  const [cAngle, setCAngle] = useState('');
  const [cFormat, setCFormat] = useState<PostFormat>('single');

  const confirm = (): void => {
    if (customOpen) {
      if (!cTitle.trim() || !cAngle.trim()) return;
      onSelect(null, { title: cTitle.trim(), angle: cAngle.trim(), format: cFormat });
      return;
    }
    if (picked) onSelect(picked);
  };

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'اختر الفكرة' : 'Pick a concept'}</h4>
        <span className="r">
          {isAr ? 'فكرة واحدة تُبنى عليها الحزمة كاملة' : 'One concept drives the whole package'}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 10 }}>
        {concepts.concepts.map((c) => {
          const on = picked === c.id && !customOpen;
          return (
            <button
              key={c.id}
              type="button"
              className={`opt${on ? ' pick' : ''}`}
              style={{ textAlign: 'start', cursor: 'pointer', width: '100%' }}
              onClick={() => { setPicked(c.id); setCustomOpen(false); }}
            >
              <span className="rd" aria-hidden />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="tx" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{c.title}</b>
                  <span className="tag">{c.format === 'carousel' ? (isAr ? 'كاروسيل' : 'Carousel') : (isAr ? 'صورة واحدة' : 'Single')}</span>
                  {concepts.recommended === c.id && (
                    <span className="tag tag-t">{isAr ? 'مقترحة' : 'Recommended'}</span>
                  )}
                </span>
                <span className="mt" style={{ display: 'block' }}>{c.angle}</span>
                <span className="mt" style={{ display: 'block' }}>
                  {isAr ? 'الفكرة التصميمية: ' : 'Design idea: '}{c.one_line_design_idea}
                </span>
                {c.leans_on_reference && (
                  <span className="mt" style={{ display: 'block' }}>
                    {isAr ? 'تستند إلى: ' : 'Leans on: '}
                    {pick(REF_KIND_LABELS, c.leans_on_reference.ref_kind as RefKind, isAr)}
                    {' · '}
                    {pick(REF_ASPECT_LABELS, c.leans_on_reference.aspect as RefAspect, isAr)}
                  </span>
                )}
                {c.suggested_targets.length > 0 && (
                  <span className="mt" style={{ display: 'block' }}>
                    {isAr ? 'الأهداف المقترحة: ' : 'Suggested targets: '}
                    {c.suggested_targets.map((t) => platformLabel(t.split(':')[0] ?? t, isAr)).join(isAr ? '، ' : ', ')}
                  </span>
                )}
                <span className="mt" style={{ display: 'block', color: 'var(--ink-2)' }}>{c.why}</span>
              </span>
            </button>
          );
        })}

        {/* The custom concept — the writer's own direction, same dignity. */}
        <button
          type="button"
          className={`opt${customOpen ? ' pick' : ''}`}
          style={{ textAlign: 'start', cursor: 'pointer', width: '100%' }}
          onClick={() => { setCustomOpen(true); setPicked(null); }}
        >
          <span className="rd" aria-hidden />
          <span className="tx"><b>{isAr ? 'فكرتي الخاصة…' : 'My own concept…'}</b></span>
        </button>

        {customOpen && (
          <div style={{ display: 'grid', gap: 10, padding: '4px 2px' }}>
            <label>
              <span className="lbl">{isAr ? 'العنوان' : 'Title'}</span>
              <input className="inp" value={cTitle} onChange={(e) => setCTitle(e.target.value)} style={{ marginTop: 4 }} />
            </label>
            <label>
              <span className="lbl">{isAr ? 'الزاوية' : 'Angle'}</span>
              <textarea className="inp" rows={2} value={cAngle} onChange={(e) => setCAngle(e.target.value)} style={{ marginTop: 4 }} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className={`fbtn${cFormat === 'single' ? ' on' : ''}`} onClick={() => setCFormat('single')}>
                {isAr ? 'صورة واحدة' : 'Single'}
              </button>
              <button type="button" className={`fbtn${cFormat === 'carousel' ? ' on' : ''}`} onClick={() => setCFormat('carousel')}>
                {isAr ? 'كاروسيل' : 'Carousel'}
              </button>
            </div>
          </div>
        )}

        {concepts.warnings.length > 0 && (
          <div className="notice bad" style={{ fontSize: 12 }}>
            {concepts.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}
        {concepts.missing.length > 0 && (
          <div className="notice" style={{ fontSize: 12 }}>
            <b>{isAr ? 'نواقص: ' : 'Missing: '}</b>
            {concepts.missing.join(isAr ? '، ' : ', ')}
          </div>
        )}

        <div>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || (!customOpen && !picked) || (customOpen && (!cTitle.trim() || !cAngle.trim()))}
            onClick={confirm}
          >
            {busy
              ? (isAr ? 'تُبنى الحزمة…' : 'Building the package…')
              : (isAr ? 'ابنِ الحزمة على هذه الفكرة' : 'Build the package on this concept')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ReferencesPanel — the posts/designs the package LEARNS from. Each reference
 * shows a real preview, the aspect it was picked for, and the four study lines
 * (why / study / adapt / do-not-copy / differ) — the difference between
 * "inspired by" and "copied from" is written down, per reference.
 *
 * References are reference-ONLY: competitor media never becomes a production
 * asset (contracts §0.9). Removing one edits the draft base; the removal lands
 * as a new human version on save.
 */
import type { ReferencePick } from '@/lib/creative/contracts';
import { REF_ASPECT_LABELS, REF_KIND_LABELS, pick } from './labels';

export default function ReferencesPanel({
  references, previews, canEdit, isAr, onRemove,
}: {
  references: ReferencePick[];
  previews: Record<string, string>;
  canEdit: boolean;
  isAr: boolean;
  onRemove: (index: number) => void;
}) {
  if (references.length === 0) return null;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'مراجع الاستلهام' : 'References'}</h4>
        <span className="r">{isAr ? 'للدراسة فقط — لا تدخل التصميم كأصول' : 'Study only — never production assets'}</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {references.map((r, i) => {
          const url = previews[r.ref_id] ?? r.preview_url ?? null;
          return (
            <div key={`${r.ref_id}-${i}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div
                style={{
                  width: 96, height: 96, borderRadius: 8, overflow: 'hidden', flex: '0 0 96px',
                  border: '1px solid var(--line)', background: 'var(--sand-2)',
                  display: 'grid', placeItems: 'center',
                }}
              >
                {url ? (
                  <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                ) : (
                  <span style={{ fontSize: 10, color: 'var(--mute)', textAlign: 'center', padding: 4 }}>
                    {isAr ? 'لا معاينة' : 'No preview'}
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="tag">{pick(REF_KIND_LABELS, r.ref_kind, isAr)}</span>
                  <span className="tag tag-t">{pick(REF_ASPECT_LABELS, r.aspect, isAr)}</span>
                  {r.level && (
                    <span className="tag">{r.level === 'slide' ? (isAr ? 'شريحة' : 'Slide') : (isAr ? 'منشور' : 'Post')}</span>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-d btn-sm"
                      style={{ marginInlineStart: 'auto' }}
                      onClick={() => onRemove(i)}
                    >
                      {isAr ? 'إزالة' : 'Remove'}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8 }}><b>{isAr ? 'لماذا: ' : 'Why: '}</b>{r.why}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8 }}><b>{isAr ? 'ندرس: ' : 'Study: '}</b>{r.study}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8 }}><b>{isAr ? 'نكيّف: ' : 'Adapt: '}</b>{r.adapt}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--late)' }}>
                  <b>{isAr ? 'لا ننسخ: ' : 'Do not copy: '}</b>{r.do_not_copy}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.8 }}><b>{isAr ? 'نتمايز بـ: ' : 'We differ by: '}</b>{r.differ}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

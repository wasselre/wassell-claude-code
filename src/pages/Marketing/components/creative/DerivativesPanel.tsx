/**
 * DerivativesPanel — one card per selected target: the exact geometry (aspect +
 * px from PLACEMENT_SPECS, never invented), the FULL VisualAdaptation the
 * designer follows (crop/extend, text + logo reposition, layout changes,
 * scaling, slide mapping, asset substitutions, separate-design badge), and the
 * per-target copy (organic caption+hashtags with a live limit counter, or the
 * five paid fields).
 *
 * Copy and the prose adaptation fields are editable; saving mints a new human
 * version server-side (the parent sends the whole derivative set).
 */
import { useState } from 'react';
import type {
  CreativeDerivativeRow, OrganicCopy, PaidCopy, VisualAdaptation,
} from '@/lib/creative/contracts';
import { num } from '../../lib/format';
import {
  IMAGE_CHANGE_LABELS, PLACEMENT_LABELS, TARGET_KIND_LABELS, platformLabel, pick,
} from './labels';

const isOrganic = (d: CreativeDerivativeRow): boolean => d.target_kind === 'organic';

function captionMax(d: CreativeDerivativeRow): number | null {
  const v = d.limits['caption_max'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function hashtagsMax(d: CreativeDerivativeRow): number | null {
  const v = d.limits['hashtags_max'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export default function DerivativesPanel({
  derivatives, canEdit, isAr, onChange,
}: {
  derivatives: CreativeDerivativeRow[];
  canEdit: boolean;
  isAr: boolean;
  onChange: (index: number, next: CreativeDerivativeRow) => void;
}) {
  const [openAdapt, setOpenAdapt] = useState<Set<number>>(new Set());

  if (derivatives.length === 0) return null;

  const toggleAdapt = (i: number): void => {
    setOpenAdapt((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const patchCopy = (i: number, copy: CreativeDerivativeRow['copy']): void =>
    onChange(i, { ...derivatives[i]!, copy });
  const patchAdaptation = (i: number, patch: Partial<VisualAdaptation>): void =>
    onChange(i, { ...derivatives[i]!, adaptation: { ...derivatives[i]!.adaptation, ...patch } });

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'المشتقات — نسخة لكل هدف' : 'Derivatives — one per target'}</h4>
        <span className="r">
          {isAr ? `${num(derivatives.length, true)} أهداف` : `${derivatives.length} targets`}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {derivatives.map((d, i) => {
          const open = openAdapt.has(i);
          const capMax = captionMax(d);
          const tagMax = hashtagsMax(d);
          const organic = isOrganic(d);
          const oc = organic ? (d.copy as OrganicCopy) : null;
          const pc = !organic ? (d.copy as PaidCopy) : null;
          return (
            <div key={d.id} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 13 }}>{platformLabel(d.platform, isAr)}</b>
                <span className="tag">{pick(PLACEMENT_LABELS, d.placement_type, isAr)}</span>
                <span className="tag">{pick(TARGET_KIND_LABELS, d.target_kind, isAr)}</span>
                <span className="tag ltr" style={{ fontSize: 10 }}>
                  {d.dimensions.aspect} · {d.dimensions.px[0]}×{d.dimensions.px[1]}
                </span>
                {d.adaptation.requires_separate_design && (
                  <span className="pill p-wait">
                    {isAr ? 'تصميم منفصل (إعادة تخطيط)' : 'Separate design (re-layout)'}
                  </span>
                )}
                {d.status === 'applied' && (
                  <span className="pill p-go">{isAr ? 'مُطبَّقة' : 'Applied'}</span>
                )}
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  style={{ marginInlineStart: 'auto' }}
                  onClick={() => toggleAdapt(i)}
                >
                  {open
                    ? (isAr ? 'إخفاء التكييف' : 'Hide adaptation')
                    : (isAr ? 'التكييف البصري' : 'Visual adaptation')}
                </button>
              </div>

              {d.warnings.length > 0 && (
                <div className="notice" style={{ fontSize: 12 }}>
                  {d.warnings.map((w, wi) => <div key={wi}>{w}</div>)}
                </div>
              )}

              {/* ── copy ─────────────────────────────────────────────── */}
              {organic && oc && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <label>
                    <span className="lbl">
                      {isAr ? 'الكابشن' : 'Caption'}
                      {capMax !== null && (
                        <span style={{ fontWeight: 400, color: (oc.caption?.length ?? 0) > capMax ? 'var(--late)' : 'var(--mute)' }}>
                          {' · '}{num(oc.caption?.length ?? 0, isAr)} / {num(capMax, isAr)}
                        </span>
                      )}
                    </span>
                    <textarea
                      className="inp"
                      rows={4}
                      style={{ marginTop: 4 }}
                      value={oc.caption ?? ''}
                      disabled={!canEdit}
                      onChange={(e) => patchCopy(i, { ...oc, caption: e.target.value, char_count: e.target.value.length })}
                    />
                  </label>
                  <label>
                    <span className="lbl">
                      {isAr ? 'الوسوم (مفصولة بفاصلة)' : 'Hashtags (comma-separated)'}
                      {tagMax !== null && (
                        <span style={{ fontWeight: 400, color: (oc.hashtags?.length ?? 0) > tagMax ? 'var(--late)' : 'var(--mute)' }}>
                          {' · '}{num(oc.hashtags?.length ?? 0, isAr)} / {num(tagMax, isAr)}
                        </span>
                      )}
                    </span>
                    <input
                      className="inp"
                      style={{ marginTop: 4 }}
                      value={(oc.hashtags ?? []).join('، ')}
                      disabled={!canEdit}
                      onChange={(e) =>
                        patchCopy(i, {
                          ...oc,
                          hashtags: e.target.value.split(/[،,]/).map((h) => h.trim()).filter(Boolean),
                        })}
                    />
                  </label>
                </div>
              )}
              {!organic && pc && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <label>
                    <span className="lbl">{isAr ? 'النص الأساسي' : 'Primary text'}</span>
                    <textarea
                      className="inp" rows={3} style={{ marginTop: 4 }}
                      value={pc.primary_text ?? ''} disabled={!canEdit}
                      onChange={(e) => patchCopy(i, { ...pc, primary_text: e.target.value })}
                    />
                  </label>
                  <div className="grid g2" style={{ gap: 10 }}>
                    <label>
                      <span className="lbl">{isAr ? 'العنوان' : 'Headline'}</span>
                      <input
                        className="inp" style={{ marginTop: 4 }}
                        value={pc.headline ?? ''} disabled={!canEdit}
                        onChange={(e) => patchCopy(i, { ...pc, headline: e.target.value })}
                      />
                    </label>
                    <label>
                      <span className="lbl">{isAr ? 'الوصف' : 'Description'}</span>
                      <input
                        className="inp" style={{ marginTop: 4 }}
                        value={pc.description ?? ''} disabled={!canEdit}
                        onChange={(e) => patchCopy(i, { ...pc, description: e.target.value })}
                      />
                    </label>
                    <label>
                      <span className="lbl">{isAr ? 'الدعوة لإجراء' : 'CTA'}</span>
                      <input
                        className="inp" style={{ marginTop: 4 }}
                        value={pc.cta ?? ''} disabled={!canEdit}
                        onChange={(e) => patchCopy(i, { ...pc, cta: e.target.value })}
                      />
                    </label>
                    <label>
                      <span className="lbl">{isAr ? 'رابط الوجهة' : 'Destination URL'}</span>
                      <input
                        className="inp ltr" style={{ marginTop: 4 }}
                        value={pc.destination_url ?? ''} disabled={!canEdit}
                        onChange={(e) => patchCopy(i, { ...pc, destination_url: e.target.value || null })}
                      />
                    </label>
                  </div>
                </div>
              )}

              {/* ── the full VisualAdaptation ────────────────────────── */}
              {open && (
                <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="tag">{pick(IMAGE_CHANGE_LABELS, d.adaptation.image_change, isAr)}</span>
                    {(d.adaptation.safe_zones.top || d.adaptation.safe_zones.bottom) && (
                      <span className="tag ltr" style={{ fontSize: 10 }}>
                        {isAr ? 'مناطق آمنة' : 'safe'} ↑{d.adaptation.safe_zones.top ?? 0} ↓{d.adaptation.safe_zones.bottom ?? 0}
                      </span>
                    )}
                  </div>
                  {(
                    [
                      ['image_instructions', isAr ? 'تعليمات الصورة (قص/تمديد)' : 'Image instructions (crop/extend)'],
                      ['text_reposition', isAr ? 'إعادة موضعة النص' : 'Text reposition'],
                      ['logo_reposition', isAr ? 'إعادة موضعة الشعار' : 'Logo reposition'],
                      ['layout_changes', isAr ? 'تغييرات التخطيط' : 'Layout changes'],
                      ['element_scaling', isAr ? 'تحجيم العناصر' : 'Element scaling'],
                    ] as Array<[keyof VisualAdaptation & string, string]>
                  ).map(([key, label]) => (
                    <label key={key}>
                      <span className="lbl">{label}</span>
                      <textarea
                        className="inp" rows={2} style={{ marginTop: 3 }}
                        value={String(d.adaptation[key] ?? '')}
                        disabled={!canEdit}
                        onChange={(e) => patchAdaptation(i, { [key]: e.target.value } as Partial<VisualAdaptation>)}
                      />
                    </label>
                  ))}

                  {d.adaptation.slide_mapping.length > 0 && (
                    <div>
                      <span className="lbl">{isAr ? 'خريطة الشرائح' : 'Slide mapping'}</span>
                      <div className="tbl-wrap" style={{ marginTop: 4 }}>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th style={{ width: 90 }}>{isAr ? 'من شريحة' : 'From slide'}</th>
                              <th style={{ width: 90 }}>{isAr ? 'إلى إطار' : 'To frame'}</th>
                              <th>{isAr ? 'ملاحظة' : 'Note'}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.adaptation.slide_mapping.map((m, mi) => (
                              <tr key={mi}>
                                <td className="ltr">{num(m.from_index, isAr)}</td>
                                <td className="ltr">{m.to_index === null ? '—' : num(m.to_index, isAr)}</td>
                                <td>{m.note}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {d.adaptation.asset_substitutions.length > 0 && (
                    <div>
                      <span className="lbl">{isAr ? 'استبدالات الأصول' : 'Asset substitutions'}</span>
                      <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                        {d.adaptation.asset_substitutions.map((s, si) => (
                          <div key={si} style={{ fontSize: 12, lineHeight: 1.8 }}>
                            <span className="tag ltr" style={{ fontSize: 10 }}>{s.from_file_id.slice(0, 8)}</span>
                            {' → '}
                            <span className="tag ltr" style={{ fontSize: 10 }}>{s.to_file_id ? s.to_file_id.slice(0, 8) : (isAr ? 'بلا' : 'none')}</span>
                            {' — '}{s.reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

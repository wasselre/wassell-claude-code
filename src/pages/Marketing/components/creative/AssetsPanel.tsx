/**
 * AssetsPanel — the production assets the design will actually use. Every pick
 * carries its trust posture as badges (nature / source / rights / verified), so
 * "can we ship this photo?" is answered on the card, not in a file manager.
 *
 * Replace goes through the shared FilePickerModal scoped to the project's files
 * with restricted/do_not_use rights filtered OUT (they are never selectable for
 * production, contracts §0.9) and the rights/nature/source meta chips on. The
 * server re-snapshots the replacement's rights; a pick with unclear rights
 * comes back with `needs_rights_confirmation` and the amber ribbon stays until
 * a human confirms at Apply time.
 */
import { useState } from 'react';
import type { AssetPick } from '@/lib/creative/contracts';
import FilePickerModal from '@/pages/Files/library/FilePickerModal';
import {
  ACQUISITION_LABELS, ASSET_NATURE_LABELS, ASSET_USAGE_LABELS,
  PRODUCTION_STATE_LABELS, USAGE_RIGHTS_LABELS, pick,
} from './labels';

/** Rights the picker may offer for production — restricted/do_not_use excluded. */
const SELECTABLE_RIGHTS = ['approved', 'use_after_edit', 'attribution_required', 'internal_only', 'needs_review'];

export default function AssetsPanel({
  assets, previews, projectId, canEdit, replacing, isAr, onReplace,
}: {
  assets: AssetPick[];
  previews: Record<string, string>;
  projectId: string | null;
  canEdit: boolean;
  /** Index currently being replaced server-side, or null. */
  replacing: number | null;
  isAr: boolean;
  onReplace: (index: number, fileId: string) => void;
}) {
  const [pickerFor, setPickerFor] = useState<number | null>(null);

  if (assets.length === 0) return null;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الأصول المختارة' : 'Selected assets'}</h4>
        <span className="r">
          {isAr ? 'الحقوق تُعاد مراجعتها عند الاعتماد النهائي' : 'Rights are re-checked at final approval'}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {assets.map((a, i) => {
          const url = previews[a.file_id] ?? null;
          const rightsTone = a.rights === 'restricted' || a.rights === 'do_not_use'
            ? 'p-late'
            : a.rights_verified ? 'p-go' : 'p-wait';
          return (
            <div key={`${a.file_id}-${i}`} style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
              {a.needs_rights_confirmation && (
                <div
                  style={{
                    background: 'color-mix(in srgb, var(--wait) 12%, transparent)',
                    color: 'var(--wait)', fontSize: 11.5, fontWeight: 700,
                    padding: '5px 10px',
                  }}
                >
                  {isAr
                    ? 'الحقوق غير مؤكدة — تتطلب تأكيدًا بشريًا قبل الاعتماد النهائي'
                    : 'Rights unconfirmed — needs a human confirmation before final approval'}
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, padding: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div
                  style={{
                    width: 88, height: 88, borderRadius: 8, overflow: 'hidden', flex: '0 0 88px',
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
                <div style={{ flex: 1, minWidth: 220, display: 'grid', gap: 5 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13 }}>{a.placement}</b>
                    {!a.is_production && (
                      <span className="tag">{isAr ? 'مرجع فقط' : 'Reference only'}</span>
                    )}
                    {canEdit && a.is_production && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginInlineStart: 'auto' }}
                        disabled={replacing !== null}
                        onClick={() => setPickerFor(i)}
                      >
                        {replacing === i
                          ? (isAr ? 'يُستبدل…' : 'Replacing…')
                          : (isAr ? 'استبدال' : 'Replace')}
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {a.nature && <span className="tag">{pick(ASSET_NATURE_LABELS, a.nature, isAr)}</span>}
                    {a.source && <span className="tag">{pick(ACQUISITION_LABELS, a.source, isAr)}</span>}
                    {a.rights && (
                      <span className={`pill ${rightsTone}`}>
                        {pick(USAGE_RIGHTS_LABELS, a.rights, isAr)}
                        {a.rights_verified ? (isAr ? ' · موثّقة' : ' · verified') : (isAr ? ' · غير موثّقة' : ' · unverified')}
                      </span>
                    )}
                    {a.production_state && (
                      <span className="tag">{pick(PRODUCTION_STATE_LABELS, a.production_state, isAr)}</span>
                    )}
                    <span className="tag tag-t">{pick(ASSET_USAGE_LABELS, a.usage, isAr)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.8 }}>
                    <b>{isAr ? 'المعالجة: ' : 'Treatment: '}</b>{a.treatment}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8 }}>
                    <b>{isAr ? 'لماذا: ' : 'Why: '}</b>{a.why}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <FilePickerModal
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        title={isAr ? 'استبدال الأصل' : 'Replace the asset'}
        sub={isAr
          ? 'ملفات المشروع — الحقوق المقيّدة والممنوعة غير قابلة للاختيار'
          : 'Project files — restricted and do-not-use rights are not selectable'}
        uploadRecordId={projectId}
        filters={{
          ...(projectId ? { linked_record_id: projectId } : {}),
          primary_category: 'image',
          usage_rights: SELECTABLE_RIGHTS,
        }}
        showMeta
        onPick={(f) => {
          const idx = pickerFor;
          setPickerFor(null);
          if (idx !== null) onReplace(idx, f.id);
        }}
      />
    </div>
  );
}

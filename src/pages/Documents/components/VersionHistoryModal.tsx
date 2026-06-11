import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Bookmark, Clock, Eye, History, Loader2, RotateCcw, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useAppStore } from '@/stores/appStore';
import {
  getVersion,
  listVersions,
  snapshotVersion,
  type DocVersionFull,
  type DocVersionMeta,
  type VersionKind,
} from '@/lib/documents/versions';

/**
 * Version history browser. Lists snapshots newest-first, previews one
 * (rendered from its stored content_html inside the doc-styling surface),
 * lets editors stamp a labeled manual version, and restores old content.
 *
 * Restore contract (owned by the PAGE via onRestore): snapshot the CURRENT
 * content first (kind='restore' — the safety net), then setContent + save.
 */

interface Props {
  open: boolean;
  fileId: string;
  /** Current doc version + content getters — for manual snapshots. */
  docVersion: number;
  getJson: () => Record<string, unknown>;
  getHtml: () => string;
  canEdit: boolean;
  onClose: () => void;
  /** Apply a version's content to the live editor (page restores + saves). */
  onRestore: (v: DocVersionFull) => Promise<void>;
}

export default function VersionHistoryModal({
  open,
  fileId,
  docVersion,
  getJson,
  getHtml,
  canEdit,
  onClose,
  onRestore,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);

  const [versions, setVersions] = useState<DocVersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<DocVersionFull | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<DocVersionFull | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(() => {
    if (!fileId) return;
    setLoading(true);
    listVersions(fileId)
      .then(setVersions)
      .catch(() => undefined) // surfaced by the lib
      .finally(() => setLoading(false));
  }, [fileId]);

  useEffect(() => {
    if (open) {
      refresh();
      setPreview(null);
      setLabel('');
    }
  }, [open, refresh]);

  const userName = (id: string | null): string => {
    if (!id) return t('doc.versions.system');
    const u = users.find((x) => x.id === id);
    return u ? (isAr ? u.name_ar : u.name_en) || u.email : t('doc.comments.unknown_user');
  };

  const fmtTime = (iso: string): string =>
    new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  const kindMeta: Record<VersionKind, { label: string; cls: string }> = {
    auto: { label: t('doc.versions.kind_auto'), cls: 'bg-cream text-charcoal/60' },
    manual: { label: t('doc.versions.kind_manual'), cls: 'bg-copper/15 text-copper' },
    approval: { label: t('doc.versions.kind_approval'), cls: 'bg-emerald-100 text-emerald-700' },
    restore: { label: t('doc.versions.kind_restore'), cls: 'bg-amber-100 text-amber-700' },
  };

  const saveManual = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await snapshotVersion({
        fileId,
        docVersion,
        kind: 'manual',
        label,
        contentJson: getJson(),
        contentHtml: getHtml(),
      });
      setLabel('');
      refresh();
    } catch {
      // surfaced by the lib
    } finally {
      setSaving(false);
    }
  };

  const openPreview = async (meta: DocVersionMeta) => {
    setPreviewLoading(meta.id);
    try {
      const full = await getVersion(meta.id);
      if (full) setPreview(full);
    } catch {
      // surfaced by the lib
    } finally {
      setPreviewLoading(null);
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title={t('doc.versions.title')} maxWidth="max-w-3xl">
        {/* Manual snapshot composer (editors only). */}
        {canEdit && (
          <div className="flex items-center gap-2 mb-4">
            <Bookmark size={16} className="text-copper shrink-0" />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              dir="auto"
              placeholder={t('doc.versions.label_placeholder')}
              className="flex-1 min-w-0 text-sm rounded-lg border border-sand/60 bg-white px-3 py-2 focus:border-copper focus:outline-none"
            />
            <Button variant="primary" disabled={saving} onClick={() => void saveManual()}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {t('doc.versions.save_now')}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="py-10 flex justify-center">
            <Loader2 size={22} className="animate-spin text-copper" />
          </div>
        ) : versions.length === 0 ? (
          <div className="py-10 text-center text-sm text-charcoal/50">
            <History size={28} className="mx-auto mb-2 text-charcoal/30" />
            {t('doc.versions.empty')}
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1 space-y-1.5">
            {versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-2.5 rounded-lg border border-sand/40 bg-white px-3 py-2 hover:border-sand transition-colors"
              >
                <Clock size={14} className="text-charcoal/35 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-charcoal">{fmtTime(v.created_at)}</span>
                    <span className={`text-[0.625rem] font-bold px-1.5 py-0.5 rounded-full ${kindMeta[v.kind].cls}`}>
                      {kindMeta[v.kind].label}
                    </span>
                    {v.label && (
                      <span className="text-xs text-charcoal/70 truncate" dir="auto">
                        {v.label}
                      </span>
                    )}
                  </div>
                  <div className="text-[0.6875rem] text-charcoal/45">
                    {userName(v.created_by_user_id)} · v{v.doc_version}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void openPreview(v)}
                  title={t('doc.versions.preview')}
                  aria-label={t('doc.versions.preview')}
                  className="p-1.5 rounded-lg text-charcoal/50 hover:text-copper hover:bg-cream shrink-0"
                >
                  {previewLoading === v.id ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Preview overlay — renders the snapshot's stored HTML inside the doc
          styling surface, with Restore in the footer. Sits above the list
          modal (both are portals; the later one paints on top). */}
      {preview && (
        <Modal
          open
          onClose={() => setPreview(null)}
          maxWidth="max-w-3xl"
          footer={
            <>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                {t('common.close')}
              </Button>
              {canEdit && (
                <Button variant="primary" onClick={() => setConfirmRestore(preview)}>
                  <RotateCcw size={14} />
                  {t('doc.versions.restore')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex items-center gap-2 mb-3 text-sm text-charcoal/60">
            <BadgeCheck size={15} className="text-copper" />
            <span className="font-bold text-charcoal">{fmtTime(preview.created_at)}</span>
            <span>· {userName(preview.created_by_user_id)}</span>
            {preview.label && <span dir="auto">· {preview.label}</span>}
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="ms-auto p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-cream"
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
          <div
            className="wassel-doc-surface max-h-[55vh] overflow-y-auto rounded-lg border border-sand/40 bg-white p-5 doc-version-preview"
            dir="auto"
            // Stored render of OUR OWN editor output (same sanitization path
            // as the live share view) — not arbitrary user HTML.
            dangerouslySetInnerHTML={{ __html: preview.content_html }}
          />
        </Modal>
      )}

      <ConfirmModal
        open={!!confirmRestore}
        danger={false}
        title={t('doc.versions.restore_title')}
        message={t('doc.versions.restore_msg')}
        confirmLabel={t('doc.versions.restore')}
        cancelLabel={t('common.cancel')}
        busy={restoring}
        onClose={() => setConfirmRestore(null)}
        onConfirm={() => {
          if (!confirmRestore) return;
          setRestoring(true);
          void onRestore(confirmRestore)
            .then(() => {
              setConfirmRestore(null);
              setPreview(null);
              refresh();
            })
            .finally(() => setRestoring(false));
        }}
      />
    </>
  );
}

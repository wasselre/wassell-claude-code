/**
 * Phase 3 · B6 — the unified Files panel on a record form.
 *
 * Spec §9: "One component, RecordFilesPanel, mounted on every record form... It
 * queries file_links for (model_id, record_id) and groups by role."
 *
 * ── THIS IS THE SURFACE THAT MAKES MANY-TO-MANY VISIBLE ───────────────────
 * The same brochure genuinely appears under a project and three units, and the
 * panel says **linked**, not copied. That is the one piece of conceptual load
 * Phase 3 puts on users, and it is worth it: the alternative is a Files UI that
 * silently disagrees with the record form.
 *
 * ── DERIVED ENTRIES ARE READ-ONLY, AND SAY WHY ────────────────────────────
 * An entry that comes from a record FIELD cannot be unlinked here — the truth
 * is the field, and removing the projection would either do nothing or make
 * this panel disagree with the form two inches above it. Those rows show where
 * they come from instead. Only a manual link has a remove button.
 *
 * ── IT DOES NOT REPLACE DOCUMENT GENERATION ───────────────────────────────
 * The spec describes this panel as replacing "the current split between
 * LinkedDocumentsPanel and RecordDocumentsPanel". It replaces the FIRST.
 * RecordDocumentsPanel is the document-GENERATION surface (template picker,
 * job polling, send-to-customer) backed by its own worker queue; folding that
 * into this panel is cosmetic reorganisation with real regression risk, and
 * generated PDFs already appear HERE anyway — the generator writes a
 * `document_links` row, so its output arrives through the projection like
 * everything else. Deliberate scope call, recorded rather than silent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Download, FileText, Link2, Loader2, Lock, Paperclip, Unlink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import { signDownloadUrl } from '@/lib/files/client';
import { listDocumentTypes } from '@/lib/files/library';
import {
  detachFileFromRecord, groupByRole, listRecordFiles, type RecordFileEntry,
} from '@/lib/files/recordFiles';
import type { FileDocumentTypeRow } from '@/types';
import { documentTypeLabel } from '@/pages/Files/library/labels';
import AttachExistingFileModal from './AttachExistingFileModal';

interface Props {
  modelId: string;
  recordId: string;
}

export default function RecordFilesPanel({ modelId, recordId }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');

  const [entries, setEntries] = useState<RecordFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<FileDocumentTypeRow[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [detachTarget, setDetachTarget] = useState<RecordFileEntry | null>(null);
  const [detaching, setDetaching] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listRecordFiles(modelId, recordId));
    } catch (e) {
      // A record whose files could not load must NOT render as a record with
      // no files. Separate state, separate screen, with a retry.
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    }
  }, [modelId, recordId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listDocumentTypes();
        if (!cancelled) setTypes(list);
      } catch {
        // listDocumentTypes toasted. Labels fall back to the raw slug — ugly
        // but true, and far better than refusing to render the panel.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onDetach = useCallback(async () => {
    const target = detachTarget;
    if (!target) return;
    setDetaching(true);
    try {
      await detachFileFromRecord(target.file.id, modelId, recordId);
      setDetachTarget(null);
      await load();
    } catch {
      // detachFileFromRecord toasted; keep the dialog open so the user sees why.
    } finally {
      setDetaching(false);
    }
  }, [detachTarget, modelId, recordId, load]);

  const download = useCallback(async (fileId: string) => {
    try {
      const { url } = await signDownloadUrl(fileId);
      window.open(url, '_blank', 'noopener');
    } catch {
      // signDownloadUrl surfaced it.
    }
  }, []);

  const linkedIds = useMemo(
    () => new Set((entries ?? []).map((e) => e.file.id)),
    [entries],
  );
  const groups = useMemo(() => groupByRole(entries ?? []), [entries]);

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Paperclip size={16} className="text-copper" aria-hidden />
          <h3 className="font-bold text-charcoal text-sm">{t('files.record.panel_title')}</h3>
          {entries && entries.length > 0 && (
            <span className="text-xs text-charcoal/35 tabular-nums">({entries.length})</span>
          )}
          {entries === null && !error && (
            <Loader2 size={13} className="animate-spin text-charcoal/30" aria-hidden />
          )}
        </div>
        <Button
          variant="secondary"
          className="!px-3 !py-2 text-xs"
          onClick={() => setAttachOpen(true)}
        >
          <Link2 size={13} aria-hidden />
          {t('files.record.attach_existing')}
        </Button>
      </div>

      {error ? (
        <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/25" role="alert">
          <p className="flex items-start gap-2 text-xs text-red-700">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>{t('files.record.load_failed')} — {error}</span>
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 px-2.5 py-1 rounded-lg bg-white border border-red-500/25 text-xs font-bold text-red-700 hover:bg-red-500/10"
          >
            {t('files.library.retry')}
          </button>
        </div>
      ) : entries !== null && entries.length === 0 ? (
        <p className="text-xs text-charcoal/45 py-2">{t('files.record.empty')}</p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.role}>
              <h4 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-charcoal/35">
                {documentTypeLabel(g.role, types, isAr)}
                <span className="ms-1.5 text-charcoal/25 tabular-nums">{g.entries.length}</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {g.entries.map((e) => {
                  const Icon = kindIcon[e.file.kind];
                  const accent = kindAccent[e.file.kind];
                  return (
                    <div
                      key={e.link_id}
                      className="group flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-sand/30 hover:border-copper/30 hover:bg-cream/60 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (e.file.kind === 'wassel_doc') navigate(`/files/doc/${e.file.id}`);
                          else void download(e.file.id);
                        }}
                        className="flex items-center gap-2.5 min-w-0 flex-1 text-start"
                      >
                        <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${accent.bg}`}>
                          <Icon size={15} className={accent.fg} aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span
                            className="block text-sm font-bold text-charcoal truncate"
                            dir="auto"
                            title={e.file.title}
                          >
                            {e.file.title}
                          </span>
                          <span className="block text-[11px] text-charcoal/40">
                            {formatBytes(e.file.size_bytes, isAr)}
                            {/* Where this came from. A derived row says so; a
                                manual one does not need to. */}
                            {!e.removable && e.sourceField && (
                              <span className="ms-1.5 inline-flex items-center gap-1">
                                <Lock size={9} aria-hidden />
                                {t('files.record.from_field', { field: e.sourceField })}
                              </span>
                            )}
                            {!e.removable && !e.sourceField && (
                              <span className="ms-1.5 inline-flex items-center gap-1">
                                <Lock size={9} aria-hidden />
                                {t('files.record.derived')}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>

                      <span className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void download(e.file.id)}
                          aria-label={t('files.library.download')}
                          className="p-1.5 rounded-md text-charcoal/0 group-hover:text-charcoal/40 hover:!text-copper hover:bg-copper/10 transition-colors"
                        >
                          <Download size={13} aria-hidden />
                        </button>
                        {e.removable && (
                          <button
                            type="button"
                            onClick={() => setDetachTarget(e)}
                            aria-label={t('files.record.unlink')}
                            className="p-1.5 rounded-md text-charcoal/0 group-hover:text-charcoal/40 hover:!text-red-600 hover:bg-red-500/10 transition-colors"
                          >
                            <Unlink size={13} aria-hidden />
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <AttachExistingFileModal
        open={attachOpen}
        modelId={modelId}
        recordId={recordId}
        types={types}
        alreadyLinkedFileIds={linkedIds}
        onClose={() => setAttachOpen(false)}
        onAttached={() => { void load(); }}
      />

      <ConfirmModal
        open={Boolean(detachTarget)}
        danger={false}
        busy={detaching}
        title={t('files.record.unlink_title')}
        message={
          <span>
            {t('files.record.unlink_message', { name: detachTarget?.file.title ?? '' })}
            {/* The honest warning: an edge proven by a field AND a manual link
                does not disappear when the manual link goes. Saying "removed"
                and leaving the row on screen is exactly the kind of quiet
                disagreement this panel exists to prevent. */}
            {detachTarget?.survivesRemoval && (
              <span className="mt-2 block text-xs text-amber-700">
                <FileText size={11} className="inline me-1" aria-hidden />
                {t('files.record.unlink_survives')}
              </span>
            )}
          </span>
        }
        confirmLabel={t('files.record.unlink')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void onDetach()}
        onClose={() => setDetachTarget(null)}
      />
    </div>
  );
}

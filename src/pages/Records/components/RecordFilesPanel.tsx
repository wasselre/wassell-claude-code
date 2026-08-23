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
  AlertTriangle, Download, FileText, LayoutGrid, Link2, List, Loader2, Lock, Paperclip, Unlink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import { getFile, signDownloadUrl, signViewUrls } from '@/lib/files/client';
import { errorText, listDocumentTypes } from '@/lib/files/library';
import {
  detachFileFromRecord, groupByRole, listRecordFiles, type RecordFileEntry,
} from '@/lib/files/recordFiles';
import type { FileDocumentTypeRow, FileRow } from '@/types';
import { documentTypeLabel } from '@/pages/Files/library/labels';
import FilePreviewModal from '@/pages/Files/components/FilePreviewModal';
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
  // Signed thumbnails for the image files in the panel (one batch request, the
  // same pattern the Library uses) and the row currently open in the full
  // preview modal.
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [previewRow, setPreviewRow] = useState<FileRow | null>(null);
  // Grid (file/thumbnail-focused) vs list (name + metadata-focused), the same
  // two layouts the Files Library offers. Remembered per browser.
  const [layout, setLayout] = useState<'grid' | 'list'>(() => {
    if (typeof window === 'undefined') return 'grid';
    return window.localStorage.getItem('wassell_record_files_layout') === 'list' ? 'list' : 'grid';
  });
  const changeLayout = useCallback((next: 'grid' | 'list') => {
    setLayout(next);
    try { window.localStorage.setItem('wassell_record_files_layout', next); } catch { /* private mode — the choice still applies this session */ }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listRecordFiles(modelId, recordId));
    } catch (e) {
      // A record whose files could not load must NOT render as a record with
      // no files. Separate state, separate screen, with a retry.
      setError(errorText(e));
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

  // Thumbnails: one batch sign for the image files on show, exactly as the
  // Library page does — a tile never signs its own URL. Ids are de-duplicated
  // because the same file legitimately appears under more than one role. A
  // failure is silent (signViewUrls surfaces it): a thumbnail is decoration and
  // the tile falls back to its kind icon.
  useEffect(() => {
    const imageIds = [
      ...new Set((entries ?? []).filter((e) => e.file.kind === 'image').map((e) => e.file.id)),
    ];
    if (imageIds.length === 0) { setThumbs({}); return; }
    let cancelled = false;
    void (async () => {
      try {
        const map = await signViewUrls(imageIds);
        if (!cancelled) setThumbs(map);
      } catch {
        if (!cancelled) setThumbs({});
      }
    })();
    return () => { cancelled = true; };
  }, [entries]);

  const openPreview = useCallback(async (fileId: string) => {
    try {
      // FilePreviewModal needs the full storage row (mime, preview cache); the
      // record-files payload deliberately omits those, so one row is fetched on
      // demand rather than widening every entry.
      const row = await getFile(fileId);
      if (row) setPreviewRow(row);
    } catch {
      // getFile toasted.
    }
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

  // A doc opens its editor; everything else opens the full previewer — images,
  // PDFs, video, audio and office files all render inline there, so a record
  // reads like the Library rather than forcing a download to see what a file is.
  const openEntry = (e: RecordFileEntry) => {
    if (e.file.kind === 'wassel_doc') navigate(`/files/doc/${e.file.id}`);
    else void openPreview(e.file.id);
  };

  // Where a non-removable row comes from — a field, or another derivation.
  const sourceSuffix = (e: RecordFileEntry) =>
    e.removable ? null : (
      <span className="ms-1.5 inline-flex items-center gap-1">
        <Lock size={9} aria-hidden />
        {e.sourceField ? t('files.record.from_field', { field: e.sourceField }) : t('files.record.derived')}
      </span>
    );

  // Grid: file-focused. A big thumbnail (or the kind icon) leads; name + size
  // sit under it; the download / unlink actions overlay the corner on hover.
  const renderTile = (e: RecordFileEntry) => {
    const Icon = kindIcon[e.file.kind];
    const accent = kindAccent[e.file.kind];
    const thumb = thumbs[e.file.id];
    return (
      <div
        key={e.link_id}
        className="group relative rounded-xl border border-sand/30 bg-white overflow-hidden hover:border-copper/30 hover:shadow-md transition-all"
      >
        <button type="button" onClick={() => openEntry(e)} className="block w-full text-start">
          <div className={`relative h-28 flex items-center justify-center ${accent.bg}`}>
            {thumb ? (
              <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover" />
            ) : (
              <Icon size={28} className={accent.fg} aria-hidden />
            )}
          </div>
          <div className="p-2.5">
            <div className="text-sm font-bold text-charcoal line-clamp-2 leading-snug" dir="auto" title={e.file.title}>
              {e.file.title}
            </div>
            <div className="mt-1 text-[11px] text-charcoal/45 flex items-center flex-wrap">
              {formatBytes(e.file.size_bytes, isAr)}
              {sourceSuffix(e)}
            </div>
          </div>
        </button>
        <span className="absolute top-1.5 end-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => void download(e.file.id)}
            aria-label={t('files.library.download')}
            className="p-1.5 rounded-md bg-white/90 border border-sand/40 text-charcoal/60 hover:!text-copper hover:bg-white transition-colors"
          >
            <Download size={13} aria-hidden />
          </button>
          {e.removable && (
            <button
              type="button"
              onClick={() => setDetachTarget(e)}
              aria-label={t('files.record.unlink')}
              className="p-1.5 rounded-md bg-white/90 border border-sand/40 text-charcoal/60 hover:!text-red-600 hover:bg-white transition-colors"
            >
              <Unlink size={13} aria-hidden />
            </button>
          )}
        </span>
      </div>
    );
  };

  // List: name + metadata focused. A small thumbnail, the title, and the type ·
  // size line; actions reveal on hover at the end of the row.
  const renderRow = (e: RecordFileEntry) => {
    const Icon = kindIcon[e.file.kind];
    const accent = kindAccent[e.file.kind];
    const thumb = thumbs[e.file.id];
    return (
      <div
        key={e.link_id}
        className="group flex items-center gap-2.5 px-3 py-2 rounded-xl border border-sand/30 hover:border-copper/30 hover:bg-cream/60 transition-colors"
      >
        <button
          type="button"
          onClick={() => openEntry(e)}
          className="flex items-center gap-2.5 min-w-0 flex-1 text-start"
        >
          {thumb ? (
            <img src={thumb} alt="" loading="lazy" className="w-9 h-9 rounded-md object-cover shrink-0 border border-sand/30" />
          ) : (
            <span className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${accent.bg}`}>
              <Icon size={15} className={accent.fg} aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-charcoal truncate" dir="auto" title={e.file.title}>
              {e.file.title}
            </span>
            <span className="block text-[11px] text-charcoal/45 truncate">
              {documentTypeLabel(e.file.document_type, types, isAr)} · {formatBytes(e.file.size_bytes, isAr)}
              {sourceSuffix(e)}
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
  };

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
        <div className="flex items-center gap-2">
          {/* Grid (files) vs list (names + metadata) — the same choice /files
              offers, so a record's files can be browsed either way. */}
          <div className="flex items-center rounded-lg border border-sand/40 overflow-hidden" role="group">
            <button
              type="button"
              onClick={() => changeLayout('grid')}
              aria-label={t('files.library.layout.grid')}
              aria-pressed={layout === 'grid'}
              title={t('files.library.layout.grid')}
              className={`p-1.5 transition-colors ${layout === 'grid' ? 'bg-copper text-white' : 'text-charcoal/45 hover:bg-cream'}`}
            >
              <LayoutGrid size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => changeLayout('list')}
              aria-label={t('files.library.layout.list')}
              aria-pressed={layout === 'list'}
              title={t('files.library.layout.list')}
              className={`p-1.5 transition-colors ${layout === 'list' ? 'bg-copper text-white' : 'text-charcoal/45 hover:bg-cream'}`}
            >
              <List size={14} aria-hidden />
            </button>
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
              {layout === 'grid' ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                  {g.entries.map((e) => renderTile(e))}
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {g.entries.map((e) => renderRow(e))}
                </div>
              )}
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

      {/* The same full-screen previewer the Files Library uses. Read-only from a
          record: canEdit/canDelete are false so it hides share/permissions/
          delete and never mutates links — it only shows the file (image, PDF,
          video, audio, office) with download. A rename (owner-only) refreshes
          the panel so the row settles. */}
      <FilePreviewModal
        file={previewRow}
        open={Boolean(previewRow)}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreviewRow(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
        onRenamed={() => { void load(); }}
      />
    </div>
  );
}

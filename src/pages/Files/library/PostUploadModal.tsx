/**
 * Phase 3 · B7 — the post-upload metadata dialog.
 *
 * A centered pop-up that lists every file just uploaded. Shared metadata
 * (classification, axes, tags, record link) is set once and applied to the
 * whole batch; per-file it lets you EDIT INDIVIDUAL files (title always, and an
 * optional per-file classification/tags OVERRIDE), and PREVIEW any file inline.
 *
 * ── SKIP STAYS SAFE — THIS IS NOT A GATE ──────────────────────────────────
 * Every escape hatch stays open — backdrop, Esc, ✕, Skip — and dismissing never
 * touches a file. A skipped upload stays `active` and unlinked, found later by
 * the "Unlinked files" view.
 *
 * ── BATCH vs PER-FILE ─────────────────────────────────────────────────────
 * The top form is the BATCH default. A file the user "customizes" gets its own
 * classification + tags, applied to that file instead of the batch; untouched
 * files keep the batch values. Title is always per-file.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Link2, Loader2, Pencil, RotateCcw, Search, Sparkles, X,
} from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { bulkLinkToRecord, bulkUpdateMetadata, type BulkPatch } from '@/lib/files/bulkEdit';
import {
  bulkAddSubjects, createDocumentType, errorText, listFileVocabularies, updateFileMetadata,
} from '@/lib/files/library';
import { signViewUrls } from '@/lib/files/client';
import { kindAccent, kindIcon } from '@/lib/files/format';
import { linkableModels, recordTitle } from '@/lib/documents/links';
import type { FileDocumentTypeRow, FileRow, FileVocabDimension, FileVocabRow } from '@/types';
import ClassificationSelect from './ClassificationSelect';
import FilePreviewModal from '../components/FilePreviewModal';

interface Props {
  files: FileRow[];
  types: FileDocumentTypeRow[];
  onDismiss: () => void;
  onApplied: () => void;
}

/** Original name minus a trailing extension — mirrors B1's fill-in trigger. */
function derivedTitle(f: FileRow): string {
  return f.original_name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

interface Override { subjects: string[]; tags: string }

export default function PostUploadModal({ files, types, onDismiss, onApplied }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // ── Batch defaults ──────────────────────────────────────────────────────
  const [subjects, setSubjects] = useState<string[]>([]);
  const [tagsText, setTagsText] = useState('');
  const [recordId, setRecordId] = useState('');
  const [modelId, setModelId] = useState('');
  const [recordQuery, setRecordQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [axes, setAxes] = useState<Record<FileVocabDimension, string>>({
    asset_nature: '', acquisition_source: '', usage_rights: '', production_state: '',
  });
  const [vocab, setVocab] = useState<FileVocabRow[]>([]);

  // ── Per-file ────────────────────────────────────────────────────────────
  const [titles, setTitles] = useState<Record<string, string>>({});
  /** Presence = this file has its own classification/tags, overriding the batch. */
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  /** The one file whose override editor is expanded (below the list, un-clipped). */
  const [editing, setEditing] = useState<string | null>(null);
  /** Signed thumbnails for image files. */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /** The file open in the full previewer. */
  const [preview, setPreview] = useState<FileRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { const rows = await listFileVocabularies(); if (!cancelled) setVocab(rows); }
      catch { /* toasted; the axis selects stay empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const initialTitles = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of files) m[f.id] = derivedTitle(f);
    return m;
  }, [files]);
  useEffect(() => { setTitles(initialTitles); }, [initialTitles]);

  useEffect(() => {
    const imageIds = files.filter((f) => f.kind === 'image').map((f) => f.id);
    if (imageIds.length === 0) { setThumbs({}); return; }
    let cancelled = false;
    void (async () => {
      try { const map = await signViewUrls(imageIds); if (!cancelled) setThumbs(map); }
      catch { if (!cancelled) setThumbs({}); }
    })();
    return () => { cancelled = true; };
  }, [files]);

  const vocabFor = (dim: FileVocabDimension) =>
    vocab.filter((v) => v.dimension === dim
      && (v.applies_to_kinds.length === 0 || files.some((f) => v.applies_to_kinds.includes(f.kind))));
  const anyAxis = Object.values(axes).some(Boolean);

  const linkable = useMemo(() => linkableModels(models), [models]);
  const defaultModelId = useMemo(() => {
    let best = linkable[0]?.id ?? ''; let bestN = -1;
    for (const m of linkable) {
      const n = records[m.id]?.length ?? 0;
      if (n > bestN) { bestN = n; best = m.id; }
    }
    return best;
  }, [linkable, records]);
  const effModel = modelId || defaultModelId;
  const model = models.find((m) => m.id === effModel);

  // ── #2 Record SEARCH picker ─────────────────────────────────────────────
  const recordResults = useMemo(() => {
    const q = recordQuery.trim().toLowerCase();
    const pool = records[effModel] ?? [];
    const scored = q
      ? pool.filter((r) => recordTitle(model, r, isAr).toLowerCase().includes(q))
      : pool;
    return scored.slice(0, 10);
  }, [records, effModel, recordQuery, model, isAr]);
  const selectedRecord = (records[effModel] ?? []).find((r) => r.id === recordId);

  const batchTags = useMemo(
    () => tagsText.split(',').map((s) => s.trim()).filter(Boolean),
    [tagsText],
  );
  const changedTitles = useMemo(
    () => files.filter((f) => {
      const v = (titles[f.id] ?? '').trim();
      return v && v !== initialTitles[f.id];
    }),
    [files, titles, initialTitles],
  );

  const batchPrimary = subjects[0] ?? null;
  const nothingToDo = subjects.length === 0 && !anyAxis && batchTags.length === 0
    && !recordId && changedTitles.length === 0 && Object.keys(overrides).length === 0;

  const optionsFor = (kind: FileRow['kind']) =>
    types.filter((x) => x.applies_to_kinds.length === 0 || x.applies_to_kinds.includes(kind));

  const startCustomize = (f: FileRow) => {
    setOverrides((prev) => prev[f.id]
      ? prev
      : { ...prev, [f.id]: { subjects: [...subjects], tags: tagsText } });
    setEditing((cur) => (cur === f.id ? null : f.id));
  };
  const clearOverride = (id: string) => {
    setOverrides((prev) => { const n = { ...prev }; delete n[id]; return n; });
    setEditing((cur) => (cur === id ? null : cur));
  };
  const patchOverride = (id: string, p: Partial<Override>) =>
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...p } as Override }));

  const apply = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { bulkEditTags } = await import('@/lib/files/bulkEdit');
      const axisPatch: Omit<BulkPatch, 'addTags' | 'removeTags'> = {};
      if (axes.asset_nature) axisPatch.asset_nature = axes.asset_nature;
      if (axes.acquisition_source) axisPatch.acquisition_source = axes.acquisition_source;
      if (axes.usage_rights) axisPatch.usage_rights = axes.usage_rights;
      if (axes.production_state) axisPatch.production_state = axes.production_state;

      // Plain files (no override) → the batch defaults, in bulk.
      const plainIds = files.filter((f) => !overrides[f.id]).map((f) => f.id);
      if (plainIds.length) {
        const patch = { ...axisPatch };
        if (batchPrimary) (patch as BulkPatch).document_type = batchPrimary;
        if (Object.keys(patch).length) await bulkUpdateMetadata(plainIds, patch);
        if (subjects.length) await bulkAddSubjects(plainIds, subjects);
        if (batchTags.length) await bulkEditTags(plainIds, batchTags, []);
      }

      // Customized files → their own classification/tags (axes still batch).
      for (const f of files.filter((x) => overrides[x.id])) {
        const ov = overrides[f.id]!;
        const ovPrimary = ov.subjects[0] ?? null;
        const ovTags = ov.tags.split(',').map((s) => s.trim()).filter(Boolean);
        const patch = { ...axisPatch };
        if (ovPrimary) (patch as BulkPatch).document_type = ovPrimary;
        if (Object.keys(patch).length) await bulkUpdateMetadata([f.id], patch);
        if (ov.subjects.length) await bulkAddSubjects([f.id], ov.subjects);
        if (ovTags.length) await bulkEditTags([f.id], ovTags, []);
      }

      for (const f of changedTitles) {
        await updateFileMetadata(f.id, { title: (titles[f.id] ?? '').trim() });
      }
      if (recordId && effModel) {
        await bulkLinkToRecord(files.map((f) => f.id), effModel, recordId, batchPrimary);
      }
      onApplied();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [files, subjects, batchPrimary, axes, batchTags, overrides, changedTitles, titles, recordId, effModel, onApplied]);

  const field = 'w-full px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30';
  const label = 'block text-[11px] font-bold text-charcoal/60 mb-1';
  const editingFile = editing ? files.find((f) => f.id === editing) : null;

  return (
    <Modal open onClose={busy ? () => {} : onDismiss} maxWidth="max-w-2xl">
      <div className="p-5 space-y-4" data-no-marquee>
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-copper" aria-hidden />
          <h2 className="text-base font-bold text-charcoal">
            {t('files.post_upload.title', { count: files.length })}
          </h2>
        </div>

        {/* ── Batch defaults ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>{t('files.library.meta.subjects')}</label>
            <ClassificationSelect
              options={optionsFor(files[0]?.kind ?? 'other')}
              selected={subjects}
              onToggle={(v) => setSubjects((prev) =>
                prev.includes(v) ? prev.filter((s) => s !== v) : [...prev, v])}
              disabled={false}
              isAr={isAr}
              emptyLabel={t('files.post_upload.keep_type')}
              onCreate={(l) => createDocumentType(l)}
              createPlaceholder={t('files.library.meta.new_classification')}
            />
          </div>
          <div>
            <label className={label}>{t('files.library.meta.tags')}</label>
            <input className={field} dir="auto" value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder={t('files.library.meta.tags_placeholder')} />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([
            ['asset_nature', 'files.library.meta.asset_nature'],
            ['acquisition_source', 'files.library.meta.acquisition_source'],
            ['usage_rights', 'files.library.meta.usage_rights'],
            ['production_state', 'files.library.meta.production_state'],
          ] as Array<[FileVocabDimension, string]>).map(([dim, key]) => (
            <div key={dim}>
              <label className={label}>{t(key)}</label>
              <select className={field} value={axes[dim]}
                onChange={(e) => setAxes((prev) => ({ ...prev, [dim]: e.target.value }))}>
                <option value="">{t('files.library.meta.unset')}</option>
                {vocabFor(dim).map((o) => (
                  <option key={o.value} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* ── #2 Link to a record — model + SEARCH ─────────────────────── */}
        <div>
          <label className={`${label} flex items-center gap-1`}>
            <Link2 size={12} aria-hidden />
            {t('files.post_upload.link_to')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select className={field} value={effModel}
              onChange={(e) => { setModelId(e.target.value); setRecordId(''); setRecordQuery(''); }}>
              {linkable.map((m) => (
                <option key={m.id} value={m.id}>{(isAr ? m.label_ar : m.label_en) || m.name}</option>
              ))}
            </select>
            {selectedRecord ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cream/60 border border-copper/30">
                <span className="flex-1 min-w-0 text-sm font-bold text-charcoal truncate" dir="auto">
                  {recordTitle(model, selectedRecord, isAr)}
                </span>
                <button type="button" onClick={() => setRecordId('')}
                  aria-label={t('files.post_upload.no_link')}
                  className="p-1 rounded-md text-charcoal/40 hover:text-red-600 hover:bg-red-500/10">
                  <X size={14} aria-hidden />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none" aria-hidden />
                <input className={`${field} ps-9`} dir="auto" value={recordQuery}
                  onChange={(e) => setRecordQuery(e.target.value)}
                  placeholder={t('files.post_upload.record_search')} />
                {recordResults.length > 0 && (
                  <div className="absolute z-30 mt-1 w-full max-h-56 overflow-auto rounded-lg bg-white border border-sand/40 shadow-lg p-1">
                    {recordResults.map((r) => (
                      <button key={r.id} type="button"
                        onClick={() => { setRecordId(r.id); setRecordQuery(''); }}
                        className="w-full px-2.5 py-1.5 rounded-md text-sm text-charcoal hover:bg-cream text-start truncate" dir="auto">
                        {recordTitle(model, r, isAr)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── #3 + #4 Per-file: preview, title, customize ──────────────── */}
        <div>
          <label className={label}>
            {files.length === 1
              ? t('files.library.meta.title')
              : t('files.post_upload.file_titles', { count: files.length })}
          </label>
          <div className="max-h-56 overflow-auto rounded-xl border border-sand/30 divide-y divide-sand/20">
            {files.map((f) => {
              const Icon = kindIcon[f.kind];
              const accent = kindAccent[f.kind];
              const thumb = thumbs[f.id];
              const overridden = Boolean(overrides[f.id]);
              return (
                <div key={f.id} className="flex items-center gap-2 p-2">
                  {/* #4 preview */}
                  <button type="button" onClick={() => setPreview(f)}
                    aria-label={t('files.actions.preview')}
                    className="shrink-0 w-9 h-9 rounded-md overflow-hidden border border-sand/30 flex items-center justify-center">
                    {thumb
                      ? <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover" />
                      : <span className={`w-full h-full flex items-center justify-center ${accent.bg}`}><Icon size={15} className={accent.fg} aria-hidden /></span>}
                  </button>
                  <input
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-white border border-sand/40 text-xs text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30"
                    dir="auto" value={titles[f.id] ?? ''}
                    onChange={(e) => setTitles((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    aria-label={f.original_name} title={f.original_name} />
                  {/* #3 customize toggle */}
                  <button type="button" onClick={() => startCustomize(f)}
                    aria-label={t('files.post_upload.customize')} title={t('files.post_upload.customize')}
                    className={`p-1.5 rounded-md shrink-0 transition-colors ${
                      overridden ? 'bg-copper/10 text-copper' : 'text-charcoal/40 hover:text-copper hover:bg-copper/10'
                    }`}>
                    <Pencil size={13} aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>

          {/* #3 the expanded override editor (below the list, so its dropdown
              is not clipped by the list's overflow). */}
          {editingFile && overrides[editingFile.id] && (
            <div className="mt-2 p-3 rounded-xl bg-cream/50 border border-copper/25 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-charcoal/60 truncate" dir="auto">
                  {t('files.post_upload.customizing', { name: titles[editingFile.id] || editingFile.original_name })}
                </span>
                <button type="button" onClick={() => clearOverride(editingFile.id)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-charcoal/50 hover:text-copper">
                  <RotateCcw size={11} aria-hidden />
                  {t('files.post_upload.use_batch')}
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <ClassificationSelect
                  options={optionsFor(editingFile.kind)}
                  selected={overrides[editingFile.id]!.subjects}
                  onToggle={(v) => patchOverride(editingFile.id, {
                    subjects: overrides[editingFile.id]!.subjects.includes(v)
                      ? overrides[editingFile.id]!.subjects.filter((s) => s !== v)
                      : [...overrides[editingFile.id]!.subjects, v],
                  })}
                  disabled={false} isAr={isAr}
                  emptyLabel={t('files.post_upload.keep_type')}
                  onCreate={(l) => createDocumentType(l)}
                  createPlaceholder={t('files.library.meta.new_classification')}
                />
                <input className={field} dir="auto"
                  value={overrides[editingFile.id]!.tags}
                  onChange={(e) => patchOverride(editingFile.id, { tags: e.target.value })}
                  placeholder={t('files.library.meta.tags_placeholder')} />
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="flex items-start gap-2 text-xs text-red-700" role="alert">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}

        <p className="text-[11px] text-charcoal/45">{t('files.post_upload.skip_hint')}</p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" className="!px-3 !py-2 text-xs" onClick={onDismiss} disabled={busy}>
            {t('files.post_upload.skip')}
          </Button>
          <Button className="!px-3 !py-2 text-xs" onClick={() => void apply()} disabled={busy || nothingToDo}>
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {t('common.save')}
          </Button>
        </div>
      </div>

      {/* #4 the full previewer, over the dialog. Read-only from here. */}
      <FilePreviewModal
        file={preview}
        open={Boolean(preview)}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreview(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
      />
    </Modal>
  );
}

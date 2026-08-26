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
  bulkAddSubjects, createDocumentType, errorText, listFileVocabularies, peekEnrichment,
  updateFileMetadata, type EnrichmentPeek,
} from '@/lib/files/library';
import { signViewUrls } from '@/lib/files/client';
import { kindAccent, kindIcon } from '@/lib/files/format';
import { linkableModels, recordTitle } from '@/lib/documents/links';
import type { AppModel, AppRecord, FileDocumentTypeRow, FileRow, FileVocabDimension, FileVocabRow } from '@/types';
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

  // ── AI enrichment: poll each file until its analysis lands ────────────────
  // Enrichment runs in the background right after upload (~seconds). Poll the
  // peek RPC so the operator watches the AI fill in a description + tags here,
  // instead of the box looking empty while the AI works out of sight.
  const [ai, setAi] = useState<Record<string, EnrichmentPeek>>({});
  const enrichable = useMemo(
    () => files.filter((f) => ['image', 'pdf', 'video', 'audio'].includes(f.kind)).map((f) => f.id),
    [files],
  );
  useEffect(() => {
    if (enrichable.length === 0) return;
    let stopped = false;
    let tries = 0;
    const MAX_TRIES = 40; // ~100s at 2.5s — well past the usual few-second finish
    const tick = async () => {
      if (stopped) return;
      tries += 1;
      try {
        const rows = await peekEnrichment(enrichable);
        if (stopped) return;
        setAi((prev) => {
          const next = { ...prev };
          for (const r of rows) next[r.file_id] = r;
          return next;
        });
        const allDone = rows.length > 0
          && rows.every((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'none');
        if (allDone || tries >= MAX_TRIES) return; // stop scheduling
      } catch {
        // peekEnrichment toasted; keep trying a few more times, then give up.
      }
      if (!stopped) window.setTimeout(() => void tick(), 2500);
    };
    void tick();
    return () => { stopped = true; };
  }, [enrichable]);

  const aiDone = enrichable.filter((id) => {
    const s = ai[id]?.status;
    return s === 'completed' || s === 'failed' || s === 'none';
  }).length;
  const aiPending = enrichable.length - aiDone;
  const typeLabel = (slug: string) => {
    const row = types.find((x) => x.value === slug);
    return row ? (isAr ? row.label_ar : row.label_en) : slug;
  };

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
  // Some models store their subject as a reference UUID (e.g. targeted_projects
  // keeps `data.project` = an all_projects id) rather than a name, so
  // recordTitle falls back to "<model> · <id8>". Resolve that by following the
  // reference into the loaded records for a readable label. Index built once.
  const recordIndex = useMemo(() => {
    const idx = new Map<string, { model: AppModel; record: AppRecord }>();
    for (const m of models) for (const r of records[m.id] ?? []) idx.set(r.id, { model: m, record: r });
    return idx;
  }, [models, records]);
  const titleFor = useCallback((r: AppRecord): string => {
    const base = recordTitle(model, r, isAr);
    if (base !== `${(isAr ? model?.label_ar : model?.label_en) ?? ''} · ${r.id.slice(0, 8)}`) return base;
    for (const v of Object.values(r.data ?? {})) {
      if (typeof v !== 'string') continue;
      const hit = recordIndex.get(v);
      if (hit && hit.record.id !== r.id) return recordTitle(hit.model, hit.record, isAr);
    }
    return base;
  }, [model, isAr, recordIndex]);

  const recordResults = useMemo(() => {
    // Only surface results once the user has typed — otherwise the dropdown
    // opens on mount with the first N records and covers the file list below.
    const q = recordQuery.trim().toLowerCase();
    if (!q) return [];
    const pool = records[effModel] ?? [];
    return pool.filter((r) => titleFor(r).toLowerCase().includes(q)).slice(0, 10);
  }, [records, effModel, recordQuery, titleFor]);
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

        {/* AI progress — the enrichment runs in the background; show it working. */}
        {enrichable.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-copper/5 border border-copper/20 text-xs">
            {aiPending > 0 ? (
              <>
                <Loader2 size={13} className="animate-spin text-copper shrink-0" aria-hidden />
                <span className="text-charcoal/70">
                  {t('files.post_upload.ai_analyzing', { done: aiDone, total: enrichable.length })}
                </span>
              </>
            ) : (
              <>
                <Sparkles size={13} className="text-copper shrink-0" aria-hidden />
                <span className="text-charcoal/70">{t('files.post_upload.ai_done', { count: enrichable.length })}</span>
              </>
            )}
          </div>
        )}

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
                  {titleFor(selectedRecord)}
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
                        {titleFor(r)}
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
              const peek = ai[f.id];
              const analyzing = ['image', 'pdf', 'video', 'audio'].includes(f.kind)
                && (!peek || peek.status === 'queued' || peek.status === 'running');
              return (
                <div key={f.id} className="p-2 space-y-1.5">
                <div className="flex items-center gap-2">
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

                {/* AI result / progress for this file */}
                {analyzing ? (
                  <div className="flex items-center gap-1.5 ps-11 text-[11px] text-charcoal/45">
                    <Loader2 size={10} className="animate-spin text-copper" aria-hidden />
                    {t('files.post_upload.ai_reading')}
                  </div>
                ) : peek && peek.status === 'completed' && (peek.ai_description || (peek.ai_subjects?.length ?? 0) > 0 || (peek.tags?.length ?? 0) > 0) ? (
                  <div className="ps-11 space-y-1">
                    {peek.ai_description && (
                      <p className="text-[11px] text-charcoal/65 leading-snug flex gap-1" dir="auto">
                        <Sparkles size={10} className="text-copper shrink-0 mt-0.5" aria-hidden />
                        <span>{peek.ai_description}</span>
                      </p>
                    )}
                    {((peek.ai_subjects?.length ?? 0) > 0 || (peek.tags?.length ?? 0) > 0) && (
                      <div className="flex flex-wrap gap-1">
                        {peek.ai_subjects.map((s) => (
                          <span key={`s-${s}`} className="px-1.5 py-0.5 rounded bg-copper/10 text-copper text-[10px] font-bold" dir="auto">
                            {typeLabel(s)}
                          </span>
                        ))}
                        {(peek.tags ?? []).slice(0, 6).map((tg) => (
                          <span key={`t-${tg}`} className="px-1.5 py-0.5 rounded bg-cream text-charcoal/55 text-[10px]" dir="auto">#{tg}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
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

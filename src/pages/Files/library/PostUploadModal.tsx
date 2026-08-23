/**
 * Phase 3 · B7 — the post-upload metadata dialog.
 *
 * Replaces the inline strip with a proper centered pop-up. The operator asked
 * for a dialog, "especially for multiple files" — and multi-file is exactly
 * where a dialog earns its keep: it has room to LIST every file just uploaded
 * and give each one its own editable title, which the strip could never do
 * (it offered a title box only for a single file).
 *
 * ── SKIP STAYS SAFE — THIS IS NOT A GATE ──────────────────────────────────
 * The strip's whole point was that metadata is NAGGED, not GATED: a modal that
 * traps you just teaches people to type "x" into the title box to escape. So
 * this dialog keeps every escape hatch open — backdrop click, Esc, ✕, and a
 * plain "Skip" button all dismiss it, and dismissing NEVER touches the file.
 * A skipped upload stays `active` and unlinked, where the "Unlinked files"
 * view finds it later. The prominent skip hint says so out loud.
 *
 * ── WHAT APPLIES TO ALL vs. ONE ───────────────────────────────────────────
 * Type, tags and the record link are shared — they are set once and applied to
 * everything just uploaded. TITLE is per-file, because a shared title across
 * twelve files is never what anyone means.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FileText, Link2, Loader2, Sparkles } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { bulkLinkToRecord, bulkUpdateMetadata, type BulkPatch } from '@/lib/files/bulkEdit';
import { errorText, listFileVocabularies, updateFileMetadata } from '@/lib/files/library';
import { linkableModels, recordTitle } from '@/lib/documents/links';
import type { FileDocumentTypeRow, FileRow, FileVocabDimension, FileVocabRow } from '@/types';

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

export default function PostUploadModal({ files, types, onDismiss, onApplied }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // The type the fill-in trigger inferred is left untouched unless the user
  // picks something; empty string means "keep the inferred type".
  const [docType, setDocType] = useState<string>('');
  const [tagsText, setTagsText] = useState('');
  const [recordId, setRecordId] = useState('');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Metadata Intelligence axes — shared across the batch, like the type. '' keeps
  // whatever the file already has (nothing, for a fresh upload).
  const [axes, setAxes] = useState<Record<FileVocabDimension, string>>({
    asset_nature: '', acquisition_source: '', usage_rights: '', production_state: '',
  });
  const [vocab, setVocab] = useState<FileVocabRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listFileVocabularies();
        if (!cancelled) setVocab(rows);
      } catch { /* toasted; the axis selects simply stay empty */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const vocabFor = (dim: FileVocabDimension) =>
    vocab.filter((v) => v.dimension === dim
      && (v.applies_to_kinds.length === 0 || files.some((f) => v.applies_to_kinds.includes(f.kind))));
  const anyAxis = Object.values(axes).some(Boolean);

  // Per-file titles, keyed by id, seeded from what we SHOW (derived name) so
  // "did the user change it" compares against the shown value, not FileRow —
  // which does not carry `title` (it is a B1 column on the business shape).
  const initialTitles = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of files) m[f.id] = derivedTitle(f);
    return m;
  }, [files]);
  const [titles, setTitles] = useState<Record<string, string>>(initialTitles);

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
  const recordChoices = useMemo(
    () => (records[effModel] ?? []).slice(0, 200),
    [records, effModel],
  );

  const tags = useMemo(
    () => tagsText.split(',').map((s) => s.trim()).filter(Boolean),
    [tagsText],
  );

  // Which files had their title edited away from what we showed.
  const changedTitles = useMemo(
    () => files.filter((f) => {
      const v = (titles[f.id] ?? '').trim();
      return v && v !== initialTitles[f.id];
    }),
    [files, titles, initialTitles],
  );

  const nothingToDo = !docType && !anyAxis && tags.length === 0 && !recordId && changedTitles.length === 0;

  const apply = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = files.map((f) => f.id);
      const metaPatch: Omit<BulkPatch, 'addTags' | 'removeTags'> = {};
      if (docType) metaPatch.document_type = docType;
      if (axes.asset_nature) metaPatch.asset_nature = axes.asset_nature;
      if (axes.acquisition_source) metaPatch.acquisition_source = axes.acquisition_source;
      if (axes.usage_rights) metaPatch.usage_rights = axes.usage_rights;
      if (axes.production_state) metaPatch.production_state = axes.production_state;
      if (Object.keys(metaPatch).length > 0) await bulkUpdateMetadata(ids, metaPatch);
      if (tags.length > 0) {
        // Reuses the bulk tag path so "add" is set arithmetic, not a
        // replacement — an upload dialog must not wipe tags a trigger set.
        const { bulkEditTags } = await import('@/lib/files/bulkEdit');
        await bulkEditTags(ids, tags, []);
      }
      for (const f of changedTitles) {
        await updateFileMetadata(f.id, { title: (titles[f.id] ?? '').trim() });
      }
      if (recordId && effModel) {
        await bulkLinkToRecord(ids, effModel, recordId, docType || null);
      }
      onApplied();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [files, docType, axes, tags, changedTitles, titles, recordId, effModel, onApplied]);

  const field = 'w-full px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30';
  const label = 'block text-[11px] font-bold text-charcoal/60 mb-1';

  return (
    <Modal open onClose={busy ? () => {} : onDismiss} maxWidth="max-w-xl">
      <div className="p-5 space-y-4" data-no-marquee>
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-copper" aria-hidden />
          <h2 className="text-base font-bold text-charcoal">
            {t('files.post_upload.title', { count: files.length })}
          </h2>
        </div>

        {/* Shared metadata — applied to every uploaded file. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>{t('files.library.meta.document_type')}</label>
            <select
              className={field}
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
            >
              <option value="">{t('files.post_upload.keep_type')}</option>
              {types.map((x) => (
                <option key={x.value} value={x.value}>{isAr ? x.label_ar : x.label_en}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>{t('files.library.meta.tags')}</label>
            <input
              className={field}
              dir="auto"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder={t('files.library.meta.tags_placeholder')}
            />
          </div>
        </div>

        {/* Metadata Intelligence axes — optional, shared across the batch. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([
            ['asset_nature', 'files.library.meta.asset_nature'],
            ['acquisition_source', 'files.library.meta.acquisition_source'],
            ['usage_rights', 'files.library.meta.usage_rights'],
            ['production_state', 'files.library.meta.production_state'],
          ] as Array<[FileVocabDimension, string]>).map(([dim, key]) => (
            <div key={dim}>
              <label className={label}>{t(key)}</label>
              <select
                className={field}
                value={axes[dim]}
                onChange={(e) => setAxes((prev) => ({ ...prev, [dim]: e.target.value }))}
              >
                <option value="">{t('files.library.meta.unset')}</option>
                {vocabFor(dim).map((o) => (
                  <option key={o.value} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Link-to — model + record, shared across the batch. */}
        <div>
          <label className={`${label} flex items-center gap-1`}>
            <Link2 size={12} aria-hidden />
            {t('files.post_upload.link_to')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              className={field}
              value={effModel}
              onChange={(e) => { setModelId(e.target.value); setRecordId(''); }}
            >
              {linkable.map((m) => (
                <option key={m.id} value={m.id}>{(isAr ? m.label_ar : m.label_en) || m.name}</option>
              ))}
            </select>
            <select
              className={field}
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
            >
              <option value="">{t('files.post_upload.no_link')}</option>
              {recordChoices.map((r) => (
                <option key={r.id} value={r.id}>{recordTitle(model, r, isAr)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Per-file titles — the reason a multi-file dialog beats the strip. */}
        <div>
          <label className={label}>
            {files.length === 1
              ? t('files.library.meta.title')
              : t('files.post_upload.file_titles', { count: files.length })}
          </label>
          <div className="max-h-56 overflow-auto rounded-xl border border-sand/30 divide-y divide-sand/20">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-2 p-2">
                <FileText size={14} className="shrink-0 text-charcoal/35" aria-hidden />
                <input
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-white border border-sand/40 text-xs text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30"
                  dir="auto"
                  value={titles[f.id] ?? ''}
                  onChange={(e) => setTitles((prev) => ({ ...prev, [f.id]: e.target.value }))}
                  aria-label={f.original_name}
                  title={f.original_name}
                />
              </div>
            ))}
          </div>
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
    </Modal>
  );
}

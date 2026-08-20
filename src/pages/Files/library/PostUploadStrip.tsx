/**
 * Phase 3 · B7 — the post-upload metadata strip.
 *
 * Spec §10, and the shape is the requirement, not a suggestion: "A single
 * inline strip, NOT a modal: title (pre-filled), type (inferred), project or
 * record (pre-filled from context), tags. Dismissible."
 *
 * ── WHY NOT A MODAL, SPELLED OUT ──────────────────────────────────────────
 * A modal after upload makes metadata compulsory in practice: it blocks the
 * screen, so the fastest way past it is to fill it with anything. An inline
 * strip lets a person ignore it and carry on — and the file is still fine.
 * Skipping leaves it `active` and unlinked, where the "Unlinked files" view
 * finds it later. That is the whole design: the backlog is NAGGED, not GATED.
 * There are already 1,583 redundant copies and a long unlinked tail; a gate
 * would not have prevented one of them, it would only have taught people to
 * type "x" into the title box.
 *
 * ── WHY IT EDITS IN BULK ──────────────────────────────────────────────────
 * Dropping twelve files and being asked twelve times is the same failure the
 * duplicate prompt avoids. Type, tags and the record apply to everything just
 * uploaded; TITLE is offered only for a single file, because a shared title
 * across twelve is never what anyone means.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Link2, Loader2, Sparkles, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { bulkLinkToRecord, bulkUpdateMetadata } from '@/lib/files/bulkEdit';
import { errorText, updateFileMetadata } from '@/lib/files/library';
import { linkableModels, recordTitle } from '@/lib/documents/links';
import type { FileDocumentTypeRow, FileRow } from '@/types';

interface Props {
  files: FileRow[];
  types: FileDocumentTypeRow[];
  onDismiss: () => void;
  onApplied: () => void;
}

export default function PostUploadStrip({ files, types, onDismiss, onApplied }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const single = files.length === 1 ? files[0] : null;
  // The type the fill-in trigger inferred from `kind` — shown as the starting
  // value so the strip agrees with what the database already decided, rather
  // than proposing a different default the user has to notice and correct.
  const [docType, setDocType] = useState<string>('');
  // Pre-filled exactly as B1's fill-in trigger derives it: the original name
  // minus its extension. `initialTitle` is kept so "did the user change it" is
  // a comparison against what we SHOWED, not against `FileRow.title` — which
  // this type does not carry (it is a B1 column on the business-file shape).
  const initialTitle = single ? single.original_name.replace(/\.[A-Za-z0-9]{1,8}$/, '') : '';
  const [title, setTitle] = useState<string>(initialTitle);
  const [tagsText, setTagsText] = useState('');
  const [recordId, setRecordId] = useState('');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
  const nothingToDo = !docType && tags.length === 0 && !recordId
    && !(single && title.trim() && title.trim() !== initialTitle);

  const apply = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = files.map((f) => f.id);
      if (docType || tags.length > 0) {
        await bulkUpdateMetadata(ids, docType ? { document_type: docType } : {});
        if (tags.length > 0) {
          // Reuses the bulk tag path so "add" is set arithmetic, not a
          // replacement — an upload strip must not wipe tags a trigger set.
          const { bulkEditTags } = await import('@/lib/files/bulkEdit');
          await bulkEditTags(ids, tags, []);
        }
      }
      if (single && title.trim() && title.trim() !== initialTitle) {
        await updateFileMetadata(single.id, { title: title.trim() });
      }
      if (recordId && effModel) {
        await bulkLinkToRecord(ids, effModel, recordId, docType || null);
      }
      setDone(true);
      onApplied();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [files, docType, tags, single, title, recordId, effModel, onApplied]);

  const field = 'px-2.5 py-1.5 rounded-lg bg-white border border-sand/40 text-xs text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30';

  return (
    <div
      // data-no-marquee: the strip sits above the grid and a drag starting here
      // must not begin a selection rectangle.
      data-no-marquee
      className="p-3 rounded-xl bg-copper/5 border border-copper/25 space-y-2.5"
      role="region"
      aria-label={t('files.post_upload.title', { count: files.length })}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-bold text-charcoal">
          {done ? <Check size={14} className="text-emerald-600" aria-hidden />
                : <Sparkles size={14} className="text-copper" aria-hidden />}
          {done
            ? t('files.post_upload.saved', { count: files.length })
            : t('files.post_upload.title', { count: files.length })}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('files.post_upload.dismiss')}
          className="p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-white"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {!done && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {single && (
              <input
                className={`${field} min-w-[14rem] flex-1`}
                dir="auto"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('files.library.meta.title')}
                aria-label={t('files.library.meta.title')}
              />
            )}
            <select
              className={field}
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              aria-label={t('files.library.meta.document_type')}
            >
              <option value="">{t('files.post_upload.keep_type')}</option>
              {types.map((x) => (
                <option key={x.value} value={x.value}>{isAr ? x.label_ar : x.label_en}</option>
              ))}
            </select>
            <input
              className={`${field} min-w-[10rem]`}
              dir="auto"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder={t('files.library.meta.tags_placeholder')}
              aria-label={t('files.library.meta.tags')}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] text-charcoal/50">
              <Link2 size={12} aria-hidden />
              {t('files.post_upload.link_to')}
            </span>
            <select
              className={field}
              value={effModel}
              onChange={(e) => { setModelId(e.target.value); setRecordId(''); }}
              aria-label={t('files.bulk.link')}
            >
              {linkable.map((m) => (
                <option key={m.id} value={m.id}>{(isAr ? m.label_ar : m.label_en) || m.name}</option>
              ))}
            </select>
            <select
              className={`${field} min-w-[12rem]`}
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
              aria-label={t('files.bulk.link_search')}
            >
              <option value="">{t('files.post_upload.no_link')}</option>
              {recordChoices.map((r) => (
                <option key={r.id} value={r.id}>{recordTitle(model, r, isAr)}</option>
              ))}
            </select>

            <span className="ms-auto flex items-center gap-2">
              {error && <span className="text-[11px] text-red-700">{error}</span>}
              <Button
                variant="secondary"
                className="!px-3 !py-1.5 text-xs"
                onClick={onDismiss}
                disabled={busy}
              >
                {t('files.post_upload.skip')}
              </Button>
              <Button className="!px-3 !py-1.5 text-xs" onClick={() => void apply()} disabled={busy || nothingToDo}>
                {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
                {t('common.save')}
              </Button>
            </span>
          </div>

          <p className="text-[11px] text-charcoal/45">{t('files.post_upload.skip_hint')}</p>
        </>
      )}
    </div>
  );
}

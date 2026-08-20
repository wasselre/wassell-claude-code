/**
 * Phase 3 · B7 (bulk half) — edit metadata across a selection.
 *
 * ── EVERY FIELD IS OPT-IN ─────────────────────────────────────────────────
 * A bulk editor whose fields are pre-filled will overwrite things nobody meant
 * to touch: open it on 60 files, change the type, press save, and the owner
 * dropdown's default has just been written to all 60. So each row has an
 * explicit checkbox and an unchecked field is not in the patch at all — not
 * sent as null, not sent as "unchanged", simply absent.
 *
 * ── THE RESULT IS A COUNT, NOT A TICK ─────────────────────────────────────
 * Editing is gated per file on edit rights, and after B4 people can see far
 * more than they can edit — a real non-admin selecting 200 files updates ZERO
 * of them, and PostgREST calls that success. So the modal reports "updated N of
 * M" and stays open when N < M, rather than closing on a cheerful lie.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { bulkEditTags, bulkUpdateMetadata, tagsAcross, type BulkResult } from '@/lib/files/bulkEdit';
import { errorText } from '@/lib/files/library';
import { FILE_CONFIDENTIALITIES, FILE_STATUSES } from '@/lib/files/libraryUrl';
import type { FileConfidentiality, FileDocumentTypeRow, FileStatus } from '@/types';

interface Props {
  open: boolean;
  fileIds: string[];
  types: FileDocumentTypeRow[];
  onClose: () => void;
  /** Fired after a run that changed at least one row, so the page can refresh. */
  onApplied: () => void;
}

export default function BulkEditModal({ open, fileIds, types, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);

  const [useType, setUseType] = useState(false);
  const [docType, setDocType] = useState('');
  const [useStatus, setUseStatus] = useState(false);
  const [status, setStatus] = useState<FileStatus>('active');
  const [useOwner, setUseOwner] = useState(false);
  const [owner, setOwner] = useState('');
  const [useConf, setUseConf] = useState(false);
  const [conf, setConf] = useState<FileConfidentiality>('internal');
  const [addTagsText, setAddTagsText] = useState('');
  const [removeTags, setRemoveTags] = useState<string[]>([]);
  const [presentTags, setPresentTags] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUseType(false); setDocType(types[0]?.value ?? '');
    setUseStatus(false); setStatus('active');
    setUseOwner(false); setOwner(users[0]?.id ?? '');
    setUseConf(false); setConf('internal');
    setAddTagsText(''); setRemoveTags([]);
    setResult(null); setError(null);
    // The remove-tag picker can only offer tags that are actually present on
    // the selection — offering the whole vocabulary would invite removing tags
    // none of these files carry.
    void (async () => {
      try { setPresentTags(await tagsAcross(fileIds)); }
      catch { setPresentTags([]); }   // tagsAcross toasted; removal just isn't offered
    })();
  }, [open, fileIds, types, users]);

  const addTags = useMemo(
    () => addTagsText.split(',').map((s) => s.trim()).filter(Boolean),
    [addTagsText],
  );

  const nothingToDo =
    !useType && !useStatus && !useOwner && !useConf && addTags.length === 0 && removeTags.length === 0;

  const apply = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let updated = 0;
      const scalar = {
        ...(useType ? { document_type: docType } : {}),
        ...(useStatus ? { status } : {}),
        ...(useOwner ? { owner_user_id: owner } : {}),
        ...(useConf ? { confidentiality: conf } : {}),
      };
      if (Object.keys(scalar).length > 0) {
        updated = Math.max(updated, (await bulkUpdateMetadata(fileIds, scalar)).updated);
      }
      if (addTags.length > 0 || removeTags.length > 0) {
        updated = Math.max(updated, (await bulkEditTags(fileIds, addTags, removeTags)).updated);
      }
      const res = { requested: fileIds.length, updated, skipped: fileIds.length - updated };
      setResult(res);
      if (updated > 0) onApplied();
      // Close ONLY on a clean full success. A partial result is the thing the
      // user most needs to see, and closing over it is how it goes unnoticed.
      if (res.skipped === 0) onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [fileIds, useType, docType, useStatus, status, useOwner, owner, useConf, conf,
      addTags, removeTags, onApplied, onClose]);

  const row = 'flex items-center gap-2.5';
  const field = 'flex-1 px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal disabled:bg-cream/70 disabled:text-charcoal/40 focus:outline-none focus:ring-2 focus:ring-copper/30';
  const box = (on: boolean) =>
    `w-4 h-4 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-copper border-copper' : 'border-sand/60'}`;

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} maxWidth="max-w-lg">
      <div className="p-5 space-y-4" data-no-marquee>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-charcoal">
            {t('files.bulk.edit_title', { count: fileIds.length })}
          </h2>
          <button
            type="button" onClick={onClose} disabled={busy}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream disabled:opacity-40"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="text-xs text-charcoal/50">{t('files.bulk.edit_hint')}</p>

        <div className="space-y-3">
          <div className={row}>
            <button type="button" onClick={() => setUseType((v) => !v)} aria-pressed={useType} className={box(useType)}>
              {useType && <Check size={11} className="text-white" aria-hidden />}
            </button>
            <label className="w-28 text-xs font-bold text-charcoal/60">{t('files.library.meta.document_type')}</label>
            <select className={field} disabled={!useType} value={docType} onChange={(e) => setDocType(e.target.value)}>
              {types.map((x) => <option key={x.value} value={x.value}>{isAr ? x.label_ar : x.label_en}</option>)}
            </select>
          </div>

          <div className={row}>
            <button type="button" onClick={() => setUseStatus((v) => !v)} aria-pressed={useStatus} className={box(useStatus)}>
              {useStatus && <Check size={11} className="text-white" aria-hidden />}
            </button>
            <label className="w-28 text-xs font-bold text-charcoal/60">{t('files.library.meta.status')}</label>
            <select className={field} disabled={!useStatus} value={status} onChange={(e) => setStatus(e.target.value as FileStatus)}>
              {FILE_STATUSES.map((s) => <option key={s} value={s}>{t(`files.library.status.${s}`)}</option>)}
            </select>
          </div>

          <div className={row}>
            <button type="button" onClick={() => setUseOwner((v) => !v)} aria-pressed={useOwner} className={box(useOwner)}>
              {useOwner && <Check size={11} className="text-white" aria-hidden />}
            </button>
            <label className="w-28 text-xs font-bold text-charcoal/60">{t('files.library.meta.owner')}</label>
            <select className={field} disabled={!useOwner} value={owner} onChange={(e) => setOwner(e.target.value)}>
              {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>)}
            </select>
          </div>

          <div className={row}>
            <button type="button" onClick={() => setUseConf((v) => !v)} aria-pressed={useConf} className={box(useConf)}>
              {useConf && <Check size={11} className="text-white" aria-hidden />}
            </button>
            <label className="w-28 text-xs font-bold text-charcoal/60">{t('files.library.meta.confidentiality')}</label>
            <select className={field} disabled={!useConf} value={conf} onChange={(e) => setConf(e.target.value as FileConfidentiality)}>
              {FILE_CONFIDENTIALITIES.map((c) => <option key={c} value={c}>{t(`files.library.conf.${c}`)}</option>)}
            </select>
          </div>

          {useConf && conf === 'restricted' && (
            <p className="ps-7 text-[11px] text-amber-700">{t('files.library.restricted_hint')}</p>
          )}

          <div className={row}>
            <span className={box(addTags.length > 0)} aria-hidden>
              {addTags.length > 0 && <Check size={11} className="text-white" />}
            </span>
            <label className="w-28 text-xs font-bold text-charcoal/60" htmlFor="bulk-add-tags">
              {t('files.bulk.add_tags')}
            </label>
            <input
              id="bulk-add-tags" className={field} dir="auto" value={addTagsText}
              placeholder={t('files.library.meta.tags_placeholder')}
              onChange={(e) => setAddTagsText(e.target.value)}
            />
          </div>

          {presentTags.length > 0 && (
            <div className="flex items-start gap-2.5">
              <span className={box(removeTags.length > 0)} aria-hidden>
                {removeTags.length > 0 && <Check size={11} className="text-white" />}
              </span>
              <span className="w-28 text-xs font-bold text-charcoal/60 pt-1">{t('files.bulk.remove_tags')}</span>
              <div className="flex-1 flex flex-wrap gap-1.5">
                {presentTags.map((tag) => {
                  const on = removeTags.includes(tag);
                  return (
                    <button
                      key={tag} type="button"
                      onClick={() => setRemoveTags((cur) => on ? cur.filter((x) => x !== tag) : [...cur, tag])}
                      className={`px-2 py-1 rounded-lg border text-xs ${
                        on ? 'bg-red-500/10 border-red-500/30 text-red-700 line-through' : 'bg-white border-sand/40 text-charcoal/70'
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
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

        {result && result.skipped > 0 && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30" role="alert">
            <p className="text-xs font-bold text-amber-800">
              {t('files.bulk.partial', { updated: result.updated, requested: result.requested })}
            </p>
            <p className="mt-1 text-[11px] text-amber-800/80">{t('files.bulk.partial_hint')}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button onClick={() => void apply()} disabled={busy || nothingToDo}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t('files.bulk.apply', { count: fileIds.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

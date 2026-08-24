/**
 * Phase 3 · B5 — the detail panel.
 *
 * Spec §6: "Detail panel — preview, editable metadata, and the Used in panel
 * from Phase 1, promoted from flag-gated to primary."
 *
 * ── WHY THE FORM IS A DRAFT, NOT LIVE-BOUND ───────────────────────────────
 * Every field edits a local draft and one Save writes them together. Saving
 * per field would mean one RLS-checked UPDATE per keystroke on a table whose
 * update policy runs `wassell_can_access_file`, and would leave a half-edited
 * file if the user navigated away mid-way.
 *
 * ── WHY EDIT RIGHTS ARE RESOLVED, NOT ASSUMED ─────────────────────────────
 * `files_update` is gated on `wassell_can_access_file(id,'edit')`, which does
 * NOT include B4's record-derived branch — B4 grants VIEW only. So a user can
 * legitimately be looking at a file they cannot edit, and that is now the
 * COMMON case rather than the rare one: B4 moved three people from ~1,280 to
 * ~6,100 visible files, and almost none of that gain is editable. The panel
 * asks the server for the caller's effective role and renders read-only when
 * it is not enough. `updateFileMetadata` still checks the row count, because
 * an affordance is not a guard.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, Check, Download, ExternalLink, Loader2, Lock, Maximize2, Save, Sparkles, X,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import { effectiveFileRoles, roleSatisfies, signDownloadUrl } from '@/lib/files/client';
import {
  approveAiSuggestions, createDocumentType, dismissAiSuggestions, errorText, fetchFileProvenance,
  fetchFileSubjects, listFileVocabularies, saveFileSubjects, updateFileMetadata,
  type FileMetadataPatch,
} from '@/lib/files/library';
import type {
  BusinessFileRow, FileConfidentiality, FileDocumentTypeRow, FilePermissionRole, FileStatus,
  FileVocabDimension, FileVocabRow,
} from '@/types';
import { FILE_CONFIDENTIALITIES, FILE_STATUSES } from '@/lib/files/libraryUrl';
import { originLabel, ownerLabel, shortDate } from './labels';
import ClassificationSelect from './ClassificationSelect';
import LibraryBadges from './LibraryBadges';
import UsedInPanel from '../components/UsedInPanel';

interface Props {
  file: BusinessFileRow;
  types: FileDocumentTypeRow[];
  onClose: () => void;
  /** Fired after a successful save so the page can patch its row in place
   *  rather than refetching the whole page. */
  onSaved: (row: BusinessFileRow) => void;
  /** Opens the full-screen preview modal (which owns its own URL lifecycle). */
  onOpenPreview: (fileId: string) => void;
  /** Signed thumbnail from the page's batch sign — the panel never signs its
   *  own URL, because the page already signed every image in the slice in one
   *  request and a second one would be pure duplication. */
  thumbUrl?: string | null;
}

interface Draft {
  title: string;
  document_type: string;
  description: string;
  tagsText: string;
  status: FileStatus;
  owner_user_id: string;
  confidentiality: FileConfidentiality;
  valid_from: string;
  valid_until: string;
  // Metadata Intelligence scalar axes. '' means "not set".
  asset_nature: string;
  acquisition_source: string;
  usage_rights: string;
  production_state: string;
}

/** `2026-08-19T00:00:00Z` → `2026-08-19` for <input type="date">, and back. */
function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}
function fromDateInput(v: string): string | null {
  return v ? new Date(`${v}T00:00:00Z`).toISOString() : null;
}

function draftFrom(file: BusinessFileRow): Draft {
  return {
    title: file.title,
    document_type: file.document_type,
    description: file.description ?? '',
    tagsText: (file.tags ?? []).join(', '),
    status: file.status,
    owner_user_id: file.owner_user_id,
    confidentiality: file.confidentiality,
    valid_from: toDateInput(file.valid_from),
    valid_until: toDateInput(file.valid_until),
    asset_nature: file.asset_nature ?? '',
    acquisition_source: file.acquisition_source ?? '',
    usage_rights: file.usage_rights ?? '',
    production_state: file.production_state ?? '',
  };
}

export default function LibraryDetailPanel({ file, types, onClose, onSaved, onOpenPreview, thumbUrl }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const addToast = useAppStore((s) => s.addToast);

  const [role, setRole] = useState<FilePermissionRole | null>(null);
  const [roleResolved, setRoleResolved] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(file));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The tag being typed. Tags themselves live in draft.tagsText (comma-joined,
   *  so the save path is unchanged); this is only the pending entry. */
  const [newTag, setNewTag] = useState('');
  const tagList = useMemo(
    () => draft.tagsText.split(',').map((s) => s.trim()).filter(Boolean),
    [draft.tagsText],
  );
  const setTags = useCallback((list: string[]) => {
    setDraft((d) => ({ ...d, tagsText: [...new Set(list)].join(', ') }));
  }, []);
  const addTag = useCallback((raw: string) => {
    const v = raw.replace(/,/g, '').trim();
    if (!v) { setNewTag(''); return; }
    setTags([...tagList, v]);
    setNewTag('');
  }, [tagList, setTags]);
  const removeTag = useCallback(
    (tag: string) => setTags(tagList.filter((x) => x !== tag)),
    [tagList, setTags],
  );
  // Metadata Intelligence: data-driven axis vocabularies + the multi-subject set.
  const [vocab, setVocab] = useState<FileVocabRow[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subjectsInit, setSubjectsInit] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listFileVocabularies();
        if (!cancelled) setVocab(rows);
      } catch {
        // listFileVocabularies toasted. Selects fall back to whatever value the
        // file already carries (added explicitly below), never blank the panel.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Subjects live in file_subjects, not on the row, so they load per file.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchFileSubjects(file.id);
        if (!cancelled) { setSubjects(list); setSubjectsInit(list); }
      } catch {
        if (!cancelled) { setSubjects([]); setSubjectsInit([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [file.id]);

  const vocabFor = (dim: FileVocabDimension) =>
    vocab.filter((v) => v.dimension === dim
      && (v.applies_to_kinds.length === 0 || v.applies_to_kinds.includes(file.kind)));

  // Which fields are still AI-SUGGESTED (awaiting the human's accept/dismiss).
  const [aiFields, setAiFields] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState(false);
  const loadProvenance = useCallback(async () => {
    try {
      const prov = await fetchFileProvenance(file.id);
      setAiFields(new Set(Object.entries(prov).filter(([, s]) => s === 'ai_suggested').map(([k]) => k)));
    } catch {
      setAiFields(new Set());
    }
  }, [file.id]);
  useEffect(() => { void loadProvenance(); }, [loadProvenance]);

  const acceptAi = useCallback(async () => {
    setReviewBusy(true);
    try {
      await approveAiSuggestions(file.id);
      setAiFields(new Set());                         // values stay, badges clear
    } catch { /* toasted */ } finally { setReviewBusy(false); }
  }, [file.id]);

  const dismissAi = useCallback(async () => {
    setReviewBusy(true);
    try {
      await dismissAiSuggestions(file.id);
      // Reflect the removals locally: description + nature cleared, AI subjects gone.
      const cleared = { ...file } as BusinessFileRow;
      if (aiFields.has('ai_description')) cleared.ai_description = null;
      if (aiFields.has('asset_nature')) { cleared.asset_nature = null; setDraft((d) => ({ ...d, asset_nature: '' })); }
      onSaved(cleared);
      await fetchFileSubjects(file.id).then((list) => { setSubjects(list); setSubjectsInit(list); }).catch(() => {});
      setAiFields(new Set());
    } catch { /* toasted */ } finally { setReviewBusy(false); }
  }, [file, aiFields, onSaved]);

  // Re-sync the draft from whatever the row now says. This fires on a NEW file
  // AND after a save (the page patches the row in place, so the object changes
  // identity), which is what makes the form settle to "not dirty" once saved.
  useEffect(() => {
    setDraft(draftFrom(file));
    setSaveError(null);
  }, [file]);

  // The caller's role is a property of the FILE, not of the row object, so it
  // is keyed on the id alone.
  //
  // These two effects were one, keyed on `file`, and that was a bug: a save
  // replaced the row object, which reset `role` to null, but the fetch that
  // refills it keys on `file.id` — unchanged — so it never re-ran and the panel
  // silently went read-only after the first successful save. Caught in the B5
  // browser pass. Splitting them is the fix; the id key is what makes the role
  // survive an edit to the row it describes.
  useEffect(() => {
    let cancelled = false;
    setRole(null);
    setRoleResolved(false);
    void (async () => {
      try {
        const map = await effectiveFileRoles([file.id]);
        if (!cancelled) { setRole(map[file.id] ?? null); setRoleResolved(true); }
      } catch {
        // effectiveFileRoles already toasted and logged. Treat an unresolved
        // role as "not editable": the form stays read-only rather than
        // offering a save the server would refuse.
        if (!cancelled) { setRole(null); setRoleResolved(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [file.id]);

  const canEdit = roleSatisfies(role, 'edit');
  const Icon = kindIcon[file.kind];
  const accent = kindAccent[file.kind];

  const subjectsChanged = useMemo(
    () => subjects.slice().sort().join('') !== subjectsInit.slice().sort().join(''),
    [subjects, subjectsInit],
  );
  const dirty = useMemo(() => {
    const base = draftFrom(file);
    return (Object.keys(base) as Array<keyof Draft>).some((k) => base[k] !== draft[k]) || subjectsChanged;
  }, [draft, file, subjectsChanged]);

  const onSave = useCallback(async () => {
    // The classification is now the multiselect. document_type (a NOT NULL
    // column) is the PRIMARY subject, derived from the set: keep the existing
    // primary if it is still selected, else the first chosen. At least one
    // subject is required.
    if (subjects.length === 0) {
      setSaveError(t('files.library.meta.subject_required'));
      return;
    }
    const primary: string = subjects.includes(draft.document_type) ? draft.document_type : subjects[0]!;
    setSaving(true);
    setSaveError(null);
    try {
      const patch: FileMetadataPatch = {
        title: draft.title.trim(),
        document_type: primary,
        description: draft.description.trim() || null,
        tags: draft.tagsText.split(',').map((s) => s.trim()).filter(Boolean),
        status: draft.status,
        owner_user_id: draft.owner_user_id,
        confidentiality: draft.confidentiality,
        valid_from: fromDateInput(draft.valid_from),
        valid_until: fromDateInput(draft.valid_until),
        // '' → null so a cleared axis stores as unset, not the empty string.
        asset_nature: draft.asset_nature || null,
        acquisition_source: draft.acquisition_source || null,
        usage_rights: draft.usage_rights || null,
        production_state: draft.production_state || null,
      };
      const saved = await updateFileMetadata(file.id, patch);
      // The subject set always contains the primary (it is one of the chosen).
      const full = [...new Set([primary, ...subjects])];
      await saveFileSubjects(file.id, full);
      setSubjects(full);
      setSubjectsInit(full);
      onSaved(saved);
      addToast(t('files.library.saved'), 'success');
    } catch (e) {
      // updateFileMetadata already toasted. This keeps the reason visible IN
      // the panel too, so the user is not left looking at an unchanged form
      // wondering whether it worked.
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [draft, file.id, subjects, onSaved, addToast, t]);

  const field = 'w-full px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30 disabled:bg-cream/70 disabled:text-charcoal/60';
  const labelCls = 'block mb-1 text-[11px] font-bold uppercase tracking-wide text-charcoal/45';

  return (
    <aside
      className="w-full lg:w-[26rem] shrink-0 card p-5 space-y-5 max-h-[calc(100vh-7rem)] overflow-auto"
      aria-label={t('files.library.details')}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-bold text-charcoal/60 uppercase tracking-widest">
          {t('files.library.details')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {/* Preview */}
      <div className={`relative h-40 rounded-xl overflow-hidden flex items-center justify-center ${accent.bg}`}>
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="w-full h-full object-contain" />
        ) : (
          <Icon size={36} className={accent.fg} aria-hidden />
        )}
        <button
          type="button"
          onClick={() => onOpenPreview(file.id)}
          className="absolute bottom-2 end-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/95 border border-sand/40 text-xs font-bold text-charcoal hover:bg-white"
        >
          <Maximize2 size={12} aria-hidden />
          {t('files.library.open_preview')}
        </button>
      </div>

      <div className="space-y-1">
        <div className="text-base font-bold text-charcoal leading-snug" dir="auto">{file.title}</div>
        <div className="text-xs text-charcoal/45 break-all" dir="auto">{file.original_name}</div>
        <LibraryBadges file={file} types={types} />
      </div>

      {/* Read-only facts. These are history or machine-set, so they are shown
          rather than offered: `origin` is set by the write path, the uploader
          is immutable, and the size is the bytes. */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div><dt className="text-charcoal/40">{t('files.library.meta.size')}</dt>
             <dd className="font-bold text-charcoal/80">{formatBytes(file.size_bytes, isAr)}</dd></div>
        <div><dt className="text-charcoal/40">{t('files.library.meta.created')}</dt>
             <dd className="font-bold text-charcoal/80">{shortDate(file.created_at, isAr)}</dd></div>
        <div><dt className="text-charcoal/40">{t('files.library.meta.origin')}</dt>
             <dd className="font-bold text-charcoal/80">{originLabel(file.origin, t)}</dd></div>
        <div><dt className="text-charcoal/40">{t('files.library.meta.uploader')}</dt>
             <dd className="font-bold text-charcoal/80 truncate" dir="auto">
               {ownerLabel(file.uploaded_by_user_id, users, isAr)}
             </dd></div>
        {/* Technical metadata — objective, machine-captured. Shown only when known. */}
        {file.width_px && file.height_px ? (
          <div><dt className="text-charcoal/40">{t('files.library.meta.dimensions')}</dt>
               <dd className="font-bold text-charcoal/80 tabular-nums">{file.width_px}×{file.height_px}</dd></div>
        ) : null}
        {file.aspect_ratio ? (
          <div><dt className="text-charcoal/40">{t('files.library.meta.aspect_ratio')}</dt>
               <dd className="font-bold text-charcoal/80 tabular-nums" dir="ltr">{file.aspect_ratio}</dd></div>
        ) : null}
        {file.duration_seconds ? (
          <div><dt className="text-charcoal/40">{t('files.library.meta.duration')}</dt>
               <dd className="font-bold text-charcoal/80 tabular-nums">
                 {Math.floor(file.duration_seconds / 60)}:{String(Math.round(file.duration_seconds % 60)).padStart(2, '0')}
               </dd></div>
        ) : null}
        {file.page_count ? (
          <div><dt className="text-charcoal/40">{t('files.library.meta.pages')}</dt>
               <dd className="font-bold text-charcoal/80 tabular-nums">{file.page_count}</dd></div>
        ) : null}
      </dl>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          className="!px-3 !py-2 text-xs"
          onClick={() => {
            void (async () => {
              try {
                const { url } = await signDownloadUrl(file.id);
                window.location.href = url;
              } catch {
                // signDownloadUrl surfaced it already.
              }
            })();
          }}
        >
          <Download size={13} aria-hidden />
          {t('files.library.download')}
        </Button>
        <Button
          variant="ghost"
          className="!px-3 !py-2 text-xs"
          onClick={() => onOpenPreview(file.id)}
        >
          <ExternalLink size={13} aria-hidden />
          {t('files.library.open_full')}
        </Button>
      </div>

      {/* Editable metadata */}
      <form
        className="space-y-3 pt-1 border-t border-sand/30"
        onSubmit={(e) => { e.preventDefault(); if (canEdit && dirty && !saving) void onSave(); }}
      >
        <div className="flex items-center justify-between gap-2 pt-3">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-charcoal/45">
            {t('files.library.metadata')}
          </h3>
          {roleResolved && !canEdit && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-charcoal/45">
              <Lock size={11} aria-hidden />
              {t('files.library.read_only')}
            </span>
          )}
          {!roleResolved && <Loader2 size={12} className="animate-spin text-charcoal/30" aria-hidden />}
        </div>

        <div>
          <label className={labelCls} htmlFor="md-title">{t('files.library.meta.title')}</label>
          <input id="md-title" className={field} dir="auto" disabled={!canEdit} maxLength={500}
                 value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </div>

        <div>
          <label className={labelCls}>{t('files.library.meta.subjects')}</label>
          {/* One MULTISELECT for classification. The set is the file's subjects;
              the primary document_type is derived from it on save. Replaces the
              old single-value type dropdown + the separate chip row. */}
          <ClassificationSelect
            options={types.filter((x) => x.applies_to_kinds.length === 0 || x.applies_to_kinds.includes(file.kind))}
            selected={subjects}
            onToggle={(v) => setSubjects((prev) =>
              prev.includes(v) ? prev.filter((s) => s !== v) : [...prev, v])}
            disabled={!canEdit}
            isAr={isAr}
            emptyLabel={t('files.library.meta.unset')}
            onCreate={canEdit ? (label) => createDocumentType(label) : undefined}
            createPlaceholder={t('files.library.meta.new_classification')}
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="md-desc">{t('files.library.meta.description')}</label>
          <textarea id="md-desc" className={`${field} min-h-[4.5rem]`} dir="auto" disabled={!canEdit}
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>

        <div>
          <label className={labelCls} htmlFor="md-tags">{t('files.library.meta.tags')}</label>
          {/* One chip per tag. Editable: each chip has an × and a typing box that
              commits on Enter or comma (and on blur). Read-only: bare chips. */}
          <div className={`flex flex-wrap items-center gap-1.5 rounded-lg border border-sand/40 bg-white p-2 ${canEdit ? '' : 'opacity-90'}`}
               dir="auto">
            {tagList.map((tag) => (
              <span key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cream text-charcoal/70 text-xs font-medium">
                #{tag}
                {canEdit && (
                  <button type="button" onClick={() => removeTag(tag)}
                          aria-label={t('common.remove')}
                          className="text-charcoal/35 hover:text-red-600">
                    <X size={11} aria-hidden />
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <input id="md-tags"
                     className="flex-1 min-w-[7rem] bg-transparent text-sm text-charcoal outline-none px-1 py-0.5"
                     dir="auto"
                     placeholder={tagList.length === 0 ? t('files.library.meta.tags_placeholder') : ''}
                     value={newTag}
                     onChange={(e) => {
                       // Typing a comma commits the tag before it, so paste of a
                       // "a, b, c" list splits into chips rather than one blob.
                       if (e.target.value.includes(',')) addTag(e.target.value);
                       else setNewTag(e.target.value);
                     }}
                     onKeyDown={(e) => {
                       if (e.key === 'Enter') { e.preventDefault(); addTag(newTag); }
                       else if (e.key === 'Backspace' && !newTag && tagList.length > 0) {
                         removeTag(tagList[tagList.length - 1]!);
                       }
                     }}
                     onBlur={() => addTag(newTag)} />
            )}
            {!canEdit && tagList.length === 0 && (
              <span className="text-xs text-charcoal/35 px-1">—</span>
            )}
          </div>
        </div>

        {/* ── Metadata Intelligence layers (Phase B) ─────────────────────────
            Each axis is a SEPARATE concern (nature ≠ source ≠ rights ≠ state),
            all data-driven from file_vocabularies. Subjects are multi-value on
            top of the primary document_type above. AI enrichment comes later. */}
        <div className="pt-2 border-t border-sand/30 space-y-3">
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-charcoal/45">
            {t('files.library.meta.intelligence')}
          </h4>

          {/* AI review banner — shown while any field is still an AI suggestion.
              Accept keeps the values (marks approved); Dismiss removes the AI
              description/nature/subjects. Editing a field elsewhere already makes
              it human-owned. */}
          {aiFields.size > 0 && canEdit && (
            <div className="rounded-xl border border-copper/30 bg-copper/5 p-2.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-copper">
                <Sparkles size={13} aria-hidden />
                {t('files.library.meta.ai_review', { count: aiFields.size })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={reviewBusy}
                  onClick={() => void acceptAi()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-copper text-white text-xs font-bold hover:bg-terracotta disabled:opacity-50"
                >
                  {reviewBusy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Check size={12} aria-hidden />}
                  {t('files.library.meta.ai_accept')}
                </button>
                <button
                  type="button"
                  disabled={reviewBusy}
                  onClick={() => void dismissAi()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-sand/40 text-charcoal/70 text-xs font-bold hover:bg-cream disabled:opacity-50"
                >
                  <X size={12} aria-hidden />
                  {t('files.library.meta.ai_dismiss')}
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {([
              ['asset_nature', 'files.library.meta.asset_nature'],
              ['acquisition_source', 'files.library.meta.acquisition_source'],
              ['usage_rights', 'files.library.meta.usage_rights'],
              ['production_state', 'files.library.meta.production_state'],
            ] as Array<[FileVocabDimension, string]>).map(([dim, key]) => {
              const cur = draft[dim as keyof Draft] as string;
              const opts = vocabFor(dim);
              return (
                <div key={dim}>
                  <label className={`${labelCls} flex items-center gap-1`} htmlFor={`md-${dim}`}>
                    {t(key)}
                    {aiFields.has(dim) && <Sparkles size={9} className="text-copper" aria-hidden />}
                  </label>
                  <select id={`md-${dim}`} className={field} disabled={!canEdit}
                          value={cur}
                          onChange={(e) => setDraft({ ...draft, [dim]: e.target.value })}>
                    <option value="">{t('files.library.meta.unset')}</option>
                    {/* A value that was since deactivated stays selectable-as-current. */}
                    {cur && !opts.some((o) => o.value === cur) && <option value={cur}>{cur}</option>}
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {/* AI description — machine-written; a badge marks it while unreviewed. */}
          {file.ai_description && (
            <div>
              <label className={`${labelCls} flex items-center gap-1`}>
                {t('files.library.meta.ai_description')}
                {aiFields.has('ai_description') && <Sparkles size={9} className="text-copper" aria-hidden />}
              </label>
              <p className="text-xs text-charcoal/70 leading-relaxed bg-cream/40 rounded-lg p-2" dir="auto">
                {file.ai_description}
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="md-status">{t('files.library.meta.status')}</label>
            <select id="md-status" className={field} disabled={!canEdit}
                    value={draft.status}
                    onChange={(e) => setDraft({ ...draft, status: e.target.value as FileStatus })}>
              {FILE_STATUSES.map((s) => (
                <option key={s} value={s}>{t(`files.library.status.${s}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="md-conf">{t('files.library.meta.confidentiality')}</label>
            <select id="md-conf" className={field} disabled={!canEdit}
                    value={draft.confidentiality}
                    onChange={(e) => setDraft({ ...draft, confidentiality: e.target.value as FileConfidentiality })}>
              {FILE_CONFIDENTIALITIES.map((c) => (
                <option key={c} value={c}>{t(`files.library.conf.${c}`)}</option>
              ))}
            </select>
          </div>
        </div>

        {draft.confidentiality === 'restricted' && (
          <p className="text-[11px] text-amber-700 leading-relaxed">
            {t('files.library.restricted_hint')}
          </p>
        )}

        <div>
          <label className={labelCls} htmlFor="md-owner">{t('files.library.meta.owner')}</label>
          <select id="md-owner" className={field} disabled={!canEdit}
                  value={draft.owner_user_id}
                  onChange={(e) => setDraft({ ...draft, owner_user_id: e.target.value })}>
            {/* An owner who is no longer in the loaded user list (deactivated,
                or filtered out) still has to be selectable-as-current, or
                saving any OTHER field would silently reassign the file. */}
            {!users.some((u) => u.id === draft.owner_user_id) && (
              <option value={draft.owner_user_id}>{draft.owner_user_id.slice(0, 8)}</option>
            )}
            {users.map((u) => (
              <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="md-from">{t('files.library.meta.valid_from')}</label>
            <input id="md-from" type="date" className={field} disabled={!canEdit}
                   value={draft.valid_from}
                   onChange={(e) => setDraft({ ...draft, valid_from: e.target.value })} />
          </div>
          <div>
            <label className={labelCls} htmlFor="md-until">{t('files.library.meta.valid_until')}</label>
            <input id="md-until" type="date" className={field} disabled={!canEdit}
                   value={draft.valid_until}
                   onChange={(e) => setDraft({ ...draft, valid_until: e.target.value })} />
          </div>
        </div>

        {saveError && (
          <p className="flex items-start gap-2 text-xs text-red-700" role="alert">
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>{saveError}</span>
          </p>
        )}

        {canEdit && (
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" className="!px-3 !py-2 text-xs"
                    disabled={!dirty || saving}
                    onClick={() => { setDraft(draftFrom(file)); setSubjects(subjectsInit); }}>
              {t('files.library.discard')}
            </Button>
            <Button type="submit" className="!px-3 !py-2 text-xs"
                    disabled={!dirty || saving || subjects.length === 0}>
              {saving ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Save size={13} aria-hidden />}
              {t('common.save')}
            </Button>
          </div>
        )}
      </form>

      {/* "Used in" — Phase 1's projection, promoted from flag-gated to primary
          by this batch. It is read-only observability: every row shown already
          passed BOTH gates server-side (the caller may view the file AND the
          target record), so it grants nothing. */}
      <div className="pt-1 border-t border-sand/30">
        <UsedInPanel fileId={file.id} isAr={isAr} />
      </div>
    </aside>
  );
}

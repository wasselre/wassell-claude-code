import { useMemo, useRef, useState } from 'react';
import {
  X, Search, MessageSquare, Image as ImageIcon, Video, Mic, FileText,
  Paperclip, Globe, Plus, Loader2, Save, Building2, UserRound,
} from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { uploadFile } from '@/lib/haberchat/client';
import { resolveTemplateCategory, templateCategoryLabel, type TemplateCategory } from '@/lib/chatTemplates';
import type { AppRecord } from '@/types';

/**
 * Every image a template sends as its own WhatsApp image message after the
 * text. Two sources, merged:
 *   • `project_image_file_ids` — CRM `files` ids of the linked project's
 *     gallery (project templates).
 *   • `images[].public_url` — the AI-cleaned listing photos (listing
 *     templates; written on Approve, so drafts contribute nothing).
 * `sendProjectImageMessages` accepts both shapes (file id or raw URL).
 */
function templateImageSends(d: Record<string, unknown>): string[] {
  const projectIds = Array.isArray(d.project_image_file_ids)
    ? (d.project_image_file_ids as unknown[]).filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      )
    : [];
  const listingUrls = Array.isArray(d.images)
    ? (d.images as Array<{ public_url?: unknown } | null>)
        .map((im) => im?.public_url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  // Curated sendable videos (data.videos — seeded on listing Approve, editable
  // like images). The fan-out classifies by mime, so these send as videos.
  const videoUrls = Array.isArray(d.videos)
    ? (d.videos as Array<{ public_url?: unknown } | null>)
        .map((v) => v?.public_url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  return [...projectIds, ...listingUrls, ...videoUrls];
}

/**
 * Template picker shown from the Composer. Lists every chat template
 * the user has created, filters by classification (project / contact
 * messages) / language / tag / search, and on click calls `onPick` with
 * the chosen body + media info so the Composer can populate itself
 * (user can then edit before sending).
 *
 * Also hosts an inline "new template" form so a template can be created
 * without leaving the chat — the saved record lands in the store and is
 * immediately pickable from the same list.
 *
 * No "send directly" option — always stages into the composer so the
 * user sees exactly what's about to go out.
 */
export default function TemplatePickerModal({
  onPick,
  onClose,
  currentLanguage,
}: {
  onPick: (input: {
    body: string;
    mediaFileId: string | null;
    mediaMime: string | null;
    mediaSize: number | null;
    mediaFilename: string | null;
    mediaKind: string | null;
    /** Images sent as their own image messages after the text. Mixed list:
     *  CRM file ids (project templates' gallery) and/or public URLs (listing
     *  templates' cleaned photos) — `sendProjectImageMessages` handles both. */
    imageFileIds: string[];
  }) => void;
  onClose: () => void;
  /** Current UI language — used to pick which body (ar/en) to insert. */
  currentLanguage: 'ar' | 'en';
}) {
  const isAr = currentLanguage === 'ar';
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const templatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);
  const templates = templatesModel ? (records[templatesModel.id] ?? []) : [];

  const [view, setView] = useState<'list' | 'create'>('list');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | TemplateCategory>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [langFilter, setLangFilter] = useState<'all' | 'ar' | 'en' | 'both'>('all');
  // When a template has BOTH ar + en bodies, picking it first asks which
  // language to insert (this row id expands to a language chooser).
  const [langChoiceId, setLangChoiceId] = useState<string | null>(null);

  // ── Inline create form state ────────────────────────────────────────────
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<TemplateCategory>('contact');
  const [newLanguage, setNewLanguage] = useState('ar');
  const [newBodyAr, setNewBodyAr] = useState('');
  const [newBodyEn, setNewBodyEn] = useState('');
  const [newMedia, setNewMedia] = useState<{
    fileId: string; mime: string | null; size: number | null; filename: string | null; kind: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openCreate = () => {
    // Default the new template's classification to the active tab so
    // "filter to project → create" pre-selects Project messages.
    setNewCategory(categoryFilter === 'project' ? 'project' : 'contact');
    setView('create');
  };

  // Derive the tag universe so we can render a filter row.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) {
      const tags = (t.data as Record<string, unknown>).tags;
      if (Array.isArray(tags)) for (const tag of tags as string[]) if (tag) set.add(tag);
    }
    return [...set].sort();
  }, [templates]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((t) => {
      const d = t.data as Record<string, unknown>;
      const name = (d.name as string | null) ?? '';
      const lang = (d.language as string | null) ?? '';
      const bodyAr = (d.body_ar as string | null) ?? '';
      const bodyEn = (d.body_en as string | null) ?? '';
      const tags = Array.isArray(d.tags) ? (d.tags as string[]) : [];

      if (categoryFilter !== 'all' && resolveTemplateCategory(d) !== categoryFilter) return false;
      if (langFilter !== 'all' && lang !== langFilter && lang !== 'both') return false;
      if (tagFilter && !tags.includes(tagFilter)) return false;
      if (!q) return true;
      return (
        name.toLowerCase().includes(q) ||
        bodyAr.toLowerCase().includes(q) ||
        bodyEn.toLowerCase().includes(q) ||
        tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [templates, search, categoryFilter, tagFilter, langFilter]);

  // Emit the pick with a specific body (media carried along).
  const pickWithBody = (t: AppRecord, body: string) => {
    const d = t.data as Record<string, unknown>;
    onPick({
      body,
      mediaFileId: (d.media_file_id as string | null) || null,
      mediaMime: (d.media_mime as string | null) || null,
      mediaSize: typeof d.media_size === 'number' ? (d.media_size as number) : null,
      mediaFilename: (d.media_filename as string | null) || null,
      mediaKind: (d.media_kind as string | null) || null,
      imageFileIds: templateImageSends(d),
    });
  };

  const handlePick = (t: AppRecord) => {
    const d = t.data as Record<string, unknown>;
    const ar = ((d.body_ar as string | null) ?? '').trim();
    const en = ((d.body_en as string | null) ?? '').trim();
    // Both languages present → ask which one to insert (the row expands to a
    // language chooser). Single-language templates insert directly.
    if (ar && en) {
      setLangChoiceId(t.id);
      return;
    }
    pickWithBody(t, ar || en);
  };

  // ── Inline create handlers ──────────────────────────────────────────────
  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      addToast(isAr ? 'حجم الملف أكبر من 10 ميغابايت' : 'File is larger than 10 MB', 'error');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      // Same posture as ChatTemplateFormPage: upload to Haberchat once at
      // template-save time; the file id is reused on every future send.
      const uploaded = await uploadFile(f);
      setNewMedia({
        fileId: uploaded.fileId,
        mime: uploaded.mime ?? f.type,
        size: uploaded.size ?? f.size,
        filename: uploaded.filename ?? f.name,
        kind:
          f.type.startsWith('image/') ? 'image'
          : f.type.startsWith('video/') ? 'video'
          : f.type.startsWith('audio/') ? 'audio'
          : 'document',
      });
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreate = async () => {
    if (!templatesModel) return;
    if (!newName.trim()) {
      addToast(isAr ? 'الاسم مطلوب' : 'Name is required', 'error');
      return;
    }
    if (!newBodyAr.trim() && !newBodyEn.trim() && !newMedia) {
      addToast(isAr ? 'يجب إدخال نص أو مرفق على الأقل' : 'Add at least a body or an attachment', 'error');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const record: AppRecord = {
        id: uuid(),
        model_id: templatesModel.id,
        data: {
          name: newName.trim(),
          category: newCategory,
          language: newLanguage,
          tags: [],
          body_ar: newBodyAr,
          body_en: newBodyEn,
          media_kind: newMedia?.kind ?? '',
          media_file_id: newMedia?.fileId ?? null,
          media_mime: newMedia?.mime ?? null,
          media_size: newMedia?.size ?? null,
          media_filename: newMedia?.filename ?? null,
        },
        created_at: now,
        updated_at: now,
      };
      const result = await saveRecord(record);
      if (result.status !== 'saved') {
        setSaving(false);
        return; // store already toasted the conflict / failure
      }
      addToast(isAr ? 'تم إنشاء القالب' : 'Template created', 'success');
      // Back to the list — the new record is already in the store, and the
      // active tab follows its classification so it's visible right away.
      setCategoryFilter(newCategory);
      setSearch('');
      setTagFilter(null);
      setLangFilter('all');
      setNewName('');
      setNewBodyAr('');
      setNewBodyEn('');
      setNewMedia(null);
      setView('list');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const NewMediaIcon =
    newMedia?.kind === 'image' ? ImageIcon
    : newMedia?.kind === 'video' ? Video
    : newMedia?.kind === 'audio' ? Mic
    : FileText;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-green-500/10 text-green-700 flex items-center justify-center shrink-0">
            <MessageSquare size={16} />
          </div>
          <h2 className="text-base font-bold text-chocolate flex-1">
            {view === 'create'
              ? (isAr ? 'قالب جديد' : 'New template')
              : (isAr ? 'اختر قالبًا' : 'Pick a template')}
          </h2>
          {view === 'list' && (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-copper bg-copper/10 hover:bg-copper/20 border border-copper/20 rounded-lg px-2.5 py-1.5 transition-colors"
            >
              <Plus size={13} />
              {isAr ? 'إضافة قالب جديد' : 'Create new template'}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        {view === 'create' ? (
          /* ── Inline create form ──────────────────────────────────────── */
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* Classification */}
            <div>
              <label className="block text-xs font-bold text-charcoal/40 mb-1.5">
                {isAr ? 'نوع القالب *' : 'Template type *'}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['project', 'contact'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewCategory(c)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors text-start ${
                      newCategory === c
                        ? 'bg-copper/10 border-copper/50 text-copper font-bold'
                        : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream/40'
                    }`}
                  >
                    {c === 'project' ? <Building2 size={15} className="shrink-0" /> : <UserRound size={15} className="shrink-0" />}
                    <span className="flex-1 min-w-0">
                      <span className="block">{templateCategoryLabel(c, isAr)}</span>
                      <span className="block text-[10px] font-normal text-charcoal/50">
                        {c === 'project'
                          ? (isAr ? 'مشاريع، أسعار، مواقع، بروشورات' : 'Projects, prices, locations, brochures')
                          : (isAr ? 'ترحيب، متابعة، تذكير بالمواعيد' : 'Greetings, follow-ups, reminders')}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Name + language */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-charcoal/40 mb-1">
                  {isAr ? 'اسم القالب *' : 'Template name *'}
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-cream/50 border-0 rounded-lg text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-copper/30"
                  placeholder={isAr ? 'مثال: ترحيب بعميل جديد' : 'e.g. New client welcome'}
                  dir="auto"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-charcoal/40 mb-1">
                  {isAr ? 'اللغة' : 'Language'}
                </label>
                <select
                  value={newLanguage}
                  onChange={(e) => setNewLanguage(e.target.value)}
                  className="w-full bg-cream/50 border-0 rounded-lg text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-copper/30"
                >
                  <option value="ar">{isAr ? 'العربية' : 'Arabic'}</option>
                  <option value="en">{isAr ? 'الإنجليزية' : 'English'}</option>
                  <option value="both">{isAr ? 'الاثنان' : 'Both'}</option>
                </select>
              </div>
            </div>

            {/* Bodies */}
            {(newLanguage === 'ar' || newLanguage === 'both') && (
              <div>
                <label className="block text-xs font-bold text-charcoal/40 mb-1">
                  {isAr ? 'النص العربي' : 'Arabic body'}
                </label>
                <textarea
                  value={newBodyAr}
                  onChange={(e) => setNewBodyAr(e.target.value)}
                  rows={4}
                  dir="rtl"
                  className="w-full bg-cream/50 border-0 rounded-lg text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-copper/30"
                  placeholder={isAr ? 'اكتب النص الذي سيظهر في الرسالة...' : 'Arabic message text…'}
                />
              </div>
            )}
            {(newLanguage === 'en' || newLanguage === 'both') && (
              <div>
                <label className="block text-xs font-bold text-charcoal/40 mb-1">
                  {isAr ? 'النص الإنجليزي' : 'English body'}
                </label>
                <textarea
                  value={newBodyEn}
                  onChange={(e) => setNewBodyEn(e.target.value)}
                  rows={4}
                  dir="ltr"
                  className="w-full bg-cream/50 border-0 rounded-lg text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-copper/30"
                  placeholder="English message text…"
                />
              </div>
            )}

            {/* Attachment (optional) */}
            <div>
              <label className="block text-xs font-bold text-charcoal/40 mb-1.5">
                {isAr ? 'المرفق (اختياري)' : 'Attachment (optional)'}
              </label>
              {newMedia ? (
                <div className="flex items-center gap-2.5 bg-cream/50 rounded-lg px-3 py-2">
                  <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center shrink-0">
                    <NewMediaIcon size={16} className="text-charcoal/70" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-charcoal truncate">
                      {newMedia.filename ?? (isAr ? 'مرفق' : 'Attachment')}
                    </div>
                    <div className="text-[10px] text-charcoal/50">
                      {newMedia.mime ?? ''}
                      {newMedia.size ? ` · ${(newMedia.size / 1024).toFixed(0)} KB` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setNewMedia(null)}
                    type="button"
                    className="p-1.5 rounded text-charcoal/50 hover:text-red-600 hover:bg-red-50 transition-colors"
                    aria-label={isAr ? 'إزالة' : 'Remove'}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  type="button"
                  className="w-full border border-dashed border-sand/60 hover:border-copper/50 rounded-lg px-4 py-4 text-xs text-charcoal/60 hover:text-copper hover:bg-cream/30 transition-colors flex items-center justify-center gap-2"
                >
                  {uploading ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {isAr ? 'جارٍ الرفع...' : 'Uploading…'}
                    </>
                  ) : (
                    <>
                      <Paperclip size={14} />
                      {isAr ? 'اضغط لاختيار ملف (حتى 10 ميغابايت)' : 'Pick a file (up to 10 MB)'}
                    </>
                  )}
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,audio/*,.pdf,.docx,.xlsx,.pptx,.zip,.txt"
                className="hidden"
                onChange={handleFilePicked}
              />
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setView('list')}
                disabled={saving}
                className="text-sm text-charcoal/60 hover:text-charcoal px-3 py-2 rounded-lg hover:bg-cream transition-colors disabled:opacity-50"
              >
                {isAr ? 'رجوع' : 'Back'}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={saving || uploading}
                className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-copper hover:bg-terracotta rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {isAr ? 'حفظ القالب' : 'Save template'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Search + filters */}
            <div className="px-5 py-3 border-b border-sand/10 shrink-0 space-y-2">
              {/* Classification tabs */}
              <div className="grid grid-cols-3 gap-1 bg-cream/60 rounded-lg p-1 text-xs">
                {(['all', 'project', 'contact'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategoryFilter(c)}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 transition-colors ${
                      categoryFilter === c
                        ? 'bg-white text-copper font-bold shadow-sm'
                        : 'text-charcoal/60 hover:text-charcoal'
                    }`}
                  >
                    {c === 'project' ? <Building2 size={12} /> : c === 'contact' ? <UserRound size={12} /> : null}
                    {c === 'all' ? (isAr ? 'الكل' : 'All') : templateCategoryLabel(c, isAr)}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={isAr ? 'ابحث في القوالب...' : 'Search templates…'}
                  className="w-full bg-cream/50 border-0 rounded-lg text-sm py-2 ps-9 pe-3 focus:outline-none focus:ring-2 focus:ring-copper/30"
                  autoFocus
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                {/* Language pills */}
                {(['all', 'ar', 'en', 'both'] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLangFilter(l)}
                    className={`px-2 py-1 rounded-full border transition-colors ${
                      langFilter === l
                        ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                        : 'bg-white border-sand/30 text-charcoal/60 hover:bg-cream/60'
                    }`}
                  >
                    {l === 'all' ? (isAr ? 'كل اللغات' : 'All')
                      : l === 'ar' ? (isAr ? 'العربية' : 'Arabic')
                      : l === 'en' ? (isAr ? 'الإنجليزية' : 'English')
                      : (isAr ? 'الاثنان' : 'Both')}
                  </button>
                ))}
                {allTags.length > 0 && (
                  <>
                    <span className="text-charcoal/20 mx-1">·</span>
                    <button
                      onClick={() => setTagFilter(null)}
                      className={`px-2 py-1 rounded-full border transition-colors ${
                        tagFilter === null
                          ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                          : 'bg-white border-sand/30 text-charcoal/60 hover:bg-cream/60'
                      }`}
                    >
                      {isAr ? 'كل الوسوم' : 'All tags'}
                    </button>
                    {allTags.map((t) => (
                      <button
                        key={t}
                        onClick={() => setTagFilter(t)}
                        className={`px-2 py-1 rounded-full border transition-colors ${
                          tagFilter === t
                            ? 'bg-copper/10 border-copper/40 text-copper font-bold'
                            : 'bg-white border-sand/30 text-charcoal/60 hover:bg-cream/60'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {visible.length === 0 && (
                <div className="py-10 text-center text-sm text-charcoal/40 space-y-3">
                  <p>
                    {templates.length === 0
                      ? (isAr ? 'لا توجد قوالب بعد.' : 'No templates yet.')
                      : (isAr ? 'لا توجد نتائج' : 'No matches')}
                  </p>
                  <button
                    type="button"
                    onClick={openCreate}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-copper bg-copper/10 hover:bg-copper/20 border border-copper/20 rounded-lg px-3 py-2 transition-colors"
                  >
                    <Plus size={13} />
                    {isAr ? 'إضافة قالب جديد' : 'Create new template'}
                  </button>
                </div>
              )}
              <div className="space-y-2">
                {visible.map((t) => {
                  const d = t.data as Record<string, unknown>;
                  const name = (d.name as string | null) ?? '';
                  const bodyAr = ((d.body_ar as string | null) ?? '').trim();
                  const bodyEn = ((d.body_en as string | null) ?? '').trim();
                  const preview = isAr
                    ? (bodyAr || bodyEn)
                    : (bodyEn || bodyAr);
                  const tags = Array.isArray(d.tags) ? (d.tags as string[]) : [];
                  const category = resolveTemplateCategory(d);
                  const imageSendCount = templateImageSends(d).length;
                  const mediaKind = (d.media_kind as string | null) ?? '';
                  const hasMedia = !!d.media_file_id;
                  const MediaIcon =
                    mediaKind === 'image' ? ImageIcon
                    : mediaKind === 'video' ? Video
                    : mediaKind === 'audio' ? Mic
                    : FileText;

                  // Both bodies present + this row chosen → show the language picker
                  // instead of the normal row (the user selects ar/en to insert).
                  if (langChoiceId === t.id && bodyAr && bodyEn) {
                    return (
                      <div key={t.id} className="rounded-lg border border-copper/40 bg-copper/5 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <Globe size={14} className="text-copper shrink-0" />
                          <span className="font-bold text-sm text-charcoal flex-1 truncate">{name || (isAr ? '(بدون اسم)' : '(unnamed)')}</span>
                          <button
                            type="button"
                            onClick={() => setLangChoiceId(null)}
                            className="text-charcoal/40 hover:text-charcoal"
                            aria-label={isAr ? 'رجوع' : 'Back'}
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <p className="text-xs text-charcoal/60 mb-2">
                          {isAr ? 'اختر اللغة المراد إدراجها:' : 'Choose the language to insert:'}
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => pickWithBody(t, bodyAr)}
                            className="flex-1 rounded-lg border border-sand/40 hover:border-copper/50 hover:bg-white px-3 py-2 text-sm font-medium text-charcoal transition-colors"
                          >
                            {isAr ? 'العربية' : 'Arabic'}
                          </button>
                          <button
                            type="button"
                            onClick={() => pickWithBody(t, bodyEn)}
                            className="flex-1 rounded-lg border border-sand/40 hover:border-copper/50 hover:bg-white px-3 py-2 text-sm font-medium text-charcoal transition-colors"
                          >
                            {isAr ? 'الإنجليزية' : 'English'}
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <button
                      key={t.id}
                      onClick={() => handlePick(t)}
                      className="w-full text-start rounded-lg border border-sand/30 hover:border-copper/40 hover:bg-cream/30 transition-colors p-3 flex items-start gap-3"
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        hasMedia ? 'bg-copper/10 text-copper' : 'bg-charcoal/5 text-charcoal/60'
                      }`}>
                        {hasMedia ? <MediaIcon size={14} /> : <MessageSquare size={14} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-charcoal">{name || (isAr ? '(بدون اسم)' : '(unnamed)')}</span>
                          <span className={`inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 ${
                            category === 'project'
                              ? 'text-copper bg-copper/10'
                              : 'text-gold bg-gold/10'
                          }`}>
                            {category === 'project' ? <Building2 size={9} /> : <UserRound size={9} />}
                            {templateCategoryLabel(category, isAr)}
                          </span>
                          {bodyAr && bodyEn && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-copper bg-copper/10 rounded-full px-1.5 py-0.5">
                              <Globe size={9} />
                              {isAr ? 'لغتان' : 'AR · EN'}
                            </span>
                          )}
                          {hasMedia && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-copper bg-copper/10 rounded-full px-1.5 py-0.5">
                              <Paperclip size={9} />
                              {mediaKind}
                            </span>
                          )}
                          {imageSendCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-copper bg-copper/10 rounded-full px-1.5 py-0.5">
                              <ImageIcon size={9} />
                              {isAr ? `${imageSendCount} صور` : `${imageSendCount} images`}
                            </span>
                          )}
                          {tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="text-[10px] text-charcoal/60 bg-charcoal/5 rounded-full px-1.5 py-0.5">
                              {tag}
                            </span>
                          ))}
                        </div>
                        {preview && (
                          <p className="text-xs text-charcoal/60 mt-1 line-clamp-2 whitespace-pre-wrap break-words" dir="auto">
                            {preview}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import {
  ArrowLeft, ArrowRight, Save, Trash2, Paperclip, X, Loader2,
  Image as ImageIcon, ImagePlus, Video, Mic, FileText, MessageSquare, Sparkles,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { uploadFile } from '@/lib/haberchat/client';
import { uploadImage } from '@/lib/imageUpload';
import { signViewUrls } from '@/lib/files/client';
import { resolveTemplateCategory, templateCategoryLabel, type TemplateCategory } from '@/lib/chatTemplates';
import Button from '@/components/ui/Button';
import ProjectMessageGeneratorModal from './components/ProjectMessageGeneratorModal';
import type { AppRecord } from '@/types';

/**
 * Custom editor for a chat template record. Replaces the generic
 * RecordFormPage for the `chat_templates` model — see the dispatcher in
 * App.tsx. Owns the media upload flow so the user gets inline preview
 * and a single save button instead of the generic "save text fields →
 * open separate upload dialog" flow.
 */
export default function ChatTemplateFormPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const deleteRecord = useAppStore((s) => s.deleteRecord);
  const addToast = useAppStore((s) => s.addToast);

  const model = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);
  const existing = useMemo(() => {
    if (!model || !recordId || recordId === 'new') return null;
    return (records[model.id] ?? []).find((r) => r.id === recordId) ?? null;
  }, [model, records, recordId]);

  const initialData = (existing?.data as Record<string, unknown> | undefined) ?? {};

  // Local form state
  const [name, setName] = useState<string>((initialData.name as string) ?? '');
  const [category, setCategory] = useState<TemplateCategory>(
    existing ? resolveTemplateCategory(initialData) : 'contact',
  );
  const [language, setLanguage] = useState<string>((initialData.language as string) ?? 'ar');
  const [tagsInput, setTagsInput] = useState<string>(
    Array.isArray(initialData.tags) ? (initialData.tags as string[]).join(', ') : '',
  );
  const [bodyAr, setBodyAr] = useState<string>((initialData.body_ar as string) ?? '');
  const [bodyEn, setBodyEn] = useState<string>((initialData.body_en as string) ?? '');
  const [mediaKind, setMediaKind] = useState<string>((initialData.media_kind as string) ?? '');
  const [mediaFileId, setMediaFileId] = useState<string | null>((initialData.media_file_id as string) ?? null);
  const [mediaMime, setMediaMime] = useState<string | null>((initialData.media_mime as string) ?? null);
  const [mediaSize, setMediaSize] = useState<number | null>((initialData.media_size as number) ?? null);
  const [mediaFilename, setMediaFilename] = useState<string | null>((initialData.media_filename as string) ?? null);

  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Gallery (the images fanned out after the text message) ───────────
  // Two storage shapes, edited in ONE grid:
  //   • project templates → `project_image_file_ids` (CRM `files` ids of the
  //     linked project gallery; raw public URLs are also legal entries — the
  //     send fan-out handles both). Manual adds append a public URL here so
  //     EVERY send surface (composer picker + follow-up project flow) sees it.
  //   • listing templates → `images[]` ({public_url}) written on Approve.
  // Removal drops only the entry — storage bytes are never deleted (cleaned
  // outputs are shared with the listing's applied photos; project files are
  // the project gallery). Persisted with the normal Save button.
  const [projectImageIds, setProjectImageIds] = useState<string[]>([]);
  const [listingImages, setListingImages] = useState<Array<Record<string, unknown>>>([]);
  // Curated sendable videos (listing templates — data.videos, seeded on
  // Approve; manual video uploads land here too, ≤15.5 MB WhatsApp cap).
  const [listingVideos, setListingVideos] = useState<Array<Record<string, unknown>>>([]);
  const [signedById, setSignedById] = useState<Record<string, string>>({});
  const [galleryUploading, setGalleryUploading] = useState(0);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const isProjectGallery = projectImageIds.length > 0 || category === 'project';

  // Sign the project file ids for PREVIEW (private files bucket). Best-effort:
  // a failed sign leaves broken tiles but never blocks editing — the error is
  // toasted once.
  useEffect(() => {
    const fileIds = projectImageIds.filter((id) => !/^https?:\/\//i.test(id) && !(id in signedById));
    if (fileIds.length === 0) return;
    let cancelled = false;
    void signViewUrls(fileIds)
      .then((m) => {
        if (!cancelled) setSignedById((prev) => ({ ...prev, ...m }));
      })
      .catch((err) => {
        console.error('[chat-template] gallery preview sign failed:', err);
        addToast(
          isAr ? 'تعذّر تجهيز معاينة صور المشروع' : 'Could not prepare the project image previews',
          'error',
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectImageIds]);

  const galleryTiles: Array<{ key: string; url: string | null; remove: () => void }> = [
    ...projectImageIds.map((id, i) => ({
      key: `p-${id}-${i}`,
      url: /^https?:\/\//i.test(id) ? id : (signedById[id] ?? null),
      remove: () => setProjectImageIds((arr) => arr.filter((_, j) => j !== i)),
    })),
    ...listingImages.map((im, i) => ({
      key: `l-${String(im.public_url ?? i)}-${i}`,
      url: typeof im.public_url === 'string' ? im.public_url : null,
      remove: () => setListingImages((arr) => arr.filter((_, j) => j !== i)),
    })),
  ];

  /** WhatsApp rejects videos over ~16 MB — refuse oversize manual uploads. */
  const MAX_VIDEO_UPLOAD_BYTES = 15_500_000;

  const addGalleryImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
    );
    if (list.length === 0) return;
    setGalleryUploading(list.length);
    try {
      for (const file of list) {
        if (file.type.startsWith('video/') && file.size > MAX_VIDEO_UPLOAD_BYTES) {
          addToast(
            isAr
              ? `«${file.name}» أكبر من 15.5 ميغابايت — واتساب لا يقبل فيديو أكبر من ذلك.`
              : `"${file.name}" is over 15.5 MB — WhatsApp rejects larger videos.`,
            'error',
          );
          setGalleryUploading((n) => n - 1);
          continue;
        }
        const url = await uploadImage(file, 'listing-manual');
        if (file.type.startsWith('video/')) {
          // Videos: project templates send project_image_file_ids entries (the
          // fan-out classifies by mime, so a video URL there sends as video);
          // listing/contact templates use the curated videos[] list.
          if (isProjectGallery) setProjectImageIds((arr) => [...arr, url]);
          else setListingVideos((arr) => [...arr, { source_url: null, public_url: url }]);
        } else if (isProjectGallery) {
          setProjectImageIds((arr) => [...arr, url]);
        } else {
          setListingImages((arr) => [
            ...arr,
            {
              asset_id: null,
              public_url: url,
              source_url: null,
              image_index: arr.reduce((m, im) => Math.max(m, Number(im.image_index ?? 0)), -1) + 1,
            },
          ]);
        }
        setGalleryUploading((n) => n - 1);
      }
    } catch (err) {
      setGalleryUploading(0);
      addToast(
        (isAr ? 'تعذّر رفع الملف: ' : 'Upload failed: ') +
          (err instanceof Error ? err.message : String(err)),
        'error',
      );
    } finally {
      if (galleryInputRef.current) galleryInputRef.current.value = '';
    }
  };

  const BackIcon = isAr ? ArrowRight : ArrowLeft;
  const isNew = !existing;

  useEffect(() => {
    // Reset the file input when the record changes (prev/next nav isn't
    // supported here, but keeps the element clean on mount).
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [recordId]);

  // Re-seed the form fields when the record first becomes available. On a hard
  // reload / direct URL load, `initialize()`'s records slow-tail resolves AFTER
  // first paint, so the `useState` initializers above captured a null `existing`
  // and every field would otherwise stay blank until a client-side
  // re-navigation remounts the component. Keyed on `existing?.id` (NOT the data)
  // so it only fires on the null→loaded transition (or a switch to another
  // template) — realtime echoes during editing keep the same id and never
  // clobber in-progress edits. Same pattern as RecordFormPage / the Follow-up
  // Workspace.
  useEffect(() => {
    const d = (existing?.data as Record<string, unknown> | undefined) ?? {};
    setName((d.name as string) ?? '');
    setCategory(existing ? resolveTemplateCategory(d) : 'contact');
    setLanguage((d.language as string) ?? 'ar');
    setTagsInput(Array.isArray(d.tags) ? (d.tags as string[]).join(', ') : '');
    setBodyAr((d.body_ar as string) ?? '');
    setBodyEn((d.body_en as string) ?? '');
    setMediaKind((d.media_kind as string) ?? '');
    setMediaFileId((d.media_file_id as string) ?? null);
    setMediaMime((d.media_mime as string) ?? null);
    setMediaSize((d.media_size as number) ?? null);
    setMediaFilename((d.media_filename as string) ?? null);
    setProjectImageIds(
      Array.isArray(d.project_image_file_ids)
        ? (d.project_image_file_ids as unknown[]).filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          )
        : [],
    );
    setListingImages(
      Array.isArray(d.images)
        ? (d.images as unknown[]).filter(
            (im): im is Record<string, unknown> => !!im && typeof im === 'object',
          )
        : [],
    );
    setListingVideos(
      Array.isArray(d.videos)
        ? (d.videos as unknown[]).filter(
            (v): v is Record<string, unknown> =>
              !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).public_url === 'string',
          )
        : [],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id]);

  if (!model) {
    return (
      <div className="p-8 text-center text-charcoal/50">
        {isAr ? 'نموذج القوالب غير متوفر' : 'Templates model not available'}
      </div>
    );
  }

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
      // Upload to Haberchat once at template-save time. The returned
      // file id is what we send with every future message that uses
      // this template — no re-upload on each send.
      const uploaded = await uploadFile(f);
      setMediaFileId(uploaded.fileId);
      setMediaMime(uploaded.mime ?? f.type);
      setMediaSize(uploaded.size ?? f.size);
      setMediaFilename(uploaded.filename ?? f.name);
      setMediaKind(
        f.type.startsWith('image/') ? 'image'
        : f.type.startsWith('video/') ? 'video'
        : f.type.startsWith('audio/') ? 'audio'
        : 'document'
      );
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearMedia = () => {
    setMediaFileId(null);
    setMediaMime(null);
    setMediaSize(null);
    setMediaFilename(null);
    setMediaKind('');
  };

  const handleSave = async () => {
    if (!name.trim()) {
      addToast(isAr ? 'الاسم مطلوب' : 'Name is required', 'error');
      return;
    }
    if (!bodyAr.trim() && !bodyEn.trim() && !mediaFileId) {
      addToast(
        isAr ? 'يجب إدخال نص أو مرفق على الأقل' : 'Add at least a body or an attachment',
        'error',
      );
      return;
    }
    setSaving(true);
    try {
      const tags = tagsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const now = new Date().toISOString();
      const record: AppRecord = {
        id: existing?.id ?? uuid(),
        model_id: model.id,
        data: {
          // Preserve listing-message keys (listing_id, images, status, cleaning,
          // project_id, …) that this generic editor doesn't expose — otherwise
          // saving here would wipe a listing template's cleaned photos + link.
          ...((existing?.data as Record<string, unknown>) ?? {}),
          name: name.trim(),
          category,
          language,
          tags,
          body_ar: bodyAr,
          body_en: bodyEn,
          media_kind: mediaKind,
          media_file_id: mediaFileId,
          media_mime: mediaMime,
          media_size: mediaSize,
          media_filename: mediaFilename,
          project_image_file_ids: projectImageIds,
          images: listingImages,
          videos: listingVideos,
        },
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      await saveRecord(record);
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
      navigate('/model/chat_templates');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    if (!confirm(isAr ? 'حذف هذا القالب؟' : 'Delete this template?')) return;
    try {
      await deleteRecord(model.id, existing.id);
      addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
      navigate('/model/chat_templates');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const MediaIcon =
    mediaKind === 'image' ? ImageIcon
    : mediaKind === 'video' ? Video
    : mediaKind === 'audio' ? Mic
    : FileText;

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto">
      {showGenerator && <ProjectMessageGeneratorModal onClose={() => setShowGenerator(false)} />}
      {/* Back */}
      <button
        onClick={() => navigate('/model/chat_templates')}
        className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-copper mb-5"
      >
        <BackIcon size={16} />
        {isAr ? 'العودة للقوالب' : 'Back to templates'}
      </button>

      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-green-500/10 text-green-700 flex items-center justify-center">
          <MessageSquare size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-chocolate">
            {isNew ? (isAr ? 'قالب جديد' : 'New template') : name || (isAr ? 'تعديل قالب' : 'Edit template')}
          </h1>
          <p className="text-sm text-charcoal/50">
            {isAr ? 'يُستخدم من داخل المحادثات لإرسال رسائل جاهزة مع أو بدون مرفق.' : 'Used inside conversations to send prewritten messages with or without an attachment.'}
          </p>
        </div>
        <Button
          onClick={() => setShowGenerator(true)}
          className="!bg-copper/10 !text-copper hover:!bg-copper/20 !border-copper/20 shrink-0"
        >
          <Sparkles size={15} />
          {isAr ? 'توليد رسائل المشاريع' : 'Generate project messages'}
        </Button>
      </div>

      <div className="card p-5 space-y-4">
        {/* Name + language */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold text-charcoal/40 mb-1">
              {isAr ? 'اسم القالب *' : 'Template name *'}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input w-full text-sm"
              placeholder={isAr ? 'مثال: ترحيب بعميل جديد' : 'e.g. New client welcome'}
              dir="auto"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-charcoal/40 mb-1">
              {isAr ? 'اللغة' : 'Language'}
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="input w-full text-sm"
            >
              <option value="ar">{isAr ? 'العربية' : 'Arabic'}</option>
              <option value="en">{isAr ? 'الإنجليزية' : 'English'}</option>
              <option value="both">{isAr ? 'الاثنان' : 'Both'}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-charcoal/40 mb-1">
              {isAr ? 'التصنيف' : 'Category'}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as TemplateCategory)}
              className="input w-full text-sm"
            >
              <option value="contact">{templateCategoryLabel('contact', isAr)}</option>
              <option value="project">{templateCategoryLabel('project', isAr)}</option>
            </select>
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-1">
            {isAr ? 'التصنيفات (فاصلة بينها)' : 'Tags (comma separated)'}
          </label>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            className="input w-full text-sm"
            placeholder={isAr ? 'ترحيب، عرض سعر، متابعة' : 'welcome, quotation, follow-up'}
          />
        </div>

        {/* Bodies */}
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-1">
            {isAr ? 'النص العربي' : 'Arabic body'}
          </label>
          <textarea
            value={bodyAr}
            onChange={(e) => setBodyAr(e.target.value)}
            rows={4}
            dir="rtl"
            className="input w-full text-sm"
            placeholder={isAr ? 'اكتب النص الذي سيظهر في الرسالة...' : 'Arabic message text…'}
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-1">
            {isAr ? 'النص الإنجليزي' : 'English body'}
          </label>
          <textarea
            value={bodyEn}
            onChange={(e) => setBodyEn(e.target.value)}
            rows={4}
            dir="ltr"
            className="input w-full text-sm"
            placeholder="English message text…"
          />
        </div>

        {/* Media */}
        <div>
          <label className="block text-xs font-bold text-charcoal/40 mb-2">
            {isAr ? 'المرفق (اختياري)' : 'Attachment (optional)'}
          </label>
          {mediaFileId ? (
            <div className="flex items-center gap-2.5 bg-cream/50 rounded-lg px-3 py-2">
              <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shrink-0">
                <MediaIcon size={18} className="text-charcoal/70" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-charcoal truncate">
                  {mediaFilename ?? (isAr ? 'مرفق' : 'Attachment')}
                </div>
                <div className="text-[10px] text-charcoal/50">
                  {mediaMime ?? ''}
                  {mediaSize ? ` · ${(mediaSize / 1024).toFixed(0)} KB` : ''}
                </div>
              </div>
              <button
                onClick={clearMedia}
                type="button"
                className="p-1.5 rounded text-charcoal/50 hover:text-red-600 hover:bg-red-50 transition-colors"
                aria-label={isAr ? 'إزالة' : 'Remove'}
                title={isAr ? 'إزالة' : 'Remove'}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              type="button"
              className="w-full border border-dashed border-sand/60 hover:border-copper/50 rounded-lg px-4 py-6 text-sm text-charcoal/60 hover:text-copper hover:bg-cream/30 transition-colors flex flex-col items-center justify-center gap-2"
            >
              {uploading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  <span>{isAr ? 'جارٍ الرفع...' : 'Uploading…'}</span>
                </>
              ) : (
                <>
                  <Paperclip size={18} />
                  <span>
                    {isAr ? 'اضغط لاختيار ملف (صورة / فيديو / صوت / مستند)' : 'Pick a file (image / video / audio / document)'}
                  </span>
                  <span className="text-[10px] text-charcoal/40">
                    {isAr ? 'حتى 10 ميغابايت' : 'up to 10 MB'}
                  </span>
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
          <p className="text-[10px] text-charcoal/40 mt-1.5">
            {isAr
              ? 'يُرفع الملف لمرة واحدة إلى Haberchat ويُعاد استخدامه في كل إرسال لهذا القالب.'
              : 'File is uploaded to Haberchat once and reused every time the template is sent.'}
          </p>
        </div>

        {/* Gallery — the images fanned out after the text message. Editable:
          * remove any tile, add manual uploads. Covers both project templates
          * (project_image_file_ids) and listing templates (cleaned images[]). */}
        {(galleryTiles.length > 0 || category === 'project' || listingImages.length > 0) && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-charcoal/40">
                {isAr ? 'صور الرسالة (تُرسل بعد النص)' : 'Message images (sent after the text)'}
              </label>
              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                disabled={galleryUploading > 0 || saving}
                className="inline-flex items-center gap-1 text-[0.7rem] font-bold text-copper hover:underline disabled:opacity-40"
              >
                {galleryUploading > 0 ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
                {galleryUploading > 0
                  ? (isAr ? `جارٍ رفع ${galleryUploading} ملف…` : `Uploading ${galleryUploading} file(s)…`)
                  : (isAr ? 'إضافة صور / فيديو' : 'Add images / videos')}
              </button>
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={(e) => void addGalleryImages(e.target.files)}
              />
            </div>
            {listingVideos.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2">
                {listingVideos.map((v, i) => (
                  <div key={`${String(v.public_url)}-${i}`} className="relative group">
                    <video
                      src={String(v.public_url)}
                      controls
                      preload="metadata"
                      className="w-full aspect-video object-cover rounded-lg border border-sand/30 bg-black/80"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setListingVideos((arr) => arr.filter((_, j) => j !== i));
                      }}
                      title={isAr ? 'إزالة الفيديو' : 'Remove video'}
                      className="absolute top-1 end-1 p-1 rounded-md bg-white/90 text-charcoal/70 hover:text-red-600 shadow opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {galleryTiles.length > 0 ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {galleryTiles.map((tile) => (
                  <div key={tile.key} className="relative group">
                    {tile.url ? (
                      <img
                        src={tile.url}
                        alt=""
                        className="w-full aspect-square object-cover rounded-lg border border-sand/30"
                      />
                    ) : (
                      <div className="w-full aspect-square rounded-lg border border-sand/30 bg-cream/50 flex items-center justify-center">
                        <Loader2 size={16} className="animate-spin text-charcoal/30" />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={tile.remove}
                      title={isAr ? 'إزالة الصورة' : 'Remove image'}
                      className="absolute top-1 end-1 p-1 rounded-md bg-white/90 text-charcoal/70 hover:text-red-600 shadow opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-charcoal/40">
                {isAr ? 'لا توجد صور — أضِف صورًا لإرسالها مع الرسالة.' : 'No images — add some to send with the message.'}
              </p>
            )}
            <p className="text-[10px] text-charcoal/40 mt-1.5">
              {isAr
                ? 'الإزالة تحذف الصورة من الرسالة فقط، ولا تمس معرض المشروع أو صور الإعلان.'
                : 'Removing only takes the image out of this message — the project gallery / listing photos are untouched.'}
            </p>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between mt-5">
        {existing ? (
          <Button onClick={handleDelete} className="!bg-red-50 !text-red-700 hover:!bg-red-100 !border-red-200">
            <Trash2 size={14} />
            {isAr ? 'حذف' : 'Delete'}
          </Button>
        ) : <div />}
        <Button onClick={handleSave} disabled={saving || uploading}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isAr ? 'حفظ' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { X, Search, MessageSquare, Image as ImageIcon, Video, Mic, FileText, Paperclip } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';

/**
 * Template picker shown from the Composer. Lists every chat template
 * the user has created, filters by language / tag / search, and on
 * click calls `onPick` with the chosen body + media info so the
 * Composer can populate itself (user can then edit before sending).
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
  }) => void;
  onClose: () => void;
  /** Current UI language — used to pick which body (ar/en) to insert. */
  currentLanguage: 'ar' | 'en';
}) {
  const isAr = currentLanguage === 'ar';
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const templatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);
  const templates = templatesModel ? (records[templatesModel.id] ?? []) : [];

  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [langFilter, setLangFilter] = useState<'all' | 'ar' | 'en' | 'both'>('all');

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
  }, [templates, search, tagFilter, langFilter]);

  const handlePick = (t: AppRecord) => {
    const d = t.data as Record<string, unknown>;
    // Pick whichever body best matches the current UI language. Fall
    // back to the other one if the preferred body is empty.
    const preferredBody = isAr
      ? (d.body_ar as string | null) || (d.body_en as string | null) || ''
      : (d.body_en as string | null) || (d.body_ar as string | null) || '';
    onPick({
      body: preferredBody,
      mediaFileId: (d.media_file_id as string | null) || null,
      mediaMime: (d.media_mime as string | null) || null,
      mediaSize: typeof d.media_size === 'number' ? (d.media_size as number) : null,
      mediaFilename: (d.media_filename as string | null) || null,
      mediaKind: (d.media_kind as string | null) || null,
    });
  };

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
            {isAr ? 'اختر قالبًا' : 'Pick a template'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Search + filters */}
        <div className="px-5 py-3 border-b border-sand/10 shrink-0 space-y-2">
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
                  {isAr ? 'كل التصنيفات' : 'All tags'}
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
            <div className="py-10 text-center text-sm text-charcoal/40">
              {templates.length === 0
                ? (isAr
                    ? 'لا توجد قوالب بعد. أنشئ قالبًا من صفحة قوالب الرسائل.'
                    : 'No templates yet. Create one from the Chat Templates page.')
                : (isAr ? 'لا توجد نتائج' : 'No matches')}
            </div>
          )}
          <div className="space-y-2">
            {visible.map((t) => {
              const d = t.data as Record<string, unknown>;
              const name = (d.name as string | null) ?? '';
              const bodyAr = (d.body_ar as string | null) ?? '';
              const bodyEn = (d.body_en as string | null) ?? '';
              const preview = isAr
                ? (bodyAr || bodyEn)
                : (bodyEn || bodyAr);
              const tags = Array.isArray(d.tags) ? (d.tags as string[]) : [];
              const mediaKind = (d.media_kind as string | null) ?? '';
              const hasMedia = !!d.media_file_id;
              const MediaIcon =
                mediaKind === 'image' ? ImageIcon
                : mediaKind === 'video' ? Video
                : mediaKind === 'audio' ? Mic
                : FileText;
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
                      {hasMedia && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-copper bg-copper/10 rounded-full px-1.5 py-0.5">
                          <Paperclip size={9} />
                          {mediaKind}
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
      </div>
    </div>
  );
}

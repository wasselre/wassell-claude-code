import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { BookOpen, Settings, Search } from 'lucide-react';
import type { AppRecord } from '@/types';

interface Props {
  snippets: AppRecord[];
  onPick: (snippetId: string) => void;
}

/**
 * Prompt-library popover trigger for the Image Chats composer.
 *
 * Click opens a small popover listing every record in
 * `prompt_snippets`, filterable by title via a search box. Picking
 * a snippet calls `onPick(snippetId)` (the composer fills the
 * textarea + adds the snippet's attached images), then closes.
 *
 * Bottom of the popover has a "Manage library…" link that routes
 * to the snippets list page so the user can curate the catalog.
 */
export default function PromptLibraryButton({ snippets, onPick }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter((s) => {
      const title = (s.data.title as string | undefined)?.toLowerCase() ?? '';
      const text = (s.data.text as string | undefined)?.toLowerCase() ?? '';
      return title.includes(q) || text.includes(q);
    });
  }, [snippets, filter]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-sand/40 bg-white hover:bg-cream transition-colors"
        title={isAr ? 'مكتبة التعليمات' : 'Prompt library'}
      >
        <BookOpen size={16} className="text-charcoal/70" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 end-0 w-80 max-h-80 rounded-lg border border-sand/40 bg-white shadow-lg z-30 flex flex-col">
          <div className="p-2 border-b border-sand/10 shrink-0">
            <div className="relative">
              <Search size={12} className="absolute top-2 start-2 text-charcoal/40" />
              <input
                type="text"
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={isAr ? 'بحث...' : 'Search…'}
                className="w-full ps-7 pe-2 py-1.5 text-xs rounded border border-sand/40 focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-charcoal/50 italic text-center">
                {snippets.length === 0
                  ? isAr
                    ? 'المكتبة فارغة. أضف تعليمة من رابط الإدارة بالأسفل.'
                    : 'Library is empty. Add a snippet from "Manage" below.'
                  : isAr
                    ? 'لا توجد نتائج.'
                    : 'No matches.'}
              </div>
            ) : (
              filtered.map((s) => {
                const id = s.id;
                const title = (s.data.title as string | undefined) ?? id;
                const category = s.data.category as string | undefined;
                const text = (s.data.text as string | undefined) ?? '';
                const imageCount = Array.isArray(s.data.images)
                  ? (s.data.images as unknown[]).length
                  : 0;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      onPick(id);
                      setOpen(false);
                    }}
                    className="w-full text-start px-3 py-2 text-xs hover:bg-cream border-b border-sand/10 last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <div className="font-medium truncate flex-1">{title}</div>
                      {category && (
                        <span className="text-[10px] bg-cream text-charcoal/70 rounded px-1.5 py-px shrink-0">
                          {category}
                        </span>
                      )}
                      {imageCount > 0 && (
                        <span className="text-[10px] bg-copper/10 text-copper rounded px-1.5 py-px shrink-0">
                          {imageCount}🖼
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-charcoal/60 truncate mt-0.5">
                      {text.slice(0, 100)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/model/prompt_snippets');
            }}
            className="w-full text-start px-3 py-2 text-xs hover:bg-cream flex items-center gap-2 border-t border-sand/10 text-copper font-medium shrink-0"
          >
            <Settings size={12} />
            <span>{isAr ? 'إدارة المكتبة...' : 'Manage library…'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

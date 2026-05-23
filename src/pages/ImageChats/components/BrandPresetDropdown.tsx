import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { ChevronDown, Check, Sparkles, Settings } from 'lucide-react';
import type { AppRecord } from '@/types';

interface Props {
  presets: AppRecord[];
  value: string | null;
  onChange: (id: string | null) => void;
}

/**
 * Brand preset dropdown for the Image Chats composer. Lists every
 * record in `image_presets` plus an explicit "None" option at the top
 * and a "Manage presets…" link at the bottom that routes to the
 * preset record list (where users add/edit/delete entries).
 */
export default function BrandPresetDropdown({ presets, value, onChange }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  const selected = useMemo(() => {
    if (!value) return null;
    return presets.find((p) => p.id === value) ?? null;
  }, [presets, value]);

  const selectedName = selected
    ? (selected.data.name as string | undefined) ?? (isAr ? 'إعداد' : 'Preset')
    : isAr
      ? 'بدون'
      : 'None';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-sand/40 bg-white hover:bg-cream transition-colors text-xs font-medium text-charcoal/80"
      >
        <Sparkles size={12} className="text-copper" />
        <span className="hidden sm:inline">
          {isAr ? 'العلامة:' : 'Brand:'}
        </span>
        <span className="max-w-[120px] truncate">{selectedName}</span>
        <ChevronDown size={12} className="text-charcoal/50" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 start-0 w-64 max-h-72 overflow-y-auto rounded-lg border border-sand/40 bg-white shadow-lg z-30">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="w-full text-start px-3 py-2 text-xs hover:bg-cream flex items-center gap-2 border-b border-sand/10"
          >
            {value === null ? <Check size={12} className="text-copper" /> : <span className="w-3" />}
            <span className="font-medium">{isAr ? 'بدون (دون علامة)' : 'None (no branding)'}</span>
          </button>
          {presets.length === 0 ? (
            <div className="px-3 py-3 text-xs text-charcoal/50 italic">
              {isAr ? 'لا توجد إعدادات. أضف واحدًا من رابط الإدارة بالأسفل.' : 'No presets yet. Add one from "Manage" below.'}
            </div>
          ) : (
            presets.map((p) => {
              const id = p.id;
              const name = (p.data.name as string | undefined) ?? id;
              const description = p.data.description as string | undefined;
              const active = value === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onChange(id);
                    setOpen(false);
                  }}
                  className={`w-full text-start px-3 py-2 text-xs hover:bg-cream flex items-start gap-2 ${
                    active ? 'bg-cream/60' : ''
                  }`}
                >
                  {active ? <Check size={12} className="text-copper mt-0.5" /> : <span className="w-3" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">✦ {name}</div>
                    {description && (
                      <div className="text-[10px] text-charcoal/60 truncate">{description}</div>
                    )}
                  </div>
                </button>
              );
            })
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/model/image_presets');
            }}
            className="w-full text-start px-3 py-2 text-xs hover:bg-cream flex items-center gap-2 border-t border-sand/10 text-copper font-medium"
          >
            <Settings size={12} />
            <span>{isAr ? 'إدارة الإعدادات...' : 'Manage presets…'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ChevronDown, Check, Cpu } from 'lucide-react';
import type { ChatModelId } from '@/lib/imageChat/client';

interface ModelOption {
  id: ChatModelId;
  label_en: string;
  label_ar: string;
  short_en: string;
  short_ar: string;
  description_en: string;
  description_ar: string;
}

/**
 * Catalog of image models the composer exposes. Keep `id` values in sync
 * with `resolveChatModelSlug` in api/_lib/imageGen.ts — that helper maps
 * each id to the actual fal.ai endpoint slug.
 */
export const CHAT_MODELS: ReadonlyArray<ModelOption> = [
  {
    id: 'nano-banana',
    label_en: 'Nano Banana 2',
    label_ar: 'نانو بنانا ٢',
    short_en: 'Nano Banana',
    short_ar: 'نانو بنانا',
    description_en: 'Google Gemini 3 Pro Image — fast, multi-image, strong with Arabic.',
    description_ar: 'جوجل جيميناي ٣ برو — سريع، يدعم عدة صور، قوي مع العربية.',
  },
  {
    id: 'gpt-image-2',
    label_en: 'GPT Image 2',
    label_ar: 'جي بي تي إيمج ٢',
    short_en: 'GPT Image 2',
    short_ar: 'جي بي تي ٢',
    description_en: 'OpenAI — best text rendering (~99%), photorealism-first.',
    description_ar: 'أوبن إيه آي — أفضل عرض للنصوص (~٩٩٪)، تركيز على الواقعية.',
  },
];

export const DEFAULT_CHAT_MODEL: ChatModelId = 'nano-banana';

export function isChatModelId(s: unknown): s is ChatModelId {
  return s === 'nano-banana' || s === 'gpt-image-2';
}

/** Resolve a model id (possibly unknown / null) to its short display
 *  name in the active language. Falls back to the default model. */
export function chatModelDisplayName(
  id: string | null | undefined,
  isAr: boolean,
): string {
  const m = CHAT_MODELS.find((x) => x.id === id) ?? CHAT_MODELS[0]!;
  return isAr ? m.short_ar : m.short_en;
}

interface Props {
  value: ChatModelId;
  onChange: (id: ChatModelId) => void;
}

/**
 * Model picker for the Image Chats composer. Mirrors the visual style
 * of BrandPresetDropdown so the controls row stays cohesive.
 */
export default function ModelDropdown({ value, onChange }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
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

  const selected = CHAT_MODELS.find((m) => m.id === value) ?? CHAT_MODELS[0]!;
  const selectedShort = isAr ? selected.short_ar : selected.short_en;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-sand/40 bg-white hover:bg-cream transition-colors text-xs font-medium text-charcoal/80"
        title={isAr ? 'النموذج' : 'Model'}
      >
        <Cpu size={12} className="text-copper" />
        <span className="hidden sm:inline">
          {isAr ? 'النموذج:' : 'Model:'}
        </span>
        <span className="max-w-[120px] truncate">{selectedShort}</span>
        <ChevronDown size={12} className="text-charcoal/50" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 start-0 w-72 rounded-lg border border-sand/40 bg-white shadow-lg z-30">
          {CHAT_MODELS.map((m) => {
            const active = value === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`w-full text-start px-3 py-2 text-xs hover:bg-cream flex items-start gap-2 ${
                  active ? 'bg-cream/60' : ''
                }`}
              >
                {active ? (
                  <Check size={12} className="text-copper mt-0.5 shrink-0" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{isAr ? m.label_ar : m.label_en}</div>
                  <div className="text-[10px] text-charcoal/60 mt-0.5">
                    {isAr ? m.description_ar : m.description_en}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

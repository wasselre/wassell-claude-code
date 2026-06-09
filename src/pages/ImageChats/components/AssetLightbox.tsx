import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import { X, ChevronLeft, ChevronRight, ChevronDown, Palette, PencilRuler } from 'lucide-react';

interface Props {
  /** Outputs to navigate (a generation's grid; a single asset in the library). */
  images: { url: string }[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** Brand-preset text (the "branding prompt"). Null/empty → muted placeholder. */
  brandingPrompt?: string | null;
  /** Preset name shown as the branding section subtitle. */
  brandingName?: string | null;
  /** The user's design instruction (the "design prompt"). */
  designPrompt?: string | null;
  /** Compact provenance shown above the actions. */
  meta?: { model?: string | null; aspect?: string | null; created?: string | null };
  /** Right-column action buttons (composed per surface, via AssetActions). */
  actions: ReactNode;
}

/**
 * Full-screen asset viewer (Image Chats v3). Three physical columns regardless
 * of language: LEFT = collapsible Branding-prompt + Design-prompt sections,
 * CENTER = the image at full size (prev/next + filmstrip across a generation's
 * outputs; ← → / Esc / backdrop close), RIGHT = the action menu. Sits at z-50 so
 * it covers the app sidebar (`.sidebar` is position:fixed z-50 — this portal is
 * later in the DOM, so equal z-index paints on top, exactly like every app
 * modal-overlay). The action modals it opens (Add-to-Files z-50 portal,
 * Add-to-Record z-[60]) are mounted later still, so they layer above it.
 *
 * Used by BOTH the workspace canvas and the cross-session Media Library — the
 * caller supplies the resolved branding/design prompts + the actions node.
 */
export default function AssetLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  brandingPrompt,
  brandingName,
  designPrompt,
  meta,
  actions,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const count = images.length;
  const current = images[index];
  const hasPrev = index > 0;
  const hasNext = index < count - 1;

  // Physical-arrow navigation (dir-independent): ← = previous index, → = next.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
      else if (e.key === 'ArrowRight' && index < count - 1) onIndexChange(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onClose, onIndexChange]);

  if (!current) return null;

  // dir="ltr" on the shell locks the three columns physically (left=prompts,
  // right=actions) per the user's spec; each panel re-applies the page dir for
  // correct label/icon flow, and prompt bodies use dir="auto" (content-driven).
  return createPortal(
    <div className="fixed inset-0 z-50 flex bg-charcoal/95 backdrop-blur-sm" dir="ltr">
      {/* LEFT — prompts */}
      <aside
        className="hidden md:flex w-[300px] shrink-0 bg-white border-r border-sand/20 flex-col overflow-y-auto"
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="p-3 border-b border-sand/20 text-sm font-semibold text-charcoal shrink-0">
          {isAr ? 'الأوصاف' : 'Prompts'}
        </div>
        <Section
          icon={<Palette size={14} className="text-copper" />}
          title={isAr ? 'وصف الهوية' : 'Branding prompt'}
          subtitle={brandingName ?? undefined}
          defaultOpen
          empty={isAr ? 'لا يوجد قالب هوية' : 'No brand preset'}
          body={brandingPrompt ?? ''}
        />
        <Section
          icon={<PencilRuler size={14} className="text-copper" />}
          title={isAr ? 'وصف التصميم' : 'Design prompt'}
          defaultOpen
          empty="—"
          body={designPrompt ?? ''}
        />
      </aside>

      {/* CENTER — image stage (click empty area to close) */}
      <div className="relative flex-1 min-w-0 flex items-center justify-center p-4 md:p-8" onClick={onClose}>
        {count > 1 && (
          <div className="absolute top-4 left-4 z-10 px-2.5 py-1 rounded-full bg-white/10 text-white text-xs font-medium" dir="ltr">
            {index + 1} / {count}
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          aria-label={isAr ? 'إغلاق' : 'Close'}
        >
          <X size={20} />
        </button>

        <img
          src={current.url}
          alt=""
          className="max-h-[84vh] max-w-full object-contain rounded-lg shadow-2xl select-none"
          onClick={(e) => e.stopPropagation()}
        />

        {count > 1 && (
          <>
            <NavBtn
              side="left"
              disabled={!hasPrev}
              label={isAr ? 'السابق' : 'Previous'}
              onClick={(e) => {
                e.stopPropagation();
                if (hasPrev) onIndexChange(index - 1);
              }}
            />
            <NavBtn
              side="right"
              disabled={!hasNext}
              label={isAr ? 'التالي' : 'Next'}
              onClick={(e) => {
                e.stopPropagation();
                if (hasNext) onIndexChange(index + 1);
              }}
            />
            <div
              className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-2 py-2 rounded-xl bg-charcoal/50 max-w-[90%] overflow-x-auto"
              dir="ltr"
              onClick={(e) => e.stopPropagation()}
            >
              {images.map((o, i) => (
                <button
                  key={o.url + i}
                  type="button"
                  onClick={() => onIndexChange(i)}
                  className={`w-12 h-12 shrink-0 rounded-md overflow-hidden border-2 transition-all ${
                    i === index ? 'border-copper' : 'border-white/20 hover:border-white/60'
                  }`}
                  aria-label={`#${i + 1}`}
                >
                  <img src={o.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* RIGHT — actions */}
      <aside
        className="w-[260px] sm:w-[300px] shrink-0 bg-white border-l border-sand/20 flex flex-col overflow-y-auto"
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="p-3 border-b border-sand/20 flex items-center gap-2 shrink-0">
          <div className="flex-1 text-sm font-semibold text-charcoal">{isAr ? 'الإجراءات' : 'Actions'}</div>
          <button onClick={onClose} className="md:hidden p-1.5 rounded-lg hover:bg-cream text-charcoal/70" aria-label={isAr ? 'إغلاق' : 'Close'}>
            <X size={16} />
          </button>
        </div>
        {meta && (meta.model || meta.aspect || meta.created) && (
          <div className="px-3 pt-3 text-[11px] text-charcoal/50 flex flex-wrap gap-x-2 gap-y-0.5" dir="ltr">
            {meta.model && <span>{meta.model}</span>}
            {meta.aspect && <span>· {meta.aspect}</span>}
            {meta.created && <span>· {formatTime(meta.created, isAr)}</span>}
          </div>
        )}
        <div className="p-3">{actions}</div>
      </aside>
    </div>,
    document.body,
  );
}

function Section({
  icon,
  title,
  subtitle,
  body,
  empty,
  defaultOpen,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  body: string;
  empty: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasBody = body.trim().length > 0;
  return (
    <div className="border-b border-sand/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-cream/60 transition-colors text-start"
      >
        <ChevronDown size={14} className={`text-charcoal/40 transition-transform shrink-0 ${open ? '' : '-rotate-90'}`} />
        {icon}
        <span className="font-semibold text-xs text-charcoal flex-1 truncate">{title}</span>
        {subtitle && <span className="text-[11px] text-charcoal/50 truncate max-w-[90px]">{subtitle}</span>}
      </button>
      {open && (
        <div
          className={`px-3 pb-3 text-xs whitespace-pre-wrap break-words leading-relaxed ${hasBody ? 'text-charcoal/80' : 'text-charcoal/40 italic'}`}
          dir="auto"
        >
          {hasBody ? body : empty}
        </div>
      )}
    </div>
  );
}

function NavBtn({
  side,
  disabled,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  disabled: boolean;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`absolute top-1/2 -translate-y-1/2 ${
        side === 'left' ? 'left-2 md:left-4' : 'right-2 md:right-4'
      } z-10 p-2.5 rounded-full bg-white/10 text-white transition-colors ${
        disabled ? 'opacity-30 cursor-default' : 'hover:bg-white/25'
      }`}
    >
      {side === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  );
}

function formatTime(iso: string, isAr: boolean): string {
  try {
    return new Date(iso).toLocaleString(isAr ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

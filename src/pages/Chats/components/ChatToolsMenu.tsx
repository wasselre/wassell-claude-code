/**
 * «أدوات» — the chat header's Tools pop-up: log an interaction, book an
 * appointment, record a visit. These three used to be separate header pills;
 * they are grouped so the header keeps only the actions reps reach for every
 * time (client profile, client options, notify officer, portal).
 *
 * The menu is PORTALED with fixed positioning, measured from the button, so no
 * `overflow` on the chat header (or the mobile bottom sheet) can clip it.
 * Closes on outside click, Escape, scroll/resize, or after choosing an item.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Wrench, ChevronDown, NotebookPen, CalendarPlus, MapPin, type LucideIcon } from 'lucide-react';

export interface ChatToolsMenuProps {
  onLogInteraction: () => void;
  onBookAppointment: () => void;
  onRecordVisit: () => void;
  /** Tailwind padding/size classes for the trigger, matching its neighbours. */
  padClass: string;
  /** Larger rows in the mobile sheet. */
  big?: boolean;
}

interface Item {
  key: string;
  icon: LucideIcon;
  label: string;
  hint: string;
  onSelect: () => void;
}

const MENU_WIDTH = 224;

export default function ChatToolsMenu({ onLogInteraction, onBookAppointment, onRecordVisit, padClass, big = false }: ChatToolsMenuProps) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === 'ar';
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Align the menu's START edge with the button's start edge, kept on screen.
    const rawLeft = isRtl ? r.right - MENU_WIDTH : r.left;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - MENU_WIDTH - 8));
    setPos({ top: r.bottom + 6, left });
  }, [isRtl]);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  const items: Item[] = [
    { key: 'log', icon: NotebookPen, label: t('chats.tools.log_interaction'), hint: t('chats.tools.log_interaction_hint'), onSelect: onLogInteraction },
    { key: 'appt', icon: CalendarPlus, label: t('chats.tools.book_appointment'), hint: t('chats.tools.book_appointment_hint'), onSelect: onBookAppointment },
    { key: 'visit', icon: MapPin, label: t('chats.tools.record_visit'), hint: t('chats.tools.record_visit_hint'), onSelect: onRecordVisit },
  ];

  let menu: ReactNode = null;
  if (open && pos) {
    menu = createPortal(
      <div
        ref={menuRef}
        role="menu"
        dir={isRtl ? 'rtl' : 'ltr'}
        style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH }}
        className="z-[70] rounded-xl border border-sand/60 bg-white py-1 shadow-lg"
      >
        {items.map(({ key, icon: Icon, label, hint, onSelect }) => (
          <button
            key={key}
            role="menuitem"
            title={hint}
            onClick={() => { setOpen(false); onSelect(); }}
            className={`flex w-full items-center gap-2.5 px-3 text-start text-charcoal hover:bg-cream ${big ? 'py-3 text-sm' : 'py-2 text-[13px]'}`}
          >
            <Icon size={15} className="shrink-0 text-copper" />
            {label}
          </button>
        ))}
      </div>,
      document.body,
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 ${padClass} font-medium text-[#8a6a2f] transition-colors hover:bg-gold/20`}
        title={t('chats.tools.title')}
      >
        <Wrench size={12} />
        {t('chats.tools.button')}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {menu}
    </>
  );
}

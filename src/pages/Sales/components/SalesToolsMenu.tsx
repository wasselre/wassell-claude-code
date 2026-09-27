/**
 * «أدوات / Tools» — the Sales Workspace's one menu for everyday actions.
 *
 * Every item reuses an existing form or page (nothing is rebuilt):
 *   - Search for a client   → ClientSearch → the client's page
 *   - Book an appointment   → QuickAppointmentModal (pickClient)
 *   - Record a visit        → QuickVisitModal (pickClient)
 *   - Project Finder        → /project-finder (moved here from the sidebar)
 *   - Financing calculator  → /financing
 *   - New WhatsApp chat     → StartChatModal
 *   - New client            → /model/clients/new
 *
 * Each item shows only when the user may already do it — model create
 * permission, custom-page access, or WhatsApp-tab access. Nothing here grants
 * anything new; the menu hides itself when no item is available.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wrench, ChevronDown, Search, CalendarPlus, MapPin, Compass, Calculator, MessageCirclePlus, UserPlus, type LucideIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { usePermission, useCanAccessPage } from '@/hooks/usePermission';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ClientSearch from './ClientSearch';
import QuickAppointmentModal from '@/pages/Followups/components/QuickAppointmentModal';
import QuickVisitModal from '@/pages/Followups/components/QuickVisitModal';
import StartChatModal from '@/pages/Chats/components/StartChatModal';

type OpenTool = 'search' | 'appointment' | 'visit' | 'chat' | null;

interface ToolItem {
  key: string;
  icon: LucideIcon;
  ar: string;
  en: string;
  show: boolean;
  run: () => void;
}

export default function SalesToolsMenu() {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const [menuOpen, setMenuOpen] = useState(false);
  const [openTool, setOpenTool] = useState<OpenTool>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const modelId = (name: string) => models.find((m) => m.name === name)?.id ?? '';
  const clientsId = modelId('clients');
  const canViewClients = usePermission(clientsId, 'view');
  const canCreateClient = usePermission(clientsId, 'create');
  const canBook = usePermission(modelId('appointments'), 'create');
  const canVisit = usePermission(modelId('visits'), 'create');
  const canFinder = useCanAccessPage('project_finder');
  const canFinancing = useCanAccessPage('financing_calculator');
  const canWhatsApp = useCanAccessPage('sw_whatsapp');

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const items: ToolItem[] = [
    { key: 'search', icon: Search, ar: 'البحث عن عميل', en: 'Search for a client', show: !!clientsId && canViewClients, run: () => setOpenTool('search') },
    { key: 'appointment', icon: CalendarPlus, ar: 'حجز موعد', en: 'Book an appointment', show: canBook, run: () => setOpenTool('appointment') },
    { key: 'visit', icon: MapPin, ar: 'تسجيل زيارة', en: 'Record a visit', show: canVisit, run: () => setOpenTool('visit') },
    { key: 'finder', icon: Compass, ar: 'الباحث عن المشاريع', en: 'Project Finder', show: canFinder, run: () => navigate('/project-finder') },
    { key: 'financing', icon: Calculator, ar: 'حاسبة التمويل', en: 'Financing calculator', show: canFinancing, run: () => navigate('/financing') },
    { key: 'chat', icon: MessageCirclePlus, ar: 'محادثة واتساب جديدة', en: 'New WhatsApp chat', show: canWhatsApp, run: () => setOpenTool('chat') },
    { key: 'new-client', icon: UserPlus, ar: 'عميل جديد', en: 'New client', show: !!clientsId && canCreateClient, run: () => navigate('/model/clients/new') },
  ].filter((i) => i.show);

  if (items.length === 0) return null;

  const close = () => setOpenTool(null);

  return (
    <div ref={wrapRef} className="relative">
      <Button
        variant="secondary"
        className="px-3 py-2"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <Wrench size={15} />
        {isAr ? 'أدوات' : 'Tools'}
        <ChevronDown size={14} className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
      </Button>

      {menuOpen && (
        <div role="menu" className="absolute end-0 top-full z-40 mt-2 w-60 rounded-xl border border-sand/60 bg-white py-1 shadow-lg">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); item.run(); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-start text-sm text-charcoal hover:bg-cream"
              >
                <Icon size={16} className="shrink-0 text-copper" />
                {isAr ? item.ar : item.en}
              </button>
            );
          })}
        </div>
      )}

      {openTool === 'search' && (
        <Modal open onClose={close} title={isAr ? 'البحث عن عميل' : 'Search for a client'} maxWidth="max-w-lg">
          <ClientSearch onPick={(c) => { close(); navigate(`/model/clients/${c.id}`); }} />
        </Modal>
      )}

      {openTool === 'appointment' && (
        <QuickAppointmentModal
          pickClient
          clientId={null}
          phone={null}
          salesRep={currentUserId}
          followupId={null}
          onClose={close}
          onSaved={() => {
            addToast(isAr ? 'تم حجز الموعد' : 'Appointment booked', 'success');
            close();
          }}
        />
      )}

      {openTool === 'visit' && (
        <QuickVisitModal
          pickClient
          clientId={null}
          clientName={null}
          phone={null}
          salesRep={currentUserId}
          followupId={null}
          onClose={close}
        />
      )}

      {openTool === 'chat' && <StartChatModal onClose={close} />}
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CircleDot, Plus, Pencil, MessageSquare, UserCheck, Globe, Phone, Send, Sparkles, type LucideIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { WorkflowAction } from '@/types';

export type AddableKind = 'condition' | WorkflowAction['type'];

export interface AddMenuPayload {
  branchId: string;
  insertAfterId: string | null;
  isEntry: boolean;
  isElse: boolean;
  isAfterAction: boolean;
  // Screen-space coordinates for the menu origin.
  screenX: number;
  screenY: number;
}

interface AddNodeMenuProps {
  payload: AddMenuPayload;
  onClose: () => void;
  onPick: (kind: AddableKind) => void;
}

// Floating picker shown at the click point of an edge's "+" button. Closes on
// outside-click and Escape. Conditions are disabled past the first action (the
// engine evaluates all conditions before actions inside a branch) and on else
// branches (else branches can't carry their own conditions).
export default function AddNodeMenu({ payload, onClose, onPick }: AddNodeMenuProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // Defer the click listener by a tick so the same click that opened the
    // menu doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // Conditions can be added on any non-else branch, even after an action.
  // The branch's underlying conditions array stays the source of truth, so
  // a condition added past an action still gets evaluated before any
  // action; the visual order in the lane reflects that (conditions float to
  // the top of the branch even if you placed them via a "+" past an action).
  const canAddCondition = !payload.isElse;

  const items: Array<{ kind: AddableKind; icon: LucideIcon; label: string; color: string; disabled?: boolean; hint?: string }> = [
    {
      kind: 'condition',
      icon: CircleDot,
      label: isAr ? 'شرط' : 'Condition',
      color: 'text-sky-600 bg-sky-50',
      disabled: !canAddCondition,
      hint: payload.isElse ? (isAr ? 'الحالة الافتراضية بلا شروط' : 'Else branches have no conditions') : undefined,
    },
    { kind: 'create_record', icon: Plus, label: isAr ? 'إنشاء سجل' : 'Create Record', color: 'text-emerald-600 bg-emerald-50' },
    { kind: 'update_record', icon: Pencil, label: isAr ? 'تحديث سجل' : 'Update Record', color: 'text-sky-600 bg-sky-50' },
    { kind: 'send_notification', icon: MessageSquare, label: isAr ? 'إشعار' : 'Notification', color: 'text-amber-600 bg-amber-50' },
    { kind: 'assign_user', icon: UserCheck, label: isAr ? 'تعيين مستخدم' : 'Assign User', color: 'text-violet-600 bg-violet-50' },
    { kind: 'http_request', icon: Globe, label: isAr ? 'طلب HTTP' : 'HTTP Request', color: 'text-rose-600 bg-rose-50' },
    { kind: 'outbound_ivr', icon: Phone, label: isAr ? 'مكالمة آلية' : 'Automated Call', color: 'text-copper bg-copper/10' },
    { kind: 'send_whatsapp_message', icon: Send, label: isAr ? 'واتساب' : 'WhatsApp', color: 'text-green-600 bg-green-50' },
    { kind: 'paseet_query', icon: Sparkles, label: isAr ? 'استعلام بسيط' : 'Paseet Query', color: 'text-copper bg-copper/10' },
  ];

  // Position: the dropdown anchors its top-start to (screenX, screenY) so it
  // opens toward the inline-end in both directions. Clamped to viewport so it
  // never falls off-screen.
  const MENU_WIDTH = 220;
  const MENU_HEIGHT_MAX = 460;
  const margin = 8;
  const maxX = window.innerWidth - MENU_WIDTH - margin;
  const maxY = window.innerHeight - MENU_HEIGHT_MAX - margin;
  const left = Math.min(Math.max(margin, payload.screenX), Math.max(margin, maxX));
  const top = Math.min(Math.max(margin, payload.screenY), Math.max(margin, maxY));

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[1000] rounded-xl bg-white border border-sand/60 shadow-xl shadow-black/10 py-1.5 min-w-[220px]"
      style={{ left, top }}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase text-charcoal/40 border-b border-sand/40 mb-1">
        {isAr ? 'أضف' : 'Add'}
      </div>
      {items.map(({ kind, icon: Icon, label, color, disabled, hint }) => (
        <button
          key={kind}
          onClick={() => { if (!disabled) onPick(kind); }}
          disabled={disabled}
          className={`w-full px-3 py-2 flex items-center gap-2.5 text-sm transition-colors text-start ${
            disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-cream cursor-pointer'
          }`}
          title={hint}
        >
          <div className={`w-7 h-7 rounded-md ${color} flex items-center justify-center shrink-0`}>
            <Icon size={14} />
          </div>
          <span className="font-bold text-charcoal">{label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

import { X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import ChatDetail from './ChatDetail';

/**
 * A single conversation (header + thread + composer) shown in a closeable
 * popup, reusing the same ChatDetail right-pane the Chats page renders. Used
 * by the Follow-up Workspace so a rep can WhatsApp a client and keep chatting
 * WITHOUT navigating away from the follow-up record — closing the popup leaves
 * them exactly where they were.
 */
export default function ChatThreadModal({ recordId, onClose }: { recordId: string; onClose: () => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-[80vh] max-h-[680px] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-end border-b border-sand/20 px-3 py-2">
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-charcoal/50 transition-colors hover:bg-cream hover:text-charcoal"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ChatDetail recordId={recordId} />
        </div>
      </div>
    </div>
  );
}

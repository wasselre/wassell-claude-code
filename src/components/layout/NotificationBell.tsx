import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

// Unread-count bell with a dropdown of recent marketing notifications.
// Notifications are written by the edge functions; the store hydrates them
// on load and on sign-in. Realtime-subscribe wiring is a follow-up.
export default function NotificationBell() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const notifications = useAppStore((s) => s.marketingNotifications);
  const markNotificationRead = useAppStore((s) => s.markNotificationRead);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.read_at).length;
  const recent = [...notifications]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 10);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="pill relative hover:bg-white/60 transition-colors"
        aria-label={isAr ? 'الإشعارات' : 'Notifications'}
        title={isAr ? 'الإشعارات' : 'Notifications'}
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -end-1 min-w-[18px] h-[18px] rounded-full bg-copper text-white text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 mt-2 w-80 bg-white rounded-xl border border-sand/50 shadow-lg z-40 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-sand/30">
            <span className="text-sm font-bold text-charcoal">
              {isAr ? 'الإشعارات' : 'Notifications'}
            </span>
            {unreadCount > 0 && (
              <button
                onClick={() => void markNotificationRead(null)}
                className="text-xs text-copper hover:underline"
              >
                {isAr ? 'تعليم كل شيء كمقروء' : 'Mark all read'}
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {recent.length === 0 ? (
              <div className="px-4 py-6 text-sm text-charcoal/50 text-center">
                {isAr ? 'لا توجد إشعارات' : 'No notifications'}
              </div>
            ) : (
              recent.map((n) => {
                const message = isAr ? n.message_ar : n.message_en;
                const date = new Date(n.created_at).toLocaleString(
                  isAr ? 'ar-SA' : 'en-US',
                  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
                );
                const to = n.operation_id ? `/marketing/${n.operation_id}` : '/marketing';
                return (
                  <Link
                    key={n.id}
                    to={to}
                    onClick={() => {
                      void markNotificationRead(n.id);
                      setOpen(false);
                    }}
                    className={`block px-4 py-3 border-b border-sand/20 hover:bg-cream/40 transition-colors ${
                      !n.read_at ? 'bg-copper/5' : ''
                    }`}
                  >
                    <div className="text-sm text-charcoal font-semibold">{message}</div>
                    <div className="text-xs text-charcoal/40 mt-1">{date}</div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

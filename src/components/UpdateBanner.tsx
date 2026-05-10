/**
 * Persistent "new version available" banner.
 *
 * Mounted once at the App level. Polls /api/version via
 * `useAppVersionPoller` and renders a sticky top bar when the deployed
 * build's commit SHA differs from the one this tab loaded with.
 *
 * No close button by design — a stale tab can cause real bugs (running
 * against a server schema it doesn't understand), and dismissing the
 * banner would silently leave the user vulnerable. The button reloads
 * the page in one click; backgrounded tabs auto-reload after a 2-minute
 * grace window. See useAppVersionPoller for the auto-reload guard.
 */

import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useAppVersionPoller } from '@/hooks/useAppVersionPoller';

export default function UpdateBanner() {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const { updateAvailable, reload } = useAppVersionPoller();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 inset-x-4 md:inset-x-auto md:end-6 md:bottom-6 md:max-w-md z-[60] rounded-2xl bg-chocolate text-white shadow-2xl border border-copper/40 p-4 flex items-center gap-3 animate-[fadeIn_0.2s_ease]"
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="w-9 h-9 rounded-full bg-copper/25 flex items-center justify-center shrink-0">
        <RefreshCw size={16} className="text-amber-200" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold">
          {isAr ? 'يتوفر إصدار جديد' : 'A new version is available'}
        </div>
        <div className="text-xs text-white/70 mt-0.5">
          {isAr
            ? 'أعد تحميل الصفحة لاستخدام آخر تحديث.'
            : 'Reload the page to pick up the latest update.'}
        </div>
      </div>
      <button
        onClick={reload}
        className="px-3 py-2 rounded-lg bg-copper hover:bg-terracotta text-white text-sm font-bold transition-colors shrink-0"
      >
        {isAr ? 'إعادة التحميل' : t('common.reload', 'Reload')}
      </button>
    </div>
  );
}

/**
 * Persistent "new version available" banner with a forced-reload countdown.
 *
 * Mounted once at the App level. Polls /api/version via `useAppVersionPoller`
 * and renders a sticky bar when the deployed build's commit SHA differs from
 * the one this tab loaded with.
 *
 * No close button by design — a stale tab is the source of the record_save
 * conflict storms (it runs against a server it doesn't understand), so it must
 * not linger. After a short grace the tab force-reloads regardless of
 * visibility (see useAppVersionPoller + src/lib/staleBuild). The banner counts
 * down visibly and warns about unsaved changes so "force" never loses work.
 */

import { useTranslation } from 'react-i18next';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useAppVersionPoller } from '@/hooks/useAppVersionPoller';

export default function UpdateBanner() {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.language);
  const isAr = language === 'ar';
  const { updateAvailable, reload, secondsUntilForcedReload, hasUnsaved, writeLocked, hasActiveJobs } =
    useAppVersionPoller();

  if (!updateAvailable) return null;

  const secs = secondsUntilForcedReload;
  const countdown =
    secs === null
      ? null
      : secs <= 0
        ? isAr ? 'جارٍ إعادة التحميل…' : 'Reloading…'
        : isAr
          ? `إعادة التحميل خلال ${secs} ثانية`
          : `Reloading in ${secs}s`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`fixed bottom-4 inset-x-4 md:inset-x-auto md:end-6 md:bottom-6 md:max-w-md z-[60] rounded-2xl text-white shadow-2xl border p-4 flex items-center gap-3 animate-[fadeIn_0.2s_ease] ${
        hasUnsaved ? 'bg-terracotta border-amber-300/60' : 'bg-chocolate border-copper/40'
      }`}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="w-9 h-9 rounded-full bg-copper/25 flex items-center justify-center shrink-0">
        {hasUnsaved ? (
          <AlertTriangle size={16} className="text-amber-200" />
        ) : (
          <RefreshCw size={16} className="text-amber-200" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold">
          {isAr ? 'يلزم تحديث الصفحة' : 'A required update is ready'}
          {countdown ? <span className="font-normal text-white/80"> · {countdown}</span> : null}
        </div>
        <div className="text-xs text-white/80 mt-0.5">
          {hasUnsaved
            ? isAr
              ? '⚠️ لديك تغييرات غير محفوظة — احفظها الآن قبل إعادة التحميل.'
              : '⚠️ You have unsaved changes — save them now before the reload.'
            : hasActiveJobs && !writeLocked
              ? isAr
                ? 'بانتظار اكتمال مهمة نشطة (إرسال وسائط / تنظيف صور) — سيُحدَّث تلقائيًا بعدها.'
                : 'Waiting for an active task (media send / photo cleaning) — the update applies right after.'
              : writeLocked
                ? isAr
                  ? 'تم إيقاف الحفظ مؤقتًا حتى يكتمل التحديث.'
                  : 'Saving is paused until the update completes.'
                : isAr
                  ? 'سيعاد تحميل هذه الصفحة تلقائيًا لتطبيق آخر تحديث.'
                  : 'This tab will reload automatically to apply the latest update.'}
        </div>
      </div>
      <button
        onClick={reload}
        className="px-3 py-2 rounded-lg bg-copper hover:bg-terracotta text-white text-sm font-bold transition-colors shrink-0"
      >
        {isAr ? 'إعادة التحميل الآن' : t('common.reloadNow', 'Reload now')}
      </button>
    </div>
  );
}

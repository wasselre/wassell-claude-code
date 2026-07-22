import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';

/**
 * Shown when someone deep-links to a retired or archived model — the retired
 * broad-assistant models (ai_chats / copywriter_chats / matching_chats, under
 * PROJECT_FINDER_ONLY) or any ARCHIVED_MODULE_MODELS entry (decks, image_chats,
 * data_migration, the Designs suite…). Non-destructive: the models and their
 * records still exist in the database; only the UI surfaces are unwired.
 * See src/lib/featureFlags.ts for both lists.
 */
export default function RetiredAssistantNotice() {
  const { i18n } = useTranslation();
  const isAr = i18n.language === 'ar';
  return (
    <div className="flex flex-col items-center justify-center text-center gap-4 py-24 px-6">
      <div className="w-16 h-16 rounded-2xl bg-cream flex items-center justify-center text-copper">
        <Compass size={32} />
      </div>
      <h2 className="text-xl font-semibold text-charcoal">
        {isAr ? 'تمت أرشفة هذا القسم' : 'This section has been archived'}
      </h2>
      <p className="max-w-md text-charcoal/60 leading-relaxed">
        {isAr
          ? 'هذا القسم لم يعد مستخدماً وتمت أرشفته — بياناته محفوظة ولم تُحذف. إذا احتجت الوصول إليه مجدداً تواصل مع مدير النظام.'
          : 'This section is no longer in use and has been archived — its data is preserved, not deleted. If you need it again, contact your administrator.'}
      </p>
    </div>
  );
}

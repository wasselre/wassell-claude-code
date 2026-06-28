import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';

/**
 * Shown when someone deep-links to a retired broad-assistant model
 * (ai_chats / copywriter_chats / matching_chats) under PROJECT_FINDER_ONLY. The
 * assistant direction was narrowed to the deterministic Project Finder, so these
 * conversational AI surfaces are unwired. Non-destructive: the data still exists.
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
        {isAr ? 'تم إيقاف هذا المساعد' : 'This assistant has been retired'}
      </h2>
      <p className="max-w-md text-charcoal/60 leading-relaxed">
        {isAr
          ? 'تم تركيز المنتج على «الباحث عن المشاريع» — أداة دقيقة لإيجاد وترتيب المشاريع المناسبة للعميل. استخدم زر «المشاريع المقترحة» في مساحة عمل المتابعة.'
          : 'The product is now focused on the Project Finder — a precise tool that finds and ranks the right projects for a client. Use the “Suggested Projects” button in the Follow-up workspace.'}
      </p>
    </div>
  );
}

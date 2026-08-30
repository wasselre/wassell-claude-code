import { useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

interface Props {
  modelId: string;
  recordId: string;
  /**
   * Push the freshly-generated English into the open form's state so the
   * read-only title_en/description_en fields reflect it immediately AND a
   * subsequent form save carries it (freeze_apply_row writes every schema
   * column from the payload, so the form MUST hold the current value).
   */
  onTranslated?: (patch: { title_en: string; description_en: string }) => void;
}

/**
 * "Translate to English" panel on a market_listings record form. Self-hides on
 * every other model. On-demand only: the listing's Arabic title/description are
 * translated to English (title_en/description_en) exactly when the operator
 * clicks — market_listings is a frozen model deliberately kept OUT of the eager
 * auto-translation pipeline. The English is persisted server-side (row-locked
 * RPC) and surfaced through the read-only English fields on this form.
 */
export default function TranslateListingPanel({ modelId, recordId, onTranslated }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
  const refreshRecordById = useAppStore((s) => s.refreshRecordById);
  const tr = (ar: string, en: string) => (isAr ? ar : en);
  const [busy, setBusy] = useState(false);

  const model = models.find((m) => m.id === modelId);
  if (model?.name !== 'market_listings') return null;

  const listing = (records[modelId] ?? []).find((r) => r.id === recordId);
  const data = (listing?.data as Record<string, unknown> | undefined) ?? {};
  const hasArabic =
    (typeof data.title === 'string' && data.title.trim() !== '') ||
    (typeof data.description === 'string' && data.description.trim() !== '');
  const titleEn = typeof data.title_en === 'string' ? data.title_en : '';
  const descriptionEn = typeof data.description_en === 'string' ? data.description_en : '';
  const hasEnglish = titleEn.trim() !== '' || descriptionEn.trim() !== '';

  const handleTranslate = async () => {
    setBusy(true);
    try {
      const token = (await supabase?.auth.getSession())?.data.session?.access_token;
      if (!token) {
        addToast(tr('يلزم تسجيل الدخول للترجمة.', 'You must be signed in to translate.'), 'error');
        return;
      }
      const res = await fetch('/api/market-listing/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: recordId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        title_en?: string;
        description_en?: string;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        addToast(
          `${tr('تعذّرت الترجمة', 'Translation failed')}${body.error ? `: ${body.error}` : ''}`,
          'error',
        );
        return;
      }
      onTranslated?.({ title_en: body.title_en ?? '', description_en: body.description_en ?? '' });
      // Re-hydrate the store row from unified_records so the list + any other
      // view reflect the new English (frozen-table writes don't echo via
      // Realtime).
      await refreshRecordById(recordId);
      addToast(tr('تمت الترجمة إلى الإنجليزية.', 'Translated to English.'), 'success');
    } catch (err) {
      addToast(
        `${tr('تعذّرت الترجمة', 'Translation failed')}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Languages size={16} className="text-copper" />
          <h3 className="font-bold text-charcoal text-sm">{tr('الترجمة الإنجليزية', 'English translation')}</h3>
        </div>
        <Button variant="primary" onClick={handleTranslate} disabled={busy || !hasArabic}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />}
          {hasEnglish ? tr('إعادة الترجمة', 'Re-translate') : tr('ترجمة إلى الإنجليزية', 'Translate to English')}
        </Button>
      </div>
      {!hasArabic ? (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr('لا يوجد عنوان أو وصف عربي لترجمته.', 'No Arabic title or description to translate.')}
        </p>
      ) : hasEnglish ? (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr(
            'الترجمة الإنجليزية محفوظة وتظهر في حقلي "العنوان (إنجليزي)" و"الوصف (إنجليزي)" أدناه.',
            'The English translation is saved and shows in the "Title (EN)" / "Description (EN)" fields below.',
          )}
        </p>
      ) : (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr(
            'أنشئ ترجمة إنجليزية للعنوان والوصف عند الطلب — تُحفظ مع الإعلان.',
            'Generate an English translation of the title and description on demand — saved with the listing.',
          )}
        </p>
      )}
    </div>
  );
}

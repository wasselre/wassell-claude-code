/**
 * Cross-language text input (bilingual W3b) — the ONE-input editing contract.
 *
 * Renders the field in the USER's language: the active translation when the
 * stored source is the other language, else the source itself. Editing:
 *   unchanged            → nothing written (the draft never sees display text)
 *   edit over source     → normal draft edit (source save path)
 *   edit over translation→ correction via record_translation_human_edit —
 *                          source untouched, machine locked out of this field
 *   "اجعلها الأصل" action → flips the source language server-side and routes
 *                          the text into the draft as the new source
 *
 * A small badge names what the input is showing so the user is never editing
 * something they think is something else.
 */

import { useEffect, useMemo, useState } from 'react';
import { Languages } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAr } from '@/hooks/useLang';
import { useRecordTranslationVersion, requestEntityTranslations } from '@/lib/recordTranslation/store';
import {
  computeBasis, commitKind, submitTranslationCorrection, flipSourceLanguage,
  type EditingBasis, type Lang,
} from '@/lib/recordTranslation/editing';
import AutoGrowTextarea from './AutoGrowTextarea';

interface Props {
  recordId: string;
  fieldName: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
}

export default function LocalizedTextInput({
  recordId, fieldName, value, onChange, multiline, placeholder,
}: Props) {
  const isAr = useIsAr();
  const lang: Lang = isAr ? 'ar' : 'en';
  const addToast = useAppStore((s) => s.addToast);
  const storeVersion = useRecordTranslationVersion();

  useEffect(() => { requestEntityTranslations(recordId); }, [recordId]);

  const basis: EditingBasis = useMemo(
    () => computeBasis(recordId, fieldName, value ?? '', lang),
    // Re-derive when hydration lands (storeVersion bumps) or the draft
    // source changes underneath us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recordId, fieldName, value, lang, storeVersion],
  );

  const [text, setText] = useState(basis.shownText);
  const [busy, setBusy] = useState(false);
  // Reset the local text whenever the basis display changes (hydration
  // arrived, correction applied, source saved elsewhere).
  useEffect(() => { setText(basis.shownText); }, [basis.shownText]);

  const commit = async () => {
    const kind = commitKind(basis, text);
    if (kind === 'none') return;
    if (kind === 'source_edit') {
      onChange(text);
      return;
    }
    // translation_correction
    setBusy(true);
    try {
      await submitTranslationCorrection(recordId, fieldName, lang, text);
      addToast(isAr ? 'تم تحديث الترجمة (لن تتغير آلياً بعد الآن)' : 'Translation updated (machine will no longer overwrite it)', 'success');
    } catch (err) {
      addToast(
        (isAr ? 'فشل تحديث الترجمة: ' : 'Translation update failed: ') + (err as Error).message,
        'error',
      );
      setText(basis.shownText);
    } finally {
      setBusy(false);
    }
  };

  const rewriteAsSource = async () => {
    setBusy(true);
    try {
      await flipSourceLanguage(recordId, fieldName, lang);
      onChange(text);   // the text becomes the draft's SOURCE value; user saves normally
      addToast(isAr ? 'أصبح هذا النص هو الأصل — احفظ السجل' : 'This text is now the source — save the record', 'success');
    } catch (err) {
      addToast((isAr ? 'تعذر تبديل لغة الأصل: ' : 'Could not flip source language: ') + (err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const showingTranslation = basis.kind === 'translation';
  const showingPendingSource = basis.kind === 'pending_source';

  const inputProps = {
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => { void commit(); },
    className: 'form-input',
    placeholder,
    disabled: busy,
  };

  return (
    <div>
      {multiline
        ? <AutoGrowTextarea rows={3} {...inputProps} />
        : <input type="text" {...inputProps} />}
      {(showingTranslation || showingPendingSource) && (
        <div className="mt-1 flex items-center gap-2 text-[0.6875rem] text-charcoal/40">
          <Languages size={11} className="text-copper" />
          {showingTranslation ? (
            <>
              <span>
                {isAr
                  ? 'تعرض ترجمة — تعديلك يصحّح الترجمة فقط، والأصل محفوظ'
                  : 'Showing a translation — your edit corrects the translation only; the source is preserved'}
              </span>
              <button
                type="button"
                onClick={() => void rewriteAsSource()}
                disabled={busy}
                className="text-copper hover:text-terracotta font-bold disabled:opacity-50"
              >
                {isAr ? 'اجعل نصّي هو الأصل' : 'Make my text the source'}
              </button>
            </>
          ) : (
            <span>
              {isAr
                ? 'النص الأصلي (لم تصل الترجمة بعد) — تعديلك يعدّل الأصل'
                : 'Original text (translation pending) — edits change the source'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

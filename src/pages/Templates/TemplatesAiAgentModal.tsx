import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, Loader2, AlertCircle } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import type { AppRecord } from '@/types';

interface TemplatesAiAgentModalProps {
  modelId: string;
  onClose: () => void;
}

interface ParsedTemplate {
  name: string;
  cleanup_prompt: string;
  editing_prompt: string;
  design_prompt: string;
  variables: Array<{ name: string; label_ar: string; label_en: string; type: 'text' | 'number' | 'currency' }>;
  notes: string;
}

const PLACEHOLDER_DESCRIPTION_AR = `الصق وصف القالب هنا...

مثال:
Template name: RSM 12
Reference design: ...
Variables: PROJECT_NAME_AR, LOCATION_AR, ...

PHASE 1 — Cleanup
\`\`\`
[الصق تعليمة المرحلة الأولى]
\`\`\`

PHASE 2 — Angle Generation
\`\`\`
[الصق تعليمة المرحلة الثانية]
\`\`\`

PHASE 3 — Design Composition
\`\`\`
[الصق تعليمة المرحلة الثالثة بصيغة {{PROJECT_NAME_AR}} ...]
\`\`\``;

const PLACEHOLDER_DESCRIPTION_EN = `Paste your template description here...

Example:
Template name: RSM 12
Reference design: ...
Variables: PROJECT_NAME_AR, LOCATION_AR, ...

PHASE 1 — Cleanup
\`\`\`
[Paste Phase 1 prompt]
\`\`\`

PHASE 2 — Angle Generation
\`\`\`
[Paste Phase 2 prompt]
\`\`\`

PHASE 3 — Design Composition
\`\`\`
[Paste Phase 3 prompt with {{PROJECT_NAME_AR}} placeholders]
\`\`\``;

/**
 * AI agent modal for the Templates Library. The user pastes a free-
 * form template description (often the structured-prompt doc the
 * design team writes per layout) and Claude extracts the four key
 * pieces — name, three phase prompts, variables list — into a real
 * design_templates record.
 *
 * The reference image is NOT generated here — Claude can't invent
 * URLs. After the record is created we route the user to its edit
 * page where they upload the reference image themselves.
 */
export default function TemplatesAiAgentModal({ modelId, onClose }: TemplatesAiAgentModalProps) {
  const navigate = useNavigate();
  const { language, saveRecord, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleEsc);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = prevOverflow;
    };
  }, [submitting, onClose]);

  const handleGenerate = async () => {
    const trimmed = description.trim();
    if (!trimmed) {
      setError(isAr ? 'الصق وصف القالب أولاً' : 'Paste a template description first');
      return;
    }
    if (trimmed.length < 50) {
      setError(isAr ? 'الوصف قصير جداً — الصق التفاصيل الكاملة' : 'Description is too short — paste the full spec');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const authHeader: Record<string, string> = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {};
      const res = await fetch('/api/templates/generate-from-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ description: trimmed }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        setError((errBody as { error?: string }).error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const json = (await res.json()) as { ok?: boolean; template?: ParsedTemplate };
      if (!json.template) {
        setError(isAr ? 'لم يُرجع الذكاء الاصطناعي قالباً' : 'AI did not return a template');
        return;
      }

      // Create the record locally + remote via the standard save path.
      const recordId = uuid();
      const newRecord: AppRecord = {
        id: recordId,
        model_id: modelId,
        data: {
          name: json.template.name,
          reference_image: '',
          cleanup_prompt: json.template.cleanup_prompt,
          editing_prompt: json.template.editing_prompt,
          design_prompt: json.template.design_prompt,
          variables: json.template.variables,
          notes: json.template.notes,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const saveResult = await saveRecord(newRecord);
      if (saveResult.status === 'conflict') {
        setError(isAr ? `فشل حفظ القالب: ${saveResult.message}` : `Failed to save template: ${saveResult.message}`);
        return;
      }
      // 'saved' or 'queued' both proceed — queued just means the upsert
      // hit the offline retry queue and will replay on next reconnect.

      addToast(
        isAr
          ? `تم إنشاء قالب "${json.template.name}" — ارفع الصورة المرجعية لإكماله`
          : `Created "${json.template.name}" — upload its reference image to finish`,
        'success',
      );
      onClose();
      navigate(`/model/design_templates/${recordId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(isAr ? `فشل الاتصال: ${msg}` : `Request failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] bg-charcoal/60 flex items-center justify-center p-4"
      onClick={() => { if (!submitting) onClose(); }}
    >
      <div
        className="bg-cream rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-5 border-b border-sand/40">
          <div className="w-10 h-10 rounded-xl bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <Sparkles size={20} />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-charcoal">
              {isAr ? 'إنشاء قالب بالذكاء الاصطناعي' : 'AI Agent — Create Template from Description'}
            </h2>
            <p className="text-xs text-charcoal/60 mt-0.5">
              {isAr
                ? 'الصق المواصفات الكاملة (٣ مراحل + المتغيرات) وسيستخرجها الذكاء الاصطناعي'
                : 'Paste the full spec (3 phases + variables) and the AI extracts a usable template.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!submitting) onClose(); }}
            disabled={submitting}
            className="p-1.5 rounded-lg hover:bg-sand/30 text-charcoal/50 hover:text-charcoal transition-colors disabled:opacity-50"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            placeholder={isAr ? PLACEHOLDER_DESCRIPTION_AR : PLACEHOLDER_DESCRIPTION_EN}
            className="form-input w-full font-mono text-xs"
            style={{ minHeight: '50vh', resize: 'vertical' }}
          />
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100 text-sm text-red-700">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span className="flex-1 break-words">{error}</span>
            </div>
          )}
          <p className="text-xs text-charcoal/50 leading-relaxed">
            {isAr
              ? 'ينشئ الذكاء الاصطناعي القالب بكل البيانات المطلوبة عدا الصورة المرجعية — ارفعها بعد إنشاء القالب من صفحة التحرير.'
              : 'The AI fills every field except the reference image — upload it on the template\'s edit page after creation.'}
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-5 border-t border-sand/40 bg-cream/40">
          <Button
            variant="secondary"
            type="button"
            onClick={() => { if (!submitting) onClose(); }}
            disabled={submitting}
          >
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={submitting || description.trim().length < 50}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {isAr ? 'جاري الإنشاء...' : 'Generating...'}
              </>
            ) : (
              <>
                <Sparkles size={14} />
                {isAr ? 'إنشاء القالب' : 'Generate Template'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

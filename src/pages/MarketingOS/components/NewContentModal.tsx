/**
 * Create content — design screen 5.
 *
 * Six decisions, not a forty-field form. The panel at the bottom states what is
 * about to happen (which workflow, which first task) BEFORE the user commits, so
 * the automation is never silent.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { createContent, MosContentRow, MosContentType } from '@/lib/marketingOS/client';

interface Props {
  types: MosContentType[];
  onClose: () => void;
  onCreated: (item: MosContentRow) => void;
}

type Purpose = 'organic' | 'paid' | 'both';

export default function NewContentModal({ types, onClose, onCreated }: Props) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);

  const [typeKey, setTypeKey] = useState<string>(types[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('organic');
  const [targetPublish, setTargetPublish] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = types.find((t) => t.key === typeKey) ?? null;

  const submit = async () => {
    if (!title.trim()) {
      addToast(isAr ? 'العنوان مطلوب' : 'Title is required', 'error');
      return;
    }
    if (!typeKey) {
      addToast(isAr ? 'اختر نوع المحتوى' : 'Pick a content type', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await createContent({
        title: title.trim(),
        content_type_key: typeKey,
        purpose,
        target_publish_at: targetPublish ? new Date(targetPublish).toISOString() : null,
      });
      onCreated(res.item);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isAr ? 'محتوى جديد' : 'New content'}
      footer={
        <div className="flex items-center gap-2">
          <p className="me-auto max-w-sm text-xs text-charcoal/50">
            {isAr
              ? 'يُنشأ الرقم ويُفتح أول مهمة تلقائيًا حسب نوع المحتوى.'
              : 'The ref and the first task are created automatically from the type.'}
          </p>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الإنشاء…' : 'Creating…') : isAr ? 'إنشاء وإسناد' : 'Create and assign'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-2 block text-xs font-semibold text-charcoal/60">
            {isAr ? 'النوع' : 'Type'}
          </label>
          <div className="grid grid-cols-4 gap-2">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTypeKey(t.key)}
                className={`rounded-lg border p-3 text-center transition ${
                  typeKey === t.key
                    ? 'border-copper bg-copper/10 ring-2 ring-copper/20'
                    : 'border-sand bg-white hover:border-copper/40'
                }`}
              >
                <div className="text-sm font-semibold">{isAr ? t.label_ar : t.label_en}</div>
                <div className="mt-0.5 font-mono text-[10px] text-charcoal/50" dir="ltr">
                  {t.prefix}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-charcoal/60">
            {isAr ? 'العنوان المبدئي' : 'Working title'}
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="form-input w-full"
            placeholder={isAr ? 'مثال: مينا ٥٢ — جولة الموقع' : 'e.g. Meena 52 — location tour'}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-charcoal/60">
              {isAr ? 'الغرض' : 'Purpose'}
            </label>
            <div className="flex overflow-hidden rounded-lg border border-sand">
              {(['organic', 'paid', 'both'] as Purpose[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPurpose(p)}
                  className={`flex-1 px-2 py-2 text-xs ${
                    purpose === p ? 'bg-cream font-semibold' : 'bg-white text-charcoal/60'
                  }`}
                >
                  {p === 'organic'
                    ? isAr ? 'عضوي' : 'Organic'
                    : p === 'paid'
                      ? isAr ? 'مدفوع' : 'Paid'
                      : isAr ? 'الاثنان' : 'Both'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-charcoal/60">
              {isAr ? 'تاريخ النشر المستهدف' : 'Target publish date'}
            </label>
            <input
              type="date"
              value={targetPublish}
              onChange={(e) => setTargetPublish(e.target.value)}
              className="form-input w-full"
            />
          </div>
        </div>

        {selected && (
          <div className="rounded-lg border border-sand bg-cream/60 px-3 py-2.5 text-xs leading-relaxed text-charcoal/70">
            {isAr ? (
              <>
                سيبدأ هذا العنصر برقم <b className="font-mono" dir="ltr">{selected.prefix}###</b>{' '}
                وسيفتح النظام <b>أول مهمة</b> في مساره ويُسندها إلى الدور المسؤول تلقائيًا.
              </>
            ) : (
              <>
                This item will be numbered <b className="font-mono" dir="ltr">{selected.prefix}###</b>{' '}
                and the system will open the <b>first task</b> of its workflow and assign it to the
                responsible role automatically.
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

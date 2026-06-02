import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { Snowflake, AlertTriangle, Loader2, Check } from 'lucide-react';
import type { AppModel, FreezeCoercionFailure } from '@/types';

interface FreezeModelModalProps {
  open: boolean;
  onClose: () => void;
  model: AppModel;
}

/**
 * Two-step modal for promoting a JSONB-backed model into a dedicated
 * Postgres table. Step 1 runs `checkFreezeCoercion` and shows any rows
 * that would fail to coerce; the user must clean them before continuing.
 * Step 2 confirms the freeze (one-way, locks UI editing) and calls
 * `freezeModel`. Aborts if the SQL transaction errors at any point.
 */
export default function FreezeModelModal({ open, onClose, model }: FreezeModelModalProps) {
  const { language, addToast, checkFreezeCoercion, freezeModel, getRecords } = useAppStore();
  const isAr = language === 'ar';

  const [phase, setPhase] = useState<'checking' | 'has_failures' | 'ready' | 'freezing' | 'done' | 'error'>('checking');
  const [failures, setFailures] = useState<FreezeCoercionFailure[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [confirmTyped, setConfirmTyped] = useState('');

  const recordCount = getRecords(model.id).length;
  const NON_FREEZABLE = new Set(['chats', 'ai_chats', 'data_migration']);
  const isFreezable = !NON_FREEZABLE.has(model.name) && !model.is_hardcoded;

  // Re-run the coercion check every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setPhase('checking');
    setFailures([]);
    setErrorMsg('');
    setConfirmTyped('');
    if (!isFreezable) {
      setPhase('error');
      setErrorMsg(
        isAr
          ? 'هذا النموذج غير قابل للتجميد (نموذج بواجهة مخصصة).'
          : 'This model is not freezable (custom-UI model).',
      );
      return;
    }
    void checkFreezeCoercion(model.id).then((rows) => {
      if (rows === null) {
        setPhase('error');
        setErrorMsg(
          isAr
            ? 'تعذر التحقق من البيانات — تأكد من الاتصال بـ Supabase.'
            : 'Could not run coercion check — Supabase may be unavailable.',
        );
        return;
      }
      if (rows.length > 0) {
        setFailures(rows);
        setPhase('has_failures');
      } else {
        setPhase('ready');
      }
    });
  }, [open, model.id, isFreezable, isAr, checkFreezeCoercion]);

  const handleFreeze = async () => {
    setPhase('freezing');
    const result = await freezeModel(model.id);
    if (!result.ok) {
      setPhase('error');
      setErrorMsg(result.error ?? (isAr ? 'فشل التجميد.' : 'Freeze failed.'));
      addToast(
        isAr ? `فشل التجميد: ${result.error}` : `Freeze failed: ${result.error}`,
        'error',
      );
      return;
    }
    setPhase('done');
    addToast(
      isAr
        ? `تم تجميد "${isAr ? model.label_ar : model.label_en}" — نُقل ${result.rowsCopied} سجل إلى جدول مخصص.`
        : `Frozen "${isAr ? model.label_ar : model.label_en}" — ${result.rowsCopied} record(s) moved to dedicated table.`,
      'success',
    );
  };

  const expectedConfirm = model.name;

  return (
    <Modal
      open={open}
      onClose={phase === 'freezing' ? () => undefined : onClose}
      title={isAr ? 'تجميد النموذج' : 'Freeze Model'}
      maxWidth="max-w-2xl"
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            {isAr ? 'إغلاق' : 'Close'}
          </Button>
        ) : phase === 'has_failures' || phase === 'error' ? (
          <Button variant="ghost" onClick={onClose}>
            {isAr ? 'إغلاق' : 'Close'}
          </Button>
        ) : phase === 'ready' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </Button>
            <Button
              variant="primary"
              onClick={handleFreeze}
              disabled={confirmTyped !== expectedConfirm}
            >
              <Snowflake size={16} />
              {isAr ? 'تجميد النموذج' : 'Freeze Model'}
            </Button>
          </>
        ) : phase === 'freezing' ? (
          <Button variant="primary" disabled>
            <Loader2 size={16} className="animate-spin" />
            {isAr ? 'جارٍ التجميد...' : 'Freezing...'}
          </Button>
        ) : null
      }
    >
      {phase === 'checking' && (
        <div className="flex items-center gap-3 text-charcoal py-6">
          <Loader2 size={18} className="animate-spin text-copper" />
          <span>{isAr ? 'جارٍ فحص البيانات...' : 'Checking records for coercion issues...'}</span>
        </div>
      )}

      {phase === 'has_failures' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">
                {isAr
                  ? `لا يمكن التجميد — ${failures.length} مشكلة في البيانات`
                  : `Cannot freeze — ${failures.length} data problem${failures.length === 1 ? '' : 's'}`}
              </p>
              <p className="text-red-800/80 mt-1">
                {isAr
                  ? 'صحّح القيم التالية في السجلات قبل المحاولة مرة أخرى. القيم لا تُحذف تلقائياً — التجميد لا يمحو بيانات بصمت.'
                  : 'Fix the values below in the affected records, then retry. Values are NOT silently nullified — freeze refuses to drop data.'}
              </p>
            </div>
          </div>
          <div className="border border-sand/50 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-cream/70 text-charcoal/60 font-bold">
                <tr>
                  <th className="text-start px-3 py-2">{isAr ? 'السجل' : 'Record'}</th>
                  <th className="text-start px-3 py-2">{isAr ? 'الحقل' : 'Field'}</th>
                  <th className="text-start px-3 py-2">{isAr ? 'القيمة' : 'Value'}</th>
                  <th className="text-start px-3 py-2">{isAr ? 'السبب' : 'Reason'}</th>
                </tr>
              </thead>
              <tbody>
                {failures.slice(0, 50).map((f, i) => (
                  <tr key={i} className="border-t border-sand/30">
                    <td className="px-3 py-2 font-mono text-charcoal/70">
                      {f.record_id.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 font-mono text-charcoal">{f.field_name}</td>
                    <td className="px-3 py-2 font-mono text-charcoal/80 truncate max-w-[160px]">
                      {f.raw_value ?? '∅'}
                    </td>
                    <td className="px-3 py-2 text-charcoal/70">{f.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {failures.length > 50 && (
              <div className="px-3 py-2 text-xs text-charcoal/50 bg-cream/40">
                {isAr
                  ? `... و ${failures.length - 50} مشكلة أخرى`
                  : `... and ${failures.length - 50} more`}
              </div>
            )}
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">{isAr ? 'إجراء غير قابل للعكس' : 'One-way action'}</p>
              <p className="text-amber-900/80 mt-1">
                {isAr
                  ? 'بعد التجميد، لن يمكن تعديل بنية النموذج من الـ Builder. أي تغيير لاحق على المخطط يتطلب طلب ترحيل من Claude.'
                  : 'After freezing, the Builder UI can no longer edit this model\'s schema. Future schema changes require a migration written by Claude.'}
              </p>
            </div>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Check size={14} className="text-green-600" />
              <span className="text-charcoal">
                {isAr
                  ? `جميع السجلات (${recordCount}) جاهزة للترحيل`
                  : `All ${recordCount} record(s) pass coercion`}
              </span>
            </div>
            <div className="text-charcoal/70 leading-relaxed">
              {isAr ? (
                <>
                  سيُنشأ جدول جديد <span className="font-mono text-charcoal">public.{model.name}</span>
                  {' '}بأعمدة مكتوبة لكل حقل، وجداول وصل (junction) للحقول متعددة القيم.
                  ثم تُنقل السجلات إليه وتُحذف نسخها من جدول <span className="font-mono">records</span>.
                </>
              ) : (
                <>
                  A new table <span className="font-mono text-charcoal">public.{model.name}</span>{' '}
                  will be created with proper typed columns + junction tables for multi-value
                  fields. Records are moved into it and removed from the unified{' '}
                  <span className="font-mono">records</span> table.
                </>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-charcoal/60">
              {isAr ? (
                <>للتأكيد، اكتب اسم النموذج: <span className="font-mono text-charcoal">{expectedConfirm}</span></>
              ) : (
                <>To confirm, type the model name: <span className="font-mono text-charcoal">{expectedConfirm}</span></>
              )}
            </label>
            <input
              type="text"
              value={confirmTyped}
              onChange={(e) => setConfirmTyped(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-sand/60 font-mono text-sm focus:border-copper focus:outline-none focus:ring-2 focus:ring-copper/20"
              placeholder={expectedConfirm}
              autoFocus
            />
          </div>
        </div>
      )}

      {phase === 'freezing' && (
        <div className="flex items-center gap-3 text-charcoal py-6">
          <Loader2 size={18} className="animate-spin text-copper" />
          <span>
            {isAr
              ? `جارٍ تجميد ${recordCount} سجل... قد يستغرق ذلك بعض الوقت.`
              : `Freezing ${recordCount} record(s)... this may take a moment.`}
          </span>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-green-900 text-sm">
          <Check size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">{isAr ? 'تم التجميد بنجاح' : 'Frozen successfully'}</p>
            <p className="text-green-900/80 mt-1">
              {isAr
                ? `النموذج الآن في جدول مخصص باسم "${model.name}". تعديلات بنيته اللاحقة تتم عبر Claude.`
                : `The model now lives in a dedicated table "${model.name}". Future schema edits go through Claude.`}
            </p>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 text-sm">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">{isAr ? 'تعذر التجميد' : 'Freeze failed'}</p>
            <p className="text-red-900/80 mt-1 font-mono text-xs whitespace-pre-wrap">{errorMsg}</p>
          </div>
        </div>
      )}
    </Modal>
  );
}

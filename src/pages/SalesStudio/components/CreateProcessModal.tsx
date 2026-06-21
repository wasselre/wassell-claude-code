import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { SalesProcess, SalesProcessVersion, SalesProcessVersionConfig } from '@/types';
import { buildDefaultVersionConfig } from '@/lib/salesStudio';

/** Create a new Sales Process, or duplicate an existing one's active config. */
export default function CreateProcessModal({
  open,
  onClose,
  source,
}: {
  open: boolean;
  onClose: () => void;
  source?: SalesProcess | null;
}) {
  const { language, workflows, salesProcessVersions, saveSalesProcess, saveSalesProcessVersion, addToast } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const isDup = !!source;
  const [nameAr, setNameAr] = useState(source ? `${source.name_ar} (نسخة)` : '');
  const [nameEn, setNameEn] = useState(source ? `${source.name_en} (copy)` : '');
  const [descAr, setDescAr] = useState(source?.description_ar ?? '');
  const [descEn, setDescEn] = useState(source?.description_en ?? '');
  const [saving, setSaving] = useState(false);

  const canSave = nameAr.trim() && nameEn.trim();

  const submit = () => {
    if (!canSave) return;
    setSaving(true);
    const now = new Date().toISOString();
    const processId = uuid();
    const versionId = uuid();
    // Config: clone the source's active version, else derive a fresh one.
    let config: SalesProcessVersionConfig;
    if (source) {
      const srcActive = salesProcessVersions.find((v) => v.sales_process_id === source.id && v.status === 'active')
        ?? salesProcessVersions.find((v) => v.sales_process_id === source.id);
      config = srcActive ? (JSON.parse(JSON.stringify(srcActive.config_json)) as SalesProcessVersionConfig) : buildDefaultVersionConfig(workflows);
    } else {
      config = buildDefaultVersionConfig(workflows);
    }
    const process: SalesProcess = {
      id: processId,
      name_ar: nameAr.trim(),
      name_en: nameEn.trim(),
      description_ar: descAr.trim() || null,
      description_en: descEn.trim() || null,
      status: 'draft',
      is_default: false,
      active_version_id: versionId,
      created_at: now,
      updated_at: now,
    };
    // First version ships as ACTIVE so the journey renders immediately; managers
    // edit further via a draft. (Publishing flow handles later active versions.)
    const version: SalesProcessVersion = {
      id: versionId,
      sales_process_id: processId,
      version_number: 1,
      status: 'active',
      config_json: config,
      published_at: now,
      published_by: null,
      created_at: now,
      updated_at: now,
    };
    saveSalesProcess(process);
    saveSalesProcessVersion(version);
    addToast(isAr ? 'تم إنشاء المسار' : 'Process created', 'success');
    setSaving(false);
    onClose();
    navigate(`/sales/studio/processes/${processId}`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isDup ? (isAr ? 'نسخ مسار المبيعات' : 'Duplicate Sales Process') : (isAr ? 'مسار مبيعات جديد' : 'New Sales Process')}
      maxWidth="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button variant="primary" onClick={submit} disabled={!canSave || saving}>{isAr ? 'إنشاء' : 'Create'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label={isAr ? 'الاسم (عربي)' : 'Name (Arabic)'}>
          <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" className="form-input w-full" placeholder="مسار المبيعات الجديد" />
        </Field>
        <Field label={isAr ? 'الاسم (إنجليزي)' : 'Name (English)'}>
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} dir="ltr" className="form-input w-full" placeholder="New sales process" />
        </Field>
        <Field label={isAr ? 'الوصف (عربي)' : 'Description (Arabic)'}>
          <textarea value={descAr} onChange={(e) => setDescAr(e.target.value)} rows={2} dir="rtl" className="form-input w-full" />
        </Field>
        <Field label={isAr ? 'الوصف (إنجليزي)' : 'Description (English)'}>
          <textarea value={descEn} onChange={(e) => setDescEn(e.target.value)} rows={2} dir="ltr" className="form-input w-full" />
        </Field>
        <p className="text-xs leading-relaxed text-charcoal/55">
          {isDup
            ? (isAr ? 'سيتم نسخ إعدادات المسار المصدر إلى الإصدار الأول من المسار الجديد.' : "The source process's configuration is copied into the new process's first version.")
            : (isAr ? 'يبدأ المسار بالإصدار الأول مبنيًا على سير عمل المبيعات الحالي — يمكنك تخصيص القيم الآمنة لاحقًا.' : "The process starts with a v1 derived from the current sales workflows — you can customize safe values afterward.")}
        </p>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-charcoal/60">{label}</label>
      {children}
    </div>
  );
}

import type { PresentationToolName } from '@/types';

/**
 * The set of tools the cloud worker exposes to the agent. Authoritative source
 * for the in-app Template Builder's "Tools" checklist — adding a new tool is
 * a worker code change first (in `cloud-worker/src/tools/`) then a registry
 * update here.
 *
 * Bilingual labels and descriptions are shown in the builder's checkbox row.
 * `serverSide: true` means Anthropic hosts execution — the agent calls it,
 * we never write a handler. Useful info to surface to the template author so
 * they understand the cost/latency profile.
 */
export interface PresentationToolDescriptor {
  name: PresentationToolName;
  label_en: string;
  label_ar: string;
  description_en: string;
  description_ar: string;
  /** True for Anthropic-hosted tools (web_search, web_fetch, code_execution).
   *  These can't be customized; they always behave the same. */
  serverSide: boolean;
}

export const TEMPLATE_TOOL_REGISTRY: PresentationToolDescriptor[] = [
  {
    name: 'web_search',
    label_en: 'Web search',
    label_ar: 'بحث الويب',
    description_en: 'Anthropic-hosted web search. Use to find current information past the model\'s training cutoff.',
    description_ar: 'بحث الويب المستضاف من Anthropic. يُستخدم للحصول على معلومات حديثة بعد آخر تحديث للنموذج.',
    serverSide: true,
  },
  {
    name: 'web_fetch',
    label_en: 'Web fetch',
    label_ar: 'جلب صفحة',
    description_en: 'Anthropic-hosted URL fetcher. Pairs with web_search — search surfaces URLs, fetch reads them in full.',
    description_ar: 'جالب صفحات الويب المستضاف من Anthropic. يقرأ الصفحات بالكامل من رابط محدد.',
    serverSide: true,
  },
  {
    name: 'code_execution',
    label_en: 'Code execution',
    label_ar: 'تنفيذ كود',
    description_en: 'Anthropic-hosted Python sandbox with python-pptx, pandas, matplotlib. Required for building .pptx files.',
    description_ar: 'صندوق Python محمي من Anthropic، يتضمن python-pptx وpandas وmatplotlib. مطلوب لبناء ملفات العروض.',
    serverSide: true,
  },
  {
    name: 'record_lookup',
    label_en: 'CRM record lookup',
    label_ar: 'قراءة سجلات النظام',
    description_en: 'Read records from this CRM\'s models (clients, projects, follow-ups, etc.). Read-only — agents can\'t write CRM data.',
    description_ar: 'قراءة سجلات النظام (العملاء، المشاريع، المتابعات...). للقراءة فقط — لا يمكن للوكيل تعديل البيانات.',
    serverSide: false,
  },
  {
    name: 'drive_upload',
    label_en: 'Google Drive upload',
    label_ar: 'الرفع إلى Drive',
    description_en: 'Copy a file built by code_execution to Google Drive. Returns a shareable URL. Required if your template produces a .pptx.',
    description_ar: 'نسخ ملف من code_execution إلى Google Drive وإرجاع رابط للمشاركة. مطلوب إذا أنتج القالب ملف عرض.',
    serverSide: false,
  },
];

/** Default labels per step kind, used when the author doesn't override. */
export const STEP_KIND_LABELS: Record<
  'research' | 'outline' | 'build' | 'review' | 'custom',
  { label_en: string; label_ar: string }
> = {
  research: { label_en: 'Research', label_ar: 'بحث' },
  outline: { label_en: 'Outline', label_ar: 'هيكلة' },
  build: { label_en: 'Build', label_ar: 'بناء' },
  review: { label_en: 'Review', label_ar: 'مراجعة' },
  custom: { label_en: 'Custom', label_ar: 'مخصص' },
};

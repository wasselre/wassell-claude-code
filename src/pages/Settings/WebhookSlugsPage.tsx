import { useState, useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { Plus, Trash2, Copy, Check, Eye, EyeOff, RefreshCw, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import BackToSettings from './components/BackToSettings';
import type { WebhookSlug } from '@/types';

// Project URL for displaying the full inbox URL next to each slug. Pulled
// from VITE_SUPABASE_URL so staging / dev / prod all show the correct host.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

export default function WebhookSlugsPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const slugs = useAppStore((s) => s.webhookSlugs);
  const saveWebhookSlug = useAppStore((s) => s.saveWebhookSlug);
  const deleteWebhookSlug = useAppStore((s) => s.deleteWebhookSlug);
  const addToast = useAppStore((s) => s.addToast);

  const [editing, setEditing] = useState<WebhookSlug | null>(null);

  const ordered = useMemo(
    () => [...slugs].sort((a, b) => a.name.localeCompare(b.name)),
    [slugs],
  );

  const startCreate = () => {
    const now = new Date().toISOString();
    setEditing({
      id: uuid(),
      slug: '',
      name: '',
      description: '',
      secret: null,
      payload_schema: {},
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  };

  const startEdit = (slug: WebhookSlug) => setEditing(structuredClone(slug));

  const removeSlug = async (slug: WebhookSlug) => {
    if (!confirm(isAr ? `حذف "${slug.name}"؟ العمليات السابقة ستبقى في السجل.` : `Delete "${slug.name}"? Past payloads stay in the audit log.`)) return;
    await deleteWebhookSlug(slug.id);
    addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
  };

  const onSave = async (draft: WebhookSlug) => {
    if (!draft.slug.trim() || !draft.name.trim()) {
      addToast(isAr ? 'الاسم والمعرّف مطلوبان' : 'Name and slug are required', 'error');
      return;
    }
    // Basic slug validation — kebab-case, URL-safe.
    if (!/^[a-z][a-z0-9-]*$/.test(draft.slug)) {
      addToast(isAr ? 'المعرّف يجب أن يكون أحرف إنجليزية صغيرة + أرقام + شرطات' : 'Slug must be lowercase letters, digits, and dashes', 'error');
      return;
    }
    const dup = slugs.find((s) => s.slug === draft.slug && s.id !== draft.id);
    if (dup) {
      addToast(isAr ? 'هذا المعرّف مستخدم لخطاف آخر' : 'Slug already used by another webhook', 'error');
      return;
    }
    try {
      await saveWebhookSlug(draft);
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
      setEditing(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-5">
      <BackToSettings className="!mb-0" />
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-1">
            {isAr ? 'نقاط استقبال الخطافات' : 'Webhook Endpoints'}
          </h1>
          <p className="text-sm text-charcoal/60 max-w-3xl">
            {isAr
              ? 'نقاط نهاية تستقبل طلبات HTTP من أنظمة خارجية (وكلاء الذكاء الاصطناعي، أنظمة CRM، …). كل نقطة لها معرّف فريد، رابط استقبال، وسر اختياري للتحقق من التوقيع. سير العمل الذي يستخدم هذه النقطة كمشغّل سيُنفّذ تلقائياً عند استقبال بياناتها.'
              : 'Inbound HTTP endpoints that external systems (AI agents, CRMs, cron jobs…) POST to. Each has a unique slug, an inbox URL, and an optional HMAC secret. Any workflow whose trigger points at this endpoint fires automatically when a payload arrives.'}
          </p>
        </div>
        <button
          onClick={startCreate}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-copper text-white hover:bg-terracotta text-sm font-bold"
        >
          <Plus size={16} />
          {isAr ? 'نقطة جديدة' : 'New webhook'}
        </button>
      </div>

      {ordered.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-sand/60 p-10 text-center text-charcoal/50 text-sm">
          {isAr ? 'لا توجد نقاط استقبال بعد. اضغط "نقطة جديدة" للبدء.' : 'No webhook endpoints yet. Click "New webhook" to create one.'}
        </div>
      ) : (
        <div className="space-y-2">
          {ordered.map((slug) => (
            <SlugRow
              key={slug.id}
              slug={slug}
              isAr={isAr}
              onEdit={() => startEdit(slug)}
              onDelete={() => removeSlug(slug)}
            />
          ))}
        </div>
      )}

      {editing && (
        <SlugEditor
          slug={editing}
          isAr={isAr}
          onSave={onSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SlugRow({
  slug,
  isAr,
  onEdit,
  onDelete,
}: {
  slug: WebhookSlug;
  isAr: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = SUPABASE_URL
    ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/inbox/${slug.slug}`
    : `/functions/v1/inbox/${slug.slug}`;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="bg-white rounded-xl border border-sand/50 p-4 hover:border-copper/40 transition-colors">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="font-bold text-charcoal truncate">{slug.name}</h3>
            {!slug.is_active && (
              <span className="text-[10px] font-bold tracking-widest uppercase bg-sand/30 text-charcoal/60 px-2 py-0.5 rounded">
                {isAr ? 'معطّل' : 'Disabled'}
              </span>
            )}
            {slug.secret && (
              <span
                className="text-[10px] font-bold tracking-widest uppercase bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded"
                title={isAr ? 'يستخدم توقيع HMAC' : 'HMAC signature required'}
              >
                {isAr ? 'موقّع' : 'Signed'}
              </span>
            )}
          </div>
          {slug.description && (
            <p className="text-xs text-charcoal/60 mb-1.5 line-clamp-2">{slug.description}</p>
          )}
          <div className="flex items-center gap-2">
            <code
              className="text-[11px] font-mono text-copper bg-copper/5 border border-copper/20 rounded px-2 py-1 truncate flex-1"
              dir="ltr"
              title={url}
            >
              {url}
            </code>
            <button
              onClick={copyUrl}
              className="p-1.5 rounded-md text-charcoal/50 hover:text-copper hover:bg-copper/5"
              aria-label={isAr ? 'نسخ الرابط' : 'Copy URL'}
              title={isAr ? 'نسخ الرابط' : 'Copy URL'}
            >
              {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={onEdit}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-copper hover:bg-copper/5"
          >
            {isAr ? 'تعديل' : 'Edit'}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md text-charcoal/35 hover:text-red-600 hover:bg-red-50"
            aria-label={isAr ? 'حذف' : 'Delete'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface SchemaField {
  name: string;
  label_ar?: string;
  label_en?: string;
}

function SlugEditor({
  slug,
  isAr,
  onSave,
  onCancel,
}: {
  slug: WebhookSlug;
  isAr: boolean;
  onSave: (draft: WebhookSlug) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<WebhookSlug>(slug);
  const [showSecret, setShowSecret] = useState(false);

  // Payload schema is stored as JSONB. We expose it in the UI as a flat list
  // of field entries ({name, label_ar?, label_en?}) — that matches how the
  // workflow editor will consume it to render condition/mapping pickers.
  const fields: SchemaField[] = useMemo(() => {
    const raw = draft.payload_schema ?? {};
    if (Array.isArray((raw as { fields?: unknown }).fields)) {
      return (raw as { fields: SchemaField[] }).fields;
    }
    return [];
  }, [draft.payload_schema]);

  const setFields = (next: SchemaField[]) =>
    setDraft({ ...draft, payload_schema: { ...(draft.payload_schema ?? {}), fields: next } });
  const addField = () => setFields([...fields, { name: '' }]);
  const updateField = (idx: number, patch: Partial<SchemaField>) =>
    setFields(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  const removeField = (idx: number) => setFields(fields.filter((_, i) => i !== idx));

  const generateSecret = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    setDraft({ ...draft, secret: hex });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-sand/30 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-charcoal">
            {slug.name ? (isAr ? 'تعديل الخطاف' : 'Edit webhook') : (isAr ? 'خطاف جديد' : 'New webhook')}
          </h2>
          <button onClick={onCancel} className="p-1.5 rounded-md text-charcoal/40 hover:bg-sand/20">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {isAr ? 'الاسم' : 'Name'} *
            </label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="form-input text-sm"
              placeholder={isAr ? 'مثلاً: نتائج وكيل البحث' : 'e.g. Research agent results'}
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {isAr ? 'المعرّف (في الرابط)' : 'Slug (URL segment)'} *
            </label>
            <input
              type="text"
              value={draft.slug}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
              className="form-input text-sm font-mono"
              placeholder="research-done"
              dir="ltr"
            />
            <p className="text-[11px] text-charcoal/40 mt-1">
              /functions/v1/inbox/<span className="font-mono text-copper">{draft.slug || '…'}</span>
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {isAr ? 'الوصف' : 'Description'}
            </label>
            <textarea
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="form-input text-sm"
              rows={2}
              placeholder={isAr ? 'ماذا تستقبل هذه النقطة، ومن المتصل؟' : 'What does this endpoint receive, and who calls it?'}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-charcoal/60">
                {isAr ? 'السر (اختياري، HMAC-SHA256)' : 'Secret (optional, HMAC-SHA256)'}
              </label>
              <div className="flex gap-2">
                {draft.secret && (
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    className="text-[11px] text-charcoal/50 hover:text-charcoal inline-flex items-center gap-1"
                  >
                    {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecret ? (isAr ? 'إخفاء' : 'Hide') : (isAr ? 'إظهار' : 'Show')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={generateSecret}
                  className="text-[11px] text-copper hover:text-terracotta font-bold inline-flex items-center gap-1"
                >
                  <RefreshCw size={12} />
                  {isAr ? 'توليد' : 'Generate'}
                </button>
              </div>
            </div>
            <input
              type={showSecret ? 'text' : 'password'}
              value={draft.secret ?? ''}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value || null })}
              className="form-input text-xs font-mono"
              placeholder={isAr ? 'اتركه فارغاً لجعل النقطة مفتوحة' : 'Leave empty to accept unsigned requests'}
              dir="ltr"
            />
            <p className="text-[11px] text-charcoal/40 mt-1">
              {isAr
                ? 'عند وجود سر، يجب على المتصل إرسال ترويسة X-Signature تحتوي على HMAC-SHA256 للجسم الخام بالصيغة السداسية عشرية.'
                : 'When set, callers must send X-Signature header with hex HMAC-SHA256 of the raw body.'}
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-charcoal/60">
                {isAr ? 'حقول المحتوى' : 'Payload fields'}
              </label>
              <button
                type="button"
                onClick={addField}
                className="text-[11px] text-copper hover:text-terracotta font-bold"
              >
                + {isAr ? 'إضافة حقل' : 'Add field'}
              </button>
            </div>
            <p className="text-[11px] text-charcoal/40 mb-2">
              {isAr
                ? 'أعلن الحقول التي سترسلها الجهة المتصلة في الـ JSON. ستظهر في محرّر الشروط والخرائط في سير العمل.'
                : 'Declare the fields the caller will send in the JSON body. They appear in the workflow editor as pickable trigger fields.'}
            </p>
            {fields.length === 0 ? (
              <div className="text-[11px] text-charcoal/35 py-2">
                {isAr ? 'لم يتم الإعلان عن حقول بعد.' : 'No fields declared yet.'}
              </div>
            ) : (
              <div className="space-y-1.5">
                {fields.map((f, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                    <input
                      type="text"
                      value={f.name}
                      onChange={(e) => updateField(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                      placeholder="field_slug"
                      className="form-input text-xs font-mono"
                      dir="ltr"
                    />
                    <input
                      type="text"
                      value={f.label_ar ?? ''}
                      onChange={(e) => updateField(i, { label_ar: e.target.value })}
                      placeholder={isAr ? 'العنوان (عربي)' : 'Label (AR)'}
                      className="form-input text-xs"
                      dir="rtl"
                    />
                    <input
                      type="text"
                      value={f.label_en ?? ''}
                      onChange={(e) => updateField(i, { label_en: e.target.value })}
                      placeholder="Label (EN)"
                      className="form-input text-xs"
                      dir="ltr"
                    />
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      className="p-1 rounded text-charcoal/30 hover:text-red-500 hover:bg-red-50"
                      aria-label="remove"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
                className="w-4 h-4 accent-copper"
              />
              <span className="text-sm text-charcoal">
                {isAr ? 'نشِط — قبول الطلبات الواردة' : 'Active — accepting incoming requests'}
              </span>
            </label>
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-sand/30 px-6 py-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-bold text-charcoal/70 hover:bg-sand/20"
          >
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            onClick={() => onSave(draft)}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-copper text-white hover:bg-terracotta"
          >
            {isAr ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

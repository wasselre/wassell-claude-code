import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import StatusBadge from './components/StatusBadge';
import {
  POST_TYPES,
  POST_COMPONENTS,
  POST_VISUALS,
  POST_USAGES,
  type Post,
  type PostType,
  type PostComponent,
  type PostVisual,
  type PostUsage,
} from '@/types';

export default function PostEditor() {
  const { operationId, postId } = useParams<{ operationId: string; postId: string }>();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const posts = useAppStore((s) => s.posts);
  const savePost = useAppStore((s) => s.savePost);
  const addToast = useAppStore((s) => s.addToast);

  const post = posts.find((p) => p.id === postId);
  const [draft, setDraft] = useState<Post | null>(post ? { ...post } : null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (post) setDraft({ ...post });
  }, [post]);

  const mandatoryCheck = useMemo(() => {
    if (!draft) return { project: false, unit: false, location: false };
    const allText = [
      draft.title,
      draft.design_text_1,
      draft.design_text_2,
      draft.design_text_3,
      draft.caption,
    ].filter(Boolean).join('\n').toLowerCase();
    return {
      project: allText.trim().length > 0,
      unit: /شقة|فيلا|دور|روف|وحدة|استوديو/i.test(allText),
      location: /الرياض|جدة|الحي|مدينة|شمال|جنوب|شرق|غرب/i.test(allText),
    };
  }, [draft]);

  if (!post || !draft) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-center">
        <p className="text-charcoal/60">{isAr ? 'لم يتم العثور على المنشور' : 'Post not found'}</p>
        <Button variant="secondary" className="mt-3" onClick={() => navigate(`/marketing/${operationId}`)}>
          {isAr ? 'العودة' : 'Back'}
        </Button>
      </div>
    );
  }

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  const doSave = async (nextStatus?: Post['status']) => {
    setSaving(true);
    try {
      await savePost({ ...draft, status: nextStatus ?? draft.status });
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto space-y-5">
      <button
        onClick={() => navigate(`/marketing/${operationId}`)}
        className="inline-flex items-center gap-1.5 text-sm text-charcoal/60 hover:text-copper"
      >
        <BackIcon size={14} />
        {isAr ? 'العودة' : 'Back'}
      </button>

      <div className="bg-white rounded-xl border border-sand/50 p-5">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-charcoal">
            {isAr ? `منشور #${draft.post_number}` : `Post #${draft.post_number}`}
          </h1>
          <StatusBadge status={draft.status} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Select
            label={isAr ? 'النوع' : 'Type'}
            value={draft.type ?? ''}
            options={POST_TYPES}
            onChange={(v) => setDraft((d) => (d ? { ...d, type: (v || null) as PostType | null } : d))}
          />
          <Select
            label={isAr ? 'المكوّن' : 'Components'}
            value={draft.components ?? ''}
            options={POST_COMPONENTS}
            onChange={(v) => setDraft((d) => (d ? { ...d, components: (v || null) as PostComponent | null } : d))}
          />
          <Select
            label={isAr ? 'العنصر البصري' : 'Visual'}
            value={draft.visual ?? ''}
            options={POST_VISUALS}
            onChange={(v) => setDraft((d) => (d ? { ...d, visual: (v || null) as PostVisual | null } : d))}
          />
          <Select
            label={isAr ? 'الاستخدام' : 'Usage'}
            value={draft.usage ?? ''}
            options={POST_USAGES}
            onChange={(v) => setDraft((d) => (d ? { ...d, usage: (v || null) as PostUsage | null } : d))}
          />
        </div>

        <ChecklistPanel check={mandatoryCheck} isAr={isAr} />
      </div>

      <div className="bg-white rounded-xl border border-sand/50 p-5 space-y-4">
        <TextField
          label={isAr ? 'نص العنوان' : 'Title'}
          value={draft.title ?? ''}
          onChange={(v) => setDraft((d) => (d ? { ...d, title: v } : d))}
          maxLines={1}
        />
        <TextField
          label={isAr ? 'النص - 1 داخل التصميم' : 'Design text 1'}
          value={draft.design_text_1 ?? ''}
          onChange={(v) => setDraft((d) => (d ? { ...d, design_text_1: v } : d))}
          maxLines={2}
        />
        <TextField
          label={isAr ? 'النص - 2 داخل التصميم' : 'Design text 2'}
          value={draft.design_text_2 ?? ''}
          onChange={(v) => setDraft((d) => (d ? { ...d, design_text_2: v } : d))}
          maxLines={2}
        />
        <TextField
          label={isAr ? 'النص - 3 داخل التصميم' : 'Design text 3'}
          value={draft.design_text_3 ?? ''}
          onChange={(v) => setDraft((d) => (d ? { ...d, design_text_3: v } : d))}
          maxLines={2}
        />
        <TextField
          label={isAr ? 'التعليق' : 'Caption'}
          value={draft.caption ?? ''}
          onChange={(v) => setDraft((d) => (d ? { ...d, caption: v } : d))}
          maxLines={6}
        />
      </div>

      <div className="flex justify-between gap-2">
        <Button variant="secondary" onClick={() => doSave('writing')} disabled={saving}>
          <RotateCcw size={14} />
          {isAr ? 'إعادة إلى الكتابة' : 'Send back to writing'}
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => doSave()} disabled={saving}>
            {saving ? (isAr ? 'جاري الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
          </Button>
          <Button onClick={() => doSave('approved')} disabled={saving}>
            <CheckCircle2 size={14} />
            {isAr ? 'اعتماد' : 'Approve'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-charcoal/70 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
      >
        <option value="">—</option>
        {options.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  maxLines,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLines: number;
}) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <label className="text-xs font-semibold text-charcoal/70">{label}</label>
        <span className="text-[0.6875rem] text-charcoal/40">{value.length} ch</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={maxLines}
        className="w-full rounded-lg border border-sand/50 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30 resize-y"
      />
    </div>
  );
}

function ChecklistPanel({
  check,
  isAr,
}: {
  check: { project: boolean; unit: boolean; location: boolean };
  isAr: boolean;
}) {
  const items = [
    { key: 'project', label: isAr ? 'اسم المشروع' : 'Project name', ok: check.project },
    { key: 'unit', label: isAr ? 'نوع الوحدة' : 'Unit type', ok: check.unit },
    { key: 'location', label: isAr ? 'الموقع' : 'Location', ok: check.location },
  ];
  return (
    <div className="bg-cream/30 rounded-lg p-3 border border-sand/50">
      <div className="text-xs font-bold text-charcoal/70 mb-2">
        {isAr ? 'العناصر الإلزامية' : 'Mandatory elements'}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <span
            key={item.key}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold ${
              item.ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'
            }`}
          >
            {item.ok ? '✓' : '✗'} {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

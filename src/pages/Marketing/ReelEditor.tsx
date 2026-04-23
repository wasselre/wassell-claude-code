import { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Plus, Trash2, CheckCircle2, RotateCcw, GripVertical } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import StatusBadge from './components/StatusBadge';
import {
  REEL_TYPES,
  REEL_DURATIONS,
  REEL_PLATFORMS,
  REEL_VOICEOVERS,
  REEL_GOALS,
  type Reel,
  type ReelScene,
  type ReelType,
  type ReelDuration,
  type ReelPlatform,
  type ReelVoiceover,
  type ReelGoal,
} from '@/types';

const MAX_SCENES = 8;

export default function ReelEditor() {
  const { operationId, reelId } = useParams<{ operationId: string; reelId: string }>();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const reels = useAppStore((s) => s.reels);
  const saveReel = useAppStore((s) => s.saveReel);
  const addToast = useAppStore((s) => s.addToast);

  const reel = reels.find((r) => r.id === reelId);

  const [draft, setDraft] = useState<Reel | null>(reel ? { ...reel, scenes: [...reel.scenes] } : null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (reel) setDraft({ ...reel, scenes: [...reel.scenes] });
  }, [reel]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const mandatoryCheck = useMemo(() => {
    if (!draft) return { location: false, price: false, area: false, unit: false };
    const allText = draft.scenes.map((s) => `${s.description}\n${s.text}`).join('\n').toLowerCase();
    return {
      location: /الرياض|جدة|الحي|مدينة|شمال|جنوب|شرق|غرب/i.test(allText),
      price: /تبدأ من|سعر|ر\.س|ريال|ألف|مليون/i.test(allText),
      area: /مساحات تصل|م²|متر/i.test(allText),
      unit: /شقة|فيلا|دور|روف|وحدة|استوديو/i.test(allText),
    };
  }, [draft]);

  if (!reel || !draft) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-center">
        <p className="text-charcoal/60">{isAr ? 'لم يتم العثور على الريل' : 'Reel not found'}</p>
        <Button variant="secondary" className="mt-3" onClick={() => navigate(`/marketing/${operationId}`)}>
          {isAr ? 'العودة' : 'Back'}
        </Button>
      </div>
    );
  }

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  const updateScene = (idx: number, patch: Partial<ReelScene>) => {
    setDraft((d) => {
      if (!d) return d;
      const scenes = d.scenes.map((s, i) => (i === idx ? { ...s, ...patch } : s));
      return { ...d, scenes };
    });
  };

  const addScene = () => {
    if (draft.scenes.length >= MAX_SCENES) return;
    setDraft((d) => {
      if (!d) return d;
      const next: ReelScene = { number: d.scenes.length + 1, description: '', text: '' };
      return { ...d, scenes: [...d.scenes, next] };
    });
  };

  const removeScene = (idx: number) => {
    setDraft((d) => {
      if (!d) return d;
      const scenes = d.scenes.filter((_, i) => i !== idx).map((s, i) => ({ ...s, number: i + 1 }));
      return { ...d, scenes };
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraft((d) => {
      if (!d) return d;
      const oldIdx = d.scenes.findIndex((s) => String(s.number) === String(active.id));
      const newIdx = d.scenes.findIndex((s) => String(s.number) === String(over.id));
      if (oldIdx < 0 || newIdx < 0) return d;
      const scenes = arrayMove(d.scenes, oldIdx, newIdx).map((s, i) => ({ ...s, number: i + 1 }));
      return { ...d, scenes };
    });
  };

  const doSave = async (nextStatus?: Reel['status']) => {
    setSaving(true);
    try {
      await saveReel({ ...draft, status: nextStatus ?? draft.status });
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
            {isAr ? `ريل #${draft.reel_number}` : `Reel #${draft.reel_number}`}
          </h1>
          <StatusBadge status={draft.status} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
          <Select
            label={isAr ? 'النوع' : 'Type'}
            value={draft.type ?? ''}
            options={REEL_TYPES}
            onChange={(v) => setDraft((d) => (d ? { ...d, type: (v || null) as ReelType | null } : d))}
          />
          <Select
            label={isAr ? 'المدة' : 'Duration'}
            value={draft.duration ?? ''}
            options={REEL_DURATIONS}
            onChange={(v) => setDraft((d) => (d ? { ...d, duration: (v || null) as ReelDuration | null } : d))}
          />
          <Select
            label={isAr ? 'المنصة' : 'Platform'}
            value={draft.platform ?? ''}
            options={REEL_PLATFORMS}
            onChange={(v) => setDraft((d) => (d ? { ...d, platform: (v || null) as ReelPlatform | null } : d))}
          />
          <Select
            label={isAr ? 'الصوت' : 'Voiceover'}
            value={draft.voiceover ?? ''}
            options={REEL_VOICEOVERS}
            onChange={(v) => setDraft((d) => (d ? { ...d, voiceover: (v || null) as ReelVoiceover | null } : d))}
          />
          <Select
            label={isAr ? 'الهدف' : 'Goal'}
            value={draft.goal ?? ''}
            options={REEL_GOALS}
            onChange={(v) => setDraft((d) => (d ? { ...d, goal: (v || null) as ReelGoal | null } : d))}
          />
        </div>

        <ChecklistPanel check={mandatoryCheck} isAr={isAr} />
      </div>

      <div className="bg-white rounded-xl border border-sand/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-charcoal">{isAr ? 'المشاهد' : 'Scenes'}</h2>
          <Button
            variant="secondary"
            onClick={addScene}
            disabled={draft.scenes.length >= MAX_SCENES}
            className="py-1.5 px-3 text-xs"
          >
            <Plus size={14} />
            {isAr ? 'إضافة مشهد' : 'Add scene'}
          </Button>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={draft.scenes.map((s) => String(s.number))} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {draft.scenes.map((s, i) => (
                <SceneRow
                  key={s.number}
                  idx={i}
                  scene={s}
                  isAr={isAr}
                  onUpdate={(patch) => updateScene(i, patch)}
                  onRemove={() => removeScene(i)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {draft.scenes.length === 0 && (
          <p className="text-sm text-charcoal/50 text-center py-6">
            {isAr ? 'لا توجد مشاهد بعد — أضف المشهد الأول.' : 'No scenes yet — add your first scene.'}
          </p>
        )}
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

function SceneRow({
  idx,
  scene,
  isAr,
  onUpdate,
  onRemove,
}: {
  idx: number;
  scene: ReelScene;
  isAr: boolean;
  onUpdate: (patch: Partial<ReelScene>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: String(scene.number),
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex gap-3 bg-cream/30 rounded-lg p-3 border border-sand/50"
    >
      <button
        className="text-charcoal/40 hover:text-charcoal cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={18} />
      </button>
      <div className="flex-1 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-charcoal/60">
            {isAr ? `المشهد ${idx + 1}` : `Scene ${idx + 1}`}
          </span>
          <button onClick={onRemove} className="text-charcoal/40 hover:text-red-600">
            <Trash2 size={14} />
          </button>
        </div>
        <input
          value={scene.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder={isAr ? 'وصف المشهد (ما يظهر على الشاشة)' : 'Scene description (what is shown)'}
          className="w-full rounded-md border border-sand/50 bg-white px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-copper/40"
        />
        <textarea
          value={scene.text}
          onChange={(e) => onUpdate({ text: e.target.value })}
          placeholder={isAr ? 'النص المنطوق / المكتوب' : 'Voiceover / on-screen text'}
          rows={2}
          className="w-full rounded-md border border-sand/50 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-copper/40"
        />
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

function ChecklistPanel({
  check,
  isAr,
}: {
  check: { location: boolean; price: boolean; area: boolean; unit: boolean };
  isAr: boolean;
}) {
  const items = [
    { key: 'location', label: isAr ? 'الموقع' : 'Location', ok: check.location },
    { key: 'price', label: isAr ? 'السعر' : 'Price', ok: check.price },
    { key: 'area', label: isAr ? 'المساحة' : 'Area', ok: check.area },
    { key: 'unit', label: isAr ? 'نوع الوحدة' : 'Unit type', ok: check.unit },
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

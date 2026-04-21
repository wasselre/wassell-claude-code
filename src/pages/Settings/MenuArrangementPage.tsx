/**
 * Menu Arrangement — Settings page for controlling the sidebar layout.
 *
 * What you can do here:
 *   • Drag groups to reorder them.
 *   • Drag a model within a group to reorder it.
 *   • Drag a model between groups (or to/from the "Ungrouped" section).
 *   • Rename a group inline, add a new group, or delete an empty one.
 *
 * Nothing is persisted until you hit Save — all edits live in a local
 * staging copy so you can experiment freely before committing. On Save,
 * the store's `reorderMenu` action writes the final shape to both
 * localStorage and Supabase in one atomic pass.
 */
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import {
  DndContext,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  ChevronLeft,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Folder,
  Save,
  RotateCcw,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { getIconComponent } from '@/components/layout/Sidebar';
import type { AppModel, ModelGroup } from '@/types';

// Sentinel "group id" for the ungrouped bucket. Kept outside the UUID space
// so it never collides with a real group. Rows with this bucket are persisted
// with `group_id: null` on save.
const UNGROUPED_ID = '__ungrouped__';

export default function MenuArrangementPage() {
  const navigate = useNavigate();
  const { language, models, groups, reorderMenu, addToast } = useAppStore();
  const isAr = language === 'ar';

  // Staging state — we operate on copies until the user hits Save.
  const [stagedGroups, setStagedGroups] = useState<ModelGroup[]>(() =>
    sortGroups([...groups]),
  );
  const [stagedModels, setStagedModels] = useState<AppModel[]>(() =>
    sortModels([...models]),
  );
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingLabelAr, setEditingLabelAr] = useState('');
  const [editingLabelEn, setEditingLabelEn] = useState('');
  const [saving, setSaving] = useState(false);

  // Re-sync staged copies when the underlying store changes from outside
  // (e.g. another browser saved first). Safe because this page is a pure
  // staging area — any unsaved local edits are lost on external change,
  // which is the right behavior for a settings screen.
  useEffect(() => {
    setStagedGroups(sortGroups([...groups]));
    setStagedModels(sortModels([...models]));
  }, [groups, models]);

  // Group models by their bucket id (real group id or the ungrouped sentinel).
  const modelsByBucket = useMemo(() => {
    const map = new Map<string, AppModel[]>();
    map.set(UNGROUPED_ID, []);
    for (const g of stagedGroups) map.set(g.id, []);
    for (const m of stagedModels) {
      const key = m.group_id ?? UNGROUPED_ID;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return map;
  }, [stagedGroups, stagedModels]);

  // Buckets rendered in display order: Ungrouped first (always visible so
  // you can drop models out of a group), then groups by `order`.
  const buckets: Array<{ id: string; group: ModelGroup | null }> = [
    { id: UNGROUPED_ID, group: null },
    ...stagedGroups.map((g) => ({ id: g.id, group: g })),
  ];

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require a small movement before drag kicks in so clicks on edit
      // buttons don't trigger accidental drags.
      activationConstraint: { distance: 5 },
    }),
  );

  const [activeKind, setActiveKind] = useState<'group' | 'model' | null>(null);

  const handleDragStart = (e: DragStartEvent): void => {
    const id = String(e.active.id);
    if (id.startsWith('group:')) setActiveKind('group');
    else if (id.startsWith('model:')) setActiveKind('model');
  };

  const handleDragEnd = (e: DragEndEvent): void => {
    setActiveKind(null);
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    // Group reorder path.
    if (activeId.startsWith('group:') && overId.startsWith('group:')) {
      const a = activeId.slice(6);
      const b = overId.slice(6);
      const oldIndex = stagedGroups.findIndex((g) => g.id === a);
      const newIndex = stagedGroups.findIndex((g) => g.id === b);
      if (oldIndex < 0 || newIndex < 0) return;
      setStagedGroups(arrayMove(stagedGroups, oldIndex, newIndex));
      return;
    }

    // Model drag — figure out the source and destination buckets.
    if (activeId.startsWith('model:')) {
      const modelId = activeId.slice(6);
      const model = stagedModels.find((m) => m.id === modelId);
      if (!model) return;

      // `over` can be either another model (drop on top of it) or a bucket
      // header (drop into an empty bucket or at its start).
      let destBucket: string;
      let destIndexInBucket: number;
      if (overId.startsWith('model:')) {
        const overModel = stagedModels.find((m) => m.id === overId.slice(6));
        if (!overModel) return;
        destBucket = overModel.group_id ?? UNGROUPED_ID;
        const bucketModels = (modelsByBucket.get(destBucket) ?? []).filter(
          (m) => m.id !== modelId,
        );
        destIndexInBucket = bucketModels.findIndex((m) => m.id === overModel.id);
        if (destIndexInBucket < 0) destIndexInBucket = bucketModels.length;
      } else if (overId.startsWith('bucket:')) {
        destBucket = overId.slice(7);
        destIndexInBucket = (modelsByBucket.get(destBucket) ?? []).filter((m) => m.id !== modelId).length;
      } else {
        return;
      }

      // Commit the move in the flat models array while preserving the
      // relative order inside each bucket.
      const movedModel: AppModel = {
        ...model,
        group_id: destBucket === UNGROUPED_ID ? null : destBucket,
      };

      // Rebuild the full models array: for each bucket, take its current
      // models (minus the moved one if it was there), and when we hit the
      // destination bucket, splice the moved model at the right position.
      const next: AppModel[] = [];
      for (const bucket of buckets) {
        const inThisBucket = (modelsByBucket.get(bucket.id) ?? []).filter(
          (m) => m.id !== modelId,
        );
        if (bucket.id === destBucket) {
          inThisBucket.splice(destIndexInBucket, 0, movedModel);
        }
        next.push(...inThisBucket);
      }
      setStagedModels(next);
    }
  };

  const addGroup = (): void => {
    const defaultAr = 'مجموعة جديدة';
    const defaultEn = 'New Group';
    const newGroup: ModelGroup = {
      id: uuid(),
      label_ar: defaultAr,
      label_en: defaultEn,
      order: stagedGroups.length,
    };
    setStagedGroups([...stagedGroups, newGroup]);
    // Drop the user straight into inline edit for the new group.
    setEditingGroupId(newGroup.id);
    setEditingLabelAr(defaultAr);
    setEditingLabelEn(defaultEn);
  };

  const startEditGroup = (g: ModelGroup): void => {
    setEditingGroupId(g.id);
    setEditingLabelAr(g.label_ar);
    setEditingLabelEn(g.label_en);
  };

  const commitEditGroup = (): void => {
    if (!editingGroupId) return;
    if (!editingLabelAr.trim() && !editingLabelEn.trim()) {
      // Refuse to save both-empty names.
      return;
    }
    setStagedGroups(
      stagedGroups.map((g) =>
        g.id === editingGroupId
          ? { ...g, label_ar: editingLabelAr.trim() || g.label_ar, label_en: editingLabelEn.trim() || g.label_en }
          : g,
      ),
    );
    setEditingGroupId(null);
  };

  const cancelEditGroup = (): void => {
    setEditingGroupId(null);
  };

  const deleteGroup = (groupId: string): void => {
    // Models in this group become ungrouped.
    const orphaned = stagedModels.map((m) =>
      m.group_id === groupId ? { ...m, group_id: null } : m,
    );
    setStagedGroups(stagedGroups.filter((g) => g.id !== groupId));
    setStagedModels(orphaned);
  };

  const resetStaging = (): void => {
    setStagedGroups(sortGroups([...groups]));
    setStagedModels(sortModels([...models]));
    setEditingGroupId(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      reorderMenu(stagedModels, stagedGroups);
      addToast(isAr ? 'تم حفظ ترتيب القائمة' : 'Menu order saved', 'success');
    } finally {
      setSaving(false);
    }
  };

  // Detect unsaved changes so we can enable/disable the Save button.
  const hasChanges = useMemo(() => {
    if (stagedGroups.length !== groups.length) return true;
    if (stagedModels.length !== models.length) return true;
    for (let i = 0; i < stagedGroups.length; i++) {
      const a = stagedGroups[i];
      const b = groups.find((g) => g.id === a!.id);
      if (!b || a!.order !== b.order || a!.label_ar !== b.label_ar || a!.label_en !== b.label_en) return true;
    }
    // Track each model's current bucket + its index in that bucket — changes
    // mean the user has dragged something.
    const origByBucket = new Map<string, string[]>();
    for (const m of sortModels([...models])) {
      const key = m.group_id ?? UNGROUPED_ID;
      if (!origByBucket.has(key)) origByBucket.set(key, []);
      origByBucket.get(key)!.push(m.id);
    }
    const stagedByBucket = new Map<string, string[]>();
    for (const m of stagedModels) {
      const key = m.group_id ?? UNGROUPED_ID;
      if (!stagedByBucket.has(key)) stagedByBucket.set(key, []);
      stagedByBucket.get(key)!.push(m.id);
    }
    if (origByBucket.size !== stagedByBucket.size) return true;
    for (const [k, v] of stagedByBucket) {
      const orig = origByBucket.get(k);
      if (!orig || orig.length !== v.length) return true;
      for (let i = 0; i < v.length; i++) if (v[i] !== orig[i]) return true;
    }
    return false;
  }, [stagedGroups, stagedModels, groups, models]);

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/settings')}
            className="p-2 rounded-lg hover:bg-cream text-charcoal/50 hover:text-charcoal transition-colors"
            aria-label={isAr ? 'عودة' : 'Back'}
          >
            <ChevronLeft size={18} className={isAr ? 'rotate-180' : ''} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">
              {isAr ? 'ترتيب القائمة' : 'Menu Arrangement'}
            </h1>
            <p className="text-sm text-charcoal/40">
              {isAr
                ? 'اسحب لإعادة ترتيب المجموعات والنماذج في القائمة الجانبية'
                : 'Drag to reorder groups and models in the sidebar'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            onClick={resetStaging}
            disabled={!hasChanges || saving}
            className="!px-3"
          >
            <RotateCcw size={15} />
            {isAr ? 'تراجع' : 'Reset'}
          </Button>
          <Button onClick={() => void save()} disabled={!hasChanges || saving}>
            <Save size={15} />
            {saving ? (isAr ? 'جاري الحفظ...' : 'Saving...') : (isAr ? 'حفظ' : 'Save')}
          </Button>
        </div>
      </div>

      {/* Add group button */}
      <div className="mb-3 flex justify-end">
        <button
          onClick={addGroup}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-copper/10 text-copper hover:bg-copper/15 text-sm font-bold transition-colors"
        >
          <Plus size={14} />
          {isAr ? 'مجموعة جديدة' : 'New group'}
        </button>
      </div>

      {/* Drag area */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {/* Buckets — ungrouped first, then groups in order */}
        <SortableContext
          items={stagedGroups.map((g) => `group:${g.id}`)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {buckets.map((b) => (
              <BucketCard
                key={b.id}
                bucketId={b.id}
                group={b.group}
                models={modelsByBucket.get(b.id) ?? []}
                isAr={isAr}
                editingGroupId={editingGroupId}
                editingLabelAr={editingLabelAr}
                editingLabelEn={editingLabelEn}
                setEditingLabelAr={setEditingLabelAr}
                setEditingLabelEn={setEditingLabelEn}
                onStartEdit={startEditGroup}
                onCommitEdit={commitEditGroup}
                onCancelEdit={cancelEditGroup}
                onDeleteGroup={deleteGroup}
                activeKind={activeKind}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Hint for empty state */}
      {stagedGroups.length === 0 && stagedModels.length === 0 && (
        <div className="text-center text-sm text-charcoal/40 py-12">
          {isAr
            ? 'لا توجد نماذج بعد. أنشئ نموذجاً من زر "+ نموذج جديد".'
            : 'No models yet. Create one from the "+ New model" button.'}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Bucket card — one per group (plus one synthetic one for ungrouped)
// ────────────────────────────────────────────────────────────────────

interface BucketCardProps {
  bucketId: string;
  group: ModelGroup | null;
  models: AppModel[];
  isAr: boolean;
  editingGroupId: string | null;
  editingLabelAr: string;
  editingLabelEn: string;
  setEditingLabelAr: (v: string) => void;
  setEditingLabelEn: (v: string) => void;
  onStartEdit: (g: ModelGroup) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDeleteGroup: (id: string) => void;
  activeKind: 'group' | 'model' | null;
}

function BucketCard({
  bucketId,
  group,
  models,
  isAr,
  editingGroupId,
  editingLabelAr,
  editingLabelEn,
  setEditingLabelAr,
  setEditingLabelEn,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDeleteGroup,
  activeKind,
}: BucketCardProps) {
  // Groups are themselves sortable; the ungrouped bucket is fixed at top.
  const sortable = useSortable({
    id: `group:${bucketId}`,
    disabled: bucketId === UNGROUPED_ID,
  });
  const style = group
    ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
    : {};

  const isEditing = group && editingGroupId === group.id;
  const canDelete = group && models.length === 0;

  return (
    <div
      ref={group ? sortable.setNodeRef : undefined}
      style={style}
      className={`bg-white rounded-2xl border border-sand/20 overflow-hidden ${sortable.isDragging ? 'opacity-60' : ''}`}
    >
      {/* Bucket header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-cream-light/40 border-b border-sand/15">
        {group ? (
          <button
            {...sortable.attributes}
            {...sortable.listeners}
            className="p-1 text-charcoal/30 hover:text-charcoal cursor-grab active:cursor-grabbing"
            aria-label={isAr ? 'اسحب المجموعة' : 'Drag group'}
          >
            <GripVertical size={16} />
          </button>
        ) : (
          <div className="w-[24px]" />
        )}

        {isEditing ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              type="text"
              value={editingLabelAr}
              onChange={(e) => setEditingLabelAr(e.target.value)}
              placeholder={isAr ? 'العربية' : 'Arabic label'}
              dir="rtl"
              className="flex-1 px-2 py-1 rounded-md border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
              autoFocus
            />
            <input
              type="text"
              value={editingLabelEn}
              onChange={(e) => setEditingLabelEn(e.target.value)}
              placeholder="English label"
              dir="ltr"
              className="flex-1 px-2 py-1 rounded-md border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
            <button
              onClick={onCommitEdit}
              className="p-1 rounded text-green-600 hover:bg-green-50"
              aria-label="Save"
            >
              <Check size={16} />
            </button>
            <button
              onClick={onCancelEdit}
              className="p-1 rounded text-charcoal/50 hover:bg-cream"
              aria-label="Cancel"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <>
            <Folder size={14} className={group ? 'text-charcoal/50' : 'text-charcoal/25'} />
            <div className="flex-1 font-bold text-sm text-charcoal">
              {group
                ? (isAr ? group.label_ar : group.label_en)
                : (isAr ? 'بدون مجموعة' : 'Ungrouped')}
            </div>
            <span className="text-xs text-charcoal/30">
              {models.length} {isAr ? (models.length === 1 ? 'نموذج' : 'نماذج') : (models.length === 1 ? 'model' : 'models')}
            </span>
            {group && (
              <>
                <button
                  onClick={() => onStartEdit(group)}
                  className="p-1 rounded text-charcoal/40 hover:bg-cream hover:text-charcoal transition-colors"
                  aria-label={isAr ? 'تعديل' : 'Rename'}
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => canDelete && onDeleteGroup(group.id)}
                  disabled={!canDelete}
                  title={
                    !canDelete
                      ? isAr
                        ? 'انقل النماذج أولاً قبل حذف المجموعة'
                        : 'Move models out first before deleting'
                      : undefined
                  }
                  className="p-1 rounded text-charcoal/40 hover:bg-red-50 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-charcoal/40"
                  aria-label={isAr ? 'حذف' : 'Delete'}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Model list */}
      <SortableContext
        items={models.map((m) => `model:${m.id}`)}
        strategy={verticalListSortingStrategy}
      >
        <div
          data-bucket={bucketId}
          id={`bucket:${bucketId}`}
          className="p-2 min-h-[52px]"
        >
          {models.length === 0 ? (
            <DroppableEmptyBucket bucketId={bucketId} isAr={isAr} highlight={activeKind === 'model'} />
          ) : (
            <div className="space-y-1">
              {models.map((m) => (
                <ModelRow key={m.id} model={m} isAr={isAr} />
              ))}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Droppable empty-bucket placeholder
// ────────────────────────────────────────────────────────────────────

function DroppableEmptyBucket({ bucketId, isAr, highlight }: { bucketId: string; isAr: boolean; highlight: boolean }) {
  // Registering as a sortable item with a stable bucket id lets the dnd-kit
  // collision detection pick "drop on empty bucket" as a target. We don't
  // render a drag handle because users aren't moving this row itself.
  const sortable = useSortable({ id: `bucket:${bucketId}` });
  return (
    <div
      ref={sortable.setNodeRef}
      className={`text-center text-xs rounded-lg border-2 border-dashed py-4 transition-colors ${
        highlight ? 'border-copper/40 bg-copper/5 text-copper' : 'border-sand/30 text-charcoal/30'
      }`}
    >
      {isAr ? 'اسحب نموذجاً هنا' : 'Drop a model here'}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Single model row — draggable
// ────────────────────────────────────────────────────────────────────

function ModelRow({ model, isAr }: { model: AppModel; isAr: boolean }) {
  const sortable = useSortable({ id: `model:${model.id}` });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const Icon = getIconComponent(model.icon);

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-2 py-2 rounded-lg bg-white border border-sand/15 ${sortable.isDragging ? 'opacity-60 shadow-lg' : ''}`}
    >
      <button
        {...sortable.attributes}
        {...sortable.listeners}
        className="p-1 text-charcoal/25 hover:text-charcoal cursor-grab active:cursor-grabbing"
        aria-label={isAr ? 'اسحب النموذج' : 'Drag model'}
      >
        <GripVertical size={14} />
      </button>
      <div
        className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${model.color}14` }}
      >
        <Icon size={13} style={{ color: model.color }} />
      </div>
      <div className="flex-1 text-sm text-charcoal truncate">
        {isAr ? model.label_ar : model.label_en}
      </div>
      {model.is_system && (
        <span className="text-[10px] text-charcoal/30 uppercase tracking-wider">
          {isAr ? 'نظام' : 'system'}
        </span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sort helpers
// ────────────────────────────────────────────────────────────────────

function sortGroups(gs: ModelGroup[]): ModelGroup[] {
  return gs.slice().sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : gs.indexOf(a);
    const bo = typeof b.order === 'number' ? b.order : gs.indexOf(b);
    return ao - bo;
  });
}

function sortModels(ms: AppModel[]): AppModel[] {
  // Preserves bucket groupings by sorting within bucket only; the caller
  // uses `modelsByBucket` to render buckets, so the global order just needs
  // to put same-bucket items together with their `order` respected.
  const bucketOf = (m: AppModel): string => m.group_id ?? UNGROUPED_ID;
  const bucketOrder = new Map<string, number>();
  ms.forEach((m, i) => {
    if (!bucketOrder.has(bucketOf(m))) bucketOrder.set(bucketOf(m), i);
  });
  return ms.slice().sort((a, b) => {
    const ab = bucketOrder.get(bucketOf(a)) ?? 0;
    const bb = bucketOrder.get(bucketOf(b)) ?? 0;
    if (ab !== bb) return ab - bb;
    const ao = typeof a.order === 'number' ? a.order : ms.indexOf(a);
    const bo = typeof b.order === 'number' ? b.order : ms.indexOf(b);
    return ao - bo;
  });
}

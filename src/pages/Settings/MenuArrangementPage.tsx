/**
 * Menu Arrangement — Settings page for controlling the sidebar layout.
 *
 * What you can do here:
 *   • Use the ↑ / ↓ buttons on a group header to move it up or down.
 *   • Use the ↑ / ↓ buttons on a model row to move it within its group.
 *   • Use the "Group" dropdown on each model to move it to another group
 *     (or to the Ungrouped bucket).
 *   • Rename a group inline, add a new group, or delete an empty one.
 *
 * Nothing is persisted until you hit Save — all edits live in a local
 * staging copy so you can experiment freely before committing. On Save,
 * the store's `reorderMenu` action writes the final shape to both
 * localStorage and Supabase in one atomic pass.
 */
import { useState, useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Folder,
  Save,
  RotateCcw,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { getIconComponent } from '@/components/layout/Sidebar';
import BackToSettings from './components/BackToSettings';
import type { AppModel, ModelGroup } from '@/types';

// Sentinel "group id" for the ungrouped bucket. Kept outside the UUID space
// so it never collides with a real group. Rows with this bucket are persisted
// with `group_id: null` on save.
const UNGROUPED_ID = '__ungrouped__';

export default function MenuArrangementPage() {
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
  // you can move models out of a group), then groups by `order`.
  const buckets: Array<{ id: string; group: ModelGroup | null }> = [
    { id: UNGROUPED_ID, group: null },
    ...stagedGroups.map((g) => ({ id: g.id, group: g })),
  ];

  // ────────────── Group reorder (up/down) ──────────────
  const moveGroup = (groupId: string, direction: -1 | 1): void => {
    const i = stagedGroups.findIndex((g) => g.id === groupId);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= stagedGroups.length) return;
    const next = [...stagedGroups];
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
    setStagedGroups(next);
  };

  // ────────────── Model reorder within its bucket ──────────────
  const moveModel = (modelId: string, direction: -1 | 1): void => {
    const model = stagedModels.find((m) => m.id === modelId);
    if (!model) return;
    const bucketId = model.group_id ?? UNGROUPED_ID;
    const bucketModels = modelsByBucket.get(bucketId) ?? [];
    const i = bucketModels.findIndex((m) => m.id === modelId);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= bucketModels.length) return;

    // Swap adjacent items inside the bucket, then rebuild the flat array
    // so `stagedModels` stays grouped bucket-by-bucket.
    const nextBucket = [...bucketModels];
    const tmp = nextBucket[i]!;
    nextBucket[i] = nextBucket[j]!;
    nextBucket[j] = tmp;

    const rebuild: AppModel[] = [];
    for (const b of buckets) {
      if (b.id === bucketId) {
        rebuild.push(...nextBucket);
      } else {
        rebuild.push(...(modelsByBucket.get(b.id) ?? []));
      }
    }
    setStagedModels(rebuild);
  };

  // ────────────── Move model to a different bucket ──────────────
  const changeModelBucket = (modelId: string, destBucket: string): void => {
    const model = stagedModels.find((m) => m.id === modelId);
    if (!model) return;
    const currentBucket = model.group_id ?? UNGROUPED_ID;
    if (currentBucket === destBucket) return;

    const movedModel: AppModel = {
      ...model,
      group_id: destBucket === UNGROUPED_ID ? null : destBucket,
    };

    // Rebuild the flat models array: pull the moved model out of its old
    // bucket and push it at the end of the destination bucket.
    const rebuild: AppModel[] = [];
    for (const b of buckets) {
      const inBucket = (modelsByBucket.get(b.id) ?? []).filter(
        (m) => m.id !== modelId,
      );
      if (b.id === destBucket) {
        inBucket.push(movedModel);
      }
      rebuild.push(...inBucket);
    }
    setStagedModels(rebuild);
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
          ? {
              ...g,
              label_ar: editingLabelAr.trim() || g.label_ar,
              label_en: editingLabelEn.trim() || g.label_en,
            }
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
    // Compare group reorder by array position against the original sorted
    // order. The `order` field itself doesn't get rewritten until save, so
    // we can't rely on it to detect in-progress reorders.
    const origGroupOrder = sortGroups([...groups]);
    for (let i = 0; i < stagedGroups.length; i++) {
      const a = stagedGroups[i]!;
      const origAtSameIndex = origGroupOrder[i];
      if (!origAtSameIndex || a.id !== origAtSameIndex.id) return true;
      const origById = groups.find((g) => g.id === a.id);
      if (!origById || a.label_ar !== origById.label_ar || a.label_en !== origById.label_en) {
        return true;
      }
    }
    // Track each model's current bucket + its index in that bucket — changes
    // mean the user has moved something.
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

  // Dropdown options for "move this model to group ___".
  const bucketOptions = [
    {
      value: UNGROUPED_ID,
      label: isAr ? 'بدون مجموعة' : 'Ungrouped',
    },
    ...stagedGroups.map((g) => ({
      value: g.id,
      label: isAr ? g.label_ar : g.label_en,
    })),
  ];

  return (
    <div className="max-w-3xl">
      <BackToSettings />
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-3">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold text-chocolate">
              {isAr ? 'ترتيب القائمة' : 'Menu Arrangement'}
            </h1>
            <p className="text-sm text-charcoal/40">
              {isAr
                ? 'استخدم الأسهم لإعادة الترتيب، واختر المجموعة من القائمة المنسدلة لنقل النموذج'
                : 'Use the arrows to reorder, and the dropdown to move a model to another group'}
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
            {saving
              ? isAr
                ? 'جاري الحفظ...'
                : 'Saving...'
              : isAr
                ? 'حفظ'
                : 'Save'}
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

      {/* Buckets — ungrouped first, then groups in order */}
      <div className="space-y-3">
        {buckets.map((b) => {
          const isUngrouped = b.id === UNGROUPED_ID;
          const groupIndex = isUngrouped
            ? -1
            : stagedGroups.findIndex((g) => g.id === b.id);
          const canMoveGroupUp = !isUngrouped && groupIndex > 0;
          const canMoveGroupDown =
            !isUngrouped && groupIndex < stagedGroups.length - 1;
          const bucketModels = modelsByBucket.get(b.id) ?? [];

          return (
            <BucketCard
              key={b.id}
              bucketId={b.id}
              group={b.group}
              models={bucketModels}
              bucketOptions={bucketOptions}
              isAr={isAr}
              canMoveGroupUp={canMoveGroupUp}
              canMoveGroupDown={canMoveGroupDown}
              onMoveGroup={moveGroup}
              onMoveModel={moveModel}
              onChangeModelBucket={changeModelBucket}
              editingGroupId={editingGroupId}
              editingLabelAr={editingLabelAr}
              editingLabelEn={editingLabelEn}
              setEditingLabelAr={setEditingLabelAr}
              setEditingLabelEn={setEditingLabelEn}
              onStartEdit={startEditGroup}
              onCommitEdit={commitEditGroup}
              onCancelEdit={cancelEditGroup}
              onDeleteGroup={deleteGroup}
            />
          );
        })}
      </div>

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

interface BucketOption {
  value: string;
  label: string;
}

interface BucketCardProps {
  bucketId: string;
  group: ModelGroup | null;
  models: AppModel[];
  bucketOptions: BucketOption[];
  isAr: boolean;
  canMoveGroupUp: boolean;
  canMoveGroupDown: boolean;
  onMoveGroup: (groupId: string, direction: -1 | 1) => void;
  onMoveModel: (modelId: string, direction: -1 | 1) => void;
  onChangeModelBucket: (modelId: string, destBucket: string) => void;
  editingGroupId: string | null;
  editingLabelAr: string;
  editingLabelEn: string;
  setEditingLabelAr: (v: string) => void;
  setEditingLabelEn: (v: string) => void;
  onStartEdit: (g: ModelGroup) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDeleteGroup: (id: string) => void;
}

function BucketCard({
  bucketId,
  group,
  models,
  bucketOptions,
  isAr,
  canMoveGroupUp,
  canMoveGroupDown,
  onMoveGroup,
  onMoveModel,
  onChangeModelBucket,
  editingGroupId,
  editingLabelAr,
  editingLabelEn,
  setEditingLabelAr,
  setEditingLabelEn,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDeleteGroup,
}: BucketCardProps) {
  const isEditing = group && editingGroupId === group.id;
  const canDelete = group && models.length === 0;

  return (
    <div className="bg-white rounded-2xl border border-sand/20 overflow-hidden">
      {/* Bucket header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-cream-light/40 border-b border-sand/15">
        {/* Group up/down arrows (hidden for the synthetic Ungrouped bucket) */}
        {group ? (
          <div className="flex flex-col -gap-0.5">
            <button
              onClick={() => onMoveGroup(group.id, -1)}
              disabled={!canMoveGroupUp}
              className="p-0.5 text-charcoal/40 hover:text-charcoal disabled:opacity-25 disabled:cursor-not-allowed"
              aria-label={isAr ? 'نقل المجموعة للأعلى' : 'Move group up'}
              title={isAr ? 'للأعلى' : 'Up'}
            >
              <ArrowUp size={14} />
            </button>
            <button
              onClick={() => onMoveGroup(group.id, 1)}
              disabled={!canMoveGroupDown}
              className="p-0.5 text-charcoal/40 hover:text-charcoal disabled:opacity-25 disabled:cursor-not-allowed"
              aria-label={isAr ? 'نقل المجموعة للأسفل' : 'Move group down'}
              title={isAr ? 'للأسفل' : 'Down'}
            >
              <ArrowDown size={14} />
            </button>
          </div>
        ) : (
          <div className="w-[20px]" />
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
            <Folder
              size={14}
              className={group ? 'text-charcoal/50' : 'text-charcoal/25'}
            />
            <div className="flex-1 font-bold text-sm text-charcoal">
              {group
                ? isAr
                  ? group.label_ar
                  : group.label_en
                : isAr
                  ? 'بدون مجموعة'
                  : 'Ungrouped'}
            </div>
            <span className="text-xs text-charcoal/30">
              {models.length}{' '}
              {isAr
                ? models.length === 1
                  ? 'نموذج'
                  : 'نماذج'
                : models.length === 1
                  ? 'model'
                  : 'models'}
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
      <div className="p-2 min-h-[52px]">
        {models.length === 0 ? (
          <div className="text-center text-xs rounded-lg border-2 border-dashed border-sand/30 text-charcoal/30 py-4">
            {isAr
              ? 'لا توجد نماذج في هذه المجموعة'
              : 'No models in this group'}
          </div>
        ) : (
          <div className="space-y-1">
            {models.map((m, idx) => (
              <ModelRow
                key={m.id}
                model={m}
                isAr={isAr}
                bucketOptions={bucketOptions}
                currentBucketId={bucketId}
                canMoveUp={idx > 0}
                canMoveDown={idx < models.length - 1}
                onMoveModel={onMoveModel}
                onChangeModelBucket={onChangeModelBucket}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Single model row — no drag; uses up/down buttons + group dropdown
// ────────────────────────────────────────────────────────────────────

interface ModelRowProps {
  model: AppModel;
  isAr: boolean;
  bucketOptions: BucketOption[];
  currentBucketId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveModel: (modelId: string, direction: -1 | 1) => void;
  onChangeModelBucket: (modelId: string, destBucket: string) => void;
}

function ModelRow({
  model,
  isAr,
  bucketOptions,
  currentBucketId,
  canMoveUp,
  canMoveDown,
  onMoveModel,
  onChangeModelBucket,
}: ModelRowProps) {
  const Icon = getIconComponent(model.icon);

  return (
    <div className="flex items-center gap-2 px-2 py-2 rounded-lg bg-white border border-sand/15">
      {/* Up/down arrows for position within this bucket */}
      <div className="flex flex-col -gap-0.5 shrink-0">
        <button
          onClick={() => onMoveModel(model.id, -1)}
          disabled={!canMoveUp}
          className="p-0.5 text-charcoal/30 hover:text-charcoal disabled:opacity-25 disabled:cursor-not-allowed"
          aria-label={isAr ? 'للأعلى' : 'Move up'}
          title={isAr ? 'للأعلى' : 'Up'}
        >
          <ArrowUp size={13} />
        </button>
        <button
          onClick={() => onMoveModel(model.id, 1)}
          disabled={!canMoveDown}
          className="p-0.5 text-charcoal/30 hover:text-charcoal disabled:opacity-25 disabled:cursor-not-allowed"
          aria-label={isAr ? 'للأسفل' : 'Move down'}
          title={isAr ? 'للأسفل' : 'Down'}
        >
          <ArrowDown size={13} />
        </button>
      </div>

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
        <span className="text-[10px] text-charcoal/30 uppercase tracking-wider shrink-0">
          {isAr ? 'نظام' : 'system'}
        </span>
      )}

      {/* Group dropdown — picks the destination bucket */}
      <select
        value={currentBucketId}
        onChange={(e) => onChangeModelBucket(model.id, e.target.value)}
        className="text-xs px-2 py-1 rounded-md border border-sand/40 bg-white text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30 shrink-0 max-w-[140px]"
        dir={isAr ? 'rtl' : 'ltr'}
        aria-label={isAr ? 'المجموعة' : 'Group'}
      >
        {bucketOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
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

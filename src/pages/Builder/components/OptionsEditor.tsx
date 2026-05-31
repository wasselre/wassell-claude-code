import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { v4 as uuid } from 'uuid';
import { GripVertical, Trash2, Plus, ChevronDown, ChevronRight, FolderPlus, Folder, Pencil, Lock, Check, List, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { slugify } from '@/lib/autoTranslate';
import { translateLabel, type TranslatedLabel } from '@/lib/translateLabel';
import { useDebouncedTranslation } from '@/hooks/useDebouncedTranslation';
import Modal from '@/components/ui/Modal';
import type { FieldOption, FieldOptionGroup } from '@/types';

const OPTION_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899',
  '#14B8A6', '#F97316', '#6366F1', '#6B7280', '#B8734F', '#C09B5F',
];

interface OptionsEditorProps {
  options: FieldOption[];
  groups: FieldOptionGroup[];
  onChange: (options: FieldOption[]) => void;
  onGroupsChange: (groups: FieldOptionGroup[]) => void;
  /**
   * When true, options with `is_section_option: true` render as locked rows —
   * read-only label, no color/group pickers, no delete. Used by the builder
   * for `section_selector` fields where section-linked options are managed
   * automatically from the model's sections.
   */
  lockSectionOptions?: boolean;
  /** Heading rendered above the editor. Defaults to the translated "Options" label. */
  label?: string;
  /** Optional hint rendered below the heading. */
  hint?: string;
}

/**
 * Compact group picker — a small folder-icon button that opens a popover.
 * Replaces a native <select> because the select's minimum width would squeeze
 * the neighbouring label input in the narrow Field Properties panel.
 * When the option is ungrouped, only the folder icon shows; when grouped, the
 * current group name renders next to the icon, truncated.
 */
function GroupPickerButton({
  groups,
  currentGroupId,
  onChange,
}: {
  groups: FieldOptionGroup[];
  currentGroupId?: string;
  onChange: (groupId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const current = groups.find((g) => g.id === currentGroupId);
  const grouped = !!current;
  // Icon-only button — the row's visual position under a group header already
  // tells the user which group this option belongs to. A pill with the group
  // name would squeeze the label input in narrow side panels.
  const titleText = grouped
    ? `${t('fields.option_group')}: ${isAr ? current.label_ar : current.label_en}`
    : t('fields.option_group');

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`p-1 rounded transition-colors ${
          grouped
            ? 'text-copper bg-copper/5 hover:bg-copper/10'
            : 'text-charcoal/30 hover:text-copper hover:bg-copper/5'
        }`}
        title={titleText}
      >
        <Folder size={12} />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 end-0 min-w-[140px] max-w-[200px] bg-white rounded-lg border border-sand shadow-lg py-1 animate-[fadeIn_0.1s_ease]">
          <button
            type="button"
            onClick={() => { onChange(undefined); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-start hover:bg-cream transition-colors ${
              !grouped ? 'text-copper bg-copper/5' : 'text-charcoal/60'
            }`}
          >
            {!grouped ? <Check size={11} className="shrink-0" /> : <span className="w-[11px] shrink-0" />}
            <span className="truncate">{t('fields.option_group_none')}</span>
          </button>
          <div className="my-1 border-t border-sand/20" />
          {groups.map((g) => {
            const selected = g.id === currentGroupId;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => { onChange(g.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-start hover:bg-cream transition-colors ${
                  selected ? 'text-copper bg-copper/5' : 'text-charcoal/70'
                }`}
              >
                {selected ? <Check size={11} className="shrink-0" /> : <span className="w-[11px] shrink-0" />}
                <span className="truncate">{isAr ? g.label_ar : g.label_en}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  option,
  groups,
  onUpdate,
  onDelete,
  locked,
}: {
  option: FieldOption;
  groups: FieldOptionGroup[];
  onUpdate: (updates: Partial<FieldOption>) => void;
  onDelete: () => void;
  locked?: boolean;
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
    disabled: !!locked,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // Which label the user is actively editing — drives the live-translation
  // source so we translate FROM the language being typed and fill the other.
  // null until the user touches a label, so simply opening the editor on an
  // existing option never kicks off a translation (and never rewrites a slug).
  const [editingLang, setEditingLang] = useState<'ar' | 'en' | null>(null);

  // A bare UUID (or empty) is machine-junk, never a deliberate api_name — e.g.
  // an orphaned section_selector option still carrying its old section id.
  // Those are eligible for auto-derivation; a real slug (snake_case, or even an
  // Arabic inline slug a user/record already relies on) is left alone.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isAutoFillableValue = (v?: string) => {
    const trimmed = (v ?? '').trim();
    return !trimmed || UUID_RE.test(trimmed);
  };

  // Sticky once the slug is a deliberate value: don't let live translation
  // overwrite it. Mirrors FieldEditor, which never auto-rewrites an existing
  // field's api_name. A manual edit to the api_name input also pins it.
  const [slugTouched, setSlugTouched] = useState(() => !isAutoFillableValue(option.value));

  // Live, debounced translation of whichever label is being edited — the same
  // flow FieldEditor uses for field api_names, so an option gets an English-
  // derived slug as you type instead of being left with a raw id.
  const source =
    editingLang === 'ar' ? (option.label_ar ?? '') :
    editingLang === 'en' ? (option.label_en ?? '') : '';
  // Only translate when something is actually fillable — a missing label or a
  // not-yet-pinned slug. A complete option (both labels + a real slug) skips
  // the network entirely when its label is edited, like FieldEditor disables
  // translation for already-saved fields.
  const needsFill =
    !(option.label_ar ?? '').trim() ||
    !(option.label_en ?? '').trim() ||
    (!slugTouched && isAutoFillableValue(option.value));
  const translation = useDebouncedTranslation(source, {
    kind: 'option',
    enabled: !locked && needsFill,
  });

  // Always reach the freshest onUpdate from the result effect — the parent
  // passes a new closure each render and a stale one could write against an
  // outdated options array.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // Fill the opposite-language label (when empty) and the api_name slug (unless
  // pinned) from a resolved translation.
  const applyTranslation = (out: TranslatedLabel) => {
    const patch: Partial<FieldOption> = {};
    if (!(option.label_ar ?? '').trim()) patch.label_ar = out.label_ar;
    if (!(option.label_en ?? '').trim()) patch.label_en = out.label_en;
    if (!slugTouched && out.name) patch.value = out.name;
    if (Object.keys(patch).length > 0) onUpdateRef.current(patch);
  };

  useEffect(() => {
    if (translation.result) applyTranslation(translation.result);
    // Apply once per new translation result. Depending on `option`/`onUpdate`
    // would re-run every keystroke and risk a fill loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translation.result]);

  // While typing, seed the slug instantly from the sync slugify for Latin input
  // (snappy, no network); Arabic input gets its slug from the live translation
  // above once it resolves. Both gated on `!slugTouched` so a deliberate slug
  // is never clobbered mid-edit.
  const handleLabelArChange = (val: string) => {
    setEditingLang('ar');
    const patch: Partial<FieldOption> = { label_ar: val };
    if (!slugTouched && val.trim()) {
      const sync = slugify(val);
      if (sync) patch.value = sync;
    }
    onUpdate(patch);
  };

  const handleLabelEnChange = (val: string) => {
    setEditingLang('en');
    const patch: Partial<FieldOption> = { label_en: val };
    if (!slugTouched && val.trim()) {
      const sync = slugify(val);
      if (sync) patch.value = sync;
    }
    onUpdate(patch);
  };

  // Safety net for fast typers who blur before the debounce settles: force the
  // translation to resolve and apply it. No-op when nothing is missing.
  const handleBlur = async () => {
    if (!source.trim()) return;
    const needsOpposite =
      !(option.label_ar ?? '').trim() || !(option.label_en ?? '').trim();
    const needsSlug = !slugTouched && isAutoFillableValue(option.value);
    if (!needsOpposite && !needsSlug) return;
    if (translation.result) { applyTranslation(translation.result); return; }
    try {
      applyTranslation(await translation.translateNow());
    } catch {
      // Failure is already surfaced as a toast by the hook; keep the typed
      // input so the user can retry without losing it.
    }
  };

  const handleApiNameChange = (raw: string) => {
    setSlugTouched(true);
    onUpdate({ value: slugify(raw) });
  };

  if (locked) {
    return (
      <div ref={setNodeRef} style={style} className="flex items-center gap-2 py-1.5 px-2 opacity-70 border-t border-sand/10 first:border-t-0">
        <span className="text-charcoal/25" title={isAr ? 'خيار مربوط بقسم — يُدار تلقائياً' : 'Section-linked option — managed automatically'}>
          <Lock size={13} />
        </span>
        <div
          className="form-input text-sm py-1.5 flex-1 min-w-0 bg-sand/15 text-charcoal/60 cursor-not-allowed"
          dir={isAr ? 'rtl' : 'ltr'}
        >
          {isAr ? option.label_ar : option.label_en}
        </div>
        <span
          className="w-6 h-6 rounded-full border border-sand/30 shrink-0"
          style={{ backgroundColor: option.color ?? '#6B7280' }}
          title={isAr ? 'لون القسم' : 'Section color'}
        />
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1.5 py-1.5 px-2 border-t border-sand/10 first:border-t-0 hover:bg-sand/5">
      <button {...attributes} {...listeners} className="cursor-grab text-charcoal/15 hover:text-charcoal/40 shrink-0">
        <GripVertical size={14} />
      </button>
      <input
        value={option.label_ar}
        onChange={(e) => handleLabelArChange(e.target.value)}
        onBlur={handleBlur}
        className="form-input text-sm py-1.5 flex-1 min-w-0"
        placeholder="عربي"
        dir="rtl"
      />
      <input
        value={option.label_en}
        onChange={(e) => handleLabelEnChange(e.target.value)}
        onBlur={handleBlur}
        className="form-input text-sm py-1.5 flex-1 min-w-0"
        placeholder="English"
        dir="ltr"
      />
      <div className="relative flex-1 min-w-0">
        <input
          value={option.value}
          onChange={(e) => handleApiNameChange(e.target.value)}
          className="form-input text-xs py-1.5 w-full font-mono text-charcoal/60 pe-6"
          placeholder="api_name"
          dir="ltr"
          title={isAr
            ? 'اسم الخيار داخل النظام — القيمة التي تُحفظ في السجلات ويقارن عليها سير العمل والكود. يُترجم تلقائياً من الاسم أثناء الكتابة. لا تعدّله بعد إنشاء سجلات تستخدم هذا الخيار إلا إذا كنت تعلم ما تفعل.'
            : 'API name — the string stored on records and matched by workflows + code. Auto-translated from the label as you type. Leave it alone after records use this option unless you know what you are doing.'}
        />
        {translation.status === 'pending' && (
          <Loader2
            size={11}
            className="animate-spin text-copper/60 absolute top-1/2 -translate-y-1/2 end-2 pointer-events-none"
          />
        )}
      </div>
      {groups.length > 0 && (
        <GroupPickerButton
          groups={groups}
          currentGroupId={option.group_id}
          onChange={(groupId) => onUpdate({ group_id: groupId })}
        />
      )}
      <ColorPickerButton
        value={option.color ?? '#6B7280'}
        onChange={(c) => onUpdate({ color: c })}
      />
      <button
        onClick={onDelete}
        className="p-1 rounded hover:bg-red-50 text-charcoal/25 hover:text-red-500 shrink-0"
        title={isAr ? 'حذف' : 'Delete'}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

/**
 * Color picker button — renders the selected color as a small circle and
 * opens a grid of swatches on click. Replaces a native `<select>` whose
 * selected value bled the hex string ("#6B") through the circle.
 */
function ColorPickerButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-6 h-6 rounded-full border border-sand/40 hover:scale-110 transition-transform"
        style={{ backgroundColor: value }}
        title={isAr ? 'اللون' : 'Color'}
      />
      {open && (
        <div className="absolute z-30 mt-1 end-0 bg-white rounded-lg border border-sand shadow-lg p-2 grid grid-cols-4 gap-1.5 animate-[fadeIn_0.1s_ease]">
          {OPTION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { onChange(c); setOpen(false); }}
              className={`w-5 h-5 rounded-full transition-transform hover:scale-125 ${
                c === value
                  ? 'ring-2 ring-copper ring-offset-1'
                  : 'border border-sand/30'
              }`}
              style={{ backgroundColor: c }}
              aria-label={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Group header shown above each cluster of options in the editor. Shows the
 * group's label with rename-on-click and a delete button. Collapsing just
 * hides the options visually in the editor; the data itself is untouched.
 */
function GroupHeader({
  group,
  collapsed,
  onToggle,
  onRename,
  onDelete,
}: {
  group: FieldOptionGroup;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(isAr ? group.label_ar : group.label_en);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) onRename(trimmed);
    else setDraft(isAr ? group.label_ar : group.label_en);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1 mt-2 mb-1 ps-1">
      <button
        onClick={onToggle}
        className="p-0.5 text-charcoal/40 hover:text-copper transition-colors"
        title={collapsed ? '' : ''}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(isAr ? group.label_ar : group.label_en);
              setEditing(false);
            }
          }}
          className="form-input text-xs py-1 flex-1"
          dir={isAr ? 'rtl' : 'ltr'}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="flex-1 text-start text-[12px] font-bold text-charcoal/70 hover:text-copper transition-colors truncate"
          dir={isAr ? 'rtl' : 'ltr'}
        >
          {isAr ? group.label_ar : group.label_en}
        </button>
      )}
      <button
        onClick={() => setEditing(true)}
        className="p-1 rounded text-charcoal/20 hover:text-copper hover:bg-copper/5"
      >
        <Pencil size={12} />
      </button>
      <button
        onClick={onDelete}
        className="p-1 rounded text-charcoal/20 hover:text-red-500 hover:bg-red-50"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export default function OptionsEditor({
  options,
  groups,
  onChange,
  onGroupsChange,
  lockSectionOptions = false,
  label,
  hint,
}: OptionsEditorProps) {
  const { t } = useTranslation();
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);

  const isLocked = (o: FieldOption) => lockSectionOptions && !!o.is_section_option;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = options.findIndex((o) => o.id === active.id);
    const newIndex = options.findIndex((o) => o.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    // Block reordering that would move a locked (section-linked) option or
    // drop something into the locked block — locked options keep their
    // section-derived order at the top.
    if (isLocked(options[oldIndex]!) || isLocked(options[newIndex]!)) return;
    onChange(arrayMove(options, oldIndex, newIndex));
  };

  const addOption = (groupId?: string) => {
    onChange([
      ...options,
      {
        id: uuid(),
        label_ar: '',
        label_en: '',
        value: '',
        color: OPTION_COLORS[options.length % OPTION_COLORS.length],
        group_id: groupId,
      },
    ]);
  };

  const updateOption = (id: string, updates: Partial<FieldOption>) => {
    onChange(options.map((o) => (o.id === id ? { ...o, ...updates } : o)));
  };

  const deleteOption = (id: string) => {
    const target = options.find((o) => o.id === id);
    if (target && isLocked(target)) return; // locked options can't be removed here
    onChange(options.filter((o) => o.id !== id));
  };

  const addGroup = () => {
    // Both labels hardcoded — this is a placeholder until the user renames,
    // and the rename path translates properly. No need to round-trip the
    // stub through /api/translate just for "New group".
    const newGroup: FieldOptionGroup = {
      id: uuid(),
      label_ar: 'مجموعة جديدة',
      label_en: 'New group',
    };
    onGroupsChange([...groups, newGroup]);
  };

  const renameGroup = async (id: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    try {
      const labels = await translateLabel(trimmed, 'group');
      onGroupsChange(groups.map((g) => (g.id === id ? {
        ...g,
        label_ar: labels.label_ar,
        label_en: labels.label_en,
      } : g)));
    } catch (err) {
      // Toast surfaced higher up; keep the user's typed value in the editor
      // so they can retry without losing their input.
      console.error('renameGroup translate failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      addToast(
        isAr ? `تعذرت ترجمة اسم المجموعة: ${msg}` : `Group name translation failed: ${msg}`,
        'error',
      );
    }
  };

  const deleteGroup = (id: string) => {
    // Remove the group; any option that referenced it falls back to ungrouped.
    onGroupsChange(groups.filter((g) => g.id !== id));
    onChange(options.map((o) => (o.group_id === id ? { ...o, group_id: undefined } : o)));
  };

  const toggleCollapsed = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Partition options into ungrouped first, then by each group's order. An
  // option whose group_id references a deleted/missing group is treated as
  // ungrouped at render time.
  const validGroupIds = new Set(groups.map((g) => g.id));
  const ungrouped = options.filter((o) => !o.group_id || !validGroupIds.has(o.group_id));
  const byGroup = new Map<string, FieldOption[]>();
  for (const g of groups) byGroup.set(g.id, []);
  for (const opt of options) {
    if (opt.group_id && validGroupIds.has(opt.group_id)) {
      byGroup.get(opt.group_id)!.push(opt);
    }
  }

  const hasOptions = options.length > 0;
  const editableCount = options.filter((o) => !isLocked(o)).length;
  const lockedCount = options.length - editableCount;
  // Preview first few labels in the user's current UI language for the
  // collapsed trigger — enough of a glance that they can find the field
  // without opening the modal.
  const previewLabels = options
    .slice(0, 5)
    .map((o) => (isAr ? o.label_ar : o.label_en) || o.value || '…')
    .filter(Boolean);

  const headerTitle = label ?? t('fields.options');

  return (
    <div>
      {/* Compact trigger — the Field Properties side panel is too narrow for
        * the full three-column editor to breathe, so clicking this button
        * opens a roomy modal. */}
      <label className="block text-sm font-bold text-charcoal mb-1">{headerTitle}</label>
      {hint && <p className="text-[11px] text-charcoal/45 mb-2">{hint}</p>}
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="w-full flex items-center gap-2 py-2 px-3 rounded-lg border border-sand/40 bg-white/50 hover:bg-copper/5 hover:border-copper/30 transition-colors text-start"
      >
        <List size={15} className="text-copper shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-charcoal">
            {isAr ? 'تحرير الخيارات' : 'Edit options'}
            <span className="ms-2 text-xs font-normal text-charcoal/45">
              ({editableCount}{lockedCount > 0 ? ` + ${lockedCount} ${isAr ? 'مُقفل' : 'locked'}` : ''})
            </span>
          </div>
          {previewLabels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {previewLabels.map((l, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-sand/20 text-charcoal/55 truncate max-w-[110px]">
                  {l}
                </span>
              ))}
              {options.length > previewLabels.length && (
                <span className="text-[10px] px-1.5 py-0.5 text-charcoal/35">
                  +{options.length - previewLabels.length}
                </span>
              )}
            </div>
          )}
          {!hasOptions && (
            <div className="text-[11px] text-charcoal/35 mt-0.5">
              {isAr ? 'لا توجد خيارات بعد — انقر للإضافة' : 'No options yet — click to add'}
            </div>
          )}
        </div>
        <ChevronRight size={14} className={`text-charcoal/30 shrink-0 ${isAr ? 'rotate-180' : ''}`} />
      </button>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={headerTitle}
        maxWidth="max-w-4xl"
      >
        {hint && <p className="text-[12px] text-charcoal/60 mb-3">{hint}</p>}
        <div className="rounded-lg border border-sand/30 bg-white overflow-hidden">
          {/* Column headers — rendered once at the top of the options table. */}
          {hasOptions && (
            <div className="flex items-center gap-2 py-2 px-3 bg-sand/10 text-[11px] font-bold text-charcoal/50 uppercase tracking-wider">
              <span className="w-[14px] shrink-0" aria-hidden />
              <span className="flex-1 text-start" dir="rtl">{isAr ? 'عربي' : 'Arabic'}</span>
              <span className="flex-1 text-start" dir="ltr">{isAr ? 'إنجليزي' : 'English'}</span>
              <span className="flex-1 text-start font-mono normal-case tracking-normal" dir="ltr">api_name</span>
              {groups.length > 0 && <span className="w-[22px] shrink-0" aria-hidden />}
              <span className="w-[28px] shrink-0" aria-hidden />
              <span className="w-[22px] shrink-0" aria-hidden />
            </div>
          )}
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
            {/* Ungrouped options (rendered first so they're easy to find). */}
            {ungrouped.length > 0 && (
              <div>
                {ungrouped.map((opt) => (
                  <OptionRow
                    key={opt.id}
                    option={opt}
                    groups={groups}
                    onUpdate={(updates) => updateOption(opt.id, updates)}
                    onDelete={() => deleteOption(opt.id)}
                    locked={isLocked(opt)}
                  />
                ))}
              </div>
            )}

            {/* Grouped options. */}
            {groups.map((g) => {
              const groupOptions = byGroup.get(g.id) ?? [];
              const collapsed = collapsedGroups.has(g.id);
              return (
                <div key={g.id} className="border-t border-sand/10">
                  <GroupHeader
                    group={g}
                    collapsed={collapsed}
                    onToggle={() => toggleCollapsed(g.id)}
                    onRename={(label) => renameGroup(g.id, label)}
                    onDelete={() => deleteGroup(g.id)}
                  />
                  {!collapsed && (
                    <div>
                      {groupOptions.map((opt) => (
                        <OptionRow
                          key={opt.id}
                          option={opt}
                          groups={groups}
                          onUpdate={(updates) => updateOption(opt.id, updates)}
                          onDelete={() => deleteOption(opt.id)}
                          locked={isLocked(opt)}
                        />
                      ))}
                      <button
                        onClick={() => addOption(g.id)}
                        className="flex items-center gap-1 text-[11px] text-charcoal/40 hover:text-copper ps-2 py-1.5 w-full border-t border-sand/10"
                      >
                        <Plus size={11} />
                        {t('fields.add_option_to_group')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </SortableContext>
        </DndContext>
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => addOption()}
            className="pill text-copper border-copper/30 hover:bg-copper/5"
          >
            <Plus size={14} />
            {t('fields.add_option')}
          </button>
          <button
            onClick={addGroup}
            className="pill text-charcoal/60 border-sand/40 hover:bg-sand/10"
          >
            <FolderPlus size={14} />
            {t('fields.add_group')}
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setModalOpen(false)}
            className="pill bg-copper text-white border-copper hover:bg-copper/90"
          >
            {isAr ? 'تم' : 'Done'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

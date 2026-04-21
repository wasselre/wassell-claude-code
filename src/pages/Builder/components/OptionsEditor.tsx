import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { v4 as uuid } from 'uuid';
import { GripVertical, Trash2, Plus, ChevronDown, ChevronRight, FolderPlus, Folder, Pencil, Lock, Check } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { bilingualFromInput, slugify } from '@/lib/autoTranslate';
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

  const handleLabelChange = (val: string) => {
    const labels = bilingualFromInput(val, language);
    onUpdate({
      ...labels,
      value: slugify(val),
    });
  };

  if (locked) {
    return (
      <div ref={setNodeRef} style={style} className="flex items-center gap-2 py-1.5 opacity-70">
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
          className="w-7 h-7 rounded-full border border-sand/30"
          style={{ backgroundColor: option.color ?? '#6B7280' }}
          title={isAr ? 'لون القسم' : 'Section color'}
        />
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 py-1.5">
      <button {...attributes} {...listeners} className="cursor-grab text-charcoal/15 hover:text-charcoal/40">
        <GripVertical size={14} />
      </button>
      <input
        value={isAr ? option.label_ar : option.label_en}
        onChange={(e) => handleLabelChange(e.target.value)}
        className="form-input text-sm py-1.5 flex-1 min-w-0"
        placeholder={isAr ? 'اسم الخيار' : 'Option name'}
        dir={isAr ? 'rtl' : 'ltr'}
      />
      {groups.length > 0 && (
        <GroupPickerButton
          groups={groups}
          currentGroupId={option.group_id}
          onChange={(groupId) => onUpdate({ group_id: groupId })}
        />
      )}
      <div className="relative">
        <select
          value={option.color ?? '#6B7280'}
          onChange={(e) => onUpdate({ color: e.target.value })}
          className="w-7 h-7 rounded-full border-0 cursor-pointer appearance-none"
          style={{ backgroundColor: option.color ?? '#6B7280' }}
        >
          {OPTION_COLORS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <button onClick={onDelete} className="p-1 rounded hover:bg-red-50 text-charcoal/20 hover:text-red-500">
        <Trash2 size={14} />
      </button>
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
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
    const defaultLabel = isAr ? 'مجموعة جديدة' : 'New group';
    const labels = bilingualFromInput(defaultLabel, language);
    const newGroup: FieldOptionGroup = {
      id: uuid(),
      label_ar: labels.label_ar,
      label_en: labels.label_en,
    };
    onGroupsChange([...groups, newGroup]);
  };

  const renameGroup = (id: string, newLabel: string) => {
    const labels = bilingualFromInput(newLabel, language);
    onGroupsChange(groups.map((g) => (g.id === id ? { ...g, ...labels } : g)));
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

  return (
    <div>
      <label className="block text-sm font-bold text-charcoal mb-1">{label ?? t('fields.options')}</label>
      {hint && <p className="text-[11px] text-charcoal/45 mb-2">{hint}</p>}
      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
          {/* Ungrouped options (rendered first so they're easy to find). */}
          {ungrouped.length > 0 && (
            <div className="space-y-0.5">
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
              <div key={g.id}>
                <GroupHeader
                  group={g}
                  collapsed={collapsed}
                  onToggle={() => toggleCollapsed(g.id)}
                  onRename={(label) => renameGroup(g.id, label)}
                  onDelete={() => deleteGroup(g.id)}
                />
                {!collapsed && (
                  <div className="space-y-0.5 ps-4 border-s border-sand/30">
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
                      className="flex items-center gap-1 text-[11px] text-charcoal/40 hover:text-copper ps-1 py-1"
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
      <div className="mt-2 flex items-center gap-2 flex-wrap">
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
      </div>
    </div>
  );
}

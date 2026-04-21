import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, AlertTriangle } from 'lucide-react';
import {
  Type, AlignLeft, Hash, AtSign, Phone, CalendarDays, Clock, DollarSign,
  Link2, ToggleLeft, ChevronDown, List, Search, Layers, UserCheck, Copy,
  StickyNote, SlidersHorizontal, Rows3, Fingerprint, Calculator,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { validateFormula, findUnknownReferences } from '@/lib/formulaEngine';
import type { ModelField, FieldType, Language, AppModel } from '@/types';

const FIELD_TYPE_CONFIG: Record<FieldType, { icon: typeof Type; color: string; bg: string }> = {
  text:             { icon: Type,              color: '#3B82F6', bg: '#3B82F612' },
  textarea:         { icon: AlignLeft,         color: '#6366F1', bg: '#6366F112' },
  notes:            { icon: StickyNote,        color: '#D97706', bg: '#D9770612' },
  number:           { icon: Hash,              color: '#F59E0B', bg: '#F59E0B12' },
  range:            { icon: SlidersHorizontal, color: '#0D9488', bg: '#0D948812' },
  email:            { icon: AtSign,            color: '#10B981', bg: '#10B98112' },
  phone:            { icon: Phone,             color: '#14B8A6', bg: '#14B8A612' },
  date:             { icon: CalendarDays,      color: '#8B5CF6', bg: '#8B5CF612' },
  datetime:         { icon: Clock,             color: '#A855F7', bg: '#A855F712' },
  currency:         { icon: DollarSign,        color: '#059669', bg: '#05966912' },
  url:              { icon: Link2,             color: '#0EA5E9', bg: '#0EA5E912' },
  checkbox:         { icon: ToggleLeft,        color: '#EC4899', bg: '#EC489912' },
  dropdown:         { icon: ChevronDown,       color: '#EF4444', bg: '#EF444412' },
  multiselect:      { icon: List,              color: '#F97316', bg: '#F9731612' },
  lookup:           { icon: Search,            color: '#B8734F', bg: '#B8734F12' },
  mirror:           { icon: Copy,              color: '#8E4E3A', bg: '#8E4E3A12' },
  section_mirror:   { icon: Rows3,             color: '#6B4226', bg: '#6B422612' },
  section_selector: { icon: Layers,            color: '#4A4E54', bg: '#4A4E5412' },
  assignee:         { icon: UserCheck,         color: '#7C3AED', bg: '#7C3AED12' },
  auto_id:          { icon: Fingerprint,       color: '#0891B2', bg: '#0891B212' },
  formula:          { icon: Calculator,        color: '#7E22CE', bg: '#7E22CE12' },
};

function detectMirrorMisconfig(field: ModelField, model: AppModel | null, allModels: AppModel[]): boolean {
  if (field.type !== 'mirror') return false;
  if (!model || !field.mirror_via_lookup_field_id || !field.mirror_target_field_name) return true;
  const sibling = model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === field.mirror_via_lookup_field_id);
  if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) return true;
  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id);
  if (!targetModel) return true;
  const targetField = targetModel.schema.sections.flatMap((s) => s.fields).find((f) => f.name === field.mirror_target_field_name);
  return !targetField;
}

function detectFormulaMisconfig(field: ModelField, model: AppModel | null): boolean {
  if (field.type !== 'formula') return false;
  if (!field.formula_expression || !field.formula_expression.trim()) return true;
  if (validateFormula(field.formula_expression) !== null) return true;
  if (model && findUnknownReferences(field.formula_expression, model).length > 0) return true;
  return false;
}

interface FieldRowProps {
  field: ModelField;
  language: Language;
  isSelected?: boolean;
  showDivider?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function FieldRow({ field, language, isSelected, showDivider, onEdit, onDelete }: FieldRowProps) {
  const isAr = language === 'ar';
  const { models } = useAppStore();
  const config = FIELD_TYPE_CONFIG[field.type];
  const TypeIcon = config.icon;
  const parentModel = models.find((m) => m.schema.sections.some((s) => s.fields.some((f) => f.id === field.id))) ?? null;
  const mirrorBroken = detectMirrorMisconfig(field, parentModel, models);
  const formulaBroken = detectFormulaMisconfig(field, parentModel);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onEdit}
      className={`flex items-center gap-2.5 py-2.5 px-2 rounded-lg cursor-pointer group transition-all ${
        isSelected
          ? 'bg-copper/[0.07]'
          : 'hover:bg-sand/[0.08]'
      } ${showDivider ? 'border-b border-sand/[0.06]' : ''}`}
    >
      {/* Type icon */}
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: config.bg, color: config.color }}
      >
        <TypeIcon size={16} />
      </div>

      {/* Label */}
      <span className={`text-[13px] font-semibold flex-1 min-w-0 truncate ${
        isSelected ? 'text-copper' : 'text-charcoal/80'
      }`}>
        {isAr ? field.label_ar : field.label_en}
        {field.required && <span className="text-red-300 ms-0.5 text-xs">*</span>}
      </span>

      {mirrorBroken && (
        <span
          className="shrink-0 text-amber-500"
          title={isAr ? 'إعداد حقل المرآة غير صالح' : 'Mirror field is misconfigured'}
        >
          <AlertTriangle size={13} />
        </span>
      )}

      {formulaBroken && (
        <span
          className="shrink-0 text-amber-500"
          title={isAr ? 'الصيغة غير صالحة أو تشير إلى حقل محذوف' : 'Formula is invalid or references a deleted field'}
        >
          <AlertTriangle size={13} />
        </span>
      )}

      {/* Hover actions — only visible on hover */}
      <div className="flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded-md text-charcoal/15 hover:text-red-400 hover:bg-red-50 transition-colors"
        >
          <Trash2 size={12} />
        </button>
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab p-1 rounded-md text-charcoal/15 hover:text-charcoal/40 transition-colors"
        >
          <GripVertical size={13} />
        </button>
      </div>
    </div>
  );
}

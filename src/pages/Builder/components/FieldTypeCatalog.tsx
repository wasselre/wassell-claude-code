import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import {
  Type, AlignLeft, Hash, AtSign, Phone, CalendarDays, Clock, DollarSign,
  Link2, ToggleLeft, ChevronDown, List, Search, Layers, UserCheck, Copy,
  StickyNote, SlidersHorizontal, Plus, Rows3, Fingerprint, Calculator, Table2,
} from 'lucide-react';
import type { FieldType } from '@/types';
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';

interface TypeCard {
  type: FieldType;
  icon: ComponentType<LucideProps>;
  color: string;
  bg: string;
}

const TYPE_CARDS: TypeCard[] = [
  { type: 'text',             icon: Type,              color: '#3B82F6', bg: '#3B82F615' },
  { type: 'textarea',         icon: AlignLeft,         color: '#6366F1', bg: '#6366F115' },
  { type: 'notes',            icon: StickyNote,        color: '#D97706', bg: '#D9770615' },
  { type: 'number',           icon: Hash,              color: '#F59E0B', bg: '#F59E0B15' },
  { type: 'range',            icon: SlidersHorizontal, color: '#0D9488', bg: '#0D948815' },
  { type: 'email',            icon: AtSign,            color: '#10B981', bg: '#10B98115' },
  { type: 'phone',            icon: Phone,             color: '#14B8A6', bg: '#14B8A615' },
  { type: 'date',             icon: CalendarDays,      color: '#8B5CF6', bg: '#8B5CF615' },
  { type: 'datetime',         icon: Clock,             color: '#A855F7', bg: '#A855F715' },
  { type: 'currency',         icon: DollarSign,        color: '#059669', bg: '#05966915' },
  { type: 'url',              icon: Link2,             color: '#0EA5E9', bg: '#0EA5E915' },
  { type: 'checkbox',         icon: ToggleLeft,        color: '#EC4899', bg: '#EC489915' },
  { type: 'dropdown',         icon: ChevronDown,       color: '#EF4444', bg: '#EF444415' },
  { type: 'multiselect',      icon: List,              color: '#F97316', bg: '#F9731615' },
  { type: 'lookup',           icon: Search,            color: '#B8734F', bg: '#B8734F15' },
  { type: 'mirror',           icon: Copy,              color: '#8E4E3A', bg: '#8E4E3A15' },
  { type: 'section_mirror',   icon: Rows3,             color: '#6B4226', bg: '#6B422615' },
  { type: 'section_selector', icon: Layers,            color: '#4A4E54', bg: '#4A4E5415' },
  { type: 'assignee',         icon: UserCheck,         color: '#7C3AED', bg: '#7C3AED15' },
  { type: 'auto_id',          icon: Fingerprint,       color: '#0891B2', bg: '#0891B215' },
  { type: 'formula',          icon: Calculator,        color: '#7E22CE', bg: '#7E22CE15' },
  { type: 'table',            icon: Table2,            color: '#B8734F', bg: '#B8734F15' },
];

interface FieldTypeCatalogProps {
  onSelectType: (type: FieldType) => void;
}

/**
 * Collapsible accordion listing all field types available for adding to a section.
 * Defaults to collapsed — user clicks the header to expand.
 */
export default function FieldTypeCatalog({ onSelectType }: FieldTypeCatalogProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-cream/40 transition-colors text-start"
      >
        <Plus size={12} className="text-copper/60 shrink-0" />
        <h3 className="flex-1 text-xs font-bold text-charcoal/50 uppercase tracking-wider">
          {isAr ? 'حقول جديدة' : 'New Fields'}
        </h3>
        <ChevronDown
          size={14}
          className={`text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-sand/20 p-2">
          <div className="grid grid-cols-2 gap-1.5">
            {TYPE_CARDS.map(({ type, icon: Icon, color, bg }) => (
              <button
                key={type}
                onClick={() => onSelectType(type)}
                className="flex flex-col items-center gap-1 p-2 rounded-lg border border-transparent hover:border-sand/40 hover:shadow-sm transition-all text-center group"
                style={{ backgroundColor: bg }}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center transition-transform group-hover:scale-110"
                  style={{ backgroundColor: `${color}18` }}
                >
                  <Icon size={16} style={{ color }} />
                </div>
                <span className="text-[10px] font-bold text-charcoal/60 leading-tight">
                  {t(`fields.type.${type}`)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

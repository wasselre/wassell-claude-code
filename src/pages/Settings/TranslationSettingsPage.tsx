import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { needsTranslation } from '@/lib/autoTranslate';
import { Languages, Search, AlertTriangle, Check, ChevronDown } from 'lucide-react';
// types used indirectly through store data

type TranslationItem = {
  id: string;
  category: string;
  categoryLabel: string;
  parentLabel: string;
  label_ar: string;
  label_en: string;
  onSave: (ar: string, en: string) => void;
};

type FilterMode = 'all' | 'needs_translation' | 'translated';

export default function TranslationSettingsPage() {
  const { t } = useTranslation();
  const { models, groups, workflows, dashboards, language, saveModel, saveGroup, saveWorkflow, saveDashboard } = useAppStore();
  const isAr = language === 'ar';

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAr, setEditAr] = useState('');
  const [editEn, setEditEn] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['models']));

  // Build the flat list of all translatable items
  const allItems = useMemo((): TranslationItem[] => {
    const items: TranslationItem[] = [];

    // Groups
    groups.forEach((g) => {
      items.push({
        id: `group_${g.id}`,
        category: 'groups',
        categoryLabel: isAr ? 'المجموعات' : 'Groups',
        parentLabel: '',
        label_ar: g.label_ar,
        label_en: g.label_en,
        onSave: (ar, en) => saveGroup({ ...g, label_ar: ar, label_en: en }),
      });
    });

    // Models + their sections + fields + options
    models.forEach((m) => {
      const modelLabel = isAr ? m.label_ar : m.label_en;
      items.push({
        id: `model_${m.id}`,
        category: 'models',
        categoryLabel: isAr ? 'النماذج' : 'Models',
        parentLabel: '',
        label_ar: m.label_ar,
        label_en: m.label_en,
        onSave: (ar, en) => saveModel({ ...m, label_ar: ar, label_en: en }),
      });

      m.schema.sections.forEach((s) => {
        items.push({
          id: `section_${s.id}`,
          category: 'models',
          categoryLabel: isAr ? 'النماذج' : 'Models',
          parentLabel: `${modelLabel} > ${isAr ? 'أقسام' : 'Sections'}`,
          label_ar: s.label_ar,
          label_en: s.label_en,
          onSave: (ar, en) => {
            const updated = {
              ...m,
              schema: {
                ...m.schema,
                sections: m.schema.sections.map((sec) =>
                  sec.id === s.id ? { ...sec, label_ar: ar, label_en: en } : sec,
                ),
              },
            };
            saveModel(updated);
          },
        });

        s.fields.forEach((f) => {
          items.push({
            id: `field_${f.id}`,
            category: 'models',
            categoryLabel: isAr ? 'النماذج' : 'Models',
            parentLabel: `${modelLabel} > ${isAr ? s.label_ar : s.label_en}`,
            label_ar: f.label_ar,
            label_en: f.label_en,
            onSave: (ar, en) => {
              const updated = {
                ...m,
                schema: {
                  ...m.schema,
                  sections: m.schema.sections.map((sec) => ({
                    ...sec,
                    fields: sec.fields.map((fld) =>
                      fld.id === f.id ? { ...fld, label_ar: ar, label_en: en } : fld,
                    ),
                  })),
                },
              };
              saveModel(updated);
            },
          });

          // Field options
          f.options?.forEach((opt) => {
            items.push({
              id: `option_${opt.id}`,
              category: 'models',
              categoryLabel: isAr ? 'النماذج' : 'Models',
              parentLabel: `${modelLabel} > ${isAr ? f.label_ar : f.label_en} > ${isAr ? 'خيارات' : 'Options'}`,
              label_ar: opt.label_ar,
              label_en: opt.label_en,
              onSave: (ar, en) => {
                const updated = {
                  ...m,
                  schema: {
                    ...m.schema,
                    sections: m.schema.sections.map((sec) => ({
                      ...sec,
                      fields: sec.fields.map((fld) => ({
                        ...fld,
                        options: fld.options?.map((o) =>
                          o.id === opt.id ? { ...o, label_ar: ar, label_en: en } : o,
                        ),
                      })),
                    })),
                  },
                };
                saveModel(updated);
              },
            });
          });
        });
      });
    });

    // Workflows
    workflows.forEach((w) => {
      items.push({
        id: `workflow_${w.id}`,
        category: 'workflows',
        categoryLabel: isAr ? 'سير العمل' : 'Workflows',
        parentLabel: '',
        label_ar: w.label_ar,
        label_en: w.label_en,
        onSave: (ar, en) => saveWorkflow({ ...w, label_ar: ar, label_en: en }),
      });
    });

    // Dashboards + widgets
    dashboards.forEach((d) => {
      const dashLabel = isAr ? d.label_ar : d.label_en;
      items.push({
        id: `dashboard_${d.id}`,
        category: 'dashboards',
        categoryLabel: isAr ? 'لوحات المعلومات' : 'Dashboards',
        parentLabel: '',
        label_ar: d.label_ar,
        label_en: d.label_en,
        onSave: (ar, en) => saveDashboard({ ...d, label_ar: ar, label_en: en }),
      });

      d.widgets.forEach((w) => {
        items.push({
          id: `widget_${w.id}`,
          category: 'dashboards',
          categoryLabel: isAr ? 'لوحات المعلومات' : 'Dashboards',
          parentLabel: `${dashLabel} > ${isAr ? 'عناصر' : 'Widgets'}`,
          label_ar: w.title_ar,
          label_en: w.title_en,
          onSave: (ar, en) => {
            saveDashboard({
              ...d,
              widgets: d.widgets.map((wg) =>
                wg.id === w.id ? { ...wg, title_ar: ar, title_en: en } : wg,
              ),
            });
          },
        });
      });
    });

    return items;
  }, [models, groups, workflows, dashboards, isAr, saveModel, saveGroup, saveWorkflow, saveDashboard]);

  // Filter + search
  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      // Filter mode
      if (filter === 'needs_translation' && !needsTranslation(item.label_ar, item.label_en)) return false;
      if (filter === 'translated' && needsTranslation(item.label_ar, item.label_en)) return false;

      // Search
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          item.label_ar.toLowerCase().includes(q) ||
          item.label_en.toLowerCase().includes(q) ||
          item.parentLabel.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [allItems, filter, search]);

  // Group by category
  const categories = useMemo(() => {
    const map = new Map<string, { label: string; items: TranslationItem[] }>();
    for (const item of filteredItems) {
      if (!map.has(item.category)) {
        map.set(item.category, { label: item.categoryLabel, items: [] });
      }
      map.get(item.category)!.items.push(item);
    }
    return Array.from(map.entries());
  }, [filteredItems]);

  const totalCount = allItems.length;
  const needsCount = allItems.filter((i) => needsTranslation(i.label_ar, i.label_en)).length;

  const startEdit = (item: TranslationItem) => {
    setEditingId(item.id);
    setEditAr(item.label_ar);
    setEditEn(item.label_en);
  };

  const saveEdit = (item: TranslationItem) => {
    item.onSave(editAr, editEn);
    setEditingId(null);
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-12 h-12 rounded-2xl bg-copper/10 flex items-center justify-center">
          <Languages size={24} className="text-copper" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-chocolate">
            {isAr ? 'إعدادات الترجمة' : 'Translation Settings'}
          </h1>
          <p className="text-sm text-charcoal/40">
            {isAr
              ? 'إدارة الترجمات لجميع عناصر النظام'
              : 'Manage translations for all system items'}
          </p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-6">
        <div className="stat-card flex-1">
          <div className="text-2xl font-bold text-chocolate">{totalCount}</div>
          <div className="text-xs text-charcoal/40">{isAr ? 'إجمالي العناصر' : 'Total items'}</div>
        </div>
        <div className="stat-card flex-1">
          <div className="text-2xl font-bold text-amber-600">{needsCount}</div>
          <div className="text-xs text-charcoal/40">{isAr ? 'بحاجة لترجمة' : 'Needs translation'}</div>
        </div>
        <div className="stat-card flex-1">
          <div className="text-2xl font-bold text-green-600">{totalCount - needsCount}</div>
          <div className="text-xs text-charcoal/40">{isAr ? 'مترجم' : 'Translated'}</div>
        </div>
      </div>

      {/* Search + Filter */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/25" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'بحث في الترجمات...' : 'Search translations...'}
            className="form-input ps-10 text-sm"
          />
        </div>
        <div className="flex gap-1">
          {([
            { value: 'all' as FilterMode, label: isAr ? 'الكل' : 'All' },
            { value: 'needs_translation' as FilterMode, label: isAr ? 'بحاجة لترجمة' : 'Needs translation', icon: AlertTriangle },
            { value: 'translated' as FilterMode, label: isAr ? 'مترجم' : 'Translated', icon: Check },
          ]).map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`pill ${filter === f.value ? 'active' : ''}`}
            >
              {f.icon && <f.icon size={13} />}
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Translation list by category */}
      <div className="space-y-4">
        {categories.map(([catKey, { label, items }]) => (
          <div key={catKey} className="card overflow-hidden">
            <button
              onClick={() => toggleCategory(catKey)}
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-cream/40 transition-colors text-start"
            >
              <div className="flex items-center gap-2">
                <span className="font-bold text-chocolate">{label}</span>
                <span className="text-xs text-charcoal/30 bg-cream px-2 py-0.5 rounded-full">
                  {items.length}
                </span>
              </div>
              <ChevronDown
                size={16}
                className={`text-charcoal/25 transition-transform ${expandedCategories.has(catKey) ? '' : '-rotate-90 rtl:rotate-90'}`}
              />
            </button>

            {expandedCategories.has(catKey) && (
              <div className="border-t border-sand/10">
                {items.map((item) => {
                  const needs = needsTranslation(item.label_ar, item.label_en);
                  const isEditing = editingId === item.id;

                  return (
                    <div
                      key={item.id}
                      className={`px-5 py-3 border-b border-sand/8 last:border-b-0 ${needs ? 'bg-amber-50/30' : ''}`}
                    >
                      {item.parentLabel && (
                        <div className="text-[0.6875rem] text-charcoal/25 mb-1">{item.parentLabel}</div>
                      )}

                      {isEditing ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[0.6875rem] font-bold text-charcoal/40 mb-0.5 block">
                                {isAr ? 'عربي' : 'Arabic'}
                              </label>
                              <input
                                value={editAr}
                                onChange={(e) => setEditAr(e.target.value)}
                                className="form-input text-sm py-1.5"
                                dir="rtl"
                              />
                            </div>
                            <div>
                              <label className="text-[0.6875rem] font-bold text-charcoal/40 mb-0.5 block">
                                {isAr ? 'إنجليزي' : 'English'}
                              </label>
                              <input
                                value={editEn}
                                onChange={(e) => setEditEn(e.target.value)}
                                className="form-input text-sm py-1.5"
                                dir="ltr"
                              />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => saveEdit(item)}
                              className="pill active text-xs"
                            >
                              <Check size={12} />
                              {t('common.save')}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="pill text-xs"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(item)}
                          className="w-full flex items-center gap-4 text-start group"
                        >
                          <div className="flex-1 grid grid-cols-2 gap-4">
                            <div className="text-sm text-charcoal" dir="rtl">{item.label_ar || <span className="text-charcoal/20 italic">—</span>}</div>
                            <div className="text-sm text-charcoal" dir="ltr">{item.label_en || <span className="text-charcoal/20 italic">—</span>}</div>
                          </div>
                          {needs ? (
                            <span className="flex items-center gap-1 text-[0.6875rem] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full font-bold shrink-0">
                              <AlertTriangle size={10} />
                              {isAr ? 'بحاجة لترجمة' : 'Needs translation'}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[0.6875rem] text-green-600 bg-green-50 px-2 py-0.5 rounded-full font-bold shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Check size={10} />
                              {isAr ? 'مترجم' : 'Translated'}
                            </span>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {categories.length === 0 && (
          <div className="text-center py-12 text-charcoal/30">
            <Languages size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-bold">{isAr ? 'لا توجد نتائج' : 'No results'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

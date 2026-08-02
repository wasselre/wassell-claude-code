import { useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { needsTranslation } from '@/lib/autoTranslate';
import {
  scanLegacyEntities,
  translateCandidates,
  applyCandidates,
  type MigrationCandidate,
  type MigrationProgress,
  type MigrationOutcome,
} from '@/lib/migrateLegacyLabels';
import { Languages, Search, AlertTriangle, Check, ChevronDown, Wand2, Loader2, X } from 'lucide-react';
import BackToSettings from './components/BackToSettings';
import RecordValueTranslationsPanel from './components/RecordValueTranslationsPanel';
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
  const {
    models, groups, workflows, dashboards, roles, profiles, language,
    saveModel, saveGroup, saveWorkflow, saveDashboard, saveRole, saveProfile,
    saveRecord, renameField, addToast,
  } = useAppStore();
  const isAr = language === 'ar';

  // ── One-shot legacy-label migration state ──────────────────────────
  // Phases:
  //   idle      — nothing scanned yet / scan returned 0 candidates
  //   scanned   — candidates found, awaiting user confirmation to translate
  //   translating — calling /api/translate for each candidate (concurrent)
  //   ready     — all translations done, awaiting user confirmation to apply
  //   applying  — sequentially writing back to the store + Supabase
  //   done      — finished; outcome shown
  //   error     — something blocked progress
  type MigrationPhase = 'idle' | 'scanned' | 'translating' | 'ready' | 'applying' | 'done' | 'error';
  const [migPhase, setMigPhase] = useState<MigrationPhase>('idle');
  const [migCandidates, setMigCandidates] = useState<MigrationCandidate[]>([]);
  const [migProgress, setMigProgress] = useState<MigrationProgress | null>(null);
  const [migOutcome, setMigOutcome] = useState<MigrationOutcome | null>(null);
  const [migTranslateFails, setMigTranslateFails] = useState<{ candidate: MigrationCandidate; error: string }[]>([]);
  const [migError, setMigError] = useState<string | null>(null);
  const migAbortRef = useRef<AbortController | null>(null);

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

  // ── Migration handlers ─────────────────────────────────────────────
  const startScan = () => {
    setMigError(null);
    setMigOutcome(null);
    setMigTranslateFails([]);
    const candidates = scanLegacyEntities({ models, groups, workflows, dashboards, roles, profiles });
    setMigCandidates(candidates);
    setMigPhase(candidates.length > 0 ? 'scanned' : 'idle');
    if (candidates.length === 0) {
      addToast(isAr ? 'لا توجد عناصر قديمة بحاجة لإصلاح' : 'No legacy items found — your data is clean', 'success');
    }
  };

  const startTranslate = async () => {
    if (migCandidates.length === 0) return;
    setMigPhase('translating');
    setMigProgress({ done: 0, total: migCandidates.length });
    setMigError(null);
    const ctrl = new AbortController();
    migAbortRef.current = ctrl;
    try {
      const { ok, failed } = await translateCandidates(
        migCandidates,
        (p) => setMigProgress(p),
        ctrl.signal,
      );
      setMigCandidates(ok);
      setMigTranslateFails(failed);
      setMigPhase(ok.length > 0 ? 'ready' : 'error');
      if (ok.length === 0 && failed.length > 0) {
        setMigError(isAr
          ? `فشلت ترجمة جميع العناصر (${failed.length})`
          : `All ${failed.length} translation calls failed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMigError(msg);
      setMigPhase('error');
    } finally {
      migAbortRef.current = null;
    }
  };

  const startApply = async () => {
    if (migCandidates.length === 0) return;
    setMigPhase('applying');
    setMigProgress({ done: 0, total: migCandidates.length });
    setMigError(null);
    const ctrl = new AbortController();
    migAbortRef.current = ctrl;
    try {
      const outcome = await applyCandidates(
        migCandidates,
        {
          getState: () => useAppStore.getState(),
          saveModel,
          saveGroup,
          saveWorkflow,
          saveDashboard,
          saveRole,
          saveProfile,
          saveRecord,
          renameField,
        },
        (p) => setMigProgress(p),
        ctrl.signal,
      );
      setMigOutcome(outcome);
      setMigPhase('done');
      addToast(
        isAr
          ? `تمت الترجمة: ${outcome.applied.length} عنصر${outcome.failed.length > 0 ? `، فشل ${outcome.failed.length}` : ''}`
          : `Migrated: ${outcome.applied.length} items${outcome.failed.length > 0 ? `, ${outcome.failed.length} failed` : ''}`,
        outcome.failed.length === 0 ? 'success' : 'info',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMigError(msg);
      setMigPhase('error');
    } finally {
      migAbortRef.current = null;
    }
  };

  const cancelMigration = () => {
    migAbortRef.current?.abort();
    setMigPhase('idle');
    setMigCandidates([]);
    setMigProgress(null);
    setMigOutcome(null);
    setMigTranslateFails([]);
    setMigError(null);
  };

  // Frozen-model field-slug renames need a SQL migration we don't run from
  // here — surface them in the preview so the user knows to ask for one.
  const migFrozenSkips = useMemo(
    () => migCandidates.filter((c) => c.kind === 'field_slug' && c.isFrozen),
    [migCandidates],
  );

  return (
    <div className="max-w-4xl">
      <BackToSettings />
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

      {/* ── Record-value translations (bilingual W2): seed-batch acceptance
          + per-model unit status. The gate between imported legacy
          translations and anything a user sees. ─────────────────────── */}
      <RecordValueTranslationsPanel />

      {/* ── One-shot legacy migration panel ────────────────────────────
          Scans for items that the legacy auto-translate stub left in
          a broken state (label_ar === label_en, item_<timestamp> slugs)
          and migrates them in three confirmable phases: scan → translate
          → apply. The translate phase calls /api/translate with a
          bounded concurrency; the apply phase rewrites the store + DB
          one item at a time, using `renameField` for field-slug renames
          so cross-references (records, formulas, lookups, mirrors,
          workflows, views) update atomically. */}
      <div className="mb-6 rounded-2xl border border-copper/20 bg-gradient-to-br from-copper/5 to-amber-50/40 p-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-copper/15 flex items-center justify-center shrink-0">
            <Wand2 size={18} className="text-copper" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-chocolate">
              {isAr ? 'ترجمة البيانات القديمة' : 'Legacy data migration'}
            </h2>
            <p className="text-xs text-charcoal/55 mt-0.5">
              {isAr
                ? 'يفحص جميع النماذج والأقسام والحقول والخيارات والقواعد واللوحات بحثاً عن نصوص لم تُترجم وأسماء مولّدة تلقائياً مثل item_xxx، ويصلحها مرة واحدة. سيُحدِّث جميع المراجع المرتبطة (السجلات، الصيغ، الروابط، النسخ، التدفقات، العروض) بشكل ذرّي.'
                : 'Scans every model, section, field, option, workflow, and dashboard for untranslated labels and auto-generated slugs like item_xxx, then fixes them in one pass. All cross-references (records, formulas, lookups, mirrors, workflows, views) are updated atomically.'}
            </p>
          </div>
        </div>

        {migPhase === 'idle' && (
          <div className="flex items-center gap-2">
            <button
              onClick={startScan}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-sm font-bold"
            >
              <Search size={14} />
              {isAr ? 'فحص البيانات' : 'Scan database'}
            </button>
            <span className="text-xs text-charcoal/40">
              {isAr ? 'لا يُجرى أي تعديل في هذه المرحلة' : 'No changes are made at this step'}
            </span>
          </div>
        )}

        {migPhase === 'scanned' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="px-3 py-2 rounded-lg bg-amber-100/60 border border-amber-300/50 text-sm">
                <b className="text-amber-700">{migCandidates.length}</b>{' '}
                <span className="text-charcoal/70">
                  {isAr ? 'عنصر بحاجة لإصلاح' : migCandidates.length === 1 ? 'item to migrate' : 'items to migrate'}
                </span>
              </div>
              {migFrozenSkips.length > 0 && (
                <div className="px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-xs text-charcoal/70">
                  {isAr
                    ? `سيتم تخطي ${migFrozenSkips.length} حقل في نماذج مجمَّدة (يحتاج هجرة SQL يدوية).`
                    : `${migFrozenSkips.length} field${migFrozenSkips.length === 1 ? '' : 's'} on frozen models will be skipped — they need a manual SQL migration.`}
                </div>
              )}
            </div>
            <CandidatePreview candidates={migCandidates} isAr={isAr} />
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={startTranslate}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-sm font-bold"
              >
                <Wand2 size={14} />
                {isAr ? 'ترجمة الكل' : 'Translate all'}
              </button>
              <button
                onClick={cancelMigration}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-sand text-charcoal/70 hover:bg-sand/20 text-sm font-bold"
              >
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <span className="text-xs text-charcoal/40">
                {isAr
                  ? 'سيقوم Claude بترجمة كل عنصر — حتى الآن لا يتم حفظ أي شيء.'
                  : 'Claude translates each item. Nothing is saved yet — you\'ll review before applying.'}
              </span>
            </div>
          </div>
        )}

        {(migPhase === 'translating' || migPhase === 'applying') && migProgress && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Loader2 size={16} className="animate-spin text-copper shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-charcoal">
                  {migPhase === 'translating'
                    ? (isAr ? 'جارٍ الترجمة…' : 'Translating…')
                    : (isAr ? 'جارٍ الحفظ في قاعدة البيانات…' : 'Writing to database…')}
                </div>
                <div className="text-xs text-charcoal/55 truncate" dir="ltr">
                  {migProgress.current?.path ?? ''}
                </div>
              </div>
              <div className="text-sm font-bold text-charcoal/70 tabular-nums shrink-0">
                {migProgress.done} / {migProgress.total}
              </div>
              <button
                onClick={cancelMigration}
                className="p-1.5 rounded-lg text-charcoal/40 hover:text-red-500 hover:bg-red-50"
                title={isAr ? 'إلغاء' : 'Cancel'}
              >
                <X size={14} />
              </button>
            </div>
            <div className="h-1.5 rounded-full bg-sand/30 overflow-hidden">
              <div
                className="h-full bg-copper transition-all duration-150"
                style={{ width: `${(migProgress.done / Math.max(1, migProgress.total)) * 100}%` }}
              />
            </div>
          </div>
        )}

        {migPhase === 'ready' && (
          <div className="space-y-3">
            <div className="px-3 py-2 rounded-lg bg-green-50 border border-green-200 text-sm">
              <b className="text-green-700">{migCandidates.length}</b>{' '}
              <span className="text-charcoal/70">
                {isAr ? 'عنصر جاهز للحفظ' : migCandidates.length === 1 ? 'item ready to apply' : 'items ready to apply'}
              </span>
              {migTranslateFails.length > 0 && (
                <span className="ms-3 text-amber-600">
                  · {isAr ? `${migTranslateFails.length} فشلت ترجمتها` : `${migTranslateFails.length} translation${migTranslateFails.length === 1 ? '' : 's'} failed`}
                </span>
              )}
            </div>
            <CandidatePreview candidates={migCandidates} isAr={isAr} showProposed />
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={startApply}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 text-sm font-bold"
              >
                <Check size={14} />
                {isAr ? 'تطبيق على قاعدة البيانات' : 'Apply to database'}
              </button>
              <button
                onClick={cancelMigration}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-sand text-charcoal/70 hover:bg-sand/20 text-sm font-bold"
              >
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <span className="text-xs text-charcoal/40">
                {isAr
                  ? 'سيُكتب التعديل إلى قاعدة البيانات وجميع المراجع المرتبطة.'
                  : 'Writes to the database and updates every cross-reference.'}
              </span>
            </div>
          </div>
        )}

        {migPhase === 'done' && migOutcome && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Check size={16} className="text-green-600" />
              <b>
                {isAr
                  ? `تمت ترجمة ${migOutcome.applied.length} عنصر بنجاح`
                  : `Migrated ${migOutcome.applied.length} item${migOutcome.applied.length === 1 ? '' : 's'} successfully`}
              </b>
            </div>
            {migOutcome.failed.length > 0 && (
              <details className="rounded-lg bg-red-50 border border-red-200 p-3">
                <summary className="text-sm font-bold text-red-700 cursor-pointer">
                  {isAr ? `${migOutcome.failed.length} عنصر فشل` : `${migOutcome.failed.length} item${migOutcome.failed.length === 1 ? '' : 's'} failed`}
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-red-700/80">
                  {migOutcome.failed.map((f, i) => (
                    <li key={i} dir="ltr">
                      <code>{f.candidate.path}</code> — {f.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {migOutcome.skipped.length > 0 && (
              <details className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                <summary className="text-sm font-bold text-amber-700 cursor-pointer">
                  {isAr ? `${migOutcome.skipped.length} عنصر تم تخطيه` : `${migOutcome.skipped.length} item${migOutcome.skipped.length === 1 ? '' : 's'} skipped`}
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-amber-700/80">
                  {migOutcome.skipped.map((s, i) => (
                    <li key={i} dir="ltr">
                      <code>{s.candidate.path}</code> — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button
              onClick={cancelMigration}
              className="text-xs font-bold text-charcoal/50 hover:text-charcoal underline"
            >
              {isAr ? 'إغلاق' : 'Close'}
            </button>
          </div>
        )}

        {migPhase === 'error' && (
          <div className="space-y-2">
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertTriangle size={14} className="inline me-2" />
              {migError ?? (isAr ? 'حدث خطأ' : 'Something went wrong')}
            </div>
            {migTranslateFails.length > 0 && (
              <details className="rounded-lg bg-red-50 border border-red-200 p-3">
                <summary className="text-sm font-bold text-red-700 cursor-pointer">
                  {isAr ? 'تفاصيل الإخفاقات' : 'Failure details'}
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-red-700/80">
                  {migTranslateFails.slice(0, 20).map((f, i) => (
                    <li key={i} dir="ltr">
                      <code>{f.candidate.path}</code> — {f.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button
              onClick={cancelMigration}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-sand text-charcoal/70 hover:bg-sand/20 text-xs font-bold"
            >
              {isAr ? 'إغلاق' : 'Close'}
            </button>
          </div>
        )}
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

/**
 * Compact preview of migration candidates. Shown twice in the migration
 * flow — once at "scanned" (just the path + current labels) and once at
 * "ready" (with proposed translations). Caps at the first 50 to keep
 * rendering snappy on large databases; the rest still get migrated.
 */
function CandidatePreview({
  candidates,
  isAr,
  showProposed = false,
}: {
  candidates: MigrationCandidate[];
  isAr: boolean;
  showProposed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? candidates : candidates.slice(0, 8);
  if (candidates.length === 0) return null;
  return (
    <div className="rounded-lg border border-sand/40 bg-white max-h-64 overflow-y-auto text-xs">
      <table className="w-full">
        <thead className="bg-sand/15 sticky top-0">
          <tr className="text-charcoal/55">
            <th className="text-start px-3 py-1.5 font-bold">{isAr ? 'المسار' : 'Path'}</th>
            <th className="text-start px-3 py-1.5 font-bold">{isAr ? 'السبب' : 'Issue'}</th>
            <th className="text-start px-3 py-1.5 font-bold">{isAr ? 'الحالي' : 'Current'}</th>
            {showProposed && (
              <th className="text-start px-3 py-1.5 font-bold">{isAr ? 'المقترح' : 'Proposed'}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => {
            const cur = c.current.slug
              ? `${c.current.label_ar || c.current.label_en || ''} (${c.current.slug})`
              : (c.current.label_ar || '') + (c.current.label_ar && c.current.label_en ? ' / ' : '') + (c.current.label_en || '');
            const prop = c.proposed
              ? `${c.proposed.label_ar} / ${c.proposed.label_en}${
                  (c.kind === 'field_slug' || c.kind === 'option_value') ? ` (${c.proposed.name})` : ''
                }`
              : '';
            return (
              <tr key={c.id} className="border-t border-sand/15 hover:bg-sand/10">
                <td className="px-3 py-1.5 text-charcoal/80 truncate max-w-[280px]" title={c.path} dir="ltr">
                  {c.path}
                </td>
                <td className="px-3 py-1.5">
                  {c.reason === 'placeholder_slug' ? (
                    <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-mono text-[10px]">
                      {isAr ? 'اسم تلقائي' : 'placeholder slug'}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px]">
                      {isAr ? 'بدون ترجمة' : 'untranslated'}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-charcoal/55 truncate max-w-[200px]" title={cur} dir="auto">
                  {cur}
                </td>
                {showProposed && (
                  <td className="px-3 py-1.5 truncate max-w-[260px]" title={prop} dir="auto">
                    {prop ? (
                      <span className="text-charcoal">{prop}</span>
                    ) : (
                      <span className="text-amber-600 italic">{isAr ? 'فشلت الترجمة' : 'translation failed'}</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {candidates.length > 8 && (
        <div className="border-t border-sand/15 px-3 py-2 bg-sand/5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs font-bold text-copper hover:text-terracotta"
          >
            {expanded
              ? (isAr ? 'إخفاء' : 'Show fewer')
              : (isAr
                  ? `عرض الكل (${candidates.length} عنصر)`
                  : `Show all ${candidates.length} items`)}
          </button>
        </div>
      )}
    </div>
  );
}

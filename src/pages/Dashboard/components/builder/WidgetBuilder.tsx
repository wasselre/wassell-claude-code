import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { v4 as uuid } from 'uuid';
import { BarChart3, PieChart, TrendingUp, Hash, Table2, Plus, Trash2, Filter, Trophy, Gauge as GaugeIcon, Target, Grid3x3 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { translateLabel } from '@/lib/translateLabel';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { getDefaultSize } from '@/lib/widgetLayout';
import { analyticsRoleFor, canAggregateFieldType } from '@/lib/analytics';
import { effectiveQuery, effectiveViz } from '@/lib/analytics/widgetAdapter';
import { vizFamilyFor } from '../../lib/widgetViz';
import ConditionsEditor from './ConditionsEditor';
import WidgetRenderer from '../WidgetRenderer';
import type {
  AggregationConfig,
  AggregationType,
  AnalyticsQuery,
  DateFilterMode,
  FilterCondition,
  FilterGroup,
  GroupByConfig,
  TimeBucket,
} from '@/lib/analytics/types';
import type {
  DashboardWidget,
  ModelField,
  WidgetConfig,
  WidgetFilterCondition,
  WidgetType,
  WidgetViz,
} from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (widget: DashboardWidget) => void;
  existingWidget?: DashboardWidget;
}

const WIDGET_TYPES: { type: WidgetType; icon: typeof Hash; ar: string; en: string }[] = [
  { type: 'stat', icon: Hash, ar: 'رقم', en: 'Stat' },
  { type: 'bar_chart', icon: BarChart3, ar: 'أعمدة', en: 'Bar' },
  { type: 'pie_chart', icon: PieChart, ar: 'دائري', en: 'Pie' },
  { type: 'line_chart', icon: TrendingUp, ar: 'خطي', en: 'Line' },
  { type: 'table', icon: Table2, ar: 'جدول', en: 'Table' },
  { type: 'funnel', icon: Filter, ar: 'قمع', en: 'Funnel' },
  { type: 'leaderboard', icon: Trophy, ar: 'المتصدرون', en: 'Leaderboard' },
  { type: 'gauge', icon: GaugeIcon, ar: 'عداد', en: 'Gauge' },
  { type: 'progress', icon: Target, ar: 'تقدم', en: 'Progress' },
  { type: 'pivot', icon: Grid3x3, ar: 'مصفوفة', en: 'Pivot' },
];

const AGG_TYPES: { value: AggregationType; ar: string; en: string }[] = [
  { value: 'count', ar: 'عدد', en: 'Count' },
  { value: 'count_distinct', ar: 'عدد مميز', en: 'Distinct' },
  { value: 'sum', ar: 'مجموع', en: 'Sum' },
  { value: 'avg', ar: 'متوسط', en: 'Average' },
  { value: 'min', ar: 'أدنى', en: 'Min' },
  { value: 'max', ar: 'أعلى', en: 'Max' },
  { value: 'percentage', ar: 'نسبة %', en: 'Percentage' },
];

const TIME_BUCKETS: { value: TimeBucket; ar: string; en: string }[] = [
  { value: 'hour', ar: 'ساعة', en: 'Hour' },
  { value: 'day', ar: 'يوم', en: 'Day' },
  { value: 'week', ar: 'أسبوع', en: 'Week' },
  { value: 'month', ar: 'شهر', en: 'Month' },
  { value: 'quarter', ar: 'ربع', en: 'Quarter' },
  { value: 'year', ar: 'سنة', en: 'Year' },
];

const DATE_MODES: { value: DateFilterMode; ar: string; en: string }[] = [
  { value: 'today', ar: 'اليوم', en: 'Today' },
  { value: 'yesterday', ar: 'أمس', en: 'Yesterday' },
  { value: 'this_week', ar: 'هذا الأسبوع', en: 'This week' },
  { value: 'last_week', ar: 'الأسبوع الماضي', en: 'Last week' },
  { value: 'this_month', ar: 'هذا الشهر', en: 'This month' },
  { value: 'last_month', ar: 'الشهر الماضي', en: 'Last month' },
  { value: 'this_quarter', ar: 'هذا الربع', en: 'This quarter' },
  { value: 'this_year', ar: 'هذه السنة', en: 'This year' },
  { value: 'last_7_days', ar: 'آخر ٧ أيام', en: 'Last 7 days' },
  { value: 'last_30_days', ar: 'آخر ٣٠ يوم', en: 'Last 30 days' },
];

interface GroupLevelState {
  field_id: string;
  time_bucket?: TimeBucket;
  numeric_width?: string;
}

function condsToGroup(conds: WidgetFilterCondition[]): FilterGroup | undefined {
  const valid = conds.filter((c) => c.field_id);
  if (valid.length === 0) return undefined;
  const conditions: FilterCondition[] = valid.map((c) => ({
    id: c.id,
    field: { kind: 'field', field_id: c.field_id, field_path: c.field_path === 'min' || c.field_path === 'max' ? c.field_path : undefined },
    operator: c.operator,
    value: c.value,
  }));
  return { mode: 'all', conditions };
}

export default function WidgetBuilder({ open, onClose, onSave, existingWidget }: Props) {
  const { models, language, addToast, metricDefinitions } = useAppStore();
  const isAr = language === 'ar';

  const [type, setType] = useState<WidgetType>('stat');
  const [titleAr, setTitleAr] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [sourceModelId, setSourceModelId] = useState('');
  const [conditions, setConditions] = useState<WidgetFilterCondition[]>([]);
  const [partConditions, setPartConditions] = useState<WidgetFilterCondition[]>([]);
  const [aggType, setAggType] = useState<AggregationType>('count');
  const [aggFieldId, setAggFieldId] = useState('');
  const [groupLevels, setGroupLevels] = useState<GroupLevelState[]>([]);
  const [dateFieldId, setDateFieldId] = useState('');
  const [dateMode, setDateMode] = useState<DateFilterMode | ''>('');
  // viz options
  const [color, setColor] = useState('#B8734F');
  const [comparison, setComparison] = useState(false);
  const [goodDir, setGoodDir] = useState<'up' | 'down'>('up');
  const [donut, setDonut] = useState(false);
  const [area, setArea] = useState(false);
  const [tableFieldIds, setTableFieldIds] = useState<string[]>([]);
  const [maxRows, setMaxRows] = useState(10);
  const [ignoreFilters, setIgnoreFilters] = useState(false);
  const [metricId, setMetricId] = useState('');
  const [goal, setGoal] = useState(''); // gauge max / progress target
  const [stacked, setStacked] = useState(false);
  const [topN, setTopN] = useState(''); // cap primary group level
  const [hideEmpty, setHideEmpty] = useState(false); // drop zero-count categories

  // Seed from existing widget (via the engine-effective query/viz) or reset.
  useEffect(() => {
    if (!open) return;
    if (existingWidget) {
      const q = effectiveQuery(existingWidget);
      const v = effectiveViz(existingWidget);
      setType(existingWidget.type);
      setTitleAr(existingWidget.title_ar);
      setTitleEn(existingWidget.title_en);
      setSourceModelId(existingWidget.source_model_id);
      setConditions(filterGroupToConds(q.filters));
      setAggType(q.aggregation.type === 'ratio' ? 'count' : q.aggregation.type);
      setAggFieldId(q.aggregation.field?.kind === 'field' ? q.aggregation.field.field_id : '');
      setPartConditions(q.aggregation.numerator ? filterGroupToConds(q.aggregation.numerator.filters) : []);
      setGroupLevels(
        (q.group_by ?? []).map((g) => ({
          field_id: g.field.kind === 'field' ? g.field.field_id : '',
          time_bucket: g.time_bucket,
          numeric_width: g.numeric_bucket ? String(g.numeric_bucket.width) : undefined,
        })),
      );
      setDateFieldId(q.date_filter?.field.kind === 'field' ? q.date_filter.field.field_id : '');
      setDateMode(q.date_filter?.mode && q.date_filter.mode !== 'custom' ? q.date_filter.mode : '');
      setColor(v.family === 'stat' || v.family === 'gauge' || v.family === 'progress' ? v.color ?? '#B8734F' : '#B8734F');
      setComparison(v.family === 'stat' && !!v.comparison);
      setGoodDir(v.family === 'stat' ? v.comparison?.good_direction ?? 'up' : 'up');
      setDonut(v.family === 'pies' ? !!v.donut : false);
      setArea(v.family === 'lines' ? !!v.area : false);
      setStacked(v.family === 'bars' ? !!v.stacked : false);
      setTableFieldIds(v.family === 'table' ? v.column_field_ids ?? [] : []);
      setMaxRows(v.family === 'table' ? v.page_size ?? 10 : 10);
      setIgnoreFilters(existingWidget.filter_behavior?.mode === 'ignore_dashboard_filters');
      setMetricId(q.aggregation.metric_id ?? '');
      setGoal(v.family === 'gauge' ? (v.max != null ? String(v.max) : '') : v.family === 'progress' ? (v.target != null ? String(v.target) : '') : '');
      setTopN(q.group_by?.[0]?.top_n ? String(q.group_by[0].top_n) : '');
      setHideEmpty(q.group_by?.[0]?.include_empty === false);
    } else {
      setType('stat'); setTitleAr(''); setTitleEn(''); setSourceModelId('');
      setConditions([]); setPartConditions([]); setAggType('count'); setAggFieldId('');
      setGroupLevels([]); setDateFieldId(''); setDateMode('');
      setColor('#B8734F'); setComparison(false); setGoodDir('up'); setDonut(false); setArea(false); setStacked(false);
      setTableFieldIds([]); setMaxRows(10); setIgnoreFilters(false); setMetricId(''); setGoal('');
      setStacked(false); setTopN(''); setHideEmpty(false);
    }
  }, [existingWidget, open]);

  const model = models.find((m) => m.id === sourceModelId);
  const allFields = useMemo<ModelField[]>(() => model?.schema.sections.flatMap((s) => s.fields) ?? [], [model]);
  const groupableFields = allFields.filter((f) => analyticsRoleFor(f.type).groupable);
  const aggFields = allFields.filter((f) => aggType !== 'count' && aggType !== 'percentage' && canAggregateFieldType(aggType, f.type));
  const dateFields = allFields.filter((f) => f.type === 'date' || f.type === 'datetime');
  const family = vizFamilyFor(type);

  const needsField = aggType === 'sum' || aggType === 'avg' || aggType === 'min' || aggType === 'max' || aggType === 'count_distinct';
  const needsGroup = family === 'bars' || family === 'pies' || family === 'lines' || family === 'funnel' || family === 'leaderboard' || family === 'pivot';

  function buildAggregation(): AggregationConfig {
    if (metricId) return { type: 'count', metric_id: metricId };
    if (aggType === 'percentage') {
      return {
        type: 'percentage',
        numerator: { source_model_id: sourceModelId, filters: condsToGroup(partConditions), aggregation: { type: 'count' } },
      };
    }
    if (aggType === 'count') return { type: 'count' };
    return { type: aggType, field: aggFieldId ? { kind: 'field', field_id: aggFieldId } : undefined };
  }

  function buildQuery(): AnalyticsQuery {
    const group_by: GroupByConfig[] = groupLevels
      .filter((g) => g.field_id)
      .map((g) => {
        const f = allFields.find((x) => x.id === g.field_id);
        const cfg: GroupByConfig = { field: { kind: 'field', field_id: g.field_id } };
        // Date/datetime group levels always bucket — default to day so the query
        // matches the bucket selector's default (it shows "Day" before the user
        // touches it). Without this, a date group falls back to raw-value grouping.
        if (f?.type === 'date' || f?.type === 'datetime') cfg.time_bucket = g.time_bucket ?? 'day';
        if ((f?.type === 'number' || f?.type === 'currency') && g.numeric_width) {
          const w = Number(g.numeric_width);
          if (w > 0) cfg.numeric_bucket = { width: w };
        }
        return cfg;
      });
    // top_n + hide-empty apply to the primary (first) group level. Funnel /
    // leaderboard / pivot always hide zero-count categories (they look broken
    // otherwise); bar/pie/line opt in via the checkbox.
    if (group_by[0]) {
      const n = Number(topN);
      if (n > 0) group_by[0].top_n = n;
      if (hideEmpty || family === 'funnel' || family === 'leaderboard' || family === 'pivot') group_by[0].include_empty = false;
    }
    const q: AnalyticsQuery = {
      source_model_id: sourceModelId,
      filters: condsToGroup(conditions),
      group_by: group_by.length ? group_by : undefined,
      aggregation: buildAggregation(),
    };
    if (dateFieldId && dateMode) q.date_filter = { field: { kind: 'field', field_id: dateFieldId }, mode: dateMode };
    if (family === 'lines' && group_by.length) q.sort = [{ by: { kind: 'group', level: 0 }, direction: 'asc' }];
    return q;
  }

  function buildViz(): WidgetViz {
    const metric = metricId ? metricDefinitions.find((m) => m.id === metricId) : undefined;
    const aggF = allFields.find((x) => x.id === aggFieldId);
    const numFmt = metric?.format
      ? metric.format
      : aggType === 'percentage'
        ? { percent: true }
        : aggF?.type === 'currency'
          ? { currency: 'SAR' }
          : undefined;
    switch (family) {
      case 'stat':
        return { family: 'stat', color, number_format: numFmt, comparison: comparison ? { mode: 'previous_period', good_direction: goodDir } : undefined };
      case 'bars':
        return { family: 'bars', color_mode: { kind: 'by_group_option' }, stacked };
      case 'pies':
        return { family: 'pies', donut, color_mode: { kind: 'by_group_option' }, show_legend: true };
      case 'lines':
        return { family: 'lines', area, smooth: false };
      case 'funnel':
        return { family: 'funnel', show_pct: true, color_mode: { kind: 'by_group_option' }, number_format: numFmt };
      case 'leaderboard':
        return { family: 'leaderboard', max_rows: 10, color_mode: { kind: 'by_group_option' }, number_format: numFmt };
      case 'gauge': {
        const g = Number(goal);
        return { family: 'gauge', max: g > 0 ? g : numFmt?.percent ? 100 : undefined, color, number_format: numFmt, good_direction: goodDir };
      }
      case 'progress': {
        const g = Number(goal);
        return { family: 'progress', target: g > 0 ? g : numFmt?.percent ? 100 : undefined, color, number_format: numFmt };
      }
      case 'pivot':
        return { family: 'pivot', number_format: numFmt };
      default:
        return { family: 'table', column_field_ids: tableFieldIds, page_size: maxRows };
    }
  }

  function buildConfig(): WidgetConfig {
    const conds = conditions.filter((c) => c.field_id);
    switch (type) {
      case 'stat':
        return { color, conditions: conds };
      case 'bar_chart':
      case 'pie_chart':
        return { group_by_field_id: groupLevels[0]?.field_id ?? '', conditions: conds };
      case 'line_chart': {
        const tb = groupLevels[0]?.time_bucket;
        const period = tb === 'day' || tb === 'week' || tb === 'month' ? tb : 'month';
        return { date_field_id: groupLevels[0]?.field_id ?? dateFieldId, period, conditions: conds };
      }
      default:
        return { field_ids: tableFieldIds, sort_field_id: null, sort_direction: 'asc', max_rows: maxRows, conditions: conds };
    }
  }

  // Only one title side is required — the other defaults to it on save (the
  // bilingual auto-translate-on-blur is best-effort and can fail; a user who
  // types one language must still be able to save).
  const valid =
    (!!titleAr.trim() || !!titleEn.trim()) && !!sourceModelId &&
    (!!metricId || !needsField || !!aggFieldId) &&
    (!needsGroup || groupLevels.some((g) => g.field_id)) &&
    (family !== 'table' || tableFieldIds.length > 0);

  const draftWidget: DashboardWidget = useMemo(
    () => ({
      id: existingWidget?.id ?? 'preview',
      type,
      source_model_id: sourceModelId,
      title_ar: titleAr.trim() || titleEn.trim() || ' ',
      title_en: titleEn.trim() || titleAr.trim() || ' ',
      query: buildQuery(),
      viz: buildViz(),
      config: buildConfig(),
      filter_behavior: ignoreFilters ? { mode: 'ignore_dashboard_filters' as const } : { mode: 'inherit_dashboard_filters' as const },
      x: 0, y: 0, w: 4, h: 4,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [type, titleAr, titleEn, sourceModelId, conditions, partConditions, aggType, aggFieldId, groupLevels, dateFieldId, dateMode, color, comparison, goodDir, donut, area, tableFieldIds, maxRows, ignoreFilters, metricId, goal, stacked, topN, hideEmpty],
  );

  const handleSave = () => {
    if (!valid) return;
    const size = existingWidget ? { w: existingWidget.w, h: existingWidget.h } : getDefaultSize(type);
    onSave({
      ...draftWidget,
      id: existingWidget?.id ?? uuid(),
      x: existingWidget?.x ?? 0,
      y: existingWidget?.y ?? 0,
      w: size.w,
      h: size.h,
    });
    onClose();
  };

  const setLevel = (i: number, patch: Partial<GroupLevelState>) =>
    setGroupLevels((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existingWidget ? (isAr ? 'تعديل العنصر' : 'Edit widget') : isAr ? 'إضافة عنصر' : 'Add widget'}
      maxWidth="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button onClick={handleSave} disabled={!valid}>{isAr ? 'حفظ' : 'Save'}</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_280px]">
        {/* ─── Config column ─── */}
        <div className="space-y-4">
          <Input
            label={isAr ? 'عنوان العنصر' : 'Widget title'}
            value={isAr ? titleAr : titleEn}
            onChange={(e) => (isAr ? setTitleAr(e.target.value) : setTitleEn(e.target.value))}
            onBlur={async (e) => {
              const typed = e.target.value.trim();
              if (!typed) return;
              const other = isAr ? titleEn : titleAr;
              if (other.trim()) return;
              try {
                const labels = await translateLabel(typed, 'dashboard');
                if (isAr) setTitleEn(labels.label_en);
                else setTitleAr(labels.label_ar);
              } catch {
                addToast(isAr ? `تعذرت الترجمة` : `Translation failed`, 'error');
              }
            }}
            required
            dir={isAr ? 'rtl' : 'ltr'}
          />

          <Section label={isAr ? 'النموذج المصدر' : 'Source model'}>
            <select value={sourceModelId} onChange={(e) => { setSourceModelId(e.target.value); setAggFieldId(''); setGroupLevels([]); setDateFieldId(''); setConditions([]); setTableFieldIds([]); setMetricId(''); }} className="form-input text-sm">
              <option value="">—</option>
              {models.map((m) => <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>)}
            </select>
          </Section>

          <Section label={isAr ? 'نوع العرض' : 'Visualization'}>
            <div className="flex flex-wrap gap-2">
              {WIDGET_TYPES.map((wt) => {
                const Icon = wt.icon;
                const on = type === wt.type;
                return (
                  <button key={wt.type} onClick={() => setType(wt.type)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold transition-colors ${on ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal hover:border-copper/50'}`}>
                    <Icon size={16} /> {isAr ? wt.ar : wt.en}
                  </button>
                );
              })}
            </div>
          </Section>

          {metricDefinitions.length > 0 && family !== 'table' && (
            <Section label={isAr ? 'مقياس محفوظ' : 'Saved metric'}>
              <select
                value={metricId}
                onChange={(e) => {
                  const id = e.target.value;
                  setMetricId(id);
                  const m = metricDefinitions.find((x) => x.id === id);
                  if (m) { setSourceModelId(m.query.source_model_id); setAggFieldId(''); setAggType('count'); setGroupLevels([]); }
                }}
                className="form-input text-sm"
              >
                <option value="">{isAr ? '— تجميع مخصص —' : '— Custom aggregation —'}</option>
                {metricDefinitions.map((m) => <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>)}
              </select>
              {metricId && <p className="mt-1 text-[11px] text-charcoal/50">{isAr ? 'يُحسب القياس تلقائياً. أضف "تجميع حسب" أدناه للتقسيم.' : 'The metric drives the value. Add a Group by below to break it down.'}</p>}
            </Section>
          )}

          {sourceModelId && family !== 'table' && !metricId && (
            <Section label={isAr ? 'القياس' : 'Aggregation'}>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {AGG_TYPES.map((a) => (
                  <button key={a.value} onClick={() => setAggType(a.value)} className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${aggType === a.value ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal'}`}>
                    {isAr ? a.ar : a.en}
                  </button>
                ))}
              </div>
              {needsField && (
                <select value={aggFieldId} onChange={(e) => setAggFieldId(e.target.value)} className="form-input text-sm">
                  <option value="">— {isAr ? 'اختر حقلاً' : 'Choose field'} —</option>
                  {aggFields.map((f) => <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>)}
                </select>
              )}
              {needsField && aggFields.length === 0 && (
                <p className="text-xs text-charcoal/50">{isAr ? 'لا توجد حقول رقمية مناسبة' : 'No suitable numeric fields'}</p>
              )}
              {aggType === 'percentage' && (
                <div className="mt-2 rounded-lg border border-sand/60 p-2">
                  <ConditionsEditor conditions={partConditions} onChange={setPartConditions} allFields={allFields} label={isAr ? 'شرط البسط (النسبة من)' : 'Numerator (% of records matching)'} compact />
                  <p className="mt-1 text-[11px] text-charcoal/40">{isAr ? 'المقام = كل السجلات ضمن النطاق' : 'Denominator = all records in scope'}</p>
                </div>
              )}
            </Section>
          )}

          {sourceModelId && family !== 'table' && (
            <Section label={isAr ? 'التجميع حسب' : 'Group by'}>
              <div className="space-y-2">
                {groupLevels.map((lvl, i) => {
                  const f = allFields.find((x) => x.id === lvl.field_id);
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-cream-light p-2">
                      <select value={lvl.field_id} onChange={(e) => { const nf = allFields.find((x) => x.id === e.target.value); const isDate = nf?.type === 'date' || nf?.type === 'datetime'; setLevel(i, { field_id: e.target.value, time_bucket: isDate ? 'day' : undefined, numeric_width: undefined }); }} className="form-input min-w-[130px] flex-1 bg-white py-1 text-xs">
                        <option value="">— {isAr ? 'حقل' : 'Field'} —</option>
                        {groupableFields.map((gf) => <option key={gf.id} value={gf.id}>{isAr ? gf.label_ar : gf.label_en}</option>)}
                      </select>
                      {(f?.type === 'date' || f?.type === 'datetime') && (
                        <select value={lvl.time_bucket ?? 'day'} onChange={(e) => setLevel(i, { time_bucket: e.target.value as TimeBucket })} className="form-input w-24 bg-white py-1 text-xs">
                          {TIME_BUCKETS.map((b) => <option key={b.value} value={b.value}>{isAr ? b.ar : b.en}</option>)}
                        </select>
                      )}
                      {(f?.type === 'number' || f?.type === 'currency') && (
                        <input type="number" value={lvl.numeric_width ?? ''} onChange={(e) => setLevel(i, { numeric_width: e.target.value })} placeholder={isAr ? 'حجم الفئة' : 'Bin size'} className="form-input w-28 bg-white py-1 text-xs" />
                      )}
                      <button onClick={() => setGroupLevels((ls) => ls.filter((_, idx) => idx !== i))} className="rounded p-1 text-charcoal/30 hover:bg-red-50 hover:text-red-500"><Trash2 size={12} /></button>
                    </div>
                  );
                })}
                {groupLevels.length < 2 && (
                  <button onClick={() => setGroupLevels((ls) => [...ls, { field_id: '' }])} className="pill border-copper/30 text-xs text-copper hover:bg-copper/5"><Plus size={12} /> {isAr ? 'مستوى تجميع' : 'Group level'}</button>
                )}
                {groupLevels.some((g) => g.field_id) && (
                  <div className="flex flex-wrap items-center gap-3 border-t border-sand/40 pt-2">
                    <label className="flex items-center gap-1.5 text-xs text-charcoal/60">
                      {isAr ? 'أعلى' : 'Top'}
                      <input type="number" min="0" value={topN} onChange={(e) => setTopN(e.target.value)} placeholder={isAr ? 'الكل' : 'All'} className="form-input w-16 bg-white py-1 text-xs" />
                    </label>
                    {(family === 'bars' || family === 'pies' || family === 'lines') && (
                      <label className="flex items-center gap-1.5 text-xs text-charcoal/60">
                        <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="h-3.5 w-3.5 text-copper" />
                        {isAr ? 'إخفاء الفئات الفارغة' : 'Hide empty categories'}
                      </label>
                    )}
                  </div>
                )}
              </div>
            </Section>
          )}

          {sourceModelId && dateFields.length > 0 && (
            <Section label={isAr ? 'نطاق التاريخ' : 'Date range'}>
              <div className="flex flex-wrap gap-2">
                <select value={dateFieldId} onChange={(e) => setDateFieldId(e.target.value)} className="form-input flex-1 bg-white py-1.5 text-sm">
                  <option value="">— {isAr ? 'حقل التاريخ' : 'Date field'} —</option>
                  {dateFields.map((f) => <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>)}
                </select>
                <select value={dateMode} onChange={(e) => setDateMode(e.target.value as DateFilterMode | '')} disabled={!dateFieldId} className="form-input flex-1 bg-white py-1.5 text-sm disabled:opacity-40">
                  <option value="">{isAr ? 'كل الوقت' : 'All time'}</option>
                  {DATE_MODES.map((d) => <option key={d.value} value={d.value}>{isAr ? d.ar : d.en}</option>)}
                </select>
              </div>
            </Section>
          )}

          {sourceModelId && family === 'table' && (
            <Section label={isAr ? 'الأعمدة' : 'Columns'}>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-sand/60 p-2">
                {allFields.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" checked={tableFieldIds.includes(f.id)} onChange={() => setTableFieldIds((ids) => ids.includes(f.id) ? ids.filter((x) => x !== f.id) : [...ids, f.id])} className="h-3.5 w-3.5 rounded border-sand text-copper" />
                    {isAr ? f.label_ar : f.label_en}
                  </label>
                ))}
              </div>
              <Input label={isAr ? 'أقصى عدد صفوف' : 'Max rows'} type="number" value={String(maxRows)} onChange={(e) => setMaxRows(Number(e.target.value) || 10)} />
            </Section>
          )}

          {sourceModelId && (
            <Section label={isAr ? 'خيارات العرض' : 'Display options'}>
              {family === 'stat' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-charcoal/60">{isAr ? 'اللون' : 'Color'}</span>
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-10 rounded border border-sand" />
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={comparison} onChange={(e) => setComparison(e.target.checked)} disabled={!dateMode} className="h-3.5 w-3.5 text-copper" />{isAr ? 'مقارنة بالفترة السابقة' : 'Compare to previous period'}</label>
                  {comparison && (
                    <select value={goodDir} onChange={(e) => setGoodDir(e.target.value as 'up' | 'down')} className="form-input w-44 text-xs">
                      <option value="up">{isAr ? 'الأعلى أفضل' : 'Higher is better'}</option>
                      <option value="down">{isAr ? 'الأقل أفضل' : 'Lower is better'}</option>
                    </select>
                  )}
                  {!dateMode && <p className="text-[11px] text-charcoal/40">{isAr ? 'تتطلب المقارنة نطاق تاريخ' : 'Comparison needs a date range'}</p>}
                </div>
              )}
              {family === 'pies' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={donut} onChange={(e) => setDonut(e.target.checked)} className="h-3.5 w-3.5 text-copper" />{isAr ? 'حلقي (دونات)' : 'Donut'}</label>}
              {family === 'lines' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={area} onChange={(e) => setArea(e.target.checked)} className="h-3.5 w-3.5 text-copper" />{isAr ? 'مساحة' : 'Area'}</label>}
              {family === 'bars' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stacked} onChange={(e) => setStacked(e.target.checked)} className="h-3.5 w-3.5 text-copper" />{isAr ? 'متراكم (مع مستويين تجميع)' : 'Stacked (with 2 group levels)'}</label>}
              {(family === 'gauge' || family === 'progress') && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-charcoal/60">{isAr ? 'اللون' : 'Color'}</span>
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-10 rounded border border-sand" />
                  </div>
                  <Input label={family === 'gauge' ? (isAr ? 'الحد الأقصى' : 'Max value') : isAr ? 'الهدف' : 'Target'} type="number" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={isAr ? 'مثال: ١٠٠' : 'e.g. 100'} />
                </div>
              )}
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={ignoreFilters} onChange={(e) => setIgnoreFilters(e.target.checked)} className="h-3.5 w-3.5 text-copper" />
                {isAr ? 'تجاهل تصفية اللوحة' : 'Ignore dashboard filters'}
              </label>
              <div className="mt-3 border-t border-sand/50 pt-3">
                <ConditionsEditor conditions={conditions} onChange={setConditions} allFields={allFields} />
              </div>
            </Section>
          )}
        </div>

        {/* ─── Live preview column ─── */}
        <div className="md:sticky md:top-0">
          <div className="mb-2 text-xs font-bold text-charcoal/50">{isAr ? 'معاينة' : 'Preview'}</div>
          <div className="h-56 rounded-xl border border-sand bg-white p-2">
            {sourceModelId ? <WidgetRenderer widget={draftWidget} /> : <div className="flex h-full items-center justify-center text-xs text-charcoal/30">{isAr ? 'اختر نموذجاً' : 'Pick a model'}</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-bold text-charcoal">{label}</label>
      {children}
    </div>
  );
}

function filterGroupToConds(group: FilterGroup | undefined): WidgetFilterCondition[] {
  if (!group) return [];
  return group.conditions
    .filter((c) => c.field.kind === 'field')
    .map((c) => ({
      id: c.id,
      field_id: c.field.kind === 'field' ? c.field.field_id : '',
      field_path: c.field.kind === 'field' ? c.field.field_path : undefined,
      operator: c.operator as WidgetFilterCondition['operator'],
      value: c.value,
    }));
}

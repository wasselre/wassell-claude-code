import { useMemo, useState } from 'react';
import {
  Search, Sparkles, Loader2, Building2, MapPin, AlertTriangle, History, Check, Layers,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { normalizeForSearch } from '@/lib/recordSearch';
import type { PostLanguage, QuantityMode, QuantityPlan } from '@/lib/postsContent/planning';
import { MAX_POSTS_PER_BATCH, MAX_POSTS_PER_PROJECT } from '@/lib/postsContent/planning';
import type { PostTone } from '@/lib/postsContent/templates';
import type { ProjectFactsResult } from '@/lib/postsContent/client';

export interface ProjectRow {
  /** our_projects record id. */
  id: string;
  allProjectId: string | null;
  name: string;
  district: string;
  city: string;
  availableUnits: number | null;
  /** Pre-formatted from the AVAILABLE-only price rollup, or null. */
  priceText: string | null;
  search: string;
}

export interface BatchSummary {
  recordId: string;
  label: string;
  when: string;
  projects: string;
  requested: number;
  completed: number;
  approved: number;
  language: PostLanguage;
  tone: PostTone;
}

interface Props {
  isAr: boolean;
  rows: ProjectRow[];
  selectedIds: string[];
  onToggleProject: (id: string) => void;
  mode: QuantityMode;
  setMode: (m: QuantityMode) => void;
  totalCount: number;
  setTotalCount: (n: number) => void;
  perCounts: Record<string, number>;
  setPerCount: (id: string, n: number) => void;
  language: PostLanguage;
  setLanguage: (l: PostLanguage) => void;
  tone: PostTone;
  setTone: (t: PostTone) => void;
  plan: QuantityPlan;
  /** Per-project facts + supported angles; null while loading. */
  planInfo: ProjectFactsResult[] | null;
  planInfoLoading: boolean;
  generating: boolean;
  onGenerate: () => void;
  batches: BatchSummary[];
  onOpenBatch: (recordId: string) => void;
}

const LANGUAGES: Array<{ value: PostLanguage; ar: string; en: string }> = [
  { value: 'ar', ar: 'العربية', en: 'Arabic' },
  { value: 'en', ar: 'الإنجليزية', en: 'English' },
  { value: 'both', ar: 'العربية والإنجليزية', en: 'Arabic & English' },
];

/**
 * Stage 1 — pick projects, choose how many posts and in what language/style,
 * see exactly how the batch will be distributed, then generate.
 *
 * The distribution preview is computed from the SAME `buildQuantityPlan` the
 * generator uses, so what the user sees before pressing the button is what
 * runs. Requests over the limits come back as blocking errors — the count is
 * never silently trimmed.
 */
export default function SetupStage({
  isAr, rows, selectedIds, onToggleProject, mode, setMode, totalCount, setTotalCount,
  perCounts, setPerCount, language, setLanguage, tone, setTone, plan, planInfo, planInfoLoading,
  generating, onGenerate, batches, onOpenBatch,
}: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    if (!q) return rows;
    return rows.filter((r) => r.search.includes(q));
  }, [rows, query]);

  const selectedRows = useMemo(
    () => selectedIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is ProjectRow => !!r),
    [selectedIds, rows],
  );

  const supportedByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of planInfo ?? []) m.set(p.our_project_id, p.ranked?.length ?? 0);
    return m;
  }, [planInfo]);

  const requestedFor = (id: string): number =>
    plan.perProject.find((p) => p.ourProjectId === id)?.requested ?? 0;

  // Projects the data cannot support at all, and ones that will need an angle
  // reused to reach the requested count.
  const unsupported = selectedRows.filter((r) => planInfo && (supportedByProject.get(r.id) ?? 0) === 0);
  const willReuse = selectedRows.filter((r) => {
    const s = supportedByProject.get(r.id);
    return planInfo && s != null && s > 0 && requestedFor(r.id) > s;
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-5">
      {/* Project picker */}
      <div className="bg-white rounded-2xl border border-sand/25 shadow-sm overflow-hidden flex flex-col">
        <div className="p-3 border-b border-sand/15 flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={15} className={`absolute top-1/2 -translate-y-1/2 text-charcoal/30 ${isAr ? 'right-3' : 'left-3'}`} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isAr ? 'ابحث باسم المشروع أو الحي…' : 'Search by project or district…'}
              className={`w-full py-2 rounded-xl border border-sand/30 bg-cream/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/25 ${isAr ? 'pr-9 pl-3' : 'pl-9 pr-3'}`}
            />
          </div>
          <span className="text-xs text-charcoal/45 shrink-0">
            {isAr ? `${selectedIds.length} محدد` : `${selectedIds.length} selected`}
          </span>
        </div>
        <div className="max-h-[58vh] overflow-y-auto divide-y divide-sand/12">
          {filtered.length === 0 && (
            <p className="p-6 text-center text-sm text-charcoal/40">
              {isAr ? 'لا توجد مشاريع مطابقة' : 'No matching projects'}
            </p>
          )}
          {filtered.map((r) => {
            const active = selectedIds.includes(r.id);
            const supported = supportedByProject.get(r.id);
            return (
              <button
                key={r.id}
                onClick={() => onToggleProject(r.id)}
                className={`w-full text-start px-4 py-3 flex items-center gap-3 transition-colors ${
                  active ? 'bg-copper/8' : 'hover:bg-cream/60'
                }`}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                  active ? 'bg-copper border-copper text-white' : 'bg-white border-sand/40 text-transparent'
                }`}>
                  <Check size={14} />
                </div>
                <div className="w-8 h-8 rounded-lg bg-cream text-charcoal/40 flex items-center justify-center shrink-0">
                  <Building2 size={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-chocolate truncate">{r.name}</p>
                  <p className="text-[11px] text-charcoal/45 truncate flex items-center gap-1">
                    <MapPin size={10} />
                    {[r.district, r.city].filter(Boolean).join(isAr ? '، ' : ', ')
                      || (isAr ? 'موقع غير محدد' : 'No location')}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  {r.priceText && <p className="text-[11px] text-charcoal/60">{r.priceText}</p>}
                  <p className="text-[10px] text-charcoal/40">
                    {r.availableUnits != null
                      ? (isAr ? `${r.availableUnits} وحدة متاحة` : `${r.availableUnits} available`)
                      : (isAr ? 'لا توجد وحدات متاحة' : 'no available units')}
                  </p>
                  {active && supported != null && (
                    <p className={`text-[10px] ${supported === 0 ? 'text-red-600' : 'text-green-700'}`}>
                      {isAr ? `${supported} زاوية مدعومة` : `${supported} angles supported`}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Controls */}
      <div className="space-y-4">
        {/* Quantity */}
        <div className="bg-white rounded-2xl border border-sand/25 shadow-sm p-4">
          <h2 className="text-sm font-bold text-chocolate mb-3">{isAr ? 'عدد المنشورات' : 'How many posts'}</h2>
          <div className="flex gap-2 mb-3">
            {(['total', 'per_project'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                  mode === m ? 'border-copper bg-copper/8 text-chocolate' : 'border-sand/25 text-charcoal/55 hover:bg-cream/60'
                }`}
              >
                {m === 'total'
                  ? (isAr ? 'إجمالي موزّع' : 'Total, distributed')
                  : (isAr ? 'عدد لكل مشروع' : 'Per project')}
              </button>
            ))}
          </div>

          {mode === 'total' ? (
            <div>
              <label className="block text-xs font-bold text-charcoal/60 mb-1">
                {isAr ? `الإجمالي (1 - ${MAX_POSTS_PER_BATCH})` : `Total (1 - ${MAX_POSTS_PER_BATCH})`}
              </label>
              <input
                type="number"
                min={1}
                max={MAX_POSTS_PER_BATCH}
                value={totalCount}
                onChange={(e) => setTotalCount(Number(e.target.value))}
                className="w-full py-2 px-3 rounded-xl border border-sand/30 bg-cream/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/25"
              />
            </div>
          ) : (
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {selectedRows.length === 0 && (
                <p className="text-xs text-charcoal/40">{isAr ? 'اختر مشاريع أولاً' : 'Select projects first'}</p>
              )}
              {selectedRows.map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-xs text-charcoal/70 truncate">{r.name}</span>
                  <input
                    type="number"
                    min={0}
                    max={MAX_POSTS_PER_PROJECT}
                    value={perCounts[r.id] ?? 0}
                    onChange={(e) => setPerCount(r.id, Number(e.target.value))}
                    className="w-16 py-1 px-2 rounded-lg border border-sand/30 bg-cream/40 text-sm text-center focus:outline-none focus:ring-2 focus:ring-copper/25"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Distribution preview */}
          {plan.perProject.length > 0 && (
            <div className="mt-3 pt-3 border-t border-sand/15">
              <p className="text-[11px] font-bold text-charcoal/60 mb-1.5 flex items-center gap-1">
                <Layers size={11} />
                {isAr ? `التوزيع (${plan.total} منشور)` : `Distribution (${plan.total} posts)`}
              </p>
              <div className="space-y-0.5">
                {plan.perProject.map((p) => {
                  const row = rows.find((r) => r.id === p.ourProjectId);
                  return (
                    <div key={p.ourProjectId} className="flex items-center gap-2 text-[11px]">
                      <span className="flex-1 min-w-0 truncate text-charcoal/60">{row?.name ?? p.ourProjectId}</span>
                      <span className="font-bold text-chocolate">{p.requested}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Language + tone */}
        <div className="bg-white rounded-2xl border border-sand/25 shadow-sm p-4 space-y-4">
          <div>
            <h2 className="text-sm font-bold text-chocolate mb-2">{isAr ? 'اللغة' : 'Language'}</h2>
            <div className="grid grid-cols-3 gap-1.5">
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  onClick={() => setLanguage(l.value)}
                  className={`px-2 py-2 rounded-xl border text-[11px] font-bold transition-colors ${
                    language === l.value ? 'border-copper bg-copper/8 text-chocolate' : 'border-sand/25 text-charcoal/55 hover:bg-cream/60'
                  }`}
                >
                  {isAr ? l.ar : l.en}
                </button>
              ))}
            </div>
          </div>
          <div>
            <h2 className="text-sm font-bold text-chocolate mb-2">{isAr ? 'أسلوب الكتابة' : 'Writing style'}</h2>
            <div className="space-y-2">
              {(['short', 'long'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={`w-full text-start p-3 rounded-xl border transition-colors ${
                    tone === t ? 'border-copper bg-copper/6' : 'border-sand/25 hover:bg-cream/60'
                  }`}
                >
                  <p className="text-sm font-bold text-chocolate">
                    {t === 'short' ? (isAr ? 'مختصر (سوشال)' : 'Short (social)') : (isAr ? 'موسّع (رسمي)' : 'Long (formal)')}
                  </p>
                  <p className="text-[11px] text-charcoal/50 mt-0.5">
                    {t === 'short'
                      ? (isAr ? 'عنوان + سطرين — تويتر وانستقرام' : 'Headline + 1-2 lines — social captions')
                      : (isAr ? 'عنوان + فقرة رسمية مع المزايا' : 'Formal paragraph with highlights')}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Warnings + generate */}
        <div className="bg-white rounded-2xl border border-sand/25 shadow-sm p-4">
          {plan.errors.map((e) => (
            <p key={e} className="mb-2 text-[11px] text-red-600 flex items-start gap-1.5">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />{e}
            </p>
          ))}
          {planInfoLoading && (
            <p className="mb-2 text-[11px] text-charcoal/45 flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" />
              {isAr ? 'جارٍ فحص بيانات المشاريع…' : 'Checking project data…'}
            </p>
          )}
          {unsupported.length > 0 && (
            <p className="mb-2 text-[11px] text-red-600 flex items-start gap-1.5">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              {isAr
                ? `لا توجد بيانات كافية لكتابة أي منشور عن: ${unsupported.map((r) => r.name).join('، ')} — سيتم تخطّيها.`
                : `Not enough data to write anything about: ${unsupported.map((r) => r.name).join(', ')} — they will be skipped.`}
            </p>
          )}
          {willReuse.length > 0 && (
            <p className="mb-2 text-[11px] text-amber-700 flex items-start gap-1.5">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              {isAr
                ? `طلبت منشورات أكثر من الزوايا المدعومة لـ: ${willReuse.map((r) => r.name).join('، ')} — ستُعاد بعض الزوايا بصياغة مختلفة.`
                : `You asked for more posts than there are supported angles for: ${willReuse.map((r) => r.name).join(', ')} — some angles will be reused with different wording.`}
            </p>
          )}
          <Button
            className="w-full"
            onClick={onGenerate}
            disabled={generating || plan.errors.length > 0 || plan.total === 0}
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {isAr ? `اكتب ${plan.total || ''} منشورًا` : `Write ${plan.total || ''} posts`}
          </Button>
        </div>

        {batches.length > 0 && (
          <div className="bg-white rounded-2xl border border-sand/25 shadow-sm p-4">
            <h2 className="text-sm font-bold text-chocolate mb-3 flex items-center gap-2">
              <History size={14} className="text-charcoal/40" />
              {isAr ? 'الدفعات السابقة' : 'Previous batches'}
            </h2>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {batches.map((b) => (
                <button
                  key={b.recordId}
                  onClick={() => onOpenBatch(b.recordId)}
                  className="w-full text-start px-3 py-2 rounded-xl border border-sand/20 hover:bg-cream/60 transition-colors"
                >
                  <p className="text-xs font-bold text-chocolate truncate">{b.projects}</p>
                  <p className="text-[11px] text-charcoal/45">
                    {b.when}
                    {' · '}
                    {isAr
                      ? `${b.completed}/${b.requested} · ${b.approved} معتمد`
                      : `${b.completed}/${b.requested} · ${b.approved} approved`}
                    {' · '}
                    {b.language === 'both' ? (isAr ? 'عربي+EN' : 'AR+EN') : b.language.toUpperCase()}
                    {' · '}
                    {b.tone === 'long' ? (isAr ? 'موسّع' : 'long') : (isAr ? 'مختصر' : 'short')}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

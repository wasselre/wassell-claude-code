/**
 * The strategy document itself.
 *
 * A strategy is not a title and a line of positioning. It is the set of choices
 * the whole plan rests on: who we are for, what problem we solve, what we
 * promise, which markets, which funnel, what each channel is for, how we judge
 * content, how we measure — and, most importantly, what we will NOT do.
 *
 * Priorities and non-priorities sit SIDE BY SIDE for that reason. A strategy
 * that only lists priorities has not actually chosen anything; the pairing is
 * the point, so the layout makes the empty column obvious.
 *
 * Approved and superseded versions render read-only. The database enforces that
 * (mkt_tg_strategy_immutable); this screen simply stops offering an edit that
 * would be rejected, and says why.
 */
import { useState } from 'react';
import { Plus, X, Lock, ChevronUp, ChevronDown, Check } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { Section, CaveatStrip } from '@/pages/MarketingIntelligence/components/shared';
import { saveStrategy, type StrategyVersion } from '@/lib/marketingMgmt/v2';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One entry in a strategy list. `en` stays optional: these are statements the
 *  team writes in Arabic, and demanding an English twin for thirteen lists is a
 *  reliable way to get thirteen half-filled lists. It can be added later
 *  without a migration. */
interface Entry { ar: string; en?: string | null; note?: string | null }

const asEntries = (v: unknown): Entry[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? { ar: x } : (x as Entry))).filter((e) => e && typeof e.ar === 'string')
    : [];

/** Every list field, with the label and the prompt that says what belongs in it.
 *  The prompt matters more than the label — "الجماهير ذات الأولوية" tells you
 *  the name of the box, "من نخدمه أولاً" tells you what to type. */
const LISTS = {
  priority_audiences: {
    ar: 'الجماهير ذات الأولوية', en: 'Priority audiences',
    hintAr: 'من نخدمه أولاً؟ مثال: مشترٍ أول 30–45 في شمال الرياض',
    hintEn: 'Who do we serve first? e.g. first-time buyer, 30–45, north Riyadh' },
  customer_problems: {
    ar: 'مشكلات العملاء', en: 'Customer problems',
    hintAr: 'ما الذي يعيق القرار؟ مثال: لا يثق بالأسعار المعلنة',
    hintEn: 'What blocks the decision? e.g. does not trust listed prices' },
  value_propositions: {
    ar: 'عروض القيمة', en: 'Value propositions',
    hintAr: 'ما الذي نعد به ويصعب تقليده؟',
    hintEn: 'What do we promise that is hard to copy?' },
  priority_markets: {
    ar: 'الأسواق ذات الأولوية', en: 'Priority markets',
    hintAr: 'مدن وأحياء بعينها', hintEn: 'Specific cities and districts' },
  property_categories: {
    ar: 'فئات العقارات', en: 'Property categories',
    hintAr: 'شقق، فلل، أراضٍ، تجاري…', hintEn: 'Apartments, villas, land, commercial…' },
  funnel: {
    ar: 'قمع التسويق', en: 'Marketing funnel',
    hintAr: 'مراحل رحلة المشتري كما نراها', hintEn: 'The buyer journey stages as we define them' },
  channel_roles: {
    ar: 'أدوار القنوات', en: 'Channel roles',
    hintAr: 'ما وظيفة كل قناة؟ مثال: تيك توك للوعي، واتساب للتحويل',
    hintEn: 'What is each channel FOR? e.g. TikTok for reach, WhatsApp for conversion' },
  content_principles: {
    ar: 'مبادئ المحتوى', en: 'Content principles',
    hintAr: 'قواعد نحكم بها على أي عمل قبل نشره',
    hintEn: 'Rules we judge any piece of work against' },
  measurement_principles: {
    ar: 'مبادئ القياس', en: 'Measurement principles',
    hintAr: 'ما الذي نعتبره دليلاً، وما الذي نرفضه؟',
    hintEn: 'What counts as evidence, and what does not?' },
  strategic_priorities: {
    ar: 'الأولويات الاستراتيجية', en: 'Strategic priorities',
    hintAr: 'ما الذي سنركّز عليه هذا العام', hintEn: 'What we will focus on' },
  not_priorities: {
    ar: 'ما لن نركّز عليه', en: 'What we will NOT prioritise',
    hintAr: 'قرارات الرفض الصريحة — بلا هذه القائمة لم تختر شيئاً',
    hintEn: 'Explicit refusals — without this list nothing has been chosen' },
  assumptions: {
    ar: 'الافتراضات', en: 'Assumptions',
    hintAr: 'ما نبني عليه وقد يكون خاطئاً', hintEn: 'What we are betting on that could be wrong' },
  risks: {
    ar: 'المخاطر', en: 'Risks',
    hintAr: 'ما الذي يُفشل هذه الاستراتيجية؟', hintEn: 'What would make this strategy fail?' },
} as const;

type ListKey = keyof typeof LISTS;

export function StrategyEditor({ version, isAr, onSaved, onError }: {
  version: StrategyVersion; isAr: boolean;
  /** Receives the UPDATED row so the parent can patch its copy in place. It must
   *  not refetch: a refetch on every field blur swaps this whole section for a
   *  spinner, which remounts the editor, resets uncontrolled inputs and steals
   *  focus mid-typing. */
  onSaved: (updated: StrategyVersion) => void;
  onError: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  const readOnly = version.status !== 'draft' && version.status !== 'in_review';
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());

  const save = async (patch: Record<string, unknown>, key: string) => {
    setSaving((s) => new Set(s).add(key));
    try {
      const r = await saveStrategy(patch, version.id);
      onSaved(r.strategy);
      setSaved((s) => new Set(s).add(key));
      setTimeout(() => setSaved((s) => { const n = new Set(s); n.delete(key); return n; }), 1800);
    } catch (e) { onError(err(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };

  const mark = (k: string) => (
    <>
      {saving.has(k) && <span className="ms-1 text-copper">•</span>}
      {saved.has(k) && <Check className="ms-1 inline h-3 w-3 text-emerald-600" />}
    </>
  );

  const text = (key: string, label: string, value: string | null, rows = 0, span = '') => (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{label}{mark(key)}</span>
      {readOnly ? (
        <div className="min-h-[32px] whitespace-pre-wrap rounded-lg bg-cream-light px-2.5 py-1.5 text-[12.5px] text-charcoal/80">
          {value || <span className="text-charcoal/30">—</span>}
        </div>
      ) : rows > 0 ? (
        <textarea rows={rows} defaultValue={value ?? ''} className={FIELD}
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (value ?? '')) void save({ [key]: v || null }, key); }} />
      ) : (
        <input defaultValue={value ?? ''} className={FIELD}
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (value ?? '')) void save({ [key]: v || null }, key); }} />
      )}
    </label>
  );

  const date = (key: string, label: string, value: string | null) => (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{label}{mark(key)}</span>
      {readOnly ? (
        <div className="rounded-lg bg-cream-light px-2.5 py-1.5 text-[12.5px] text-charcoal/80">
          {value || <span className="text-charcoal/30">—</span>}
        </div>
      ) : (
        <input type="date" defaultValue={value ?? ''} className={FIELD}
          onChange={(e) => void save({ [key]: e.target.value || null }, key)} />
      )}
    </label>
  );

  return (
    <div className="space-y-3">
      {readOnly && (
        <CaveatStrip>
          {isAr
            ? 'هذه النسخة معتمدة أو مُستبدلة، لذا لا تُعدَّل — الخطط والحملات نُفِّذت تحتها. التغيير يعني إنشاء نسخة جديدة.'
            : 'This version is approved or superseded, so it cannot be edited — plans and campaigns were executed under it. A change means a new version.'}
        </CaveatStrip>
      )}

      {/* ── identity ── */}
      <Section title={isAr ? 'التعريف' : 'Identity'}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {text('name_ar', isAr ? 'الاسم' : 'Name', version.name_ar)}
          {text('name_en', isAr ? 'الاسم بالإنجليزية' : 'Name (English)', version.name_en)}
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
              {isAr ? 'المسؤول' : 'Owner'}{mark('owner_user_id')}
            </span>
            {readOnly ? (
              <div className="rounded-lg bg-cream-light px-2.5 py-1.5 text-[12.5px] text-charcoal/80">
                {users.find((u) => u.id === version.owner_user_id)
                  ? ((isAr ? users.find((u) => u.id === version.owner_user_id)!.name_ar
                           : users.find((u) => u.id === version.owner_user_id)!.name_en) || '—')
                  : <span className="text-charcoal/30">—</span>}
              </div>
            ) : (
              <select defaultValue={version.owner_user_id ?? ''} className={FIELD}
                onChange={(e) => void save({ owner_user_id: e.target.value || null }, 'owner_user_id')}>
                <option value="">{isAr ? '— غير محدد —' : '— unassigned —'}</option>
                {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>)}
              </select>
            )}
          </label>
          {date('effective_date', isAr ? 'تاريخ السريان' : 'Effective from', version.effective_date)}
          {date('expires_at', isAr ? 'تاريخ الانتهاء' : 'Expires', version.expires_at)}
          {text('summary_ar', isAr ? 'الملخص' : 'Summary', version.summary_ar, 3, 'sm:col-span-2 lg:col-span-3')}
        </div>
      </Section>

      {/* ── positioning & value ── */}
      <Section title={isAr ? 'التموضع والقيمة' : 'Positioning & value'}
        subtitle={isAr ? 'لماذا يختارنا العميل بدل غيرنا' : 'Why a customer picks us over the alternative'}>
        <div className="grid gap-3">
          {text('positioning', isAr ? 'التموضع' : 'Positioning', version.positioning, 2)}
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <ListField k="customer_problems" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="value_propositions" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
        </div>
      </Section>

      {/* ── audience & market ── */}
      <Section title={isAr ? 'الجمهور والسوق' : 'Audience & market'}>
        <div className="grid gap-3 lg:grid-cols-3">
          <ListField k="priority_audiences" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="priority_markets" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="property_categories" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
        </div>
      </Section>

      {/* ── funnel & channels ── */}
      <Section title={isAr ? 'القمع والقنوات' : 'Funnel & channels'}>
        <div className="grid gap-3 lg:grid-cols-2">
          <ListField k="funnel" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="channel_roles" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
        </div>
        <div className="mt-3">
          {text('organic_paid_strategy', isAr ? 'استراتيجية العضوي والمدفوع' : 'Organic vs paid strategy',
            version.organic_paid_strategy, 2)}
        </div>
      </Section>

      {/* ── the choice: priorities vs refusals, side by side ── */}
      <Section title={isAr ? 'الأولويات' : 'Priorities'}
        subtitle={isAr ? 'العمود الأيسر هو ما يجعل هذه استراتيجية — قائمة بلا رفض ليست اختياراً'
                       : 'The right-hand column is what makes this a strategy — a list with no refusals is not a choice'}>
        <div className="grid gap-3 lg:grid-cols-2">
          <ListField k="strategic_priorities" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="not_priorities" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} emphasis />
        </div>
      </Section>

      {/* ── principles ── */}
      <Section title={isAr ? 'المبادئ' : 'Principles'}>
        <div className="grid gap-3 lg:grid-cols-2">
          <ListField k="content_principles" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="measurement_principles" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
        </div>
      </Section>

      {/* ── what could be wrong ── */}
      <Section title={isAr ? 'الافتراضات والمخاطر' : 'Assumptions & risks'}>
        <div className="grid gap-3 lg:grid-cols-2">
          <ListField k="assumptions" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
          <ListField k="risks" version={version} isAr={isAr} readOnly={readOnly} onSave={save} mark={mark} />
        </div>
      </Section>
    </div>
  );
}

/** A repeating list of statements. Add, edit, reorder, remove — saved as a whole
 *  array, because the order carries meaning (first priority is first). */
function ListField({ k, version, isAr, readOnly, onSave, mark, emphasis = false }: {
  k: ListKey; version: StrategyVersion; isAr: boolean; readOnly: boolean;
  onSave: (patch: Record<string, unknown>, key: string) => Promise<void>;
  mark: (k: string) => React.ReactNode; emphasis?: boolean;
}) {
  const meta = LISTS[k];
  const [items, setItems] = useState<Entry[]>(() => asEntries((version as unknown as Record<string, unknown>)[k]));
  const [draft, setDraft] = useState('');

  const commit = (next: Entry[]) => { setItems(next); void onSave({ [k]: next }, k); };
  const add = () => {
    const v = draft.trim(); if (!v) return;
    commit([...items, { ar: v }]); setDraft('');
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= items.length) return;
    const next = [...items]; [next[i], next[j]] = [next[j]!, next[i]!]; commit(next);
  };

  return (
    <div className={`rounded-xl border p-3 ${emphasis
      ? 'border-amber-300/70 bg-amber-50/40' : 'border-sand/50 bg-white/60'}`}>
      <div className="mb-0.5 text-[12px] font-semibold text-charcoal">
        {isAr ? meta.ar : meta.en}{mark(k)}
      </div>
      <p className="mb-2 text-[10.5px] leading-relaxed text-charcoal/45">
        {isAr ? meta.hintAr : meta.hintEn}
      </p>

      {items.length === 0 ? (
        <p className={`text-[11.5px] ${emphasis ? 'text-amber-800' : 'text-charcoal/35'}`}>
          {emphasis
            ? (isAr ? 'فارغة — لم تُرفض أي أولوية بعد' : 'Empty — nothing has been ruled out yet')
            : (isAr ? 'لا عناصر' : 'No entries')}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {items.map((it, i) => (
            <li key={`${k}-${i}`} className="flex items-start gap-1.5">
              <span className="mt-1.5 w-4 shrink-0 text-end text-[10px] tabular-nums text-charcoal/35">{i + 1}</span>
              {readOnly ? (
                <span className="flex-1 py-1 text-[12px] leading-relaxed text-charcoal/80">{it.ar}</span>
              ) : (
                <>
                  <input defaultValue={it.ar}
                    className="flex-1 rounded border border-sand/50 bg-white px-2 py-1 text-[12px] focus:border-copper focus:outline-none"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v === it.ar) return;
                      if (!v) { commit(items.filter((_, j) => j !== i)); return; }
                      commit(items.map((x, j) => (j === i ? { ...x, ar: v } : x)));
                    }} />
                  <span className="flex shrink-0 items-center">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                      className="p-0.5 text-charcoal/25 hover:text-charcoal disabled:opacity-25">
                      <ChevronUp className="h-3 w-3" /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1}
                      className="p-0.5 text-charcoal/25 hover:text-charcoal disabled:opacity-25">
                      <ChevronDown className="h-3 w-3" /></button>
                    <button type="button" onClick={() => commit(items.filter((_, j) => j !== i))}
                      className="p-0.5 text-charcoal/25 hover:text-red-600">
                      <X className="h-3 w-3" /></button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      {!readOnly && (
        <div className="mt-2 flex items-center gap-1.5">
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder={isAr ? 'أضف عنصراً…' : 'Add an entry…'}
            className="flex-1 rounded border border-sand/50 bg-white px-2 py-1 text-[12px] focus:border-copper focus:outline-none" />
          <button type="button" onClick={add} disabled={!draft.trim()}
            className="rounded border border-sand/60 p-1 text-charcoal/45 hover:border-copper/50 hover:text-copper disabled:opacity-30">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Small read-only summary used in the version list, so a reviewer can see how
 *  much of the strategy is actually filled in before approving it. */
export function StrategyCompleteness({ version, isAr }: { version: StrategyVersion; isAr: boolean }) {
  const keys = Object.keys(LISTS) as ListKey[];
  const filled = keys.filter((k) => asEntries((version as unknown as Record<string, unknown>)[k]).length > 0).length;
  const hasPositioning = Boolean(version.positioning?.trim());
  const hasRefusals = asEntries((version as unknown as Record<string, unknown>).not_priorities).length > 0;
  return (
    <span className="flex items-center gap-2 text-[10.5px] text-charcoal/45">
      <span className="tabular-nums">
        {isAr ? `${filled}/${keys.length} قوائم` : `${filled}/${keys.length} lists`}
      </span>
      {!hasPositioning && (
        <span className="text-amber-700">{isAr ? 'بلا تموضع' : 'no positioning'}</span>)}
      {!hasRefusals && (
        <span className="text-amber-700">{isAr ? 'بلا قائمة رفض' : 'no refusals'}</span>)}
      {version.status !== 'draft' && <Lock className="h-3 w-3 text-charcoal/25" />}
    </span>
  );
}

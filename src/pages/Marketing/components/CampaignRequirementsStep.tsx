/**
 * Step 1 of the campaign wizard — the REQUIREMENTS, not the content.
 *
 * The old builder asked you to type a row per content piece. This asks the
 * question a manager actually answers: which projects, how much of each, on
 * which platforms, over which dates, how often. The engine turns that into the
 * individual pieces, their publishing slots, and everyone's calendar — and it
 * can only do that if the requirement is stated as a QUANTITY.
 *
 * Nothing here creates anything. The only button that writes is «اعتماد» in
 * step 3.
 */
import type { MosProject } from '@/lib/marketingOS/client';
import { PLATFORM_LABELS } from '@/lib/marketingOS/client';
import { ORGANIC_PLATFORMS, PAID_PLATFORMS } from '@/lib/marketingOS/scheduling';
import { Field } from './kit';
import ProjectMultiSelect from './ProjectMultiSelect';
import {
  frequencyOf, quantityOf, requestedItemCount,
  type RequirementsDraft,
} from '../lib/planPresentation';
import { num } from '../lib/format';

const WEEKDAYS: Array<{ n: number; ar: string; en: string }> = [
  { n: 0, ar: 'الأحد', en: 'Sun' },
  { n: 1, ar: 'الاثنين', en: 'Mon' },
  { n: 2, ar: 'الثلاثاء', en: 'Tue' },
  { n: 3, ar: 'الأربعاء', en: 'Wed' },
  { n: 4, ar: 'الخميس', en: 'Thu' },
  { n: 5, ar: 'الجمعة', en: 'Fri' },
  { n: 6, ar: 'السبت', en: 'Sat' },
];

const platformLabelOf = (p: string, isAr: boolean): string => {
  const l = PLATFORM_LABELS[p];
  return l ? (isAr ? l.ar : l.en) : p;
};

/** A small whole-number stepper — the quantity table's only input shape. */
function QtyInput({
  value, onChange, ariaLabel, disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <input
      className="inp ltr"
      style={{ width: 74, textAlign: 'center', padding: '6px 8px' }}
      inputMode="numeric"
      aria-label={ariaLabel}
      disabled={disabled}
      value={String(value)}
      onChange={(e) => {
        const n = Number(e.target.value.replace(/[^\d]/g, ''));
        onChange(Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
      }}
    />
  );
}

export default function CampaignRequirementsStep({
  draft, onChange, projects, projectName, isAr,
}: {
  draft: RequirementsDraft;
  onChange: (next: RequirementsDraft) => void;
  projects: MosProject[];
  projectName: (id: string | null | undefined) => string;
  isAr: boolean;
}) {
  const patch = (p: Partial<RequirementsDraft>): void => onChange({ ...draft, ...p });
  const isPaid = draft.kind === 'paid';
  const platformPool: readonly string[] = isPaid ? PAID_PLATFORMS : ORGANIC_PLATFORMS;
  const total = requestedItemCount(draft);

  const setQty = (projectId: string, key: 'posts' | 'videos', v: number): void => {
    const current = quantityOf(draft, projectId);
    patch({ quantities: { ...draft.quantities, [projectId]: { ...current, [key]: v } } });
  };

  const togglePlatform = (p: string): void => {
    const on = draft.platforms.includes(p);
    patch({ platforms: on ? draft.platforms.filter((x) => x !== p) : [...draft.platforms, p] });
  };

  const setFreq = (platform: string, next: Partial<{ perDay: number; weekdays: number[] | null }>): void => {
    const cur = frequencyOf(draft, platform);
    patch({ frequency: { ...draft.frequency, [platform]: { ...cur, ...next } } });
  };

  const toggleWeekday = (platform: string, n: number): void => {
    const cur = frequencyOf(draft, platform);
    const set = cur.weekdays ?? WEEKDAYS.map((w) => w.n);
    const next = set.includes(n) ? set.filter((x) => x !== n) : [...set, n];
    // All seven selected means "no restriction" — store it as null, which is
    // what the engine reads as «كل الأيام» rather than a seven-day mask.
    setFreq(platform, { weekdays: next.length === 7 ? null : next });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ── projects + the quantity table ───────────────────────────── */}
      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'المشاريع والكميات' : 'Projects and quantities'}
        </div>
        <ProjectMultiSelect
          projects={projects}
          value={draft.projectIds}
          onChange={(ids) => patch({ projectIds: ids })}
          isAr={isAr}
        />

        <div className="card" style={{ marginTop: 11 }}>
          <div className="card-h">
            <h4>{isAr ? 'لكل مشروع' : 'Per project'}</h4>
            <span className="r">
              {isAr
                ? `${num(total, true)} بندًا في المجموع`
                : `${total} items in total`}
            </span>
          </div>
          <div className="card-b" style={{ paddingBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="lbl">{isAr ? 'الافتراضي للجميع' : 'Set for all'}</span>
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>{isAr ? 'منشورات' : 'posts'}</span>
              <QtyInput
                value={draft.globalPosts}
                ariaLabel={isAr ? 'منشورات لكل مشروع' : 'posts per project'}
                onChange={(v) => patch({ globalPosts: v })}
              />
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>{isAr ? 'فيديو' : 'videos'}</span>
              <QtyInput
                value={draft.globalVideos}
                ariaLabel={isAr ? 'فيديو لكل مشروع' : 'videos per project'}
                onChange={(v) => patch({ globalVideos: v })}
              />
              {Object.keys(draft.quantities).length > 0 && (
                <button
                  type="button"
                  className="fbtn"
                  style={{ marginInlineStart: 'auto' }}
                  onClick={() => patch({ quantities: {} })}
                >
                  {isAr ? 'إلغاء كل التخصيصات' : 'Clear all overrides'}
                </button>
              )}
            </div>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'المشروع' : 'Project'}</th>
                  <th className="num">{isAr ? 'منشورات' : 'Posts'}</th>
                  <th className="num">{isAr ? 'فيديو' : 'Videos'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.projectIds.map((id) => {
                  const q = quantityOf(draft, id);
                  const overridden = draft.quantities[id] !== undefined;
                  return (
                    <tr key={id}>
                      <td className="ttl">
                        {/* thumb slot — the project's cover once projects carry one */}
                        {projectName(id)}
                      </td>
                      <td className="num">
                        <QtyInput
                          value={q.posts}
                          ariaLabel={`${projectName(id)} — ${isAr ? 'منشورات' : 'posts'}`}
                          onChange={(v) => setQty(id, 'posts', v)}
                        />
                      </td>
                      <td className="num">
                        <QtyInput
                          value={q.videos}
                          ariaLabel={`${projectName(id)} — ${isAr ? 'فيديو' : 'videos'}`}
                          onChange={(v) => setQty(id, 'videos', v)}
                        />
                      </td>
                      <td style={{ width: 120 }}>
                        {overridden
                          ? (
                            <button
                              type="button"
                              className="fbtn"
                              onClick={() => {
                                const next = { ...draft.quantities };
                                delete next[id];
                                patch({ quantities: next });
                              }}
                            >
                              {isAr ? 'اتبع الافتراضي' : 'Follow default'}
                            </button>
                          )
                          : <span className="tag">{isAr ? 'الافتراضي' : 'default'}</span>}
                      </td>
                    </tr>
                  );
                })}
                {draft.projectIds.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--mute)' }}>
                      {isAr ? 'لم تُختر مشاريع بعد.' : 'No projects selected yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── platforms ───────────────────────────────────────────────── */}
      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isPaid ? (isAr ? 'قنوات الإعلان' : 'Ad channels') : (isAr ? 'منصات النشر' : 'Publishing platforms')}
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {platformPool.map((p) => (
            <button
              key={p}
              type="button"
              className={`fbtn${draft.platforms.includes(p) ? ' on' : ''}`}
              onClick={() => togglePlatform(p)}
            >
              {platformLabelOf(p, isAr)}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 6, lineHeight: 1.8 }}>
          {isAr
            ? 'كل منصة تصبح حملة فرعية مستقلة لها جدولها وأرقامها، تحت هذه الحملة الأم.'
            : 'Each platform becomes its own child campaign with its own schedule and numbers, under this parent.'}
        </div>
      </div>

      {/* ── dates ───────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: isPaid ? '1fr 1fr' : '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'بداية النشر' : 'Publishing starts'}>
          <input
            type="date"
            className="inp ltr"
            value={draft.rangeStart}
            onChange={(e) => patch({ rangeStart: e.target.value })}
          />
        </Field>
        <Field label={isAr ? 'نهاية النشر' : 'Publishing ends'}>
          <input
            type="date"
            className="inp ltr"
            value={draft.rangeEnd}
            onChange={(e) => patch({ rangeEnd: e.target.value })}
          />
        </Field>
      </div>

      {/* ── frequency per platform ──────────────────────────────────── */}
      {!isPaid && draft.platforms.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h4>{isAr ? 'التكرار لكل منصة' : 'Frequency per platform'}</h4>
            <span className="r">
              {isAr ? 'كم منشورًا في اليوم، وفي أي أيام' : 'how many a day, and on which days'}
            </span>
          </div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {draft.platforms.map((p) => {
              const f = frequencyOf(draft, p);
              const all = f.weekdays === null;
              return (
                <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 12.5 }}>{platformLabelOf(p, isAr)}</b>
                    <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                      {isAr ? 'منشورات/يوم' : 'posts/day'}
                    </span>
                    <QtyInput
                      value={f.perDay}
                      ariaLabel={`${platformLabelOf(p, isAr)} — ${isAr ? 'منشورات في اليوم' : 'posts per day'}`}
                      onChange={(v) => setFreq(p, { perDay: Math.max(1, v) })}
                    />
                    <button
                      type="button"
                      className={`fbtn${all ? ' on' : ''}`}
                      onClick={() => setFreq(p, { weekdays: all ? [0, 1, 2, 3, 4, 6] : null })}
                    >
                      {isAr ? 'كل الأيام' : 'Every day'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                    {WEEKDAYS.map((w) => {
                      const on = all || (f.weekdays ?? []).includes(w.n);
                      return (
                        <button
                          key={w.n}
                          type="button"
                          className={`fbtn${on ? ' on' : ''}`}
                          onClick={() => toggleWeekday(p, w.n)}
                        >
                          {isAr ? w.ar : w.en}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── cross-post ──────────────────────────────────────────────── */}
      {!isPaid && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={draft.crossPost}
            onChange={(e) => patch({ crossPost: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            <b style={{ fontSize: 12.5 }}>{isAr ? 'تصميم واحد لكل المنصات' : 'One creative across every platform'}</b>
            <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.8 }}>
              {isAr
                ? 'يُنتج التصميم مرة واحدة ويُنشر على كل منصة مختارة. بدونه، لكل منصة تصاميمها الخاصة — والعمل يتضاعف بعدد المنصات.'
                : 'The creative is produced once and published on every selected platform. Without it, each platform gets its own creatives — and the production work multiplies by the number of platforms.'}
            </div>
          </span>
        </label>
      )}

      {/* ── paid: the refresh policy ────────────────────────────────── */}
      {isPaid && (
        <div className="card">
          <div className="card-h">
            <h4>{isAr ? 'سياسة تحديث التصاميم' : 'Creative refresh policy'}</h4>
            <span className="r">{isAr ? 'افتراضاتها من الإعدادات' : 'defaults from Settings'}</span>
          </div>
          <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 13 }}>
            <Field label={isAr ? 'عدد التصاميم النشطة' : 'Slate size'}>
              <QtyInput
                value={draft.refresh.slate_size}
                ariaLabel={isAr ? 'عدد التصاميم النشطة' : 'slate size'}
                onChange={(v) => patch({ refresh: { ...draft.refresh, slate_size: Math.max(1, v) } })}
              />
            </Field>
            <Field label={isAr ? 'أقل عدد يُبقى عليه' : 'Keep at least'}>
              <QtyInput
                value={draft.refresh.keep_min}
                ariaLabel={isAr ? 'أقل عدد يُبقى عليه' : 'keep min'}
                onChange={(v) => patch({ refresh: { ...draft.refresh, keep_min: v } })}
              />
            </Field>
            <Field label={isAr ? 'طول الدورة (أيام)' : 'Cycle length (days)'}>
              <QtyInput
                value={draft.refresh.cycle_days}
                ariaLabel={isAr ? 'طول الدورة' : 'cycle days'}
                onChange={(v) => patch({ refresh: { ...draft.refresh, cycle_days: Math.max(1, v) } })}
              />
            </Field>
            <Field label={isAr ? 'أقل مدة متبقية للتحديث' : 'Minimum remaining days'}>
              <QtyInput
                value={draft.refresh.min_remaining_days}
                ariaLabel={isAr ? 'أقل مدة متبقية' : 'min remaining days'}
                onChange={(v) => patch({ refresh: { ...draft.refresh, min_remaining_days: v } })}
              />
            </Field>
            <Field label={isAr ? 'مهلة الإنتاج (أيام عمل)' : 'Production lead (working days)'}>
              <QtyInput
                value={draft.refresh.lead_time_working_days}
                ariaLabel={isAr ? 'مهلة الإنتاج' : 'lead time'}
                onChange={(v) => patch({ refresh: { ...draft.refresh, lead_time_working_days: Math.max(1, v) } })}
              />
            </Field>
            <Field label={isAr ? 'سياسة التصميم الخامس' : 'Fifth-creative policy'}>
              <div className="seg" style={{ width: '100%' }}>
                {(['A', 'B'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={draft.refresh.fifth_policy === k ? 'on' : ''}
                    style={{ flex: 1, textAlign: 'center' }}
                    onClick={() => patch({ refresh: { ...draft.refresh, fifth_policy: k } })}
                  >
                    {k === 'A' ? (isAr ? 'أ' : 'A') : (isAr ? 'ب' : 'B')}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
            {draft.refresh.fifth_policy === 'A'
              ? (isAr
                  ? 'أ — يُنتَج تصميم خامس مع كل تحديث، فاستبدال الخمسة متاح دائمًا يوم التحديث. أغلى، ولا ينتظر أحدًا. (إن وُجد تصميم احتياطي مؤكَّد في البنك قبل بدء إنتاج الدورة، تُنتج أربعة فقط.)'
                  : 'A — a fifth creative is produced with every refresh, so replacing all five is always available on the day. Costlier, waits for nobody. (If a banked spare is a known fact before that cycle’s production starts, only four are produced.)')
              : (isAr
                  ? 'ب — أربعة بدائل مضمونة لكل تحديث. اختيار «استبدال الخمسة» يفتح تصميمًا إضافيًا بتاريخ جهوزيته الحقيقي، وحتى ذلك الحين يبقى أفضل تصميم قائم يعمل.'
                  : 'B — four guaranteed replacements per refresh. Choosing “replace all five” opens an extra creative with its real ready date; until then the best-ranked outgoing creative keeps running.')}
          </div>
        </div>
      )}
    </div>
  );
}

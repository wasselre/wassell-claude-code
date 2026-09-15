/**
 * The month's three project slots — «المشاريع الثلاثة» (mockup `s-month.html`).
 *
 * Two components, one shape: the PLAN tense shows the suggestion and lets you
 * change any slot; the REPORT tense shows the same three cards with live
 * numbers instead of expectations. That is the whole idea of the screen — one
 * page in two tenses, the layout constant, only the tense changing.
 *
 * THE SUGGESTION IS LABELLED, NOT ASSERTED. Decision D6 settled that "days
 * since last featured" has no source yet — nothing has ever published — so it
 * is `greatest(last day with spend, last content created)` and the card SAYS SO
 * under the number. An unlabelled proxy is how a stand-in quietly becomes a
 * fact nobody re-examines.
 *
 * COST PER QUALIFIED LEAD IS RENDERED AS A COUNT, not as a second riyal figure
 * next to cost per lead (the D5 note). «١٣ مؤهل من ١٧» is honest at any triage
 * state; two near-identical currency figures under two Arabic labels are not,
 * because an ad lead onboards at «جديد» — which counts as qualified — so on the
 * 20th the two numbers are the same number wearing different words.
 */
import { useMemo, useState } from 'react';
import type { MosMonthRankingRow, MosMonthReportProject } from '@/lib/marketingOS/client';
import { Modal } from './kit';
import { num, money } from '../lib/format';
import { monthDate, sar1 } from './MonthDates';

const AR_LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز'];
const EN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const SLOT_CLASS = ['s-a', 's-b', 's-c'];

export const slotKey = (i: number, isAr: boolean): string =>
  (isAr ? AR_LETTERS[i] : EN_LETTERS[i]) ?? String(i + 1);

export interface MonthSlot {
  project_id: string;
  project_name: string | null;
  ranking: MosMonthRankingRow | null;
}

/* ------------------------------------------------------------------ */
/* the picker                                                          */
/* ------------------------------------------------------------------ */

function RankingPicker({
  ranking, chosen, isAr, onPick, onClose, slotLabel,
}: {
  ranking: MosMonthRankingRow[];
  chosen: string[];
  isAr: boolean;
  onPick: (projectId: string) => void;
  onClose: () => void;
  slotLabel: string;
}) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim();
    if (!needle) return ranking;
    return ranking.filter((r) => (r.project_name ?? '').includes(needle));
  }, [ranking, q]);

  return (
    <Modal
      title={isAr ? `اختر مشروع الخانة ${slotLabel}` : `Pick the project for slot ${slotLabel}`}
      sub={isAr
        ? 'الترتيب من ثلاثة أرقام فقط: الوحدات المتاحة، والأيام منذ آخر إبراز، وتكلفة العميل المؤهَّل في آخر شهر عُرض فيه.'
        : 'Ranked on three numbers only: available units, days since last featured, and last month’s cost per qualified lead.'}
      onClose={onClose}
      wide
    >
      <input
        className="btn"
        style={{ width: '100%', marginBlockEnd: 12, fontWeight: 400 }}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={isAr ? 'ابحث باسم المشروع' : 'Search by project name'}
      />
      <div className="tbl-wrap" style={{ maxHeight: 440, overflowY: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{isAr ? 'المشروع' : 'Project'}</th>
              <th className="num">{isAr ? 'وحدات متاحة' : 'Available'}</th>
              <th>{isAr ? 'آخر إبراز' : 'Last featured'}</th>
              <th className="num">{isAr ? 'تكلفة العميل المؤهَّل' : 'Cost / qualified'}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isChosen = chosen.includes(r.project_id);
              return (
                <tr key={r.project_id} className={isChosen ? 'hl' : undefined}>
                  <td className="ttl">{r.project_name ?? r.project_id.slice(0, 8)}</td>
                  <td className="num">{num(r.available_units, isAr)}</td>
                  <td>
                    {r.last_featured_on
                      ? `${monthDate(r.last_featured_on, isAr)}${r.days_since_featured !== null
                        ? ` · ${isAr ? 'قبل' : ''} ${num(r.days_since_featured, isAr)} ${isAr ? 'يومًا' : 'days ago'}`
                        : ''}`
                      : (isAr ? 'لم يُبرَز من قبل' : 'never featured')}
                  </td>
                  <td className="num">
                    {r.cost_per_qualified_lead !== null
                      ? sar1(r.cost_per_qualified_lead, isAr)
                      : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={isChosen}
                      onClick={() => { onPick(r.project_id); onClose(); }}
                    >
                      {isChosen ? (isAr ? 'مختار' : 'chosen') : (isAr ? 'اختر' : 'Pick')}
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="mth-tiny">{isAr ? 'لا مشروع مطابق' : 'No matching project'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* the plan tense                                                      */
/* ------------------------------------------------------------------ */

export function MonthProjectSlots({
  slots, slotCount, ranking, isAr, canEdit, onChange,
}: {
  slots: MonthSlot[];
  slotCount: number;
  ranking: MosMonthRankingRow[];
  isAr: boolean;
  canEdit: boolean;
  onChange: (index: number, projectId: string) => void;
}) {
  const [picking, setPicking] = useState<number | null>(null);
  const chosen = slots.map((s) => s.project_id);
  const rankOf = useMemo(
    () => new Map(ranking.map((r) => [r.project_id, r])), [ranking],
  );

  return (
    <>
      <div className="mth-slots">
        {Array.from({ length: slotCount }).map((_, i) => {
          const slot = slots[i];
          const r = slot ? (slot.ranking ?? rankOf.get(slot.project_id) ?? null) : null;
          const cls = SLOT_CLASS[i] ?? 's-a';
          if (!slot) {
            return (
              <div className={`mth-slot s-empty`} key={`empty-${i}`}>
                <span className="k">{slotKey(i, isAr)}</span>
                <div className="nm">{isAr ? 'خانة فارغة' : 'Empty slot'}</div>
                <div className="mt">
                  {isAr
                    ? 'لا مشروع في هذه الخانة — ستتحوّل أيام نشرها إلى صفوف «عام» بلا مشروع.'
                    : 'No project here — its posting days become general rows with no project.'}
                </div>
                <div className="mth-row">
                  <button type="button" className="btn btn-sm" disabled={!canEdit}
                    onClick={() => setPicking(i)}>
                    {isAr ? 'اختر مشروعًا' : 'Pick a project'}
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div className={`mth-slot ${cls}`} key={slot.project_id}>
              <span className="k">{slotKey(i, isAr)}</span>
              <div className="nm">{slot.project_name ?? slot.project_id.slice(0, 8)}</div>
              <div className="mt">
                {r
                  ? (
                    <>
                      <b>{num(r.available_units, isAr)}</b>{' '}
                      {isAr ? 'وحدة متاحة' : 'units available'}
                      {r.price_from !== null && (
                        <> · {isAr ? 'تبدأ من' : 'from'} {money(r.price_from, isAr)}</>
                      )}
                      <br />
                      {r.last_featured_on
                        ? (
                          <>
                            {isAr ? 'آخر إبراز' : 'Last featured'} {monthDate(r.last_featured_on, isAr)}
                            {r.days_since_featured !== null && (
                              <> — {isAr ? 'قبل' : ''} {num(r.days_since_featured, isAr)} {isAr ? 'يومًا' : 'days ago'}</>
                            )}
                            <br />
                            <span style={{ fontSize: 10.5 }}>
                              {isAr
                                ? `محسوب من ${r.last_featured_source === 'spend' ? 'آخر يوم إنفاق' : 'آخر محتوى أُنشئ'} — لا سجل نشر بعد`
                                : `computed from ${r.last_featured_source === 'spend' ? 'the last day of spend' : 'the last content created'} — no publish history yet`}
                            </span>
                          </>
                        )
                        : (isAr ? 'لم يُبرَز من قبل — أول شهر له' : 'Never featured — its first month')}
                      <br />
                      {r.cost_per_qualified_lead !== null
                        ? (
                          <>
                            {isAr ? 'تكلفة العميل المؤهَّل في آخر شهر عُرض فيه' : 'Cost per qualified lead, last month it ran'}{' '}
                            <b>{sar1(r.cost_per_qualified_lead, isAr)}</b>
                            {r.last_run_qualified !== null && (
                              <> ({num(r.last_run_qualified, isAr)} {isAr ? 'مؤهلًا' : 'qualified'})</>
                            )}
                          </>
                        )
                        : (isAr ? 'لا سجل لتكلفة العميل المؤهَّل' : 'No cost-per-qualified-lead history')}
                    </>
                  )
                  : (isAr
                    ? 'لا أرقام لهذا المشروع في الترتيب — اختير يدويًا أو نفدت وحداته.'
                    : 'No ranking numbers for this project — chosen by hand, or it has no units left.')}
              </div>
              <div className="mth-row">
                <button type="button" className="btn btn-sm" disabled={!canEdit}
                  onClick={() => setPicking(i)}>
                  {isAr ? 'تغيير' : 'Change'}
                </button>
                {r && ranking[0]?.project_id === r.project_id && (
                  <span className="tag">{isAr ? 'الأقوى في الترتيب' : 'Top of the ranking'}</span>
                )}
                {r && r.last_featured_on === null && (
                  <span className="tag">{isAr ? 'أول شهر له' : 'First month'}</span>
                )}
                {r && r.days_since_featured !== null && r.days_since_featured >= 120 && (
                  <span className="tag">{isAr ? 'غاب طويلًا' : 'Long absent'}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {picking !== null && (
        <RankingPicker
          ranking={ranking}
          chosen={chosen}
          isAr={isAr}
          slotLabel={slotKey(picking, isAr)}
          onPick={(id) => onChange(picking, id)}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* the report tense                                                    */
/* ------------------------------------------------------------------ */

export function MonthProjectResults({
  projects, isAr,
}: {
  projects: MosMonthReportProject[];
  isAr: boolean;
}) {
  return (
    <div className="mth-slots">
      {projects.slice(0, 3).map((p, i) => (
        <div className={`mth-slot ${SLOT_CLASS[i] ?? 's-a'}`} key={p.project_id}>
          <span className="k">{slotKey(i, isAr)}</span>
          <div className="nm">{p.project_name ?? p.project_id.slice(0, 8)}</div>
          <div className="mt">
            <b>{money(p.spend, isAr)}</b> {isAr ? 'منفَق من' : 'spent of'} {money(p.budget, isAr)}
            <br />
            <b>{num(p.our_leads, isAr)}</b> {isAr ? 'عميلًا محتملًا' : 'leads'}
            {p.cost_per_lead !== null && (
              <> · <b>{sar1(p.cost_per_lead, isAr)}</b> {isAr ? 'للعميل' : 'per lead'}</>
            )}
            <br />
            {/* The D5 count pair — never a second riyal figure. */}
            <b>{num(p.qualified_clients, isAr)}</b>{' '}
            {isAr ? 'مؤهل من' : 'qualified of'} {num(p.attributed_clients, isAr)}{' '}
            {isAr ? 'عميلًا سُجِّلوا' : 'client records'}
            {p.ungraded_clients > 0 && (
              <> · <span style={{ fontSize: 10.5 }}>
                {isAr
                  ? `${num(p.ungraded_clients, isAr)} بلا مرحلة مقروءة`
                  : `${num(p.ungraded_clients, isAr)} with no readable stage`}
              </span></>
            )}
            <br />
            {num(p.posts_published, isAr)} {isAr ? 'منشورًا نُشر' : 'posts published'}
            {p.posts_planned > 0 && <> {isAr ? 'من' : 'of'} {num(p.posts_planned, isAr)}</>}
            {' · '}
            {num(p.ads_active, isAr)} {isAr ? 'إعلانًا نشطًا' : 'ads active'}
            {p.ads_paused > 0 && (
              <>، {num(p.ads_paused, isAr)} {isAr ? 'موقوفًا' : 'paused'}</>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

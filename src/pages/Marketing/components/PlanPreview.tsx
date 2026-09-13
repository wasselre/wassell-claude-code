/**
 * Step 2 of the campaign wizard — the plan, before anything exists.
 *
 * Everything on this screen is a PROPOSAL computed by the scheduling engine
 * against the live workload. No content row, no reservation, no publication and
 * no ad exists yet; the first write happens when the manager approves in step 3.
 *
 * The screen answers, in order, the questions the plan document says a manager
 * actually asks (§6.3): can this be done at all · what exactly gets made · when
 * does production have to start · who is it landing on and can they take it ·
 * what will the feed look like · when does each wave publish · what is in the
 * way · and for paid, how many creatives across how many refreshes.
 *
 * The one wording rule that must never slip lives in `planPresentation.ts`:
 * an unproven failure is «لم نعثر على جدول», never «مستحيل».
 */
import type { PlanResult } from '@/lib/marketingOS/scheduling';
import type { MosPlanRequestInput } from '@/lib/marketingOS/client';
import { PLATFORM_LABELS } from '@/lib/marketingOS/client';
import { Stat } from './kit';
import PlanGrid from './PlanGrid';
import PlanLoadTable from './PlanLoadTable';
import RefreshForecastCard from './RefreshForecastCard';
import {
  alternativeOptions, conflictLines, feasibilityVerdict, personName, pickText,
  productionWindowText, rangeText, stageColumns, stepLabel,
  type NamedPerson, type PlanAlternative, type PlanDiffEntry,
} from '../lib/planPresentation';
import { num, shortDate } from '../lib/format';

const platformLabelOf = (p: string, isAr: boolean): string => {
  const l = PLATFORM_LABELS[p];
  return l ? (isAr ? l.ar : l.en) : p;
};

export default function PlanPreview({
  plan, input, people, projectName, isAr, busy = false, diff, onAlternative, onSwap,
}: {
  plan: PlanResult;
  input: MosPlanRequestInput;
  people: NamedPerson[];
  projectName: (id: string | null | undefined) => string;
  isAr: boolean;
  busy?: boolean;
  /** Stage moves to highlight — set after a re-plan (409 or campaign binding). */
  diff?: PlanDiffEntry[] | null;
  onAlternative: (alt: PlanAlternative) => void;
  onSwap: (platform: string, aKey: string, bKey: string) => void;
}) {
  const verdict = feasibilityVerdict(plan);
  // What was ASKED for — the "fewer items" alternative is only meaningful
  // against the request, not against what the engine managed to place.
  const requested = input.projects.reduce((n, p) => n + p.posts + p.videos, 0);
  const alternatives = alternativeOptions(plan, Math.max(requested, plan.totals.items));
  const conflicts = conflictLines(plan.conflicts);
  const stages = stageColumns(plan.items);
  const movedKeys = new Set((diff ?? []).map((d) => d.item));

  const gridPlatforms = [...new Set(
    plan.items.flatMap((i) => i.placements.map((p) => p.platform)),
  )];

  return (
    <div>
      {/* ── the verdict ─────────────────────────────────────────────── */}
      <div className={`notice${verdict.tone === 'bad' ? ' bad' : ''}`} role={verdict.tone === 'bad' ? 'alert' : undefined}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{pickText(verdict.title, isAr)}</div>
        <div>{pickText(verdict.body, isAr)}</div>
        {alternatives.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 11 }}>
            {alternatives.map((alt) => (
              <button
                key={alt.kind}
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => onAlternative(alt)}
                title={pickText(alt.detail, isAr)}
              >
                {pickText(alt.label, isAr)}
                <span style={{ color: 'var(--mute)', marginInlineStart: 6 }}>
                  {pickText(alt.detail, isAr)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── what was asked for, and what it costs ───────────────────── */}
      <div className="grid g4" style={{ marginTop: 16, gap: 13 }}>
        <Stat
          isAr={isAr}
          label={isAr ? 'بنود المحتوى' : 'Content items'}
          value={plan.totals.items}
          detail={isAr
            ? `${num(plan.totals.posts, true)} منشورًا · ${num(plan.totals.videos, true)} فيديو`
            : `${plan.totals.posts} posts · ${plan.totals.videos} videos`}
        />
        <Stat
          isAr={isAr}
          label={isAr ? 'مرات النشر' : 'Placements'}
          value={plan.totals.placements}
          detail={isAr
            ? `${num(plan.totals.batches, true)} دفعة نشر`
            : `${plan.totals.batches} publishing batches`}
        />
        <div className="stat">
          <div className="k">{isAr ? 'مدى النشر المطلوب' : 'Requested publishing range'}</div>
          <div className="v" style={{ fontSize: 16, marginTop: 12 }} dir="ltr">
            {rangeText(input.range_start, input.range_end, false)}
          </div>
          <div className="d">
            {input.platforms.map((p) => platformLabelOf(p, isAr)).join(' · ') || '—'}
          </div>
        </div>
        <div className="stat">
          <div className="k">{isAr ? 'نافذة الإنتاج' : 'Production window'}</div>
          <div className="v" style={{ fontSize: 16, marginTop: 12 }} dir={isAr ? 'rtl' : 'ltr'}>
            {productionWindowText(plan, isAr)}
          </div>
          <div className="d">
            {isAr
              ? 'من أول بداية إنتاج إلى آخر اعتماد نهائي.'
              : 'From the earliest production start to the last final approval.'}
          </div>
        </div>
      </div>

      {/* ── the diff, when this plan replaced one already reviewed ──── */}
      {diff && diff.length > 0 && (
        <div className="notice" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {isAr
              ? `تحرّك ${num(diff.length, true)} إسنادًا عن الخطة التي راجعتها`
              : `${diff.length} assignment(s) moved since the plan you reviewed`}
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'البند والمرحلة' : 'Item and stage'}</th>
                  <th>{isAr ? 'كان' : 'Was'}</th>
                  <th>{isAr ? 'صار' : 'Now'}</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d) => (
                  <tr key={d.item}>
                    <td className="id">{d.item}</td>
                    <td className="ltr" style={{ color: 'var(--mute)' }}>{d.was}</td>
                    <td className="ltr" style={{ fontWeight: 700 }}>{d.now}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── required content, per project and per platform ──────────── */}
      <div className="grid g2" style={{ marginTop: 16, gap: 16 }}>
        <div className="card">
          <div className="card-h"><h4>{isAr ? 'المطلوب لكل مشروع' : 'Required per project'}</h4></div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'المشروع' : 'Project'}</th>
                  <th className="num">{isAr ? 'بنود' : 'Items'}</th>
                </tr>
              </thead>
              <tbody>
                {plan.totals.perProject.map((p) => (
                  <tr key={p.projectId}>
                    <td className="ttl">{p.projectName || projectName(p.projectId)}</td>
                    <td className="num">{num(p.items, isAr)}</td>
                  </tr>
                ))}
                {plan.totals.perProject.length === 0 && (
                  <tr><td colSpan={2} style={{ color: 'var(--mute)' }}>—</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h4>{isAr ? 'المطلوب لكل منصة' : 'Required per platform'}</h4></div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th className="num">{isAr ? 'مرات النشر' : 'Placements'}</th>
                </tr>
              </thead>
              <tbody>
                {plan.totals.perPlatform.map((p) => (
                  <tr key={p.platform}>
                    <td className="ttl">{platformLabelOf(p.platform, isAr)}</td>
                    <td className="num">{num(p.placements, isAr)}</td>
                  </tr>
                ))}
                {plan.totals.perPlatform.length === 0 && (
                  <tr><td colSpan={2} style={{ color: 'var(--mute)' }}>—</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── conflicts, in plain words ───────────────────────────────── */}
      {conflicts.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h">
            <h4>{isAr ? 'ما الذي يقف في الطريق' : 'What is in the way'}</h4>
            <span className="r">{num(conflicts.length, isAr)}</span>
          </div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {conflicts.map((c, i) => (
              <div key={`${c.kind}-${c.itemKey ?? ''}-${i}`} style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                <b style={{ color: 'var(--ink)' }}>{pickText(c.headline, isAr)}</b>
                {c.day && <span className="tag" style={{ marginInlineStart: 8 }}>{shortDate(c.day, isAr)}</span>}
                {c.stepKey && (
                  <span className="tag" style={{ marginInlineStart: 6 }}>
                    {pickText(stepLabel(c.stepKey), isAr)}
                  </span>
                )}
                <div style={{ color: 'var(--mute)' }}>{pickText(c.body, isAr)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── the grid(s) ─────────────────────────────────────────────── */}
      {gridPlatforms.map((p) => (
        <PlanGrid
          key={p}
          items={plan.items}
          platform={p}
          isAr={isAr}
          busy={busy}
          onSwap={(a, b) => onSwap(p, a, b)}
        />
      ))}

      {/* ── the publishing batches ──────────────────────────────────── */}
      {plan.batches.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h">
            <h4>{isAr ? 'دفعات النشر' : 'Publishing batches'}</h4>
            <span className="r">{num(plan.batches.length, isAr)}</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>{isAr ? 'اليوم' : 'Day'}</th>
                  <th>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th className="num">{isAr ? 'بنود' : 'Items'}</th>
                  <th>{isAr ? 'المحتوى' : 'Content'}</th>
                </tr>
              </thead>
              <tbody>
                {plan.batches.map((b) => (
                  <tr key={b.key}>
                    <td className="num">{num(b.sequence, isAr)}</td>
                    <td className="ltr">{shortDate(b.day, isAr)}</td>
                    <td>{platformLabelOf(b.platform, isAr)}</td>
                    <td className="num">{num(b.itemKeys.length, isAr)}</td>
                    <td style={{ color: 'var(--mute)' }}>
                      {/* thumb slot — one <ContentThumb> per item once produced */}
                      {b.itemKeys
                        .map((k) => plan.items.find((i) => i.key === k))
                        .map((i) => (i ? (i.projectName || projectName(i.projectId)) : '—'))
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── the proposed per-stage assignments ──────────────────────── */}
      {plan.items.length > 0 && stages.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h">
            <h4>{isAr ? 'الإسناد المقترح لكل مرحلة' : 'Proposed assignment per stage'}</h4>
            <span className="r">
              {isAr ? 'لا شيء محجوز حتى الاعتماد' : 'nothing is reserved until approval'}
            </span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'البند' : 'Item'}</th>
                  <th>{isAr ? 'ينشر' : 'Publishes'}</th>
                  <th>{isAr ? 'يبدأ الإنتاج' : 'Production'}</th>
                  {stages.map((s) => (
                    <th key={s}>{pickText(stepLabel(s), isAr)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => {
                  const byStep = new Map(item.stages.map((s) => [s.stepKey, s]));
                  const first = item.placements[0];
                  return (
                    <tr key={item.key}>
                      <td className="ttl">
                        {/* thumb slot */}
                        <div>{item.projectName || projectName(item.projectId)}</div>
                        <div className="id">{item.key}</div>
                      </td>
                      <td className="ltr">
                        {first ? shortDate(first.day, isAr) : '—'}
                        {first && first.gridRow !== null && (
                          <span className="id" style={{ marginInlineStart: 6 }}>
                            r{first.gridRow}c{first.gridCol}
                          </span>
                        )}
                      </td>
                      <td className="ltr">{shortDate(item.productionStart, isAr)}</td>
                      {stages.map((s) => {
                        const st = byStep.get(s);
                        if (!st) return <td key={s} style={{ color: 'var(--mute)' }}>—</td>;
                        const moved = movedKeys.has(`${item.key}|${s}`);
                        return (
                          <td
                            key={s}
                            style={moved
                              ? { background: 'color-mix(in srgb, var(--gold) 22%, transparent)', fontWeight: 700 }
                              : undefined}
                          >
                            <div>{personName(st.assigneeUserId, people, isAr)}</div>
                            <div className="id">
                              {st.start === st.end
                                ? shortDate(st.start, isAr)
                                : `${shortDate(st.start, isAr)} → ${shortDate(st.end, isAr)}`}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── who it lands on ─────────────────────────────────────────── */}
      <PlanLoadTable load={plan.load} people={people} isAr={isAr} />

      {/* ── paid: the refresh forecast, one card per paid child ─────── */}
      {(input.paid ?? []).map((child) => {
        const cycles = plan.cycles.filter((c) => c.executionKey === child.execution_key);
        return (
          <RefreshForecastCard
            key={child.execution_key}
            cycles={cycles}
            totals={plan.totals.creatives}
            rangeEnd={input.range_end}
            platform={child.platform}
            fifthPolicy={child.policy.fifth_policy}
            isAr={isAr}
          />
        );
      })}
    </div>
  );
}

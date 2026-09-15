/**
 * «الأرقام» — the month report's numbers (mockup `s-month.html`, report pane).
 *
 * WHOSE LEADS. Spend and impressions come from Meta's daily table as they are.
 * A LEAD here is OUR number: a WhatsApp conversation whose opening message
 * carried the ad (`ourLeads.ts`), not Meta's own lead counter — the two always
 * differ, and every keep/pause decision in this system turns on ours. Meta's
 * count is shown beside it, labelled, so a disagreement is visible instead of
 * being discovered later.
 *
 * QUALIFIED IS A COUNT, NOT A SECOND PRICE (the D5 note). «١٣ مؤهل من ١٧» beside
 * cost per lead, never a near-identical riyal figure under a different Arabic
 * label — an ad lead onboards at «جديد», which is qualified, so before anyone
 * triages, cost per lead and cost per qualified lead ARE the same number.
 *
 * THE UNATTRIBUTED ROW IS A GUARD, NOT A CATEGORY. Spend whose campaign names
 * no project is shown in its own row, in red, because after the cutover pause no
 * NEW spend can be unattributed — so a non-zero row inside the month means
 * something is wired wrong, not that a bucket exists.
 */
import type { MosMonthReport } from '@/lib/marketingOS/client';
import { num, money, pct } from '../lib/format';
import { monthDate, sar1 } from './MonthDates';

export default function MonthNumbers({
  report, isAr,
}: {
  report: MosMonthReport;
  isAr: boolean;
}) {
  const t = report.totals;
  const spend = t.spend ?? 0;
  const budget = t.budget_total || 0;
  const cheapest = report.projects
    .filter((p) => p.cost_per_lead !== null)
    .sort((a, b) => (a.cost_per_lead ?? 0) - (b.cost_per_lead ?? 0));
  const un = report.unattributed;
  const unSpend = un.spend ?? 0;
  const hist = report.unattributed_history;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الأرقام' : 'The numbers'}</h4>
        <span className="r">
          {isAr
            ? `الفترة ${monthDate(report.window.from, true)} إلى ${monthDate(report.window.to, true)}`
            : `${monthDate(report.window.from, false)} → ${monthDate(report.window.to, false)}`}
        </span>
      </div>
      <div className="card-b">
        <div className="grid g4" style={{ marginBlockEnd: 14 }}>
          <div className="stat">
            <div className="k">{isAr ? 'الإنفاق' : 'Spend'}</div>
            <div className="v">{money(spend, isAr)}</div>
            <div className="d">
              {budget > 0
                ? (isAr
                  ? `${pct((spend / budget) * 100, true)} من ${money(budget, true)}`
                  : `${pct((spend / budget) * 100, false)} of ${money(budget, false)}`)
                : (isAr ? 'لا ميزانية مسجّلة لهذا الشهر' : 'no budget recorded for this month')}
            </div>
          </div>
          <div className="stat">
            <div className="k">{isAr ? 'العملاء المحتملون — لنا' : 'Leads — ours'}</div>
            <div className="v">{num(t.our_leads, isAr)}</div>
            <div className="d">
              {isAr
                ? `محادثات واتساب فتحها الإعلان · ميتا تقول ${num(t.meta_leads ?? 0, true)}`
                : `WhatsApp conversations the ad opened · Meta reports ${num(t.meta_leads ?? 0, false)}`}
            </div>
          </div>
          <div className="stat">
            <div className="k">{isAr ? 'تكلفة العميل' : 'Cost per lead'}</div>
            <div className="v">{t.cost_per_lead !== null ? sar1(t.cost_per_lead, isAr) : '—'}</div>
            <div className="d">
              {cheapest.length >= 2
                ? (isAr
                  ? `من ${sar1(cheapest[0]?.cost_per_lead ?? 0, true)} إلى ${sar1(cheapest[cheapest.length - 1]?.cost_per_lead ?? 0, true)}`
                  : `${sar1(cheapest[0]?.cost_per_lead ?? 0, false)} → ${sar1(cheapest[cheapest.length - 1]?.cost_per_lead ?? 0, false)}`)
                : (isAr ? 'الإنفاق ÷ عملاؤنا' : 'spend ÷ our leads')}
            </div>
          </div>
          <div className="stat">
            <div className="k">{isAr ? 'منشورات نُشرت' : 'Posts published'}</div>
            <div className="v">
              {num(t.posts_published ?? 0, isAr)}
              <small style={{ fontSize: 12, marginInlineStart: 5 }}>
                {isAr ? `من ${num(t.posts_planned, true)}` : `of ${num(t.posts_planned, false)}`}
              </small>
            </div>
            <div className="d">
              {isAr
                ? `${num(t.releases_published ?? 0, true)} إصدارًا — منشور وستوري لكل واحد`
                : `${num(t.releases_published ?? 0, false)} releases — a feed post and a story each`}
            </div>
          </div>
        </div>

        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isAr ? 'المشروع' : 'Project'}</th>
                <th className="num">{isAr ? 'الإنفاق' : 'Spend'}</th>
                <th className="num">{isAr ? 'الظهور' : 'Impressions'}</th>
                <th className="num">{isAr ? 'عملاؤنا' : 'Our leads'}</th>
                <th className="num">{isAr ? 'ت.ع.' : 'CPL'}</th>
                <th>{isAr ? 'المؤهلون' : 'Qualified'}</th>
                <th className="num">{isAr ? 'منشورات' : 'Posts'}</th>
                <th>{isAr ? 'الإعلانات' : 'Ads'}</th>
              </tr>
            </thead>
            <tbody>
              {report.projects.map((p, i) => (
                <tr key={p.project_id} className={i === 0 ? 'hl' : undefined}>
                  <td className="ttl">{p.project_name ?? p.project_id.slice(0, 8)}</td>
                  <td className="num">{money(p.spend, isAr)}</td>
                  <td className="num">{num(p.impressions, isAr)}</td>
                  <td className="num">{num(p.our_leads, isAr)}</td>
                  <td className="num">{p.cost_per_lead !== null ? sar1(p.cost_per_lead, isAr) : '—'}</td>
                  <td>
                    {p.attributed_clients > 0
                      ? (isAr
                        ? `${num(p.qualified_clients, true)} مؤهل من ${num(p.attributed_clients, true)}`
                        : `${num(p.qualified_clients, false)} of ${num(p.attributed_clients, false)}`)
                      : '—'}
                  </td>
                  <td className="num">
                    {num(p.posts_published, isAr)}
                    {p.posts_planned > 0 && (
                      <span className="mth-tiny">
                        {isAr ? ` من ${num(p.posts_planned, true)}` : ` / ${num(p.posts_planned, false)}`}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="tag">
                      {isAr
                        ? `${num(p.ads_active, true)} نشط · ${num(p.ads_paused, true)} موقوف`
                        : `${num(p.ads_active, false)} live · ${num(p.ads_paused, false)} paused`}
                    </span>
                  </td>
                </tr>
              ))}

              {(unSpend > 0 || (un.our_leads ?? 0) > 0) && (
                <tr>
                  <td className="ttl" style={{ color: 'var(--late)' }}>
                    {isAr ? 'بلا مشروع — يحتاج ربطًا' : 'No project — needs linking'}
                  </td>
                  <td className="num">{money(unSpend, isAr)}</td>
                  <td className="num">{num(un.impressions ?? 0, isAr)}</td>
                  <td className="num">{num(un.our_leads ?? 0, isAr)}</td>
                  <td className="num">—</td>
                  <td colSpan={3} className="mth-tiny">
                    {isAr
                      ? 'إنفاق على حملة لا تسمّي مشروعًا. بعد إيقاف الإعلانات القديمة لا يُفترض أن يظهر إنفاق جديد هنا — ظهوره يعني ربطًا ناقصًا، لا فئة قائمة.'
                      : 'Spend on a campaign that names no project. After the legacy pause no NEW spend should land here — a row means something is unlinked, not that a bucket exists.'}
                  </td>
                </tr>
              )}

              <tr>
                <td><b>{isAr ? 'المجموع' : 'Total'}</b></td>
                <td className="num"><b>{money(spend, isAr)}</b></td>
                <td className="num"><b>{num(t.impressions ?? 0, isAr)}</b></td>
                <td className="num"><b>{num(t.our_leads, isAr)}</b></td>
                <td className="num">
                  <b>{t.cost_per_lead !== null ? sar1(t.cost_per_lead, isAr) : '—'}</b>
                </td>
                <td>
                  <b>
                    {isAr
                      ? `${num(t.qualified_clients ?? 0, true)} مؤهل من ${num(t.attributed_clients ?? 0, true)}`
                      : `${num(t.qualified_clients ?? 0, false)} of ${num(t.attributed_clients ?? 0, false)}`}
                  </b>
                </td>
                <td className="num"><b>{num(t.posts_published ?? 0, isAr)}</b></td>
                <td className="mth-tiny">
                  {isAr
                    ? `${num(t.creatives_planned, true)} تصميمًا مدفوعًا في الشهر`
                    : `${num(t.creatives_planned, false)} paid creatives this month`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-b" style={{ borderBlockStart: '1px solid var(--line-soft)' }}>
        <p className="mth-tiny" style={{ margin: 0 }}>
          {isAr
            ? 'الإنفاق والظهور من جدول ميتا اليومي كما هو. أما «عملاؤنا» فهي محادثات واتساب — كل محادثة فُتحت برسالة تحمل الإعلان — لا عدّاد ميتا؛ الرقمان يختلفان دائمًا وقرارنا يُبنى على رقمنا. و«المؤهلون» عدد سجلات العملاء التي أنشأتها تلك المحادثات ولم تنتهِ إلى مرحلة خاسرة، لا مبلغًا ثانيًا بجانب تكلفة العميل.'
            : 'Spend and impressions are Meta’s daily table as it stands. “Our leads” are WhatsApp conversations — each one opened by a message carrying the ad — not Meta’s counter; the two always differ and our decisions use ours. “Qualified” counts the client records those conversations created that have not ended in a lost stage — a count, never a second riyal figure beside cost per lead.'}
        </p>
        {(hist.spend ?? 0) > 0 && (
          <p className="mth-tiny" style={{ marginBlockEnd: 0 }}>
            {isAr
              ? `قبل هذه الفترة: ${money(hist.spend ?? 0, true)} إنفاقًا بلا مشروع (${monthDate(hist.first_day, true)} — ${monthDate(hist.last_day, true)}). هذا سجل ما قبل التحويل، ويبقى معروضًا حتى لا يختفي بصمت.`
              : `Before this window: ${money(hist.spend ?? 0, false)} of spend with no project (${monthDate(hist.first_day, false)} — ${monthDate(hist.last_day, false)}). That is the pre-cutover record, kept visible rather than quietly dropped.`}
          </p>
        )}
        <p className="mth-tiny" style={{ marginBlockEnd: 0 }}>
          {isAr
            ? `المراحل المستبعَدة من «المؤهل»: ${report.excluded_stages.join('، ')} — مأخوذة من تعريف عملية المبيعات نفسه، لا مكتوبة هنا.`
            : `Stages excluded from “qualified”: ${report.excluded_stages.join(', ')} — taken from the sales-process definition itself, not written here.`}
        </p>
      </div>
    </div>
  );
}

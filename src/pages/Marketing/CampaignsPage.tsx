/**
 * Campaigns — design screens 14 and 19.
 *
 * The spend side. A campaign is an envelope of money and time; the content that
 * runs inside it stays in the content library rather than being copied here.
 * Cost per lead is COMPUTED from the executions, never typed — a number you can
 * type is a number that can disagree with its own inputs.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  CAMPAIGN_STATUS_LABELS, EXEC_PURPOSE_LABELS, MosCampaign, OBJECTIVE_LABELS,
  PLATFORM_LABELS, ROLE_LABELS, SUCCESS_METRIC_LABELS, fetchCampaigns, saveCampaign,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import { IconCampaigns, IconCheck, IconMetrics, IconPlus } from './components/icons';
import { money, num, shortDate } from './lib/format';

const TONE: Record<string, 'now' | 'go' | 'idle' | 'wait' | 'live'> = {
  planning: 'idle',
  active: 'now',
  paused: 'wait',
  done: 'live',
  cancelled: 'idle',
};

export default function CampaignsPage() {
  const { isAr, can, projectName } = useWorkspace();
  const navigate = useNavigate();

  const [rows, setRows] = useState<MosCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await fetchCampaigns()).campaigns);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const totalBudget = rows.reduce((a, c) => a + (c.budget_total ?? 0), 0);
  const totalSpend = rows.reduce((a, c) => a + (c.total_spend ?? 0), 0);
  const totalLeads = rows.reduce((a, c) => a + (c.total_leads ?? 0), 0);

  return (
    <>
      <PageHead
        title={isAr ? 'الحملات' : 'Campaigns'}
        sub={isAr
          ? `${num(rows.length, true)} حملة · ${money(totalSpend, true)} من ${money(totalBudget, true)}`
          : `${rows.length} campaigns · ${money(totalSpend, false)} of ${money(totalBudget, false)}`}
      >
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
        {can('approve_budget') && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'حملة جديدة' : 'New campaign'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}

        {!loading && rows.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا حملات بعد' : 'No campaigns yet'}
            body={isAr
              ? 'الحملة ظرف من المال والوقت. المحتوى يبقى في المكتبة ويُنسب إليها، فلا يُنسخ مرتين.'
              : 'A campaign is an envelope of money and time. Content stays in the library and is attributed to it, never copied.'}
          >
            {can('approve_budget') && (
              <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
                <IconPlus />
                {isAr ? 'حملة جديدة' : 'New campaign'}
              </button>
            )}
          </Empty>
        )}

        {rows.length > 0 && (
          <>
            <div className="grid g4" style={{ marginBottom: 16 }}>
              <div className="stat">
                <div className="k">{isAr ? 'الميزانية' : 'Budget'}</div>
                <div className="v">{num(Math.round(totalBudget), isAr)}</div>
                <div className="d">{isAr ? 'ر.س عبر كل الحملات' : 'SAR across all campaigns'}</div>
              </div>
              <div className="stat">
                <div className="k">{isAr ? 'المصروف' : 'Spent'}</div>
                <div className="v">{num(Math.round(totalSpend), isAr)}</div>
                <div className="meter">
                  <i style={{ width: `${totalBudget > 0 ? Math.min(100, (totalSpend / totalBudget) * 100) : 0}%`, background: 'var(--copper)' }} />
                </div>
              </div>
              <div className="stat">
                <div className="k">{isAr ? 'العملاء' : 'Leads'}</div>
                <div className="v">{num(totalLeads, isAr)}</div>
                <div className="d">{isAr ? 'مُدخلة يدويًا' : 'entered by hand'}</div>
              </div>
              <div className="stat">
                <div className="k">{isAr ? 'تكلفة العميل' : 'Cost per lead'}</div>
                <div className="v">{totalLeads > 0 ? num(Math.round(totalSpend / totalLeads), isAr) : '—'}</div>
                <div className="d">{isAr ? 'محسوبة، لا تُكتب' : 'computed, never typed'}</div>
              </div>
            </div>

            <div className="card">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                      <th>{isAr ? 'الحملة' : 'Campaign'}</th>
                      <th style={{ width: 120 }}>{isAr ? 'المشروع' : 'Project'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'الهدف' : 'Objective'}</th>
                      <th style={{ width: 150 }}>{isAr ? 'المدة' : 'Dates'}</th>
                      <th className="num" style={{ width: 110 }}>{isAr ? 'الميزانية' : 'Budget'}</th>
                      <th className="num" style={{ width: 110 }}>{isAr ? 'المصروف' : 'Spent'}</th>
                      <th className="num" style={{ width: 80 }}>{isAr ? 'عملاء' : 'Leads'}</th>
                      <th className="num" style={{ width: 90 }}>{isAr ? 'التكلفة' : 'CPL'}</th>
                      <th style={{ width: 100 }}>{isAr ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => {
                      const cpl = (c.total_leads ?? 0) > 0 && c.total_spend
                        ? c.total_spend / (c.total_leads ?? 1)
                        : null;
                      return (
                        <tr key={c.id} className="click" onClick={() => navigate(`/m/campaigns/${c.id}`)}>
                          <td className="id">{c.ref}</td>
                          <td className="ttl">
                            {c.name}
                            <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 400 }}>
                              {isAr
                                ? `${num(c.content_count, true)} عنصر · ${num(c.execution_count, true)} تنفيذ`
                                : `${c.content_count} items · ${c.execution_count} executions`}
                            </div>
                          </td>
                          <td>{c.project_id ? projectName(c.project_id) : '—'}</td>
                          <td>
                            {(isAr ? OBJECTIVE_LABELS[c.objective]?.ar : OBJECTIVE_LABELS[c.objective]?.en) ?? c.objective}
                          </td>
                          <td style={{ color: 'var(--mute)', fontSize: 11.5 }}>
                            {shortDate(c.starts_on, isAr)} — {shortDate(c.ends_on, isAr)}
                          </td>
                          <td className="num">{num(c.budget_total, isAr)}</td>
                          <td className="num">{num(c.total_spend, isAr)}</td>
                          <td className="num">{num(c.total_leads, isAr)}</td>
                          <td className="num">{cpl === null ? '—' : num(Math.round(cpl), isAr)}</td>
                          <td>
                            <Pill tone={TONE[c.status] ?? 'idle'}>
                              {(isAr ? CAMPAIGN_STATUS_LABELS[c.status]?.ar : CAMPAIGN_STATUS_LABELS[c.status]?.en) ?? c.status}
                            </Pill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {creating && (
        <CampaignModal
          isAr={isAr}
          onClose={() => setCreating(false)}
          onSaved={(c) => { setCreating(false); navigate(`/m/campaigns/${c.id}`); }}
        />
      )}
    </>
  );
}

/**
 * Screen 19 — the campaign brief, faithful to the design.
 *
 * The fork at the top matters: picking paid or organic changes the fields below
 * it, because a budget and a cost-per-lead are meaningless on an organic push.
 * There is deliberately NO name field — the goal sentence, written as a RESULT,
 * is the campaign's identity («زيادة الوعي» ليست هدفًا). The success criterion
 * is mandatory: a campaign without one cannot be judged, and every campaign in
 * the old sheet lacked it. Nothing here spends money — executions are created
 * as drafts until someone launches them on the platform itself.
 */
const SPLIT_PLATFORMS = ['meta', 'tiktok', 'google', 'snapchat', 'x'] as const;

interface SplitRow {
  on: boolean;
  purpose: string;
  budget: string;
}

export function CampaignModal({
  campaign, isAr, onClose, onSaved,
}: {
  campaign?: MosCampaign | null;
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  const { projects } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const isNew = !campaign;

  const [kind, setKind] = useState<MosCampaign['kind']>(campaign?.kind ?? 'paid');
  const [goal, setGoal] = useState(campaign?.goal ?? campaign?.name ?? '');
  const [projectId, setProjectId] = useState(campaign?.project_id ?? '');
  const [ownerRole, setOwnerRole] = useState<string>(campaign?.owner_role ?? 'marketing_manager');
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '');
  const [budget, setBudget] = useState(campaign?.budget_total?.toString() ?? '');
  const [metric, setMetric] = useState(campaign?.success_metric ?? 'cpl_qualified');
  const [threshold, setThreshold] = useState(campaign?.success_threshold?.toString() ?? '');
  const [status, setStatus] = useState<MosCampaign['status']>(campaign?.status ?? 'planning');
  const [split, setSplit] = useState<Record<string, SplitRow>>(() =>
    Object.fromEntries(SPLIT_PLATFORMS.map((p) => [
      p,
      { on: p === 'meta', purpose: 'lead_form', budget: '' },
    ])),
  );
  const [busy, setBusy] = useState(false);

  const totalBudget = budget.trim() === '' ? null : Number(budget);
  const allocated = Object.values(split)
    .filter((r) => r.on && r.budget.trim() !== '')
    .reduce((a, r) => a + (Number(r.budget) || 0), 0);
  const unallocated = totalBudget === null ? null : totalBudget - allocated;
  const chosen = SPLIT_PLATFORMS.filter((p) => split[p]?.on);

  const patchSplit = (p: string, patch: Partial<SplitRow>): void =>
    setSplit((cur) => ({ ...cur, [p]: { ...(cur[p] ?? { on: false, purpose: 'lead_form', budget: '' }), ...patch } }));

  const submit = async (): Promise<void> => {
    if (!goal.trim()) {
      addToast(
        isAr ? 'اكتب الهدف كنتيجة — هو ما تُقاس به الحملة.' : 'Write the goal as a result — it is what the campaign is judged by.',
        'error',
      );
      return;
    }
    // The design's note: معيار النجاح إلزامي. A paid campaign without a
    // criterion cannot be judged, so the form refuses it up front.
    if (kind === 'paid' && threshold.trim() === '') {
      addToast(
        isAr ? 'حدّد معيار النجاح — حملة بلا معيار لا يمكن الحكم عليها.' : 'Set the success criterion — a campaign without one cannot be judged.',
        'error',
      );
      return;
    }
    setBusy(true);
    try {
      const executions = isNew && kind === 'paid'
        ? chosen.map((p) => {
            const row = split[p];
            const purpose = EXEC_PURPOSE_LABELS[row?.purpose ?? ''];
            return {
              platform: p,
              label: purpose ? (isAr ? purpose.ar : purpose.en) : null,
              budget: row && row.budget.trim() !== '' ? Number(row.budget) : null,
            };
          })
        : undefined;

      const res = await saveCampaign(
        {
          id: campaign?.id,
          // The goal doubles as the list's short handle — no separate name.
          name: goal.trim(),
          goal: goal.trim(),
          kind,
          project_id: projectId || null,
          owner_role: ownerRole || null,
          objective: kind === 'organic' ? 'awareness' : 'leads',
          status,
          starts_on: startsOn || null,
          ends_on: endsOn || null,
          budget_total: kind === 'paid' ? totalBudget : null,
          success_metric: metric || null,
          success_threshold: threshold.trim() === '' ? null : Number(threshold),
        },
        executions,
      );
      addToast(
        isNew
          ? isAr
            ? `أُنشئت الحملة ${res.item?.ref ?? ''} و${num(executions?.length ?? 0, true)} تنفيذات كمسودات.`
            : `Created campaign ${res.item?.ref ?? ''} with ${executions?.length ?? 0} draft executions.`
          : isAr ? 'حُفظت الحملة.' : 'Campaign saved.',
        'success',
      );
      onSaved(res.item);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? (isAr ? 'حملة جديدة' : 'New campaign') : (isAr ? 'تعديل الحملة' : 'Edit campaign')}
      sub={isAr
        ? 'هدف، ومدة، والمنصات التي ستعمل عليها. تُنشأ التنفيذات كمسودات.'
        : 'A goal, a duration, and the platforms it runs on. Executions are created as drafts.'}
      onClose={onClose}
      footer={
        <>
          <span className="note">
            {isAr
              ? 'لا شيء ينفق مالًا هنا. التنفيذات مسودات حتى يطلقها أحد على المنصة نفسها.'
              : 'Nothing here spends money. Executions stay drafts until someone launches them on the platform itself.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy
              ? (isAr ? 'جارٍ الإنشاء…' : 'Working…')
              : isNew ? (isAr ? 'إنشاء الحملة' : 'Create campaign') : (isAr ? 'حفظ' : 'Save')}
          </button>
        </>
      }
    >
      <div>
        <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'النوع' : 'Type'}</div>
        <div className="pick2">
          <button type="button" className={`p2${kind === 'paid' ? ' on' : ''}`} onClick={() => setKind('paid')}>
            <IconCampaigns />
            <div className="n4">{isAr ? 'مدفوعة' : 'Paid'}</div>
            <div className="s4">{isAr ? 'ميزانية وتكلفة مستهدفة' : 'a budget and a target cost'}</div>
          </button>
          <button type="button" className={`p2${kind === 'organic' ? ' on' : ''}`} onClick={() => setKind('organic')}>
            <IconMetrics />
            <div className="n4">{isAr ? 'عضوية' : 'Organic'}</div>
            <div className="s4">{isAr ? 'حجم ووصول' : 'volume and reach'}</div>
          </button>
        </div>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'الهدف — اكتبه كنتيجة' : 'The goal — write it as a result'}
        </div>
        <input
          className="inp"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus={isNew}
          placeholder={isAr ? '١٥٠ عميلًا مؤهلًا لمينا ٥٢ خلال أغسطس' : '150 qualified leads for Mina 52 during August'}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
          {isAr
            ? 'هذا يصبح الهدف الذي تُقاس به الحملة. «زيادة الوعي» ليست هدفًا.'
            : 'This becomes what the campaign is measured against. “Raise awareness” is not a goal.'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المشروع' : 'Project'}>
          <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'المسؤول' : 'Responsible'}>
          <select className="inp" value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
            {(['marketing_manager', 'ops_supervisor', 'writer', 'montage'] as const).map((r) => (
              <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: kind === 'paid' ? '1fr 1fr 1fr' : '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'تبدأ' : 'Starts'}>
          <input type="date" className="inp ltr" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
        <Field label={isAr ? 'تنتهي' : 'Ends'}>
          <input type="date" className="inp ltr" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
        {kind === 'paid' && (
          <Field label={isAr ? 'الميزانية الكلية' : 'Total budget'}>
            <div className="inp inp-row" style={{ padding: 0 }}>
              <input
                className="inp"
                style={{ border: 0, flex: 1 }}
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
              <span style={{ fontSize: 11, color: 'var(--mute)', paddingInlineEnd: 11 }}>
                {isAr ? 'ريال' : 'SAR'}
              </span>
            </div>
          </Field>
        )}
      </div>

      {kind === 'paid' && isNew && (
        <div>
          <div className="lbl" style={{ marginBottom: 7 }}>
            {isAr ? 'التنفيذات التي ستُنشأ' : 'The executions this will create'}
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 38 }} />
                  <th>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th style={{ width: 130 }}>{isAr ? 'الغرض' : 'Purpose'}</th>
                  <th className="num" style={{ width: 122 }}>{isAr ? 'حصة الميزانية' : 'Budget share'}</th>
                </tr>
              </thead>
              <tbody>
                {SPLIT_PLATFORMS.map((p) => {
                  const row = split[p];
                  if (!row) return null;
                  return (
                    <tr key={p} style={row.on ? undefined : { opacity: 0.55 }}>
                      <td>
                        <button
                          type="button"
                          className={`pill ${row.on ? 'p-go' : 'p-idle'}`}
                          style={{ padding: '3px 6px', cursor: 'pointer' }}
                          onClick={() => patchSplit(p, { on: !row.on })}
                          aria-label={isAr ? `تفعيل ${PLATFORM_LABELS[p]?.ar ?? p}` : `Toggle ${PLATFORM_LABELS[p]?.en ?? p}`}
                        >
                          {row.on ? <IconCheck style={{ width: 11, height: 11 }} /> : '○'}
                        </button>
                      </td>
                      <td>{(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}</td>
                      <td>
                        {row.on ? (
                          <select
                            className="inp"
                            style={{ padding: '4px 8px', fontSize: 12 }}
                            value={row.purpose}
                            onChange={(e) => patchSplit(p, { purpose: e.target.value })}
                          >
                            {Object.keys(EXEC_PURPOSE_LABELS).map((k) => (
                              <option key={k} value={k}>
                                {isAr ? EXEC_PURPOSE_LABELS[k]?.ar : EXEC_PURPOSE_LABELS[k]?.en}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span style={{ color: 'var(--mute)' }}>—</span>
                        )}
                      </td>
                      <td className="num">
                        {row.on ? (
                          <input
                            className="inp"
                            style={{ padding: '4px 8px', fontSize: 12, textAlign: 'end' }}
                            inputMode="numeric"
                            value={row.budget}
                            onChange={(e) => patchSplit(p, { budget: e.target.value })}
                          />
                        ) : (
                          <span style={{ color: 'var(--mute)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* The remainder is shown in the warning tone rather than accepted
              silently — the design's whole point for this table. */}
          {totalBudget !== null && (
            <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: 'var(--mute)', flexWrap: 'wrap' }}>
              <span>
                {isAr ? 'موزّع ' : 'Allocated '}
                <b style={{ color: 'var(--ink)' }}>{num(allocated, isAr)}</b>
                {isAr ? ` من ${num(totalBudget, true)}` : ` of ${num(totalBudget, false)}`}
              </span>
              {unallocated !== null && unallocated !== 0 && (
                <span style={{ color: unallocated > 0 ? 'var(--wait)' : 'var(--late)', fontWeight: 700 }}>
                  {unallocated > 0
                    ? isAr
                      ? `${num(unallocated, true)} ريال غير موزّعة`
                      : `${num(unallocated, false)} SAR unallocated`
                    : isAr
                      ? `تجاوز بمقدار ${num(Math.abs(unallocated), true)} ريال`
                      : `over by ${num(Math.abs(unallocated), false)} SAR`}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'معيار النجاح' : 'Success criterion'}</div>
        <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap' }}>
          <select className="inp" style={{ flex: 1, minWidth: 180 }} value={metric} onChange={(e) => setMetric(e.target.value)}>
            {Object.keys(SUCCESS_METRIC_LABELS).map((k) => (
              <option key={k} value={k}>
                {isAr ? SUCCESS_METRIC_LABELS[k]?.ar : SUCCESS_METRIC_LABELS[k]?.en}
              </option>
            ))}
          </select>
          <div className="inp inp-row" style={{ width: 170, padding: 0 }}>
            <input
              className="inp"
              style={{ border: 0, flex: 1 }}
              inputMode="numeric"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <span style={{ fontSize: 11, color: 'var(--mute)', paddingInlineEnd: 11, whiteSpace: 'nowrap' }}>
              {metric === 'leads' || metric === 'reach'
                ? isAr ? 'أو أكثر' : 'or more'
                : isAr ? 'ريال أو أقل' : 'SAR or less'}
            </span>
          </div>
        </div>
      </div>

      {!isNew && (
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <div className="seg" style={{ width: '100%' }}>
            {(['planning', 'active', 'paused', 'done'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={status === s ? 'on' : ''}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setStatus(s)}
              >
                {isAr ? CAMPAIGN_STATUS_LABELS[s]?.ar : CAMPAIGN_STATUS_LABELS[s]?.en}
              </button>
            ))}
          </div>
        </Field>
      )}

      {isNew && (
        <div
          style={{
            background: 'var(--sand-2)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '11px 13px',
            fontSize: 11.5,
            color: 'var(--mute)',
            lineHeight: 1.9,
          }}
        >
          <b style={{ color: 'var(--ink)' }}>{isAr ? 'عند الإنشاء' : 'On create'}</b>
          {isAr ? ' — حملة برقم ' : ' — a campaign numbered '}
          <b style={{ color: 'var(--ink)' }} className="ltr">C-</b>
          {kind === 'paid' && chosen.length > 0 && (
            <>
              {isAr
                ? `، و${num(chosen.length, true)} تنفيذات كمسودات`
                : `, and ${chosen.length} draft executions`}
            </>
          )}
          {isAr
            ? '، وهدف يُقاس بمعياره أعلاه.'
            : ', and a goal judged by the criterion above.'}
          <br />
          {isAr
            ? 'لا يُربط أي محتوى بعد؛ يُنسب المحتوى القائم من تبويب المحتوى.'
            : 'No content is linked yet; existing content is attributed from the Content tab.'}
        </div>
      )}
    </Modal>
  );
}

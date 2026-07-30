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
  CAMPAIGN_STATUS_LABELS, MosCampaign, OBJECTIVE_LABELS, fetchCampaigns, saveCampaign,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import { IconPlus } from './components/icons';
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

/** Screen 19 — new campaign. */
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
  const [name, setName] = useState(campaign?.name ?? '');
  const [projectId, setProjectId] = useState(campaign?.project_id ?? '');
  const [objective, setObjective] = useState<MosCampaign['objective']>(campaign?.objective ?? 'leads');
  const [status, setStatus] = useState<MosCampaign['status']>(campaign?.status ?? 'planning');
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '');
  const [budget, setBudget] = useState(campaign?.budget_total?.toString() ?? '');
  const [note, setNote] = useState(campaign?.note ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      addToast(isAr ? 'اكتب اسم الحملة.' : 'Give the campaign a name.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await saveCampaign({
        id: campaign?.id,
        name: name.trim(),
        project_id: projectId || null,
        objective,
        status,
        starts_on: startsOn || null,
        ends_on: endsOn || null,
        budget_total: budget.trim() === '' ? null : Number(budget),
        note: note || null,
      });
      addToast(isAr ? 'حُفظت الحملة.' : 'Campaign saved.', 'success');
      onSaved(res.item);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={campaign ? (isAr ? 'تعديل الحملة' : 'Edit campaign') : (isAr ? 'حملة جديدة' : 'New campaign')}
      sub={isAr
        ? 'الميزانية سقف، لا التزام. المصروف الحقيقي يأتي من صفوف التنفيذ.'
        : 'The budget is a ceiling, not a commitment. Real spend comes from the execution rows.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'اسم الحملة' : 'Campaign name'}>
        <input className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المشروع' : 'Project'}>
          <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'الهدف' : 'Objective'}>
          <select
            className="inp"
            value={objective}
            onChange={(e) => setObjective(e.target.value as MosCampaign['objective'])}
          >
            {Object.keys(OBJECTIVE_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? OBJECTIVE_LABELS[k]?.ar : OBJECTIVE_LABELS[k]?.en}</option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'من' : 'From'}>
          <input type="date" className="inp" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
        <Field label={isAr ? 'إلى' : 'To'}>
          <input type="date" className="inp" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الميزانية' : 'Budget'} hint={isAr ? 'ر.س' : 'SAR'}>
          <input className="inp" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
      </div>
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
      <Field label={isAr ? 'ملاحظة' : 'Note'}>
        <textarea className="inp" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

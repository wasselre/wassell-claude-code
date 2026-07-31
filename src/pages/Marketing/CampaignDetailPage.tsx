/**
 * Campaign detail — design screens 15, 20, 21, 39 and 40.
 *
 * Four tabs: the envelope, the content running inside it, the executions where
 * content meets spend, and the results. Every rolled-up number here is summed
 * from the execution rows by the database view, so the header can never
 * disagree with the table underneath it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  CAMPAIGN_STATUS_LABELS, EXEC_STATUS_LABELS, MosCampaign, MosComment, MosContentRow,
  MosExecution, OBJECTIVE_LABELS, PLATFORM_LABELS, ROLE_LABELS, SUCCESS_METRIC_LABELS,
  deleteExecution, fetchCampaignDetail, saveExecution,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import {
  Empty, Field, KindCell, LoadError, Modal, Pill, ReadField, Skeleton, StatusPill,
} from './components/kit';
import CommentThread from './components/CommentThread';
import NewContentModal from './components/NewContentModal';
import { CampaignModal } from './CampaignsPage';
import { IconBack, IconForward, IconPlus, IconTrash } from './components/icons';
import { money, num, shortDate } from './lib/format';

type Tab = 'overview' | 'content' | 'executions' | 'results';

/**
 * Sum the values that were actually measured, and return null when NONE were.
 *
 * `reduce((a, x) => a + (x ?? 0), 0)` would print ٠ for a column nobody has
 * filled in yet, which is the same lie as saving a blank box as zero: it says
 * "measured, and it was nothing" when the truth is "not measured".
 */
function sumOrNull(
  rows: MosExecution[],
  pick: (row: MosExecution) => number | null,
): number | null {
  const values = rows.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube'] as const;

export default function CampaignDetailPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const { isAr, can, projectName, users, typeLabel } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [item, setItem] = useState<MosCampaign | null>(null);
  const [executions, setExecutions] = useState<MosExecution[]>([]);
  const [content, setContent] = useState<MosContentRow[]>([]);
  const [comments, setComments] = useState<MosComment[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [execEditing, setExecEditing] = useState<MosExecution | null>(null);
  const [execAdding, setExecAdding] = useState(false);
  const [addingContent, setAddingContent] = useState(false);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCampaignDetail(campaignId);
      setItem(res.item);
      setExecutions(res.executions);
      setContent(res.content);
      setComments(res.comments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { void load(); }, [load]);

  const removeExec = async (id: string): Promise<void> => {
    if (!campaignId) return;
    try {
      setExecutions((await deleteExecution(campaignId, id)).executions);
      addToast(isAr ? 'حُذف صف التنفيذ.' : 'Execution removed.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  if (loading && !item) return <div className="body"><Skeleton rows={6} /></div>;
  if (error && !item) {
    return <div className="body"><LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>;
  }
  if (!item) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'الحملة غير موجودة.' : 'That campaign does not exist.'}</div>
      </div>
    );
  }

  const Back = isAr ? IconForward : IconBack;
  const spend = item.total_spend ?? 0;
  const budget = item.budget_total ?? 0;
  const leads = item.total_leads ?? 0;
  const qualified = item.total_qualified ?? 0;
  const cpl = leads > 0 ? spend / leads : null;
  const cpq = qualified > 0 ? spend / qualified : null;

  const tabs: Array<{ key: Tab; ar: string; en: string; badge?: number }> = [
    { key: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    { key: 'content', ar: 'المحتوى', en: 'Content', badge: content.length || undefined },
    { key: 'executions', ar: 'التنفيذات', en: 'Executions', badge: executions.length || undefined },
    { key: 'results', ar: 'النتائج', en: 'Results' },
  ];

  return (
    <>
      <div className="rhead">
        <div className="top">
          <div style={{ minWidth: 0 }}>
            <div className="crumb">
              <button type="button" onClick={() => navigate('/m/campaigns')}>
                <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الحملات' : 'Campaigns'}
              </button>
              <span className="sep">/</span>
              <span className="ltr">{item.ref}</span>
            </div>
            <h3>{item.name}</h3>
            <div className="chips">
              <Pill tone={item.status === 'active' ? 'now' : item.status === 'done' ? 'live' : 'idle'}>
                {(isAr ? CAMPAIGN_STATUS_LABELS[item.status]?.ar : CAMPAIGN_STATUS_LABELS[item.status]?.en) ?? item.status}
              </Pill>
              <span className="tag">
                {(isAr ? OBJECTIVE_LABELS[item.objective]?.ar : OBJECTIVE_LABELS[item.objective]?.en) ?? item.objective}
              </span>
              {item.project_id && <span className="tag">{projectName(item.project_id)}</span>}
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {shortDate(item.starts_on, isAr)} — {shortDate(item.ends_on, isAr)}
              </span>
            </div>
          </div>
          <div className="acts">
            {can('approve_budget') && (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                {isAr ? 'تعديل' : 'Edit'}
              </button>
            )}
            <button type="button" className="btn" onClick={() => void load()}>
              {isAr ? 'تحديث' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {isAr ? t.ar : t.en}
              {t.badge ? <span className="b">{num(t.badge, isAr)}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="wsplit">
        <div className="wmain">
          {tab === 'overview' && (
            <div style={{ display: 'grid', gap: 16 }}>
              <div className="grid g4">
                <div className="stat">
                  <div className="k">{isAr ? 'المصروف' : 'Spent'}</div>
                  <div className="v">{num(Math.round(spend), isAr)}</div>
                  <div className="d">
                    {isAr ? `من ${num(Math.round(budget), true)} ر.س` : `of ${num(Math.round(budget), false)} SAR`}
                  </div>
                  <div className="meter">
                    <i style={{ width: `${budget > 0 ? Math.min(100, (spend / budget) * 100) : 0}%`, background: 'var(--copper)' }} />
                  </div>
                </div>
                <div className="stat">
                  <div className="k">{isAr ? 'العملاء' : 'Leads'}</div>
                  <div className="v">{num(leads, isAr)}</div>
                  <div className="d">{isAr ? 'من صفوف التنفيذ' : 'from the execution rows'}</div>
                </div>
                <div className="stat">
                  <div className="k">{isAr ? 'تكلفة العميل' : 'Cost per lead'}</div>
                  <div className="v">{cpl === null ? '—' : num(Math.round(cpl), isAr)}</div>
                  <div className="d">{isAr ? 'محسوبة' : 'computed'}</div>
                </div>
                <div className="stat">
                  <div className="k">{isAr ? 'تكلفة المؤهل' : 'Cost per qualified'}</div>
                  <div className="v">{cpq === null ? '—' : num(Math.round(cpq), isAr)}</div>
                  <div className="d">
                    {isAr ? `${num(qualified, true)} مؤهلًا` : `${qualified} qualified`}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'الحملة' : 'The campaign'}</h4></div>
                <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}>
                  <ReadField label={isAr ? 'الهدف — كنتيجة' : 'The goal — as a result'}>
                    {item.goal ?? item.name}
                  </ReadField>
                  <ReadField label={isAr ? 'معيار النجاح' : 'Success criterion'}>
                    {item.success_metric && SUCCESS_METRIC_LABELS[item.success_metric]
                      ? `${isAr
                          ? SUCCESS_METRIC_LABELS[item.success_metric]?.ar
                          : SUCCESS_METRIC_LABELS[item.success_metric]?.en} — ${
                          item.success_threshold !== null
                            ? num(item.success_threshold, isAr)
                            : '—'} ${
                          item.success_metric === 'leads' || item.success_metric === 'reach'
                            ? isAr ? 'أو أكثر' : 'or more'
                            : isAr ? 'ريال أو أقل' : 'SAR or less'}`
                      : isAr ? 'غير محدد — لا يمكن الحكم على الحملة' : 'Not set — the campaign cannot be judged'}
                  </ReadField>
                  <ReadField label={isAr ? 'النوع' : 'Type'}>
                    {item.kind === 'organic'
                      ? isAr ? 'عضوية — حجم ووصول' : 'Organic — volume and reach'
                      : isAr ? 'مدفوعة — ميزانية وتكلفة مستهدفة' : 'Paid — a budget and a target cost'}
                  </ReadField>
                  <ReadField label={isAr ? 'المسؤول' : 'Responsible'}>
                    {item.owner_role && ROLE_LABELS[item.owner_role]
                      ? isAr ? ROLE_LABELS[item.owner_role].ar : ROLE_LABELS[item.owner_role].en
                      : '—'}
                  </ReadField>
                  <ReadField label={isAr ? 'المشروع' : 'Project'}>
                    {item.project_id ? projectName(item.project_id) : '—'}
                  </ReadField>
                  <ReadField label={isAr ? 'المدة' : 'Dates'}>
                    {shortDate(item.starts_on, isAr)} — {shortDate(item.ends_on, isAr)}
                  </ReadField>
                  <ReadField label={isAr ? 'الميزانية' : 'Budget'}>{money(item.budget_total, isAr)}</ReadField>
                  <ReadField label={isAr ? 'المحتوى' : 'Content'}>
                    {isAr ? `${num(item.content_count, true)} عنصر` : `${item.content_count} items`}
                  </ReadField>
                  <ReadField label={isAr ? 'التنفيذات' : 'Executions'}>
                    {isAr ? `${num(item.execution_count, true)} صف` : `${item.execution_count} rows`}
                  </ReadField>
                </div>
              </div>

              {item.note && (
                <div className="card">
                  <div className="card-h"><h4>{isAr ? 'ملاحظة' : 'Note'}</h4></div>
                  <div className="card-b" style={{ fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>
                    {item.note}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'content' && (
            <div style={{ display: 'grid', gap: 12 }}>
              {content.length === 0 ? (
                <Empty
                  title={isAr ? 'لا محتوى منسوب لهذه الحملة' : 'No content attributed to this campaign'}
                  body={isAr
                    ? 'المحتوى يعيش في المكتبة ويُنسب إلى الحملة — لا يُنسخ إليها.'
                    : 'Content lives in the library and is attributed to a campaign — never copied into it.'}
                >
                  {can('write_content') && (
                    <button type="button" className="btn btn-p" onClick={() => setAddingContent(true)}>
                      <IconPlus />
                      {isAr ? 'محتوى جديد لهذه الحملة' : 'New content for this campaign'}
                    </button>
                  )}
                </Empty>
              ) : (
                <>
                  <div className="card">
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th style={{ width: 70 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                            <th style={{ width: 84 }}>{isAr ? 'النوع' : 'Type'}</th>
                            <th>{isAr ? 'العنوان' : 'Title'}</th>
                            <th style={{ width: 150 }}>{isAr ? 'المرحلة' : 'Stage'}</th>
                            <th style={{ width: 96 }}>{isAr ? 'النشر' : 'Publish'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {content.map((r) => (
                            <tr key={r.id} className="click" onClick={() => navigate(`/m/content/${r.id}`)}>
                              <td className="id">{r.ref}</td>
                              <td><KindCell typeKey={r.content_type_key} label={typeLabel(r.content_type_key)} /></td>
                              <td className="ttl">{r.title}</td>
                              <td><StatusPill row={r} isAr={isAr} /></td>
                              <td style={{ color: 'var(--mute)' }}>{shortDate(r.target_publish_at, isAr)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {can('write_content') && (
                    <div>
                      <button type="button" className="btn" onClick={() => setAddingContent(true)}>
                        <IconPlus />
                        {isAr ? 'محتوى جديد لهذه الحملة' : 'New content for this campaign'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'executions' && (
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'التنفيذات' : 'Executions'}</h4>
                  <span className="r">
                    {isAr ? 'حيث يلتقي المحتوى بالإنفاق' : 'where content meets spend'}
                  </span>
                  <span className="tag tag-t">{isAr ? 'مُدخلة يدويًا' : 'entered by hand'}</span>
                </div>
                {executions.length === 0 ? (
                  <p style={{ padding: 26, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
                    {isAr
                      ? 'لا صفوف تنفيذ. أضف صفًّا لكل مجموعة إعلانية على كل منصة.'
                      : 'No execution rows. Add one per ad set, per platform.'}
                  </p>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 120 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                          <th>{isAr ? 'المجموعة' : 'Ad set'}</th>
                          <th style={{ width: 120 }}>{isAr ? 'المحتوى' : 'Content'}</th>
                          <th className="num" style={{ width: 90 }}>{isAr ? 'الميزانية' : 'Budget'}</th>
                          <th className="num" style={{ width: 90 }}>{isAr ? 'المصروف' : 'Spent'}</th>
                          <th className="num" style={{ width: 80 }}>{isAr ? 'عملاء' : 'Leads'}</th>
                          <th className="num" style={{ width: 90 }}>{isAr ? 'مؤهلون' : 'Qualified'}</th>
                          <th style={{ width: 100 }}>{isAr ? 'الحالة' : 'Status'}</th>
                          {can('enter_metrics') && <th style={{ width: 110 }} />}
                        </tr>
                      </thead>
                      <tbody>
                        {executions.map((x) => {
                          const linked = content.find((c) => c.id === x.content_id);
                          return (
                            // The row opens the execution's own page — screen 21,
                            // where the ads live. The buttons stay for quick edits.
                            <tr
                              key={x.id}
                              className="click"
                              onClick={() => navigate(`/m/campaigns/${item.id}/exec/${x.id}`)}
                            >
                              <td>
                                <span className="tag">
                                  {(isAr ? PLATFORM_LABELS[x.platform]?.ar : PLATFORM_LABELS[x.platform]?.en) ?? x.platform}
                                </span>
                              </td>
                              <td className="ttl">{x.label ?? '—'}</td>
                              <td className="id">{linked?.ref ?? '—'}</td>
                              <td className="num">{num(x.budget, isAr)}</td>
                              <td className="num">{num(x.spend, isAr)}</td>
                              <td className="num">{num(x.leads, isAr)}</td>
                              <td className="num">{num(x.qualified, isAr)}</td>
                              <td>
                                <Pill tone={x.status === 'running' ? 'now' : x.status === 'ended' ? 'live' : 'idle'}>
                                  {(isAr ? EXEC_STATUS_LABELS[x.status]?.ar : EXEC_STATUS_LABELS[x.status]?.en) ?? x.status}
                                </Pill>
                              </td>
                              {can('enter_metrics') && (
                                <td onClick={(e) => e.stopPropagation()}>
                                  <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                                    <button type="button" className="btn btn-sm" onClick={() => setExecEditing(x)}>
                                      {isAr ? 'تعديل' : 'Edit'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-d btn-sm"
                                      onClick={() => void removeExec(x.id)}
                                      aria-label={isAr ? 'حذف' : 'Delete'}
                                    >
                                      <IconTrash />
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {can('enter_metrics') && (
                <div>
                  <button type="button" className="btn" onClick={() => setExecAdding(true)}>
                    <IconPlus />
                    {isAr ? 'إضافة تنفيذ' : 'Add an execution'}
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'results' && (
            <div style={{ display: 'grid', gap: 12 }}>
              {executions.length === 0 ? (
                <Empty
                  title={isAr ? 'لا نتائج بعد' : 'No results yet'}
                  body={isAr
                    ? 'النتائج تُجمع من صفوف التنفيذ. أضف صفًّا وأدخل أرقامه.'
                    : 'Results are summed from the execution rows. Add one and enter its numbers.'}
                />
              ) : (
                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'النتيجة لكل منصة' : 'Result by platform'}</h4>
                    <span className="r">{isAr ? 'مجموعة من التنفيذات' : 'summed from executions'}</span>
                  </div>
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>{isAr ? 'المنصة' : 'Platform'}</th>
                          <th className="num">{isAr ? 'المصروف' : 'Spent'}</th>
                          <th className="num">{isAr ? 'ظهور' : 'Impressions'}</th>
                          <th className="num">{isAr ? 'نقرات' : 'Clicks'}</th>
                          <th className="num">{isAr ? 'عملاء' : 'Leads'}</th>
                          <th className="num">{isAr ? 'التكلفة' : 'CPL'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(
                          executions.reduce<Record<string, MosExecution[]>>((acc, x) => {
                            (acc[x.platform] ??= []).push(x);
                            return acc;
                          }, {}),
                        ).map(([platform, list]) => {
                          const s = sumOrNull(list, (x) => x.spend);
                          const l = sumOrNull(list, (x) => x.leads);
                          return (
                            <tr key={platform}>
                              <td>
                                <span className="tag">
                                  {(isAr ? PLATFORM_LABELS[platform]?.ar : PLATFORM_LABELS[platform]?.en) ?? platform}
                                </span>
                              </td>
                              <td className="num">{num(s === null ? null : Math.round(s), isAr)}</td>
                              <td className="num">{num(sumOrNull(list, (x) => x.impressions), isAr)}</td>
                              <td className="num">{num(sumOrNull(list, (x) => x.clicks), isAr)}</td>
                              <td className="num">{num(l, isAr)}</td>
                              <td className="num">
                                {s !== null && l !== null && l > 0 ? num(Math.round(s / l), isAr) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="wside">
          <CommentThread
            target={{ campaignId: item.id }}
            comments={comments}
            tasks={[]}
            steps={[]}
            users={users}
            canComment={can('comment')}
            isAr={isAr}
            onChange={setComments}
          />
        </div>
      </div>

      {editing && (
        <CampaignModal
          campaign={item}
          isAr={isAr}
          onClose={() => setEditing(false)}
          onSaved={(c) => { setItem(c); setEditing(false); }}
        />
      )}

      {(execEditing || execAdding) && campaignId && (
        <ExecutionModal
          campaignId={campaignId}
          execution={execEditing}
          content={content}
          isAr={isAr}
          onClose={() => { setExecEditing(null); setExecAdding(false); }}
          onSaved={(rows) => { setExecutions(rows); setExecEditing(null); setExecAdding(false); void load(); }}
        />
      )}

      {addingContent && (
        <NewContentModal
          onClose={() => setAddingContent(false)}
          presetCampaign={item.id}
          presetProject={item.project_id}
          onCreated={(id) => navigate(`/m/content/${id}`)}
        />
      )}
    </>
  );
}

/** Screen 21 — the execution row, where content meets spend. */
function ExecutionModal({
  campaignId, execution, content, isAr, onClose, onSaved,
}: {
  campaignId: string;
  execution: MosExecution | null;
  content: MosContentRow[];
  isAr: boolean;
  onClose: () => void;
  onSaved: (rows: MosExecution[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [platform, setPlatform] = useState(execution?.platform ?? 'instagram');
  const [label, setLabel] = useState(execution?.label ?? '');
  const [contentId, setContentId] = useState(execution?.content_id ?? '');
  const [status, setStatus] = useState<MosExecution['status']>(execution?.status ?? 'draft');
  const [budget, setBudget] = useState(execution?.budget?.toString() ?? '');
  const [spend, setSpend] = useState(execution?.spend?.toString() ?? '');
  const [impressions, setImpressions] = useState(execution?.impressions?.toString() ?? '');
  const [clicks, setClicks] = useState(execution?.clicks?.toString() ?? '');
  const [leads, setLeads] = useState(execution?.leads?.toString() ?? '');
  const [qualified, setQualified] = useState(execution?.qualified?.toString() ?? '');
  const [busy, setBusy] = useState(false);

  // Blank is "not measured", not zero — same rule as the metric snapshots.
  const n = (s: string): number | null => (s.trim() === '' ? null : Number(s));

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await saveExecution(campaignId, {
        id: execution?.id,
        platform,
        label: label || null,
        content_id: contentId || null,
        status,
        budget: n(budget),
        spend: n(spend),
        impressions: n(impressions),
        clicks: n(clicks),
        leads: n(leads),
        qualified: n(qualified),
      });
      addToast(isAr ? 'حُفظ التنفيذ.' : 'Execution saved.', 'success');
      onSaved(res.executions);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={execution ? (isAr ? 'تعديل التنفيذ' : 'Edit execution') : (isAr ? 'تنفيذ جديد' : 'New execution')}
      sub={isAr
        ? 'صف واحد لكل مجموعة إعلانية. الأرقام تُدخل يدويًا حتى تُربط المنصات.'
        : 'One row per ad set. Numbers are typed in by hand until the platforms are connected.'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="note">
            {isAr ? 'اترك أي خانة فارغة إن لم تُقس — الفارغ ليس صفرًا.' : 'Leave a box empty if it was not measured — empty is not zero.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المنصة' : 'Platform'}>
          <select className="inp" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}
              </option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'اسم المجموعة' : 'Ad set name'}>
          <input className="inp" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <select
            className="inp"
            value={status}
            onChange={(e) => setStatus(e.target.value as MosExecution['status'])}
          >
            {Object.keys(EXEC_STATUS_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? EXEC_STATUS_LABELS[k]?.ar : EXEC_STATUS_LABELS[k]?.en}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={isAr ? 'المحتوى الذي يعمل هنا' : 'The content running here'}>
        <select className="inp" value={contentId} onChange={(e) => setContentId(e.target.value)}>
          <option value="">{isAr ? 'غير محدد' : 'Not specified'}</option>
          {content.map((c) => (
            <option key={c.id} value={c.id}>{c.ref} · {c.title}</option>
          ))}
        </select>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 13 }}>
        <Field label={isAr ? 'الميزانية' : 'Budget'}>
          <input className="inp" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <Field label={isAr ? 'المصروف' : 'Spent'}>
          <input className="inp" inputMode="numeric" value={spend} onChange={(e) => setSpend(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الظهور' : 'Impressions'}>
          <input className="inp" inputMode="numeric" value={impressions} onChange={(e) => setImpressions(e.target.value)} />
        </Field>
        <Field label={isAr ? 'النقرات' : 'Clicks'}>
          <input className="inp" inputMode="numeric" value={clicks} onChange={(e) => setClicks(e.target.value)} />
        </Field>
        <Field label={isAr ? 'العملاء' : 'Leads'}>
          <input className="inp" inputMode="numeric" value={leads} onChange={(e) => setLeads(e.target.value)} />
        </Field>
        <Field label={isAr ? 'المؤهلون' : 'Qualified'}>
          <input className="inp" inputMode="numeric" value={qualified} onChange={(e) => setQualified(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

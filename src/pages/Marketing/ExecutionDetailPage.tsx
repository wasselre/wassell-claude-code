/**
 * Execution detail — design screen 21: where content meets spend.
 *
 * The bottom layer. Each AD is a content reference + targeting + a result —
 * campaign → execution → ad is the minimum shape that finally answers the
 * question the old sheet couldn't: WHICH ad brought the client?
 *
 * The design's honesty rules are kept: «الأفضل» is computed (lowest cost per
 * qualified among measured ads), never assigned; a wrong-project ad is shown
 * in the alarm tone instead of assumed impossible; and «مزامنة من ميتا» is
 * rendered DISABLED because before a connection exists it would be an
 * aspiration, not a feature.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  AD_STATUS_LABELS, EXEC_STATUS_LABELS, MosAd, MosAdSet, MosCampaign, MosContentRow,
  MosExecution, MosTargeting, PLATFORM_LABELS,
  deleteAd, fetchContentList, fetchExecutionDetail, mosMetaPushStructure, saveAd, saveExecution,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { PURPOSE_PILL_LABELS } from './CampaignDetailPage';
import {
  PlatformSettings, getPlatformSchema, settingsProgress, settingsSummary,
} from '@/lib/marketingOS/adPlatforms';
import { PlatformFieldsGrid, PlatformSettingsForm } from './components/PlatformSettingsForm';
import CampaignTreeModal from './components/CampaignTreeModal';
import { Empty, Field, LoadError, Modal, Pill, ReadField, Skeleton } from './components/kit';
import { IconBack, IconForward, IconPlus } from './components/icons';
import { num, whole } from './lib/format';

type Tab = 'ads' | 'targeting';

const AD_TONE: Record<string, 'now' | 'wait' | 'idle' | 'late'> = {
  running: 'now',
  watch: 'wait',
  paused: 'late',
  waiting: 'idle',
};

/** Cost per qualified — null (an em-dash) until both sides are measured. */
const cpq = (ad: MosAd): number | null =>
  ad.spend !== null && ad.qualified !== null && ad.qualified > 0
    ? ad.spend / ad.qualified
    : null;

export default function ExecutionDetailPage() {
  const { executionId } = useParams<{ executionId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const addToast = useAppStore((s) => s.addToast);
  const { isAr, can, projectName, typeLabel } = useWorkspace();

  const [execution, setExecution] = useState<MosExecution | null>(null);
  const [campaign, setCampaign] = useState<MosCampaign | null>(null);
  const [ads, setAds] = useState<MosAd[]>([]);
  const [adContent, setAdContent] = useState<MosContentRow[]>([]);
  const [adSets, setAdSets] = useState<MosAdSet[]>([]);
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get('tab');
    return t === 'targeting' ? t : 'ads';
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingAd, setAddingAd] = useState(false);
  const [editingAd, setEditingAd] = useState<MosAd | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!executionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchExecutionDetail(executionId);
      setExecution(res.execution);
      setCampaign(res.campaign);
      setAds(res.ads);
      setAdContent(res.ad_content);
      setAdSets(res.ad_sets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => { void load(); }, [load]);

  const contentOf = (id: string | null): MosContentRow | undefined =>
    adContent.find((c) => c.id === id);

  /** The ad the numbers say to feed — computed, never assigned. */
  const bestAdId = useMemo(() => {
    const measured = ads
      .filter((a) => a.status !== 'paused' && cpq(a) !== null)
      .sort((a, b) => (cpq(a) ?? 0) - (cpq(b) ?? 0));
    return measured.length > 1 ? measured[0]?.id ?? null : null;
  }, [ads]);

  /** The insight line under the table — the argument for making more of what works. */
  const insight = useMemo(() => {
    const measured = ads.filter((a) => cpq(a) !== null)
      .sort((a, b) => (cpq(a) ?? 0) - (cpq(b) ?? 0));
    if (measured.length < 2) return null;
    const best = measured[0];
    const worst = measured[measured.length - 1];
    if (!best || !worst || best.id === worst.id) return null;
    const bc = contentOf(best.content_id);
    const wc = contentOf(worst.content_id);
    if (!bc || !wc) return null;
    return { best, worst, bc, wc, bcpq: cpq(best) ?? 0, wcpq: cpq(worst) ?? 0 };
    // adContent is stable per load; contentOf reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ads, adContent]);

  const pushToMeta = async (): Promise<void> => {
    if (!execution) return;
    setBusy(true);
    try {
      // All-or-nothing on the server: a rejected ad set rolls the whole push back
      // and throws with Meta's reason, so reaching here means full success.
      const r = await mosMetaPushStructure(execution.id);
      const sets = r.ad_sets.length;
      addToast(
        isAr
          ? `أُنشئت الحملة و${sets} مجموعة إعلانية في ميتا (موقوفة).`
          : `Created the campaign + ${sets} ad set(s) in Meta (paused).`,
        'success',
      );
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleExecStatus = async (): Promise<void> => {
    if (!execution) return;
    const next = execution.status === 'running' ? 'paused' : 'running';
    setBusy(true);
    try {
      await saveExecution(execution.campaign_id, { id: execution.id, status: next });
      setExecution({ ...execution, status: next });
      addToast(
        next === 'paused'
          ? isAr ? 'أُوقفت الحملة الإعلانية.' : 'Ad campaign paused.'
          : isAr ? 'أُعيد تشغيل الحملة الإعلانية.' : 'Ad campaign resumed.',
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !execution) return <div className="body"><Skeleton rows={6} /></div>;
  if (error && !execution) {
    return <div className="body"><LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>;
  }
  if (!execution) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'الحملة الإعلانية غير موجودة.' : 'That ad campaign does not exist.'}</div>
      </div>
    );
  }

  const Back = isAr ? IconForward : IconBack;
  const platformLabel = (isAr ? PLATFORM_LABELS[execution.platform]?.ar : PLATFORM_LABELS[execution.platform]?.en)
    ?? execution.platform;
  const projectLabel = campaign?.project_id ? projectName(campaign.project_id) : null;

  // Spend rolls up from the ads when ads carry numbers; the execution's own
  // figure is the fallback for executions tracked only at the envelope level.
  const adSpend = ads.reduce((a, x) => a + (x.spend ?? 0), 0);
  const spent = ads.some((a) => a.spend !== null) ? adSpend : execution.spend;
  const canEnter = can('enter_metrics');
  // Removing an ad is a delete — its own gate, split from enter_metrics.
  const canDelete = can('delete_records');
  const targeting: MosTargeting = execution.targeting ?? {};

  // Structured platforms (meta/instagram/snapchat/tiktok) get the real
  // Ads-Manager fields; the rest keep the free-text targeting brief.
  const platformSchema = getPlatformSchema(execution.platform);
  const isMetaExec = execution.platform === 'meta' || execution.platform === 'instagram';
  const platformSettings = (execution.platform_settings ?? null) as PlatformSettings | null;
  const summaryParts = settingsSummary(execution.platform, platformSettings, isAr);

  const tabs: Array<{ key: Tab; ar: string; en: string }> = [
    { key: 'ads', ar: 'الإعلانات', en: 'Ads' },
    platformSchema
      ? { key: 'targeting', ar: 'إعدادات المنصة', en: 'Platform settings' }
      : { key: 'targeting', ar: 'الاستهداف', en: 'Targeting' },
  ];

  // Map ad_set_id -> name, so the ads table can show which ad set each ad is in.
  const adSetName = (id: string | null | undefined): string | null =>
    id ? adSets.find((s) => s.id === id)?.name ?? null : null;

  const purposeLabel = execution.purpose && PURPOSE_PILL_LABELS[execution.purpose]
    ? isAr ? PURPOSE_PILL_LABELS[execution.purpose]?.ar : PURPOSE_PILL_LABELS[execution.purpose]?.en
    : null;

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
              {campaign && (
                <>
                  <button type="button" onClick={() => navigate(`/m/campaigns/${campaign.id}`)}>
                    <span className="ltr">{campaign.ref}</span>
                  </button>
                  <span className="sep">/</span>
                </>
              )}
              <span>{isAr ? 'الحملات الإعلانية' : 'Ad campaigns'}</span>
              <span className="sep">/</span>
              <span>{platformLabel}</span>
            </div>
            <h3>
              {platformLabel}
              {projectLabel && <> — {projectLabel}</>}
            </h3>
            <div className="chips">
              {purposeLabel
                ? <span className="tag">{purposeLabel}</span>
                : execution.label && <span className="tag">{execution.label}</span>}
              {summaryParts.length > 0 ? (
                <span className="tag">{summaryParts.slice(0, 3).join(' · ')}</span>
              ) : targeting.location && targeting.age && (
                <span className="tag">{targeting.location} · {targeting.age}</span>
              )}
              <Pill tone={execution.status === 'running' ? 'now' : execution.status === 'ended' ? 'live' : 'idle'}>
                {(isAr ? EXEC_STATUS_LABELS[execution.status]?.ar : EXEC_STATUS_LABELS[execution.status]?.en)
                  ?? execution.status}
              </Pill>
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {num(spent === null ? null : Math.round(spent), isAr)}
                {execution.budget !== null && (
                  <> {isAr ? `من ${num(execution.budget, true)} ريال` : `of ${num(execution.budget, false)} SAR`}</>
                )}
              </span>
            </div>
          </div>
          <div className="acts">
            {canEnter && (
              <button type="button" className="btn btn-d" disabled={busy} onClick={() => void toggleExecStatus()}>
                {execution.status === 'running'
                  ? isAr ? 'إيقاف الحملة الإعلانية' : 'Pause ad campaign'
                  : isAr ? 'تشغيل الحملة الإعلانية' : 'Resume ad campaign'}
              </button>
            )}
            {canEnter && (
              <button type="button" className="btn btn-p" onClick={() => setTreeOpen(true)}>
                <IconPlus />
                {isAr ? 'المجموعات والإعلانات' : 'Ad sets & ads'}
              </button>
            )}
            {canEnter && (
              <button type="button" className="btn" onClick={() => setAddingAd(true)}>
                <IconPlus />
                {isAr ? 'إضافة إعلان' : 'Add an ad'}
              </button>
            )}
            {/* Build the planned campaign + ad sets in Meta (paused). Ads are
                added by the buyer in Meta; the hourly sync matches them back. */}
            {platformSchema && can('manage_paid_ads') && (
              execution.platform_campaign_id ? (
                <button
                  type="button"
                  className="btn"
                  disabled
                  title={`${isAr ? 'مربوطة بحملة ميتا' : 'Linked to Meta campaign'} ${execution.platform_campaign_id}`}
                >
                  {isAr ? '✓ مربوطة بميتا' : '✓ Linked to Meta'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-p"
                  disabled={busy}
                  onClick={() => void pushToMeta()}
                  title={isAr
                    ? 'تُنشئ الحملة والمجموعات الإعلانية في ميتا (موقوفة) وتربط المعرفات تلقائيًا. الإعلانات يضيفها المشتري في ميتا.'
                    : 'Creates the campaign + ad sets in Meta (paused) and links the ids automatically. Ads are added by the buyer in Meta.'}
                >
                  {isAr ? 'إنشاء في ميتا' : 'Create in Meta'}
                </button>
              )
            )}
          </div>
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {isAr ? t.ar : t.en}
            </button>
          ))}
        </div>
      </div>

      <div className="body">
        <div className="grid m4-xd">
          <div style={{ minWidth: 0 }}>
            {tab === 'ads' && (
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'الإعلانات في هذه الحملة الإعلانية' : 'The ads in this ad campaign'}</h4>
                  <span className="r">
                    {adSets.length > 0
                      ? isAr
                        ? `${num(ads.length, true)} إعلان · ${num(adSets.length, true)} مجموعة إعلانية`
                        : `${ads.length} ads · ${adSets.length} ad set${adSets.length === 1 ? '' : 's'}`
                      : isAr
                        ? `${num(ads.length, true)} إعلانات · كل واحد سجل محتوى`
                        : `${ads.length} ads · each one is a content record`}
                  </span>
                </div>
                {ads.length === 0 ? (
                  <div style={{ padding: 22 }}>
                    <Empty
                      title={isAr ? 'لا إعلانات بعد' : 'No ads yet'}
                      body={isAr
                        ? 'الإعلان = إشارة إلى سجل محتوى + استهداف + نتيجة. هذا ما يجعل «أي إعلان جلب العميل؟» سؤالًا له جواب.'
                        : 'An ad = a content reference + targeting + a result. That is what makes "which ad brought the client?" answerable.'}
                    >
                      {canEnter && (
                        <button type="button" className="btn btn-p" onClick={() => setAddingAd(true)}>
                          <IconPlus />
                          {isAr ? 'إضافة إعلان' : 'Add an ad'}
                        </button>
                      )}
                    </Empty>
                  </div>
                ) : (
                  <>
                    <div className="tbl-wrap m4-desk">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th style={{ width: 62 }}>{isAr ? 'المحتوى' : 'Content'}</th>
                            <th>{isAr ? 'الإعلان' : 'Ad'}</th>
                            {adSets.length > 0 && (
                              <th style={{ width: 150 }}>{isAr ? 'المجموعة الإعلانية' : 'Ad set'}</th>
                            )}
                            <th className="num" style={{ width: 84 }}>{isAr ? 'الإنفاق' : 'Spend'}</th>
                            <th className="num" style={{ width: 70 }}>{isAr ? 'النقرات' : 'Clicks'}</th>
                            <th className="num" style={{ width: 64 }}>{isAr ? 'عملاء' : 'Leads'}</th>
                            <th className="num" style={{ width: 74 }}>{isAr ? 'مؤهلون' : 'Qualified'}</th>
                            <th className="num" style={{ width: 92 }}>{isAr ? 'تكلفة المؤهل' : 'Cost/qual.'}</th>
                            <th style={{ width: 104 }}>{isAr ? 'الحالة' : 'Status'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ads.map((ad) => {
                            const c = contentOf(ad.content_id);
                            const wrongProject = Boolean(
                              c && campaign?.project_id && c.project_id && c.project_id !== campaign.project_id,
                            );
                            const waitingOnContent = ad.status === 'waiting' && c && c.status_key !== 'done';
                            const value = cpq(ad);
                            const isBest = ad.id === bestAdId;
                            return (
                              <tr
                                key={ad.id}
                                className={isBest ? 'hl click' : 'click'}
                                style={{
                                  ...(wrongProject
                                    ? { background: 'color-mix(in srgb, var(--late) 6%, transparent)' }
                                    : {}),
                                  ...(ad.status === 'waiting' ? { opacity: 0.6 } : {}),
                                }}
                                onClick={() => setEditingAd(ad)}
                              >
                                <td className="id">{c?.ref ?? '—'}</td>
                                <td>
                                  <div className="ttl">{c?.title
                                    ?? (typeof ad.creative?.asset_title === 'string' ? ad.creative.asset_title : undefined)
                                    ?? ad.label ?? (isAr ? 'بلا محتوى' : 'No content')}</div>
                                  <div
                                    style={{
                                      fontSize: 11,
                                      marginTop: 2,
                                      color: wrongProject ? 'var(--late)' : 'var(--mute)',
                                      fontWeight: wrongProject ? 700 : 400,
                                    }}
                                  >
                                    {wrongProject && c
                                      ? isAr
                                        ? `المشروع الخطأ — محتوى ${projectName(c.project_id)} في حملة ${projectLabel ?? ''}`
                                        : `Wrong project — ${projectName(c.project_id)} content in a ${projectLabel ?? ''} campaign`
                                      : waitingOnContent
                                        ? isAr
                                          ? 'في الانتظار — لا يعمل قبل اعتماد المحتوى'
                                          : 'Waiting — does not run before the content is approved'
                                        : c
                                          ? typeLabel(c.content_type_key)
                                          : ad.note ?? ''}
                                  </div>
                                </td>
                                {adSets.length > 0 && (
                                  <td style={{ fontSize: 12, color: 'var(--mute)' }}>
                                    {adSetName(ad.ad_set_id) ?? '—'}
                                  </td>
                                )}
                                <td className="num">{num(whole(ad.spend), isAr)}</td>
                                <td className="num">{num(ad.clicks, isAr)}</td>
                                <td className="num">{num(ad.leads, isAr)}</td>
                                <td className="num">{num(ad.qualified, isAr)}</td>
                                <td
                                  className="num"
                                  style={isBest ? { color: 'var(--go)', fontWeight: 700 } : undefined}
                                >
                                  {value === null ? '—' : num(Math.round(value), isAr)}
                                </td>
                                <td onClick={wrongProject ? (e) => e.stopPropagation() : undefined}>
                                  {/* A wrong-project row's one honest action is
                                      removal — the mockup puts it right here. */}
                                  {wrongProject && canEnter && canDelete ? (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      onClick={() => void (async () => {
                                        try {
                                          setAds((await deleteAd(execution.id, ad.id)).ads);
                                          addToast(isAr ? 'أُزيل الإعلان.' : 'Ad removed.', 'success');
                                        } catch (err) {
                                          addToast(err instanceof Error ? err.message : String(err), 'error');
                                        }
                                      })()}
                                    >
                                      {isAr ? 'إزالة' : 'Remove'}
                                    </button>
                                  ) : isBest ? (
                                    <Pill tone="go">{isAr ? 'الأفضل' : 'Best'}</Pill>
                                  ) : (
                                    <Pill tone={AD_TONE[ad.status] ?? 'idle'}>
                                      {(isAr ? AD_STATUS_LABELS[ad.status]?.ar : AD_STATUS_LABELS[ad.status]?.en)
                                        ?? ad.status}
                                    </Pill>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* s32 — the same ads as cards: cost per qualified is
                        the dominant number; the rest sit under it in a
                        smaller line. */}
                    <div className="m4-mob" style={{ padding: '10px 12px 12px' }}>
                      <div className="m4-cards">
                        {ads.map((ad) => {
                          const c = contentOf(ad.content_id);
                          const wrongProject = Boolean(
                            c && campaign?.project_id && c.project_id && c.project_id !== campaign.project_id,
                          );
                          const waitingOnContent = ad.status === 'waiting' && c && c.status_key !== 'done';
                          const value = cpq(ad);
                          const isBest = ad.id === bestAdId;
                          return (
                            <button
                              key={ad.id}
                              type="button"
                              className={`m4-vcard${wrongProject ? ' late2' : ''}${ad.status === 'waiting' ? ' dim' : ''}`}
                              onClick={() => setEditingAd(ad)}
                            >
                              <div className="m4-vtop">
                                <span className="id ltr">{c?.ref ?? '—'}</span>
                                {isBest ? (
                                  <Pill tone="go">{isAr ? 'الأفضل' : 'Best'}</Pill>
                                ) : wrongProject ? (
                                  <Pill tone="late">{isAr ? 'المشروع الخطأ' : 'Wrong project'}</Pill>
                                ) : (
                                  <Pill tone={AD_TONE[ad.status] ?? 'idle'}>
                                    {(isAr ? AD_STATUS_LABELS[ad.status]?.ar : AD_STATUS_LABELS[ad.status]?.en)
                                      ?? ad.status}
                                  </Pill>
                                )}
                              </div>
                              <div className="m4-vt">
                                {c?.title ?? ad.label ?? (isAr ? 'بلا محتوى' : 'No content')}
                              </div>
                              {(wrongProject || waitingOnContent) && (
                                <div className={`m4-vwarn${wrongProject ? ' bad' : ''}`}>
                                  {wrongProject && c
                                    ? isAr
                                      ? `المشروع الخطأ — محتوى ${projectName(c.project_id)} في حملة ${projectLabel ?? ''}`
                                      : `Wrong project — ${projectName(c.project_id)} content in a ${projectLabel ?? ''} campaign`
                                    : isAr
                                      ? 'في الانتظار — لا يعمل قبل اعتماد المحتوى'
                                      : 'Waiting — does not run before the content is approved'}
                                </div>
                              )}
                              <div className="m4-vnum">
                                <span
                                  className="n lg"
                                  style={{ color: value === null ? 'var(--mute)' : isBest ? 'var(--go)' : undefined }}
                                >
                                  {value === null ? '—' : num(Math.round(value), isAr)}
                                </span>
                                <span className="s">{isAr ? 'ريال لكل مؤهل' : 'SAR per qualified'}</span>
                              </div>
                              <div className="m4-vstats">
                                <span>
                                  {isAr
                                    ? <>صُرف <b>{num(whole(ad.spend), true)}</b></>
                                    : <><b>{num(whole(ad.spend), false)}</b> spent</>}
                                </span>
                                <span>{isAr ? `${num(ad.clicks, true)} نقرة` : `${num(ad.clicks, false)} clicks`}</span>
                                <span>{isAr ? `${num(ad.leads, true)} عميلًا` : `${num(ad.leads, false)} leads`}</span>
                                <span>{isAr ? `${num(ad.qualified, true)} مؤهلًا` : `${num(ad.qualified, false)} qualified`}</span>
                              </div>
                              {wrongProject && canEnter && canDelete && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  className="btn btn-sm m4-vact"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void (async () => {
                                      try {
                                        setAds((await deleteAd(execution.id, ad.id)).ads);
                                        addToast(isAr ? 'أُزيل الإعلان.' : 'Ad removed.', 'success');
                                      } catch (err) {
                                        addToast(err instanceof Error ? err.message : String(err), 'error');
                                      }
                                    })();
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      void (async () => {
                                        try {
                                          setAds((await deleteAd(execution.id, ad.id)).ads);
                                          addToast(isAr ? 'أُزيل الإعلان.' : 'Ad removed.', 'success');
                                        } catch (err) {
                                          addToast(err instanceof Error ? err.message : String(err), 'error');
                                        }
                                      })();
                                    }
                                  }}
                                >
                                  {isAr ? 'إزالة' : 'Remove'}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {insight && (
                      <div
                        className="card-b"
                        style={{ borderTop: '1px solid var(--line-soft)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85 }}
                      >
                        <b>
                          {isAr
                            ? `${insight.bc.ref} تكلفة المؤهل فيه ${num(Math.round(insight.bcpq), true)} مقابل ${num(Math.round(insight.wcpq), true)} لـ ${insight.wc.ref}`
                            : `${insight.bc.ref} costs ${num(Math.round(insight.bcpq), false)} per qualified against ${num(Math.round(insight.wcpq), false)} for ${insight.wc.ref}`}
                        </b>
                        {isAr
                          ? ` — هذه حجة لصناعة المزيد مما يعمل، وهي ظاهرة فقط لأن الإعلان يشير إلى سجل محتوى بدل ملف مرفوع بلا هوية.`
                          : ` — the argument for making more of what works, visible only because the ad points at a content record instead of an uploaded file with no identity.`}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === 'targeting' && (
              <div style={{ display: 'grid', gap: 14 }}>
                {platformSchema && (
                  <PlatformSettingsForm
                    execution={execution}
                    schema={platformSchema}
                    canEdit={canEnter}
                    isAr={isAr}
                    onSaved={(s) => setExecution({ ...execution, platform_settings: s })}
                  />
                )}
                {/* Meta/Instagram get their audience from the campaign's linked
                    Saved Audience (edited on the campaign page), so the legacy
                    free-text targeting brief would only duplicate/contradict it.
                    Non-schema platforms (google/x/youtube) keep the free-text
                    brief as their only targeting surface. */}
                {isMetaExec ? (
                  <div className="card">
                    <div className="card-h">
                      <h4>{isAr ? 'الجمهور' : 'Audience'}</h4>
                    </div>
                    <div className="card-b" style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.9 }}>
                      {isAr
                        ? 'الجمهور على ميتا يأتي من الجمهور المحفوظ المرتبط بالحملة — يُختار في صفحة الحملة، ويُدفع إلى المجموعات الإعلانية عند «الإنشاء في ميتا». لا يُكتب هنا كنص حر.'
                        : 'The Meta audience comes from the Saved Audience linked on the campaign — set on the campaign page and pushed to the ad sets on «Create in Meta». It is not typed here as free text.'}
                    </div>
                  </div>
                ) : !platformSchema ? (
                  <TargetingEditor
                    execution={execution}
                    canEdit={canEnter}
                    isAr={isAr}
                    onSaved={(t) => setExecution({ ...execution, targeting: t })}
                  />
                ) : null}
              </div>
            )}

          </div>

          {/* The side panels from the frame — always visible on desktop. */}
          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <OnPlatformCard
              execution={execution}
              canEdit={canEnter}
              isAr={isAr}
              onSaved={(pid, purpose) => setExecution({
                ...execution,
                platform_campaign_id: pid,
                purpose,
              })}
            />
            <div className="card">
              <div className="card-h">
                <h4>{platformSchema ? (isAr ? 'إعدادات المنصة' : 'Platform settings') : (isAr ? 'الاستهداف' : 'Targeting')}</h4>
                {platformSchema && platformSettings && (
                  <span className="r">
                    {(() => {
                      const p = settingsProgress(platformSchema, platformSettings);
                      return isAr ? `${num(p.set, true)} من ${num(p.total, true)}` : `${p.set} of ${p.total}`;
                    })()}
                  </span>
                )}
              </div>
              <div className="card-b">
                {platformSchema && summaryParts.length > 0 ? (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {summaryParts.map((p, i) => <span key={i} className="tag">{p}</span>)}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.8 }}>
                      {isAr
                        ? 'التفاصيل الكاملة في تبويب إعدادات المنصة.'
                        : 'Full detail lives in the Platform settings tab.'}
                    </div>
                  </>
                ) : platformSchema ? (
                  <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.85 }}>
                    {isAr
                      ? 'لم تُعبأ الإعدادات بعد — تبويب إعدادات المنصة يعرض نفس حقول مدير إعلانات المنصة.'
                      : 'Nothing set yet — the Platform settings tab carries the platform’s own Ads Manager fields.'}
                  </div>
                ) : (
                  <>
                    <ReadField label={isAr ? 'الموقع' : 'Location'}>{targeting.location || '—'}</ReadField>
                    <ReadField label={isAr ? 'العمر' : 'Age'}>{targeting.age || '—'}</ReadField>
                    <ReadField label={isAr ? 'الاهتمامات' : 'Interests'}>{targeting.interests || '—'}</ReadField>
                    <ReadField label={isAr ? 'مواضع الظهور' : 'Placements'}>{targeting.placements || '—'}</ReadField>
                    <ReadField label={isAr ? 'المزايدة' : 'Bidding'}>{targeting.bidding || '—'}</ReadField>
                    <ReadField label={isAr ? 'الميزانية اليومية' : 'Daily budget'}>{targeting.daily_budget || '—'}</ReadField>
                  </>
                )}
              </div>
            </div>

            <div
              style={{
                background: 'color-mix(in srgb, var(--gold) 14%, transparent)',
                border: '1px solid color-mix(in srgb, var(--gold) 40%, transparent)',
                borderRadius: 9,
                padding: '12px 13px',
                fontSize: 12,
                lineHeight: 1.85,
                color: 'var(--ink-2)',
              }}
            >
              <b>{isAr ? '«مزامنة من المنصة» طموح لا واقع.' : '“Sync from platform” is ambition, not reality.'}</b>{' '}
              {isAr
                ? 'قبل وجود الربط، هذه الأرقام مُدخلة يدويًا والزر معطّل. الإعدادات ← المنصات هي مكان إنشاء ذلك الربط.'
                : 'Until a connection exists these numbers are entered by hand and the button stays disabled. Settings → Platforms is where that connection gets built.'}
            </div>
          </div>
        </div>
      </div>

      {(addingAd || editingAd) && (
        <AdModal
          executionId={execution.id}
          ad={editingAd}
          adSets={adSets}
          campaignId={execution.campaign_id}
          platform={execution.platform}
          isAr={isAr}
          onClose={() => { setAddingAd(false); setEditingAd(null); }}
          onSaved={(rows) => { setAds(rows); setAddingAd(false); setEditingAd(null); void load(); }}
        />
      )}

      {treeOpen && (
        <CampaignTreeModal
          executionId={execution.id}
          platform={execution.platform}
          onClose={() => setTreeOpen(false)}
          onSaved={() => void load()}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* «على المنصة» — the execution's own id on the ad platform            */
/* ------------------------------------------------------------------ */

/**
 * Every execution stores its platform campaign id — the design note on
 * screen 20: that id is what lets the numbers be pulled automatically later
 * without re-entering anything. Editable here, per screen 21.
 */
function OnPlatformCard({
  execution, canEdit, isAr, onSaved,
}: {
  execution: MosExecution;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (platformCampaignId: string | null, purpose: MosExecution['purpose']) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [pid, setPid] = useState(execution.platform_campaign_id ?? '');
  const [purpose, setPurpose] = useState<string>(execution.purpose ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const nextPurpose = (purpose === '' ? null : purpose) as MosExecution['purpose'];
      await saveExecution(execution.campaign_id, {
        id: execution.id,
        platform_campaign_id: pid.trim() || null,
        purpose: nextPurpose,
      });
      onSaved(pid.trim() || null, nextPurpose);
      addToast(isAr ? 'حُفظ رقم المنصة والغرض.' : 'Platform id and purpose saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-h"><h4>{isAr ? 'على المنصة' : 'On the platform'}</h4></div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <Field
          label={isAr ? 'رقم الحملة على المنصة' : 'Platform campaign id'}
          hint={isAr ? 'ما يتيح سحب الأرقام آليًا لاحقًا' : 'lets the numbers be pulled automatically later'}
        >
          <input
            className="inp ltr cd-platform-id"
            value={pid}
            disabled={!canEdit}
            onChange={(e) => setPid(e.target.value)}
          />
        </Field>
        <Field label={isAr ? 'الغرض' : 'Purpose'}>
          <select
            className="inp"
            value={purpose}
            disabled={!canEdit}
            onChange={(e) => setPurpose(e.target.value)}
          >
            <option value="">{isAr ? 'غير محدد' : 'Not specified'}</option>
            {Object.keys(PURPOSE_PILL_LABELS).map((k) => (
              <option key={k} value={k}>
                {isAr ? PURPOSE_PILL_LABELS[k]?.ar : PURPOSE_PILL_LABELS[k]?.en}
              </option>
            ))}
          </select>
        </Field>
        {canEdit && (
          <div>
            <button type="button" className="btn btn-p btn-sm" onClick={() => void save()} disabled={busy}>
              {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the ad — a content reference + numbers                             */
/* ------------------------------------------------------------------ */

function AdModal({
  executionId, ad, adSets, campaignId, platform, isAr, onClose, onSaved,
}: {
  executionId: string;
  ad: MosAd | null;
  adSets: MosAdSet[];
  campaignId: string;
  platform: string;
  isAr: boolean;
  onClose: () => void;
  onSaved: (ads: MosAd[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { can } = useWorkspace();
  // Meta/Instagram results (status + spend/clicks/leads/qualified) come from
  // the hourly sync — typing them here would just be overwritten, so those
  // fields go read-only and are excluded from the save patch.
  const isMeta = platform === 'meta' || platform === 'instagram';
  const [contentId, setContentId] = useState(ad?.content_id ?? '');
  const [adSetId, setAdSetId] = useState(ad?.ad_set_id ?? '');
  const [status, setStatus] = useState<MosAd['status']>(ad?.status ?? 'waiting');
  const [spend, setSpend] = useState(ad?.spend?.toString() ?? '');
  const [clicks, setClicks] = useState(ad?.clicks?.toString() ?? '');
  const [leads, setLeads] = useState(ad?.leads?.toString() ?? '');
  const [qualified, setQualified] = useState(ad?.qualified?.toString() ?? '');
  const [options, setOptions] = useState<MosContentRow[]>([]);
  const [busy, setBusy] = useState(false);
  // The platform's ad-level creative fields (format, copy, CTA, destination).
  const adSchema = getPlatformSchema(platform);
  const [creative, setCreative] = useState<PlatformSettings>(
    (ad?.creative as PlatformSettings | null) ?? {},
  );

  useEffect(() => {
    // The pick list favors this campaign's content but offers the whole
    // library — the wrong-project WARNING is the guard, not a hard wall,
    // because real campaigns accumulate exactly that mistake.
    void (async () => {
      try {
        const res = await fetchContentList({ limit: 300 });
        const inCampaign = res.content.filter((c) => c.campaign_id === campaignId);
        const rest = res.content.filter((c) => c.campaign_id !== campaignId);
        setOptions([...inCampaign, ...rest]);
      } catch (e) {
        console.error('[marketing] content list for ad picker unavailable', e);
        addToast(isAr ? 'تعذّر تحميل قائمة المحتوى.' : 'Could not load the content list.', 'error');
      }
    })();
  }, [campaignId, addToast, isAr]);

  const n = (s: string): number | null => (s.trim() === '' ? null : Number(s));

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await saveAd(executionId, {
        id: ad?.id,
        content_id: contentId || null,
        ad_set_id: adSetId || null,
        // For Meta the status + result metrics are synced — never write them
        // from this modal (empty would wipe Meta's real numbers).
        ...(isMeta ? {} : {
          status,
          spend: n(spend),
          clicks: n(clicks),
          leads: n(leads),
          qualified: n(qualified),
        }),
        ...(adSchema ? { creative } : {}),
      });
      addToast(isAr ? 'حُفظ الإعلان.' : 'Ad saved.', 'success');
      onSaved(res.ads);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!ad) return;
    setBusy(true);
    try {
      const res = await deleteAd(executionId, ad.id);
      addToast(isAr ? 'حُذف الإعلان.' : 'Ad deleted.', 'success');
      onSaved(res.ads);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={ad ? (isAr ? 'تعديل الإعلان' : 'Edit ad') : (isAr ? 'إضافة إعلان' : 'Add an ad')}
      sub={isMeta
        ? isAr
          ? 'الإعلان إشارة إلى سجل محتوى. الحالة والأرقام تأتي من ميتا تلقائيًا — لا تُدخل هنا.'
          : 'An ad references a content record. Status and numbers come from Meta automatically — not entered here.'
        : isAr
          ? 'الإعلان إشارة إلى سجل محتوى، لا ملف مرفوع. الأرقام تُدخل يدويًا حتى تُربط المنصة.'
          : 'An ad references a content record, never an uploaded file. Numbers are entered by hand until the platform is connected.'}
      onClose={onClose}
      wide={Boolean(adSchema)}
      footer={
        <>
          {ad && can('delete_records') && (
            <button type="button" className="btn btn-d" onClick={() => void remove()} disabled={busy}>
              {isAr ? 'حذف' : 'Delete'}
            </button>
          )}
          {!isMeta && (
            <span className="note">
              {isAr ? 'اترك أي خانة فارغة إن لم تُقس — الفارغ ليس صفرًا.' : 'Leave a box empty if it was not measured — empty is not zero.'}
            </span>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'سجل المحتوى' : 'The content record'}>
        <select className="inp" value={contentId} onChange={(e) => setContentId(e.target.value)}>
          <option value="">{isAr ? 'غير محدد' : 'Not specified'}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>{c.ref} · {c.title}</option>
          ))}
        </select>
      </Field>
      {adSets.length > 0 && (
        <Field
          label={isAr ? 'المجموعة الإعلانية' : 'Ad set'}
          hint={isAr ? 'أي مجموعة يعمل تحتها هذا الإعلان' : 'which ad set this ad runs under'}
        >
          <select className="inp" value={adSetId} onChange={(e) => setAdSetId(e.target.value)}>
            <option value="">{isAr ? 'غير محدَّدة' : 'Unassigned'}</option>
            {adSets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
      )}
      {isMeta ? (
        <Field
          label={isAr ? 'الحالة' : 'Status'}
          hint={isAr ? 'تأتي من ميتا وتُحدَّث تلقائيًا' : 'comes from Meta, updated automatically'}
        >
          <div className="inp" style={{ display: 'flex', alignItems: 'center', color: 'var(--mute)' }}>
            {(isAr ? AD_STATUS_LABELS[status]?.ar : AD_STATUS_LABELS[status]?.en) ?? status}
            <span className="tag" style={{ marginInlineStart: 'auto', fontSize: 10 }}>
              {isAr ? 'من ميتا' : 'from Meta'}
            </span>
          </div>
        </Field>
      ) : (
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <div className="seg" style={{ width: '100%' }}>
            {(['waiting', 'running', 'watch', 'paused'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={status === s ? 'on' : ''}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setStatus(s)}
              >
                {isAr ? AD_STATUS_LABELS[s]?.ar : AD_STATUS_LABELS[s]?.en}
              </button>
            ))}
          </div>
        </Field>
      )}
      {isMeta ? (
        <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.85 }}>
          {isAr
            ? 'النتائج — الإنفاق، النقرات، العملاء، المؤهلون — تأتي من ميتا تلقائيًا، فلا تُدخل هنا.'
            : 'Results — spend, clicks, leads, qualified — come from Meta automatically, not entered here.'}
        </div>
      ) : (
        <div className="m4-adnum">
          <Field label={isAr ? 'الإنفاق' : 'Spend'}>
            <input className="inp" inputMode="numeric" value={spend} onChange={(e) => setSpend(e.target.value)} />
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
      )}
      {adSchema && (
        <div style={{ marginTop: 16 }}>
          <PlatformFieldsGrid
            schema={adSchema}
            sections={adSchema.adSections}
            draft={creative}
            disabled={busy}
            isAr={isAr}
            onChange={setCreative}
          />
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* targeting + lead form editors                                      */
/* ------------------------------------------------------------------ */

const TARGETING_FIELDS: Array<{ key: keyof MosTargeting; ar: string; en: string; hint_ar?: string }> = [
  { key: 'location', ar: 'الموقع', en: 'Location', hint_ar: 'الرياض + ٢٥ كم' },
  { key: 'age', ar: 'العمر', en: 'Age', hint_ar: '٣٠ – ٤٥' },
  { key: 'interests', ar: 'الاهتمامات', en: 'Interests', hint_ar: 'عقار، تحسين المنزل، عائلة' },
  { key: 'placements', ar: 'مواضع الظهور', en: 'Placements', hint_ar: 'الرئيسية، ريلز، ستوري' },
  { key: 'bidding', ar: 'المزايدة', en: 'Bidding', hint_ar: 'أقل تكلفة · بلا سقف' },
  { key: 'daily_budget', ar: 'الميزانية اليومية', en: 'Daily budget', hint_ar: '٦٤٥ ريالًا' },
];

function TargetingEditor({
  execution, canEdit, isAr, onSaved,
}: {
  execution: MosExecution;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (t: MosTargeting) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState<MosTargeting>(execution.targeting ?? {});
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await saveExecution(execution.campaign_id, { id: execution.id, targeting: draft });
      onSaved(draft);
      addToast(isAr ? 'حُفظ الاستهداف.' : 'Targeting saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الاستهداف' : 'Targeting'}</h4>
        <span className="r">
          {isAr ? 'وصف الإعداد على المنصة — نص حر' : 'describes the platform setup — free text'}
        </span>
      </div>
      <div className="card-b m4-2col">
        {TARGETING_FIELDS.map((f) => (
          <Field key={f.key} label={isAr ? f.ar : f.en}>
            <input
              className="inp"
              value={draft[f.key] ?? ''}
              disabled={!canEdit}
              placeholder={isAr ? f.hint_ar : undefined}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      {canEdit && (
        <div className="card-b" style={{ paddingTop: 0 }}>
          <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ الاستهداف' : 'Save targeting'}
          </button>
        </div>
      )}
    </div>
  );
}

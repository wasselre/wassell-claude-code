/**
 * Channel capacity, and the conflict it produces.
 *
 * Capacity belongs to the CHANNEL, above any campaign: "two videos and one image
 * a day" is a property of the Instagram account's operating plan, not of
 * whichever campaign happens to be running. Campaigns REQUEST slots; the master
 * calendar decides which requests are granted.
 *
 * The arithmetic lives in mkt_capacity_status so the UI and any future report
 * cannot disagree. This screen shows it and gives a way to resolve an
 * over-allocation — granting less than requested is the resolution, and the gap
 * between requested and granted stays visible rather than being edited away.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, AlertTriangle, Check } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section, Stat, EmptyHint, CaveatStrip, Spinner }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import { PLATFORM_LABEL } from '@/lib/marketingMgmt/labels';
import {
  fetchPlanningOverview, fetchPlanDetail, fetchPortfolio, fetchCapacityStatus,
  saveChannelPlan, allocateCapacity,
  type MktPlan, type ChannelPlan, type CapacityStatus, type Program,
} from '@/lib/marketingMgmt/v2';
import type { Campaign } from '@/lib/marketingMgmt/client';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Monday of the ISO week containing d — the unit editorial teams plan in. */
function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (x.getUTCDay() + 6) % 7;           // Mon = 0
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

export function CapacityView({ isAr, onError, onToast }: {
  isAr: boolean; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const [plans, setPlans] = useState<MktPlan[]>([]);
  const [planId, setPlanId] = useState('');
  const [channels, setChannels] = useState<ChannelPlan[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [week, setWeek] = useState(() => mondayOf(new Date()));
  const [chanId, setChanId] = useState('');
  const [status, setStatus] = useState<CapacityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addingChannel, setAddingChannel] = useState(false);
  const [addingAlloc, setAddingAlloc] = useState(false);
  const [cf, setCf] = useState<Record<string, string>>({ platform: 'instagram' });
  const [af, setAf] = useState<Record<string, string>>({ allocation_kind: 'campaign_allocation' });

  useEffect(() => {
    fetchPlanningOverview()
      .then((o) => { setPlans(o.plans); if (!planId && o.plans[0]) setPlanId(o.plans[0].id); })
      .catch((e) => onError(err(e)))
      .finally(() => setLoading(false));
  }, [onError, planId]);

  const loadPlan = useCallback(() => {
    if (!planId) { setChannels([]); return; }
    Promise.all([fetchPlanDetail(planId), fetchPortfolio(planId)])
      .then(([d, p]) => {
        setChannels(d.channels);
        setPrograms(p.programs); setCampaigns(p.campaigns);
        if (!chanId && d.channels[0]) setChanId(d.channels[0].id);
      })
      .catch((e) => onError(err(e)));
  }, [planId, chanId, onError]);
  useEffect(loadPlan, [loadPlan]);

  const loadStatus = useCallback(() => {
    if (!chanId || !week) { setStatus(null); return; }
    fetchCapacityStatus(chanId, week).then((r) => setStatus(r.status)).catch((e) => onError(err(e)));
  }, [chanId, week, onError]);
  useEffect(loadStatus, [loadStatus]);

  const addChannel = async () => {
    if (!planId || !cf.platform) return;
    setBusy(true);
    try {
      await saveChannelPlan({
        plan_id: planId, platform: cf.platform, account_handle: cf.handle || null,
        max_per_week: cf.max_per_week ? Number(cf.max_per_week) : null,
        max_per_day: cf.max_per_day ? Number(cf.max_per_day) : null,
        reactive_reserve: cf.reactive ? Number(cf.reactive) : 0,
      });
      setAddingChannel(false); setCf({ platform: 'instagram' });
      onToast(isAr ? 'أُضيفت القناة' : 'Channel added'); loadPlan();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const addAllocation = async () => {
    if (!chanId || !af.slots) return;
    const kind = af.allocation_kind;
    setBusy(true);
    try {
      await allocateCapacity({
        channel_plan_id: chanId, week_start: week, allocation_kind: kind,
        program_id: kind === 'program_reservation' ? af.subject || null : null,
        campaign_id: kind === 'campaign_allocation' ? af.subject || null : null,
        slots_requested: Number(af.slots),
      });
      setAddingAlloc(false); setAf({ allocation_kind: 'campaign_allocation' });
      onToast(isAr ? 'سُجِّل الطلب' : 'Request recorded'); loadStatus(); loadPlan();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  /** Resolution: grant a number that fits. The request stays as it was, so the
   *  shortfall remains visible instead of being quietly rewritten. */
  const grant = async (allocId: string, granted: number) => {
    setBusy(true);
    try {
      await allocateCapacity({ slots_granted: granted }, allocId);
      onToast(isAr ? 'حُدِّث المعتمد' : 'Granted updated'); loadStatus(); loadPlan();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const chan = channels.find((c) => c.id === chanId) ?? null;
  // Program and reserve rows come from the channel copy; CAMPAIGN rows come from
  // the server payload, which already scoped them to this week and carries the
  // allocation id. Deriving them client-side let the conflict banner (server) and
  // the editable list (client filter) describe different weeks.
  const nonCampaignAllocs = (chan?.mkt_capacity_allocations ?? [])
    .filter((a) => a.week_start === week && a.allocation_kind !== 'campaign_allocation');
  const nameForProgram = (id: string | null) =>
    id ? programs.find((p) => p.id === id)?.name_ar ?? null : null;

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  return (
    <Section title={isAr ? 'سعة القنوات' : 'Channel capacity'}
      subtitle={isAr ? 'السعة تخص القناة، لا الحملة. الحملات تطلب، والتقويم يقرر.'
                     : 'Capacity belongs to the channel, not the campaign. Campaigns request; the calendar decides.'}>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'الخطة' : 'Plan'}</span>
          <select value={planId} onChange={(e) => { setPlanId(e.target.value); setChanId(''); }}
            className={`${FIELD} min-w-[160px]`}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'القناة' : 'Channel'}</span>
          <select value={chanId} onChange={(e) => setChanId(e.target.value)} className={`${FIELD} min-w-[160px]`}>
            <option value="">{isAr ? '— اختر —' : '— select —'}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {lbl(PLATFORM_LABEL, c.platform, isAr)}{c.account_handle ? ` ${c.account_handle}` : ''}
              </option>))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'الأسبوع' : 'Week'}</span>
          <input type="date" value={week} onChange={(e) => setWeek(mondayOf(new Date(e.target.value)))}
            className={FIELD} />
        </label>
        <Button variant="secondary" onClick={() => setAddingChannel((v) => !v)} disabled={!planId}>
          <Plus className="h-4 w-4" />{isAr ? 'قناة' : 'Channel'}
        </Button>
      </div>

      {addingChannel && (
        <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-5">
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'المنصة' : 'Platform'}</span>
            <select value={cf.platform} onChange={(e) => setCf({ ...cf, platform: e.target.value })} className={FIELD}>
              {['instagram','tiktok','youtube','snapchat','x','facebook','linkedin','whatsapp','website'].map((p) => (
                <option key={p} value={p}>{lbl(PLATFORM_LABEL, p, isAr)}</option>))}
            </select></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'الحساب' : 'Handle'}</span>
            <input value={cf.handle ?? ''} onChange={(e) => setCf({ ...cf, handle: e.target.value })} className={FIELD} placeholder="@wassel" /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'أسبوعياً' : 'Per week'}</span>
            <input type="number" value={cf.max_per_week ?? ''} onChange={(e) => setCf({ ...cf, max_per_week: e.target.value })} className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'يومياً' : 'Per day'}</span>
            <input type="number" value={cf.max_per_day ?? ''} onChange={(e) => setCf({ ...cf, max_per_day: e.target.value })} className={FIELD} /></label>
          <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'احتياطي تفاعلي' : 'Reactive reserve'}</span>
            <input type="number" value={cf.reactive ?? ''} onChange={(e) => setCf({ ...cf, reactive: e.target.value })} className={FIELD} /></label>
          <div className="sm:col-span-5">
            <Button onClick={addChannel} disabled={busy}>{isAr ? 'إضافة' : 'Add'}</Button>
          </div>
        </div>
      )}

      {!chan ? (
        <EmptyHint>
          {isAr ? 'لا قنوات لهذه الخطة — أضف قناة لتحديد السعة' : 'No channels on this plan — add one to set capacity'}
        </EmptyHint>
      ) : !status ? (
        <Spinner label={isAr ? 'جارٍ الحساب…' : 'Calculating…'} />
      ) : (
        <>
          {!status.capacity_configured && (
            <CaveatStrip>
              {isAr ? 'لم تُحدَّد سعة أسبوعية لهذه القناة — لا يمكن حساب التعارض. هذا ليس صفراً، بل غير مُعرَّف.'
                    : 'No weekly capacity set for this channel — the conflict cannot be computed. That is undefined, not zero.'}
            </CaveatStrip>
          )}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            <Stat label={isAr ? 'سعة الأسبوع' : 'Week capacity'} value={status.week_capacity} />
            <Stat label={isAr ? 'محجوز للبرامج' : 'Program reserved'} value={status.program_reserved} />
            <Stat label={isAr ? 'احتياطي تفاعلي' : 'Reactive reserve'} value={status.reactive_reserved} />
            <Stat label={isAr ? 'متاح للحملات' : 'Campaign available'} value={status.campaign_available} />
            <Stat label={isAr ? 'مطلوب' : 'Requested'} value={status.campaign_requested} />
          </div>

          {status.is_over_allocated === true && (
            <div className="mt-2.5 rounded-xl border border-red-200 bg-red-50 p-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-red-800">
                <AlertTriangle className="h-4 w-4" />
                {isAr
                  ? `الطلبات تتجاوز المتاح بـ ${status.over_allocated_by} خانة`
                  : `Requests exceed available capacity by ${status.over_allocated_by} slots`}
              </div>
              <p className="mt-1 text-[12px] text-red-700">
                {isAr
                  ? `${status.campaign_requests.length} حملات تطلب ${status.campaign_requested} من أصل ${status.campaign_available} متاحة. اعتمد أقل من المطلوب لأي منها، أو ارفع سعة القناة، أو أجّل حملة لأسبوع آخر.`
                  : `${status.campaign_requests.length} campaigns request ${status.campaign_requested} of ${status.campaign_available} available. Grant less than requested, raise the channel capacity, or move a campaign to another week.`}
              </p>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <h4 className="text-[12px] font-semibold text-charcoal/70">
              {isAr ? 'الطلبات هذا الأسبوع' : 'Requests this week'}
            </h4>
            <button type="button" onClick={() => setAddingAlloc((v) => !v)}
              className="text-[11.5px] font-medium text-copper hover:underline">
              {isAr ? '+ طلب' : '+ request'}
            </button>
          </div>

          {addingAlloc && (
            <div className="mt-2 grid gap-2 rounded-lg border border-copper/30 bg-white p-2.5 sm:grid-cols-4">
              <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'النوع' : 'Kind'}</span>
                <select value={af.allocation_kind} onChange={(e) => setAf({ ...af, allocation_kind: e.target.value, subject: '' })} className={FIELD}>
                  <option value="campaign_allocation">{isAr ? 'حملة' : 'Campaign'}</option>
                  <option value="program_reservation">{isAr ? 'برنامج' : 'Program'}</option>
                  <option value="reactive_reserve">{isAr ? 'احتياطي تفاعلي' : 'Reactive reserve'}</option>
                </select></label>
              {af.allocation_kind !== 'reactive_reserve' && (
                <label className="block sm:col-span-2"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'العنصر' : 'Subject'}</span>
                  <select value={af.subject ?? ''} onChange={(e) => setAf({ ...af, subject: e.target.value })} className={FIELD}>
                    <option value="">{isAr ? '— اختر —' : '— select —'}</option>
                    {(af.allocation_kind === 'program_reservation' ? programs : campaigns).map((x) => (
                      <option key={x.id} value={x.id}>{x.name_ar}</option>))}
                  </select></label>
              )}
              <label className="block"><span className="mb-1 block text-[11px] text-charcoal/55">{isAr ? 'الخانات' : 'Slots'}</span>
                <input type="number" value={af.slots ?? ''} onChange={(e) => setAf({ ...af, slots: e.target.value })} className={FIELD} /></label>
              <div className="sm:col-span-4">
                <Button onClick={addAllocation}
                  disabled={busy || !af.slots || (af.allocation_kind !== 'reactive_reserve' && !af.subject)}>
                  {isAr ? 'تسجيل الطلب' : 'Record request'}</Button>
              </div>
            </div>
          )}

          {status.campaign_requests.length === 0 && nonCampaignAllocs.length === 0 ? (
            <div className="mt-2"><EmptyHint>{isAr ? 'لا طلبات لهذا الأسبوع' : 'No requests this week'}</EmptyHint></div>
          ) : (
            <table className="mt-2 w-full text-[12px]">
              <thead>
                <tr className="text-[10.5px] uppercase text-charcoal/40">
                  <th className="py-1 text-start">{isAr ? 'العنصر' : 'Subject'}</th>
                  <th className="py-1 text-start">{isAr ? 'النوع' : 'Kind'}</th>
                  <th className="py-1 text-end">{isAr ? 'مطلوب' : 'Requested'}</th>
                  <th className="py-1 text-end">{isAr ? 'معتمد' : 'Granted'}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-sand/30">
                {/* Programs and the reactive reserve: read-only here — a program's
                    reservation is changed on the program, not in the week view. */}
                {nonCampaignAllocs.map((a) => (
                  <tr key={a.id}>
                    <td className="py-1.5 text-charcoal">
                      {a.allocation_kind === 'program_reservation'
                        ? (nameForProgram(a.program_id) ?? (isAr ? 'برنامج' : 'program'))
                        : (isAr ? 'احتياطي المحتوى التفاعلي' : 'reactive reserve')}
                    </td>
                    <td className="py-1.5 text-charcoal/55">
                      {a.allocation_kind === 'program_reservation'
                        ? (isAr ? 'برنامج' : 'program') : (isAr ? 'احتياطي' : 'reserve')}
                    </td>
                    <td className="py-1.5 text-end tabular-nums text-charcoal">{a.slots_requested}</td>
                    <td className="py-1.5 text-end tabular-nums text-charcoal/55">
                      {a.slots_granted ?? <span className="text-charcoal/30">—</span>}
                    </td>
                    <td />
                  </tr>
                ))}
                {/* Campaign requests, straight from the server payload for this
                    week — same source as the conflict banner, so the two cannot
                    describe different weeks. */}
                {status.campaign_requests.map((r) => {
                  const short = r.granted != null && r.granted < r.requested;
                  return (
                    <tr key={r.allocation_id ?? r.campaign_id}>
                      <td className="py-1.5 text-charcoal">{r.name_ar}</td>
                      <td className="py-1.5 text-charcoal/55">{isAr ? 'حملة' : 'campaign'}</td>
                      <td className="py-1.5 text-end tabular-nums text-charcoal">{r.requested}</td>
                      <td className={`py-1.5 text-end tabular-nums ${short ? 'text-amber-700' : 'text-charcoal'}`}>
                        {r.granted ?? <span className="text-charcoal/30">—</span>}
                        {short && <span className="ms-1 text-[10px]">({r.granted! - r.requested})</span>}
                      </td>
                      <td className="py-1.5 text-end">
                        {r.allocation_id && (
                          <span className="inline-flex items-center gap-1">
                            <input type="number" defaultValue={r.granted ?? ''} disabled={busy}
                              aria-label={isAr ? 'المعتمد' : 'Granted'}
                              className="w-16 rounded border border-sand/60 px-1 py-0.5 text-[11px]"
                              onBlur={(e) => {
                                const v = e.target.value === '' ? null : Number(e.target.value);
                                if (v != null && v !== r.granted) void grant(r.allocation_id!, v);
                              }} />
                            <Check className="h-3 w-3 text-charcoal/25" />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <p className="mt-2 text-[11px] text-charcoal/45">
            {isAr ? 'المطلوب يبقى كما هو عند اعتماد أقل منه — الفجوة تظل ظاهرة بدل أن تُمحى.'
                  : 'A request is not rewritten when less is granted — the shortfall stays visible.'}
          </p>
        </>
      )}
    </Section>
  );
}

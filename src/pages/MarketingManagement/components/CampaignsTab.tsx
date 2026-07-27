/**
 * Campaigns — list, create and drill into one campaign.
 *
 * Completion % counts PUBLISHED content against total linked content. It is a
 * ratio of real rows, so a campaign with no content shows "—" rather than 0%,
 * which would read as "nothing done" instead of "nothing planned".
 */
import { useEffect, useState } from 'react';
import { Plus, ArrowLeft, Target } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section, Stat, EmptyHint, Spinner, CaveatStrip, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  fetchCampaigns, fetchCampaign, saveCampaign, STATUS_LABEL,
  type Campaign, type ContentItem, type ContentTask, type ContentStatus,
} from '@/lib/marketingMgmt/client';

const TYPES = ['organic','paid','project_launch','promotional_offer','awareness',
  'lead_generation','retargeting','construction_update','investor','seasonal','custom'] as const;
const STATUSES = ['draft','planned','active','paused','completed','cancelled','archived'] as const;
const ST_LABEL: Record<string, { ar: string; en: string }> = {
  draft:{ar:'مسودة',en:'Draft'}, planned:{ar:'مخطط',en:'Planned'}, active:{ar:'نشط',en:'Active'},
  paused:{ar:'موقوف',en:'Paused'}, completed:{ar:'مكتمل',en:'Completed'},
  cancelled:{ar:'ملغي',en:'Cancelled'}, archived:{ar:'مؤرشف',en:'Archived'},
};

export default function CampaignsTab({ isAr, onOpenContent }: { isAr: boolean; onOpenContent: (id: string) => void }) {
  const [rows, setRows] = useState<Campaign[]>([]);
  const [detail, setDetail] = useState<{ campaign: Campaign; content: ContentItem[]; tasks: ContentTask[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: '', name_ar: '', campaign_type: 'organic', channel_mix: 'organic' });

  const load = () => {
    setLoading(true); setErr(null);
    fetchCampaigns().then((r) => setRows(r.campaigns))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const open = async (id: string) => {
    setBusy(true);
    try { const r = await fetchCampaign(id); setDetail({ campaign: r.campaign, content: r.content, tasks: r.tasks }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const create = async () => {
    if (!form.code.trim() || !form.name_ar.trim()) return;
    setBusy(true);
    try {
      await saveCampaign({ ...form, status: 'planned' });
      setCreating(false); setForm({ code: '', name_ar: '', campaign_type: 'organic', channel_mix: 'organic' });
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const setStatus = async (id: string, status: string) => {
    setBusy(true);
    try { await saveCampaign({ status }, id); load(); if (detail?.campaign.id === id) await open(id); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  if (detail) {
    const c = detail.campaign;
    const published = detail.content.filter((x) => x.status === 'published').length;
    const pct = detail.content.length > 0 ? Math.round((published / detail.content.length) * 100) : null;
    return (
      <div className="space-y-4">
        <Button variant="secondary" onClick={() => setDetail(null)}>
          <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />{isAr ? 'كل الحملات' : 'All campaigns'}
        </Button>
        {err && <CaveatStrip>{err}</CaveatStrip>}
        <Section title={`${c.code} · ${isAr ? c.name_ar : (c.name_en ?? c.name_ar)}`}
          subtitle={`${c.campaign_type} · ${isAr ? ST_LABEL[c.status]?.ar : ST_LABEL[c.status]?.en} · ${c.channel_mix}`}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label={isAr ? 'المحتوى' : 'Content'} value={detail.content.length} />
            <Stat label={isAr ? 'نُشر' : 'Published'} value={published} />
            <Stat label={isAr ? 'الإنجاز' : 'Completion'} value={pct === null ? null : `${pct}%`}
                  hint={pct === null ? (isAr ? 'لا محتوى مخطط' : 'no content planned') : undefined} tone={pct === null ? 'muted' : 'default'} />
            <Stat label={isAr ? 'المهام' : 'Tasks'} value={detail.tasks.length} />
            <Stat label={isAr ? 'هدف العملاء' : 'Lead target'} value={c.target_leads} />
            <Stat label={isAr ? 'الميزانية' : 'Budget'} value={c.budget === null ? null : Math.round(c.budget).toLocaleString()} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {STATUSES.filter((s) => s !== c.status).map((s) => (
              <button key={s} type="button" disabled={busy} onClick={() => setStatus(c.id, s)}
                className="rounded-lg border border-sand/60 bg-white px-2 py-1 text-[11px] text-charcoal/70 hover:border-copper/50 disabled:opacity-40">
                → {isAr ? ST_LABEL[s]?.ar ?? s : ST_LABEL[s]?.en ?? s}
              </button>
            ))}
          </div>
        </Section>
        <Section title={isAr ? 'محتوى الحملة' : 'Campaign content'}>
          {detail.content.length === 0 ? (
            <EmptyHint>{isAr ? 'لا محتوى مرتبط — أنشئ محتوى واربطه بهذه الحملة' : 'No linked content yet'}</EmptyHint>
          ) : (
            <ul className="divide-y divide-sand/40">
              {detail.content.map((it) => (
                <li key={it.id}>
                  <button type="button" onClick={() => onOpenContent(it.id)}
                    className="flex w-full items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light">
                    <span className="min-w-0 truncate text-[13px] text-charcoal">{it.content_number} · {it.title}</span>
                    <span className="shrink-0 text-[11.5px] text-charcoal/50">
                      {isAr ? STATUS_LABEL[it.status as ContentStatus]?.ar : STATUS_LABEL[it.status as ContentStatus]?.en}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    );
  }

  return (
    <Section title={isAr ? 'الحملات' : 'Campaigns'}
      right={<Button onClick={() => setCreating((v) => !v)}><Plus className="h-4 w-4" />{isAr ? 'حملة جديدة' : 'New campaign'}</Button>}>
      {err && <div className="mb-3"><CaveatStrip>{err}</CaveatStrip></div>}
      {creating && (
        <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder={isAr ? 'الرمز (مثال RVR-Q3)' : 'Code (e.g. RVR-Q3)'}
            className="rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px] focus:border-copper focus:outline-none" />
          <input value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
            placeholder={isAr ? 'اسم الحملة' : 'Campaign name'}
            className="rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px] focus:border-copper focus:outline-none" />
          <select value={form.campaign_type} onChange={(e) => setForm({ ...form, campaign_type: e.target.value })}
            className="rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px]">
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="flex gap-2">
            <select value={form.channel_mix} onChange={(e) => setForm({ ...form, channel_mix: e.target.value })}
              className="flex-1 rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px]">
              <option value="organic">{isAr ? 'عضوي' : 'Organic'}</option>
              <option value="paid">{isAr ? 'مدفوع' : 'Paid'}</option>
              <option value="both">{isAr ? 'الاثنان' : 'Both'}</option>
            </select>
            <Button onClick={create} disabled={busy || !form.code.trim() || !form.name_ar.trim()}>{isAr ? 'إنشاء' : 'Create'}</Button>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyHint>{isAr ? 'لا حملات بعد' : 'No campaigns yet'}</EmptyHint>
      ) : (
        <ul className="divide-y divide-sand/40">
          {rows.map((c) => {
            const total = c.mkt_content_items?.length ?? 0;
            const pub = c.mkt_content_items?.filter((x) => x.status === 'published').length ?? 0;
            return (
              <li key={c.id}>
                <button type="button" onClick={() => void open(c.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light">
                  <span className="flex min-w-0 items-center gap-2">
                    <Target className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
                    <span className="truncate text-[13px] font-medium text-charcoal">{c.code} · {isAr ? c.name_ar : (c.name_en ?? c.name_ar)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-charcoal/50">
                    <span>{isAr ? ST_LABEL[c.status]?.ar : ST_LABEL[c.status]?.en}</span>
                    <span>{total === 0 ? (isAr ? 'بلا محتوى' : 'no content') : `${pub}/${total}`}</span>
                    <span>{c.end_date ? fmtDate(c.end_date, isAr) : '—'}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

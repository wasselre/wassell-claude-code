/**
 * Project Intelligence — everything observed about how ONE project is being
 * marketed, by whom, saying what, at what price.
 *
 * Reads mkt_project_intelligence() in a single round trip. Every figure is a
 * count or an aggregate over stored facts; nothing here is model output.
 *
 * The attribution caveat is rendered FIRST and unconditionally. Post counts on
 * this page are confirmed attributions only — the speculative candidate set is
 * ~20x larger, and an earlier version of the rollup that mixed them reported
 * roughly 130 posts for nearly every project.
 */
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { fetchProjectIntelligence, type ProjectIntelligence, type PIFactType, type PIFactValue } from '@/lib/marketing/client';
import { Section, Stat, Pill, CaveatStrip, EmptyHint, Spinner, ShownOf, fmtDate, fmtPrice } from './shared';

const FACT_LABELS: Record<PIFactType, { ar: string; en: string }> = {
  price: { ar: 'الأسعار المعلنة', en: 'Advertised prices' },
  offer: { ar: 'العروض التجارية', en: 'Commercial offers' },
  payment_plan: { ar: 'خطط السداد', en: 'Payment plans' },
  financing: { ar: 'التمويل', en: 'Financing' },
  cta: { ar: 'دعوات الإجراء', en: 'Calls to action' },
  campaign_message: { ar: 'رسائل الحملة', en: 'Campaign messages' },
  selling_point: { ar: 'نقاط البيع', en: 'Selling points' },
  amenity: { ar: 'المرافق', en: 'Amenities' },
  unit_type: { ar: 'أنواع الوحدات', en: 'Unit types' },
  district: { ar: 'الأحياء', en: 'Districts' },
  delivery_date: { ar: 'مواعيد التسليم', en: 'Delivery dates' },
  phone: { ar: 'أرقام التواصل', en: 'Phone numbers' },
  audience: { ar: 'الجمهور', en: 'Audience' },
};
const FACT_ORDER: PIFactType[] = [
  'price', 'offer', 'payment_plan', 'financing', 'cta', 'campaign_message',
  'selling_point', 'amenity', 'unit_type', 'district', 'delivery_date', 'phone', 'audience',
];

function FactGroup({ label, values, isAr }: { label: string; values: PIFactValue[]; isAr: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? values : values.slice(0, 6);
  return (
    <div className="rounded-xl border border-sand/50 bg-white p-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-charcoal">{label}</span>
        <span className="text-[11px] tabular-nums text-charcoal/40">{values.length}</span>
      </div>
      <ul className="space-y-1.5">
        {shown.map((v) => (
          <li key={v.key} className="flex items-start justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal/80" title={v.value}>{v.value}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-charcoal/45">
              {v.posts}
              {isAr ? ' منشور' : v.posts === 1 ? ' post' : ' posts'}
            </span>
          </li>
        ))}
      </ul>
      {values.length > 6 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-[11.5px] font-medium text-copper hover:underline"
        >
          {expanded
            ? (isAr ? 'عرض أقل' : 'Show less')
            : (isAr ? `عرض الكل (${values.length})` : `Show all (${values.length})`)}
        </button>
      )}
    </div>
  );
}

export default function ProjectPanel({ projectId, isAr }: { projectId: string; isAr: boolean }) {
  const [data, setData] = useState<ProjectIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProjectIntelligence(projectId, { limit: 25 })
      .then((r) => { if (!cancelled) setData(r.intelligence); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  if (error) return <CaveatStrip>{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</CaveatStrip>;
  if (!data || !data.project) return <EmptyHint>{isAr ? 'لا توجد بيانات' : 'No data'}</EmptyHint>;

  const p = data.project;
  const aq = data.attribution_quality;
  const priceLo = fmtPrice(data.trends.price.find((x) => x.min !== null)?.min ?? null);
  const factGroups = FACT_ORDER
    .map((k) => ({ k, label: isAr ? FACT_LABELS[k].ar : FACT_LABELS[k].en, values: data.facts[k] ?? [] }))
    .filter((g) => g.values.length > 0);

  return (
    <div className="space-y-4">
      <Section
        title={p.name ?? (isAr ? 'مشروع' : 'Project')}
        subtitle={[p.city, p.status, p.developer?.name].filter(Boolean).join(' · ') || undefined}
        right={p.page_url
          ? <a href={p.page_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-copper hover:underline">
              {isAr ? 'الصفحة' : 'Page'}<ExternalLink className="h-3.5 w-3.5" />
            </a>
          : undefined}
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={isAr ? 'منشورات مؤكدة' : 'Confirmed posts'} value={aq.confirmed_posts} />
          <Stat label={isAr ? 'مرشّحة (غير مؤكدة)' : 'Speculative'} value={aq.speculative_posts} tone="muted" />
          <Stat label={isAr ? 'إعلانات مدفوعة' : 'Paid ads'} value={data.paid_ads.total} />
          <Stat label={isAr ? 'حقائق مرصودة' : 'Observed facts'} value={Object.values(data.facts).reduce((n, v) => n + (v?.length ?? 0), 0)} />
          <Stat label={isAr ? 'أقل سعر معلن' : 'Lowest advertised'} value={priceLo ? `${priceLo} ${isAr ? 'ر.س' : 'SAR'}` : null} />
        </div>
        <div className="mt-3">
          <CaveatStrip>{aq.note}</CaveatStrip>
        </div>
      </Section>

      {factGroups.length > 0 && (
        <Section
          title={isAr ? 'ما يقولونه فعلياً' : 'What they actually say'}
          subtitle={isAr
            ? 'مستخرج من نص المنشورات والنص المقروء من الصور — لا استنتاج نموذجي'
            : 'Extracted from captions, transcripts and image OCR — no model inference'}
        >
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {factGroups.map((g) => <FactGroup key={g.k} label={g.label} values={g.values} isAr={isAr} />)}
          </div>
        </Section>
      )}

      {data.organizations.length > 0 && (
        <Section title={isAr ? 'من يسوّق هذا المشروع' : 'Who markets this project'}>
          <ul className="divide-y divide-sand/40">
            {data.organizations.map((o) => (
              <li key={o.organization_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-charcoal">{o.name ?? '—'}</span>
                  <Pill tone={o.role === 'developer' ? 'copper' : 'neutral'}>
                    {o.role === 'developer' ? (isAr ? 'المطوّر' : 'Developer')
                      : o.role === 'authorized_marketer' ? (isAr ? 'مسوّق معتمد' : 'Authorized marketer')
                      : (isAr ? 'مسوّق مرصود' : 'Observed marketer')}
                  </Pill>
                  {o.human_confirmed && <Pill>{isAr ? 'مؤكد بشرياً' : 'human-confirmed'}</Pill>}
                </div>
                <span className="text-[11.5px] text-charcoal/45">
                  {isAr ? 'أول رصد ' : 'first seen '}{fmtDate(o.first_observed_at, isAr)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.trends.platforms.length > 0 && (
        <Section title={isAr ? 'التوزيع على المنصات' : 'Platform distribution'}>
          <div className="space-y-2">
            {data.trends.platforms.map((pl) => (
              <div key={pl.platform} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-[12px] capitalize text-charcoal/70">{pl.platform}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-cream">
                  <div className="h-full rounded-full bg-copper" style={{ width: `${Math.min(100, pl.share_pct ?? 0)}%` }} />
                </div>
                <span className="w-24 shrink-0 text-end text-[11.5px] tabular-nums text-charcoal/50">
                  {pl.posts} · {pl.share_pct === null ? '—' : `${Math.round(pl.share_pct)}%`}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data.content.recent.length > 0 && (
        <Section
          title={isAr ? 'أحدث المنشورات' : 'Recent posts'}
          right={<ShownOf shown={data.content.shown} total={data.content.total} isAr={isAr} />}
        >
          <ul className="divide-y divide-sand/40">
            {data.content.recent.map((c) => (
              <li key={c.post_id} className="py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-charcoal/75">
                    {c.caption_preview || (isAr ? '(بدون نص)' : '(no caption)')}
                  </p>
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 text-charcoal/35 hover:text-copper">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-charcoal/45">
                  <span className="capitalize">{c.platform}</span>
                  <span>{fmtDate(c.published_at, isAr)}</span>
                  {c.attribution_method && <Pill>{c.attribution_method}</Pill>}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

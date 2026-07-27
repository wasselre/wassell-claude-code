/**
 * Organization Intelligence — one competitor (developer, marketing company, or
 * both), across every project they touch.
 *
 * Role is per-project, never a property of the org: 9 organizations in
 * production are simultaneously a developer on some projects and a marketer on
 * others, so this panel shows a role breakdown rather than a single label.
 *
 * Two honesty rules are enforced in the render, not just the data:
 *   - Follower growth shows "—" when `growth_measurable` is false. Fewer than
 *     two observations means we cannot SEE growth; rendering 0% would assert
 *     "flat", which is a different and unfounded claim.
 *   - `change_pct === null` (no prior baseline) likewise renders "—", never 0.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, TrendingUp, TrendingDown } from 'lucide-react';
import { fetchOrganizationIntelligence, type OrganizationIntelligence, type PIFactValue } from '@/lib/marketing/client';
import { Section, Stat, Pill, CaveatStrip, EmptyHint, Spinner, ShownOf, fmtDate, fmtPrice } from './shared';

const ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  developer: { ar: 'مطوّر', en: 'Developer' },
  authorized_marketer: { ar: 'مسوّق معتمد', en: 'Authorized marketer' },
  observed_marketer: { ar: 'مسوّق مرصود', en: 'Observed marketer' },
};

function FactChips({ label, values, isAr }: { label: string; values: PIFactValue[]; isAr: boolean }) {
  if (values.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {values.slice(0, 10).map((v) => (
          <span key={v.key} className="inline-flex items-center gap-1.5 rounded-full border border-sand/60 bg-white px-2.5 py-1 text-[12px] text-charcoal/75">
            <span className="max-w-[220px] truncate" title={v.value}>{v.value}</span>
            <span className="tabular-nums text-charcoal/40">{v.posts}</span>
          </span>
        ))}
        {values.length > 10 && (
          <span className="inline-flex items-center rounded-full px-2 py-1 text-[11.5px] text-charcoal/40">
            {isAr ? `+${values.length - 10} أخرى` : `+${values.length - 10} more`}
          </span>
        )}
      </div>
    </div>
  );
}

export default function OrganizationPanel({
  organizationId, isAr, onOpenProject,
}: { organizationId: string; isAr: boolean; onOpenProject: (projectId: string) => void }) {
  const [data, setData] = useState<OrganizationIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOrganizationIntelligence(organizationId, { limit: 25 })
      .then((r) => { if (!cancelled) setData(r.intelligence); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [organizationId]);

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  if (error) return <CaveatStrip>{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</CaveatStrip>;
  if (!data || !data.organization) return <EmptyHint>{isAr ? 'لا توجد بيانات' : 'No data'}</EmptyHint>;

  const o = data.organization;
  const aud = data.audience;
  const pf = data.posting_frequency;
  const cov = data.coverage;
  const growth = aud.growth_measurable ? aud.net_change : null;
  const trendUp = (pf.change_pct ?? 0) > 0;

  return (
    <div className="space-y-4">
      <Section
        title={o.name ?? (isAr ? 'منشأة' : 'Organization')}
        subtitle={[o.hq_city, o.status].filter(Boolean).join(' · ') || undefined}
        right={o.website
          ? <a href={o.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-copper hover:underline">
              {isAr ? 'الموقع' : 'Website'}<ExternalLink className="h-3.5 w-3.5" />
            </a>
          : undefined}
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {Object.entries(data.roles).map(([role, n]) => (
            <Pill key={role} tone={role === 'developer' ? 'copper' : 'neutral'}>
              {(isAr ? ROLE_LABELS[role]?.ar : ROLE_LABELS[role]?.en) ?? role} · {n}
            </Pill>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={isAr ? 'مشاريع' : 'Projects'} value={data.projects.total} />
          <Stat label={isAr ? 'منشورات' : 'Posts'} value={pf.total_posts} />
          <Stat
            label={isAr ? 'المتابعون' : 'Followers'}
            value={aud.current_followers}
            hint={aud.growth_measurable
              ? undefined
              : (isAr ? 'رصدة واحدة فقط — النمو غير قابل للقياس بعد' : 'single observation — growth not measurable yet')}
          />
          <Stat
            label={isAr ? 'تغيّر المتابعين' : 'Follower change'}
            value={growth === null ? null : (growth > 0 ? `+${growth.toLocaleString()}` : growth.toLocaleString())}
            tone={growth === null ? 'muted' : 'default'}
          />
          <Stat
            label={isAr ? 'وتيرة النشر (٣ أشهر)' : 'Posting trend (3mo)'}
            value={pf.change_pct === null ? null : `${pf.change_pct > 0 ? '+' : ''}${Math.round(pf.change_pct)}%`}
            hint={pf.change_pct === null
              ? (isAr ? 'لا يوجد أساس سابق للمقارنة' : 'no prior baseline to compare against')
              : `${pf.last_3_months} ${isAr ? 'مقابل' : 'vs'} ${pf.prior_3_months}`}
            tone={pf.change_pct === null ? 'muted' : 'default'}
          />
        </div>
        {(cov.content_unprocessed_posts > 0 || !cov.has_facts) && (
          <div className="mt-3"><CaveatStrip>{cov.note}</CaveatStrip></div>
        )}
      </Section>

      {data.projects.items.length > 0 && (
        <Section
          title={isAr ? 'المشاريع' : 'Projects'}
          right={<ShownOf shown={data.projects.shown} total={data.projects.total} isAr={isAr} />}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-sand/50 text-[11px] uppercase tracking-wide text-charcoal/45">
                  <th className="py-2 text-start font-medium">{isAr ? 'المشروع' : 'Project'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'الدور' : 'Role'}</th>
                  <th className="py-2 text-end font-medium">{isAr ? 'مؤكدة' : 'Confirmed'}</th>
                  <th className="py-2 text-end font-medium">{isAr ? 'مرشّحة' : 'Speculative'}</th>
                  <th className="py-2 text-end font-medium">{isAr ? 'حقائق' : 'Facts'}</th>
                  <th className="py-2 text-end font-medium">{isAr ? 'السعر المعلن' : 'Advertised'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand/30">
                {data.projects.items.map((pr) => {
                  const lo = fmtPrice(pr.min_advertised_price);
                  const hi = fmtPrice(pr.max_advertised_price);
                  return (
                    <tr key={pr.project_id} className="hover:bg-cream-light">
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => onOpenProject(pr.project_id)}
                          className="text-start font-medium text-copper hover:underline"
                        >
                          {pr.name ?? '—'}
                        </button>
                        {pr.city && <span className="ms-2 text-[11px] text-charcoal/40">{pr.city}</span>}
                      </td>
                      <td className="py-2 text-charcoal/60">
                        {(isAr ? ROLE_LABELS[pr.role]?.ar : ROLE_LABELS[pr.role]?.en) ?? pr.role}
                      </td>
                      <td className="py-2 text-end tabular-nums text-charcoal/80">{pr.post_count}</td>
                      <td className="py-2 text-end tabular-nums text-charcoal/35">{pr.candidate_post_count}</td>
                      <td className="py-2 text-end tabular-nums text-charcoal/60">{pr.fact_count}</td>
                      <td className="py-2 text-end tabular-nums text-charcoal/60">
                        {lo ? (hi && hi !== lo ? `${lo}–${hi}` : lo) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {Object.keys(data.facts).length > 0 && (
        <Section
          title={isAr ? 'لغتهم التسويقية' : 'Their marketing language'}
          subtitle={isAr ? 'أكثر القيم تكراراً عبر كل منشوراتهم' : 'Most frequent values across all their content'}
        >
          <div className="space-y-3.5">
            <FactChips label={isAr ? 'العروض التجارية' : 'Commercial offers'} values={data.facts.offer ?? []} isAr={isAr} />
            <FactChips label={isAr ? 'رسائل الحملة' : 'Campaign messages'} values={data.facts.campaign_message ?? []} isAr={isAr} />
            <FactChips label={isAr ? 'نقاط البيع' : 'Selling points'} values={data.facts.selling_point ?? []} isAr={isAr} />
            <FactChips label={isAr ? 'دعوات الإجراء' : 'Calls to action'} values={data.facts.cta ?? []} isAr={isAr} />
            <FactChips label={isAr ? 'خطط السداد' : 'Payment plans'} values={data.facts.payment_plan ?? []} isAr={isAr} />
            <FactChips label={isAr ? 'أنواع الوحدات' : 'Unit types'} values={data.facts.unit_type ?? []} isAr={isAr} />
          </div>
        </Section>
      )}

      {data.social_accounts.length > 0 && (
        <Section title={isAr ? 'الحسابات' : 'Accounts'}>
          <ul className="divide-y divide-sand/40">
            {data.social_accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] capitalize text-charcoal/55">{a.platform}</span>
                  {a.profile_url
                    ? <a href={a.profile_url} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-copper hover:underline">{a.handle ?? '—'}</a>
                    : <span className="text-[13px] font-medium text-charcoal">{a.handle ?? '—'}</span>}
                  {a.collection_enabled === false && <Pill>{isAr ? 'الجمع متوقف' : 'collection off'}</Pill>}
                </div>
                <div className="flex items-center gap-3 text-[11.5px] text-charcoal/45">
                  {a.followers !== null && (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      {trendUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {a.followers.toLocaleString()}
                    </span>
                  )}
                  <span>{isAr ? 'آخر مزامنة ' : 'synced '}{fmtDate(a.last_synced_at, isAr)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

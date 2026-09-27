/**
 * Settings → AI Usage → the run log.
 *
 * Every other panel on that page is an aggregate, and aggregates hide exactly
 * the things worth seeing: that 116 of a month's calls were one account running
 * dry inside 28 hours, that a call site's 1,232 calls were the same two items
 * retried forever, that a fallback row means the cheap provider fell over. Those
 * are visible only one call at a time.
 *
 * The default is the last ten — enough to answer "what just happened" without
 * pulling thousands of rows at every page load. "Show all" pages through the
 * rest on demand, in both directions of the filter: a call site chosen from the
 * spend table, and failures only.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Loader2, ChevronDown, ChevronRight, X, AlertTriangle, CornerDownRight } from 'lucide-react';
import {
  fetchRuns, usd, usdPrecise, formatTokens, areaLabel,
  type AiRun,
} from '@/lib/aiUsage/client';

const PEEK = 10;
const PAGE = 50;

/** Absolute time, western digits, seconds included — two calls in one second is a fact. */
function stamp(iso: string, isAr: boolean): string {
  const d = new Date(iso);
  return d.toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function ms(v: number | null, isAr: boolean): string {
  if (v === null) return '—';
  if (v < 1000) return `${v} ${isAr ? 'مث' : 'ms'}`;
  return `${(v / 1000).toFixed(1)} ${isAr ? 'ث' : 's'}`;
}

export default function AiRunsPanel({
  isAr, callSite, onClearCallSite,
}: {
  isAr: boolean;
  /** Set when the operator clicked a row in the spend table. */
  callSite: string | null;
  onClearCallSite: () => void;
}) {
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A filter or an expand is a different question — always re-ask from the top.
  const load = useCallback(async (limit: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchRuns({ limit, callSite, failedOnly });
      setRuns(page.runs);
      setHasMore(page.hasMore);
    } catch (e) {
      // Loud: an empty run log and a failed read look identical, and "nothing
      // ran" is the more dangerous of the two to believe.
      setError(e instanceof Error ? e.message : String(e));
      setRuns([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [callSite, failedOnly]);

  useEffect(() => { void load(expanded ? PAGE : PEEK); }, [load, expanded]);

  // A chosen call site is a question about that call site — show its whole list.
  useEffect(() => { if (callSite) setExpanded(true); }, [callSite]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await fetchRuns({ limit: PAGE, offset: runs.length, callSite, failedOnly });
      setRuns((prev) => [...prev, ...page.runs]);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-charcoal">
          {expanded
            ? (isAr ? 'سجل التشغيلات' : 'Run log')
            : (isAr ? 'آخر ١٠ تشغيلات' : 'Last 10 runs')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {callSite && (
            <button
              onClick={onClearCallSite}
              className="inline-flex items-center gap-1 rounded-lg border border-copper/40 bg-copper/10 px-2 py-1 font-mono text-[11px] text-copper transition hover:bg-copper/15"
            >
              {callSite}
              <X size={11} />
            </button>
          )}
          <button
            onClick={() => { setFailedOnly((v) => !v); setOpenId(null); }}
            className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition ${
              failedOnly
                ? 'border-red-300 bg-red-50 text-red-700'
                : 'border-sand/40 text-charcoal/55 hover:bg-cream'
            }`}
          >
            {isAr ? 'الإخفاقات فقط' : 'Failures only'}
          </button>
          <button
            onClick={() => { setExpanded((v) => !v); setOpenId(null); }}
            className="rounded-lg border border-sand/40 px-2.5 py-1 text-[11px] font-bold text-charcoal/55 transition hover:bg-cream"
          >
            {expanded ? (isAr ? 'عرض آخر ١٠' : 'Show last 10') : (isAr ? 'عرض الكل' : 'Show all')}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div>
            <strong>{isAr ? 'تعذّرت قراءة السجل.' : 'Could not read the run log.'}</strong>{' '}
            {isAr ? 'هذا ليس «لا توجد تشغيلات».' : 'This is not "no runs".'}
            <div className="mt-1 font-mono text-xs opacity-70">{error}</div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-sand/30 bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-sand/30 text-[10px] uppercase tracking-wider text-charcoal/45">
              <th className="px-3 py-2.5 text-start font-medium">{isAr ? 'الوقت' : 'When'}</th>
              <th className="px-3 py-2.5 text-start font-medium">{isAr ? 'الموضع' : 'Call site'}</th>
              <th className="px-3 py-2.5 text-start font-medium">{isAr ? 'النموذج' : 'Model'}</th>
              <th className="px-3 py-2.5 text-end font-medium">{isAr ? 'الرموز' : 'Tokens'}</th>
              <th className="px-3 py-2.5 text-end font-medium">{isAr ? 'المدة' : 'Took'}</th>
              <th className="px-3 py-2.5 text-end font-medium">{isAr ? 'التكلفة' : 'Cost'}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-charcoal/45">
                <Loader2 size={15} className="inline animate-spin" />
              </td></tr>
            )}

            {!loading && runs.length === 0 && !error && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-charcoal/45">
                {failedOnly
                  ? (isAr ? 'لا توجد إخفاقات — وهذه أخبار جيدة.' : 'No failures — which is good news.')
                  : (isAr ? 'لا توجد تشغيلات مُسجَّلة.' : 'No runs recorded.')}
              </td></tr>
            )}

            {!loading && runs.map((r) => {
              const failed = r.status !== 'ok';
              const open = openId === r.id;
              return (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => setOpenId(open ? null : r.id)}
                    className={`cursor-pointer border-b border-sand/20 transition last:border-0 ${
                      open ? 'bg-cream/70' : 'hover:bg-cream/40'
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-charcoal/60">
                      <span className="inline-flex items-center gap-1">
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} className="rtl:rotate-180" />}
                        {stamp(r.created_at, isAr)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-xs text-charcoal">{r.call_site}</div>
                      <div className="text-[10px] text-charcoal/40">
                        {areaLabel(r.area, isAr)}{r.operation ? ` · ${r.operation}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-xs text-charcoal/75">{r.model}</div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className="text-charcoal/40">{r.provider}</span>
                        {r.is_fallback && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 text-amber-700">
                            <CornerDownRight size={9} />
                            {isAr ? `بديل عن ${r.fallback_from ?? ''}` : `fallback from ${r.fallback_from ?? ''}`}
                          </span>
                        )}
                        {failed && (
                          <span className="rounded bg-red-100 px-1 font-bold text-red-700">
                            {isAr ? 'أخفق' : 'failed'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-end font-mono text-xs tabular-nums text-charcoal/60">
                      {r.input_tokens || r.output_tokens
                        ? `${formatTokens(r.input_tokens)} → ${formatTokens(r.output_tokens)}`
                        : r.units !== null ? `${r.units} ${r.unit_kind ?? ''}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-end font-mono text-xs tabular-nums text-charcoal/60">
                      {ms(r.latency_ms, isAr)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-end font-mono text-xs tabular-nums text-charcoal">
                      {r.cost_known ? usdPrecise(r.cost_usd) : (
                        <span className="text-amber-600">{isAr ? 'بلا سعر' : 'unpriced'}</span>
                      )}
                    </td>
                  </tr>

                  {open && (
                    <tr className="border-b border-sand/20 bg-cream/40">
                      <td colSpan={6} className="px-4 py-3">
                        {r.error && (
                          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-red-700">
                              {isAr ? 'رسالة المزوّد' : 'What the provider said'}
                            </div>
                            <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-red-800">
                              {r.error}
                            </div>
                          </div>
                        )}
                        <dl className="grid gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-2 lg:grid-cols-3">
                          <Detail label={isAr ? 'وقت التشغيل' : 'Timestamp'} value={new Date(r.created_at).toISOString()} mono />
                          <Detail label={isAr ? 'الحالة' : 'Status'} value={r.status} />
                          <Detail
                            label={isAr ? 'رموز الإدخال' : 'Input tokens'}
                            value={r.input_tokens.toLocaleString('en-US')}
                            mono
                          />
                          <Detail
                            label={isAr ? 'رموز الإخراج' : 'Output tokens'}
                            value={r.output_tokens.toLocaleString('en-US')}
                            mono
                          />
                          {(r.cache_read_tokens > 0 || r.cache_write_tokens > 0) && (
                            <Detail
                              label={isAr ? 'ذاكرة مؤقتة (قراءة/كتابة)' : 'Cache (read/write)'}
                              value={`${r.cache_read_tokens.toLocaleString('en-US')} / ${r.cache_write_tokens.toLocaleString('en-US')}`}
                              mono
                            />
                          )}
                          {r.units !== null && (
                            <Detail label={isAr ? 'وحدات' : 'Units'} value={`${r.units} ${r.unit_kind ?? ''}`} mono />
                          )}
                          <Detail
                            label={isAr ? 'التكلفة' : 'Cost'}
                            value={r.cost_known
                              ? usd(r.cost_usd)
                              : (isAr ? 'غير معروفة — لا يوجد سعر لهذا النموذج' : 'unknown — no price for this model')}
                            mono={r.cost_known}
                          />
                          {r.entity_id && (
                            <Detail label={r.entity_kind ?? (isAr ? 'السجل' : 'Entity')} value={r.entity_id} mono />
                          )}
                          <Detail label={isAr ? 'معرّف التشغيل' : 'Run id'} value={r.id} mono />
                        </dl>
                        {r.meta && Object.keys(r.meta).length > 0 && (
                          <div className="mt-3">
                            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-charcoal/40">
                              {isAr ? 'تفاصيل إضافية' : 'Extra detail'}
                            </div>
                            <pre className="overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-[10px] leading-relaxed text-charcoal/70">
                              {JSON.stringify(r.meta, null, 2)}
                            </pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-charcoal/45">
        <span>
          {runs.length > 0 && (isAr
            ? `${runs.length.toLocaleString('en-US')} تشغيل معروض`
            : `showing ${runs.length.toLocaleString('en-US')}`)}
        </span>
        {expanded && hasMore && !loading && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sand/40 px-3 py-1.5 text-[11px] font-bold text-charcoal/60 transition hover:bg-cream disabled:opacity-50"
          >
            {loadingMore && <Loader2 size={12} className="animate-spin" />}
            {isAr ? `تحميل ${PAGE} أخرى` : `Load ${PAGE} more`}
          </button>
        )}
      </div>
    </section>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-sand/20 pb-1">
      <dt className="shrink-0 text-charcoal/45">{label}</dt>
      <dd className={`truncate text-charcoal/75 ${mono ? 'font-mono tabular-nums' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Calendar and Raw Assets.
 *
 * The calendar READS content items and publications — it never stores its own
 * copy of a date. Moving something here would move the underlying record, which
 * is why rescheduling writes through savePublication rather than to a calendar
 * table. A disconnected calendar is the classic way this kind of system starts
 * lying about what is actually scheduled.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, Link2, Search, Sparkles } from 'lucide-react';
import AssetUploader from './AssetUploader';
import { AssetThumb, AssetDetail, type AssetRow } from './AssetPreview';
import Button from '@/components/ui/Button';
import { Section, Stat, EmptyHint, Spinner, CaveatStrip, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  fetchPublications, fetchContentList, fetchAssets, processAssets,
  STATUS_LABEL, type PublicationRow, type ContentItem, type ContentStatus,
} from '@/lib/marketingMgmt/client';
import { fetchPlanningOverview, fetchPlanDetail, type ChannelPlan } from '@/lib/marketingMgmt/v2';
import { lbl, PLATFORM_LABEL } from '@/lib/marketingMgmt/labels';

/** Monday of the ISO week containing an ISO date. Capacity is planned in ISO
 *  weeks; the month grid below draws Sunday-start weeks (KSA convention). The
 *  two genuinely do not line up, so the capacity summary is its own strip rather
 *  than being painted onto grid rows it would misrepresent. */
function isoMonday(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// ── Calendar ────────────────────────────────────────────────────────────────
interface Entry {
  id: string; kind: 'publication' | 'content';
  date: string; title: string; platform?: string; status: string; approved?: boolean;
}

export function CalendarTab({ isAr, onOpenContent, onError }: {
  isAr: boolean; onOpenContent: (id: string) => void; onError: (m: string) => void;
}) {
  const [pubs, setPubs] = useState<PublicationRow[]>([]);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [channels, setChannels] = useState<ChannelPlan[]>([]);

  // Channel ceilings come from the ACTIVE plan. Without one there is no
  // configured capacity, and the strip says so rather than showing zeros.
  useEffect(() => {
    fetchPlanningOverview()
      .then((o) => {
        const active = o.plans.find((p) => p.status === 'active') ?? o.plans[0];
        return active ? fetchPlanDetail(active.id) : null;
      })
      .then((d) => { if (d) setChannels(d.channels); })
      .catch(() => { /* capacity is additive here; the calendar still works */ });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchPublications({ limit: 500 }), fetchContentList({ limit: 500 })])
      .then(([p, c]) => { setPubs(p.publications); setContent(c.content); })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(load, [load]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const p of pubs) {
      const d = p.published_at ?? p.scheduled_for;
      if (d) out.push({ id: p.id, kind: 'publication', date: d.slice(0, 10),
        title: p.mkt_content_items?.title ?? '—', platform: p.platform, status: p.status });
    }
    // planned content with no publication yet — the gap the calendar must show
    const pubItemIds = new Set(pubs.map((p) => p.content_item_id));
    for (const c of content) {
      if (c.planned_publish_at && !pubItemIds.has(c.id)) {
        out.push({ id: c.id, kind: 'content', date: c.planned_publish_at.slice(0, 10),
          title: c.title, status: c.status });
      }
    }
    return out;
  }, [pubs, content]);

  const grid = useMemo(() => {
    const y = cursor.getFullYear(); const m = cursor.getMonth();
    const first = new Date(y, m, 1);
    const startPad = first.getDay();          // week starts Sunday (KSA convention)
    const days = new Date(y, m + 1, 0).getDate();
    const cells: Array<{ date: string | null; items: Entry[] }> = [];
    for (let i = 0; i < startPad; i++) cells.push({ date: null, items: [] });
    for (let d = 1; d <= days; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ date: iso, items: entries.filter((e) => e.date === iso) });
    }
    return cells;
  }, [cursor, entries]);

  /** Scheduled load per ISO week per platform for the visible month, against the
   *  channel ceiling where one is configured. Counts PUBLICATIONS only: planned
   *  content with no publication has not taken a slot yet. */
  const weekLoad = useMemo(() => {
    const ym = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const byWeek = new Map<string, Map<string, number>>();
    for (const e of entries) {
      if (e.kind !== 'publication' || !e.platform || !e.date.startsWith(ym)) continue;
      const wk = isoMonday(e.date);
      if (!byWeek.has(wk)) byWeek.set(wk, new Map());
      const m = byWeek.get(wk)!;
      m.set(e.platform, (m.get(e.platform) ?? 0) + 1);
    }
    return [...byWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, plats]) => ({
        week,
        rows: [...plats.entries()].map(([platform, used]) => {
          const ch = channels.find((c) => c.platform === platform);
          return { platform, used, cap: ch?.max_per_week ?? null };
        }).sort((a, b) => b.used - a.used),
      }));
  }, [entries, cursor, channels]);

  const monthLabel = cursor.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { month: 'long', year: 'numeric' });
  const shift = (n: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  const monthCount = entries.filter((e) => e.date.startsWith(
    `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)).length;

  return (
    <Section title={isAr ? 'التقويم' : 'Calendar'}
      subtitle={isAr ? 'يقرأ من المنشورات والمحتوى — لا نسخة منفصلة' : 'Reads publications and content — no separate copy'}
      right={
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => shift(-1)} className="rounded-lg border border-sand/60 p-1 text-charcoal/60 hover:border-copper/50">
            {isAr ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
          <span className="min-w-[130px] text-center text-[13px] font-medium text-charcoal">{monthLabel}</span>
          <button type="button" onClick={() => shift(1)} className="rounded-lg border border-sand/60 p-1 text-charcoal/60 hover:border-copper/50">
            {isAr ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      }>
      {monthCount === 0 && (
        <div className="mb-3">
          <CaveatStrip>
            {isAr ? 'لا يوجد نشر مخطط هذا الشهر — فجوة في التقويم.' : 'Nothing planned this month — a gap in the calendar.'}
          </CaveatStrip>
        </div>
      )}

      {/* Channel load per ISO week. Kept as its own strip rather than painted on
          the grid, because capacity is planned Monday-to-Sunday and the grid
          draws Sunday-start weeks — overlaying them would misstate which days a
          number covers. A platform with no channel plan reads "—", never 0. */}
      {weekLoad.length > 0 && (
        <div className="mb-3 rounded-xl border border-sand/50 bg-cream-light/40 p-2.5">
          <div className="mb-1.5 text-[11px] font-medium text-charcoal/55">
            {isAr ? 'الحمل الأسبوعي على القنوات (أسابيع الاثنين–الأحد)'
                  : 'Weekly channel load (Monday–Sunday weeks)'}
          </div>
          <ul className="space-y-1">
            {weekLoad.map((w) => (
              <li key={w.week} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                <span className="min-w-[92px] tabular-nums text-charcoal/60">{w.week}</span>
                {w.rows.map((r) => {
                  const over = r.cap != null && r.used > r.cap;
                  return (
                    <span key={r.platform}
                      className={`rounded px-1.5 py-0.5 tabular-nums ${
                        over ? 'bg-red-50 font-medium text-red-700' : 'bg-white text-charcoal/65'}`}>
                      {lbl(PLATFORM_LABEL, r.platform, isAr)} {r.used}
                      {r.cap != null
                        ? `/${r.cap}`
                        : <span className="text-charcoal/30"> / —</span>}
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
          {channels.length === 0 && (
            <p className="mt-1.5 text-[10.5px] text-charcoal/45">
              {isAr ? 'لا توجد خطط قنوات معرّفة، لذا لا سقف للمقارنة — أضفها من «سعة القنوات» أعلاه.'
                    : 'No channel plans defined, so there is no ceiling to compare against — add them in Channel capacity above.'}
            </p>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <div className="grid min-w-[640px] grid-cols-7 gap-1">
          {(isAr ? ['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'] : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']).map((d) => (
            <div key={d} className="px-1 pb-1 text-center text-[10.5px] font-semibold text-charcoal/45">{d}</div>
          ))}
          {grid.map((cell, i) => (
            <div key={i} className={`min-h-[74px] rounded-lg border p-1 ${
              cell.date ? 'border-sand/50 bg-white' : 'border-transparent bg-transparent'}`}>
              {cell.date && (
                <>
                  <div className="mb-1 text-[10.5px] tabular-nums text-charcoal/40">{Number(cell.date.slice(8))}</div>
                  <ul className="space-y-0.5">
                    {cell.items.slice(0, 3).map((e) => (
                      <li key={`${e.kind}-${e.id}`}>
                        <button type="button"
                          onClick={() => onOpenContent(e.kind === 'content' ? e.id : (pubs.find((p) => p.id === e.id)?.content_item_id ?? e.id))}
                          title={e.title}
                          className={`w-full truncate rounded px-1 py-0.5 text-start text-[10px] ${
                            e.status === 'published' ? 'bg-emerald-50 text-emerald-700'
                            : e.kind === 'content' ? 'bg-amber-50 text-amber-800'
                            : 'bg-copper/10 text-copper-500'}`}>
                          {e.platform ? `${e.platform.slice(0, 2)} · ` : ''}{e.title}
                        </button>
                      </li>
                    ))}
                    {cell.items.length > 3 && (
                      <li className="px-1 text-[9.5px] text-charcoal/40">+{cell.items.length - 3}</li>
                    )}
                  </ul>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-charcoal/50">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-copper/40" />{isAr ? 'مجدول' : 'Scheduled'}</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-400" />{isAr ? 'منشور' : 'Published'}</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-amber-400" />{isAr ? 'مخطط بلا نشر' : 'Planned, no publication'}</span>
      </div>
    </Section>
  );
}

// ── Raw assets ──────────────────────────────────────────────────────────────
/**
 * Files are REAL here: AssetUploader puts bytes in the wassel-files bucket via
 * the Files subsystem and links the resulting files.id to the asset row.
 * Previews come from signViewUrl because that bucket is private — an <img src>
 * straight at storage would 400, so thumbnails are signed on demand and only
 * for image assets, which keeps the request count to what is actually shown.
 */

export function AssetsTab({ isAr, onError }: { isAr: boolean; onError: (m: string) => void }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [analysing, setAnalysing] = useState(false);
  const [q, setQ] = useState('');
  /** Which row is expanded. Inline rather than a modal: the point of a library
   *  is to scan it, and a dialog per asset makes comparing two of them a chore. */
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback((query?: string) => {
    setLoading(true);
    fetchAssets(query ? { q: query, limit: 200 } : { limit: 200 })
      .then((r) => setRows(r.assets))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const analyse = async () => {
    setAnalysing(true);
    try {
      const r = await processAssets();
      onError(isAr ? `تم إدراج ${r.queued} أصل للتحليل` : `${r.queued} assets queued for analysis`);
      load(q);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setAnalysing(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  const noFile = rows.filter((r) => !r.file_id).length;
  const unprocessed = rows.filter((r) => r.processing_status === 'not_attempted').length;
  const inFlight = rows.filter((r) => r.processing_status === 'pending' || r.processing_status === 'processing').length;

  return (
    <div className="space-y-4">
      <Section title={isAr ? 'مكتبة المواد الخام' : 'Raw asset library'}
        subtitle={isAr ? 'ملف واحد، استخدامات متعددة — لا تُنسخ الملفات لتظهر في مكان آخر'
                       : 'One file, many uses — files are never duplicated to appear elsewhere'}>
        <AssetUploader isAr={isAr} onUploaded={() => load(q)} />

        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/30 start-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(q); }}
              placeholder={isAr ? 'بحث بالاسم أو النص المقروء أو التفريغ…' : 'Search name, OCR text or transcript…'}
              className="w-full rounded-xl border border-sand/60 bg-white py-2 text-[13px] focus:border-copper focus:outline-none ps-9 pe-3" />
          </div>
          <Button variant="secondary" onClick={() => load(q)}>{isAr ? 'بحث' : 'Search'}</Button>
          <Button onClick={analyse} disabled={analysing || unprocessed === 0}>
            <Sparkles className="h-4 w-4" />
            {analysing ? (isAr ? 'جارٍ الإدراج…' : 'Queueing…')
                       : (isAr ? `تحليل ${unprocessed}` : `Analyse ${unprocessed}`)}
          </Button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label={isAr ? 'الإجمالي' : 'Total'} value={rows.length} />
          <Stat label={isAr ? 'متاحة' : 'Available'} value={rows.filter((r) => r.usage_status === 'available').length} />
          <Stat label={isAr ? 'سجل بلا ملف' : 'Record without file'} value={noFile} tone={noFile > 0 ? 'warn' : 'default'} />
          <Stat label={isAr ? 'بلا تحليل' : 'Not analysed'} value={unprocessed} tone={unprocessed > 0 ? 'warn' : 'default'}
                hint={inFlight > 0 ? (isAr ? `${inFlight} قيد التحليل` : `${inFlight} in flight`)
                                   : (isAr ? 'لا قراءة صور ولا تفريغ بعد' : 'no OCR or transcript yet')} />
        </div>

        {rows.length === 0 ? (
          <EmptyHint>{isAr ? 'لا مواد بعد — ارفع ملفاً للبدء' : 'No assets yet — upload a file to begin'}</EmptyHint>
        ) : (
          <ul className="divide-y divide-sand/40">
            {rows.map((a) => {
              const w = a.width as number | null, h = a.height as number | null;
              const dur = a.duration_ms as number | null;
              const size = a.size_bytes as number | null;
              const id = String(a.id);
              const expanded = open === id;
              const asset = a as AssetRow;
              // A phrase from the transcript or the AI description, so a row
              // says what is IN the file rather than only what it is called.
              const gist = ((asset.ai_description ?? asset.transcript ?? '') || '').trim();
              return (
                <li key={id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <AssetThumb asset={asset} isAr={isAr} onClick={() => setOpen(expanded ? null : id)} />
                    <button type="button" onClick={() => setOpen(expanded ? null : id)}
                      className="min-w-0 flex-1 text-start">
                      <span className="block truncate text-[13px] text-charcoal">{String(a.asset_name)}</span>
                      <span className="block text-[11px] text-charcoal/45">
                        {String(a.asset_type)}
                        {w && h ? ` · ${w}×${h}` : ''}
                        {dur ? ` · ${Math.round(dur / 1000)}s` : ''}
                        {size ? ` · ${(size / 1024 / 1024).toFixed(1)} MB` : ''}
                      </span>
                      {gist && !expanded && (
                        <span className="mt-0.5 block truncate text-[11px] text-charcoal/55">{gist}</span>
                      )}
                    </button>
                    <span className="flex shrink-0 items-center gap-3 text-[11.5px] text-charcoal/50">
                      {!a.file_id && (
                        <span className="text-amber-700">{isAr ? 'بلا ملف' : 'no file'}</span>
                      )}
                      <span className={a.processing_status === 'not_attempted' ? 'text-amber-700' : ''}>
                        {String(a.processing_status)}
                      </span>
                      <span>{a.created_at ? fmtDate(String(a.created_at), isAr) : '—'}</span>
                      <ChevronDown className={`h-4 w-4 text-charcoal/30 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </span>
                  </div>
                  {expanded && (
                    <div className="mt-2.5 rounded-xl border border-sand/50 bg-cream-light/60 p-3">
                      <AssetDetail asset={asset} isAr={isAr} onClose={() => setOpen(null)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <CaveatStrip>
        {isAr
          ? 'الأبعاد والمدة تُقاس من الملف عند الرفع. التحليل (قراءة النص من الصور، التفريغ الصوتي، الوصف) يعمل في الخلفية على العامل نفسه المستخدم لمحتوى المنافسين. الحالات صريحة: «لم تُحاول» تعني لم يُنظر بعد، «غير مدعوم» تعني لا يوجد محلل لهذا النوع، و«جزئي» تعني قُرئ بعضه فقط — ولا شيء منها يعني «لا يوجد نص».'
          : 'Dimensions and duration are measured from the file on upload. Analysis (image OCR, transcription, description) runs in the background on the same worker used for competitor content. The states are explicit: "not attempted" means nobody looked yet, "unsupported" means there is no analyser for that type, and "degraded" means only part was read — none of them mean "no text found".'}
      </CaveatStrip>
    </div>
  );
}

/** Where an asset is used — one asset, many links, never a duplicated file. */
export function AssetUsage({ links, isAr }: { links: Array<{ target_type: string }>; isAr: boolean }) {
  if (links.length === 0) return <EmptyHint>{isAr ? 'غير مستخدم بعد' : 'Not used anywhere yet'}</EmptyHint>;
  return (
    <ul className="space-y-1">
      {links.map((l, i) => (
        <li key={i} className="flex items-center gap-1.5 text-[12px] text-charcoal/70">
          <Link2 className="h-3 w-3 text-charcoal/30" />{l.target_type}
        </li>
      ))}
    </ul>
  );
}

export function ContentStatusChip({ status, isAr }: { status: string; isAr: boolean }) {
  const l = STATUS_LABEL[status as ContentStatus];
  return <span className="text-[11.5px] text-charcoal/55">{l ? (isAr ? l.ar : l.en) : status}</span>;
}

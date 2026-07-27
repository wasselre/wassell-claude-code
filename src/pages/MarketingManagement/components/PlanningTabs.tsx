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
import { ChevronLeft, ChevronRight, Image as ImageIcon, Link2, Plus, Search } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section, Stat, EmptyHint, Spinner, CaveatStrip, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  fetchPublications, fetchContentList, fetchAssets, saveAsset,
  STATUS_LABEL, type PublicationRow, type ContentItem, type ContentStatus,
} from '@/lib/marketingMgmt/client';

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
const ASSET_TYPES = ['property_photo','property_video','drone_footage','presenter_footage',
  'developer_footage','construction_footage','floor_plan','brochure','logo','audio','voice_over',
  'testimonial','render','ai_generated','screenshot','document','music','brand_template','custom'] as const;

export function AssetsTab({ isAr, onError }: { isAr: boolean; onError: (m: string) => void }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ asset_name: '', asset_type: 'property_photo', usage_rights: 'owned' });

  const load = useCallback((query?: string) => {
    setLoading(true);
    fetchAssets(query ? { q: query, limit: 200 } : { limit: 200 })
      .then((r) => setRows(r.assets))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.asset_name.trim()) return;
    setBusy(true);
    try {
      // processing_status starts 'not_attempted' — the DB default. It is NOT
      // 'completed', because nothing has extracted metadata/OCR/transcript yet.
      await saveAsset({ ...form, processing_status: 'not_attempted' });
      setCreating(false); setForm({ asset_name: '', asset_type: 'property_photo', usage_rights: 'owned' });
      load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  const unprocessed = rows.filter((r) => r.processing_status === 'not_attempted').length;

  return (
    <div className="space-y-4">
      <CaveatStrip>
        {isAr
          ? 'رفع الملفات وتوليد المصغّرات والنسخ والوصف الآلي غير مفعّلة بعد — تُسجَّل الأصول هنا يدوياً وحالة المعالجة "لم تُحاول".'
          : 'File upload, thumbnails, transcription and AI description are not wired yet — assets are registered manually and their processing state reads "not attempted".'}
      </CaveatStrip>

      <Section title={isAr ? 'مكتبة المواد الخام' : 'Raw asset library'}
        right={<Button onClick={() => setCreating((v) => !v)}><Plus className="h-4 w-4" />{isAr ? 'أصل جديد' : 'New asset'}</Button>}>
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/30 start-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(q); }}
              placeholder={isAr ? 'بحث بالاسم أو النص المقروء أو التفريغ…' : 'Search name, OCR text or transcript…'}
              className="w-full rounded-xl border border-sand/60 bg-white py-2 text-[13px] focus:border-copper focus:outline-none ps-9 pe-3" />
          </div>
          <Button variant="secondary" onClick={() => load(q)}>{isAr ? 'بحث' : 'Search'}</Button>
        </div>

        {creating && (
          <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-4">
            <input value={form.asset_name} onChange={(e) => setForm({ ...form, asset_name: e.target.value })}
              placeholder={isAr ? 'اسم الأصل' : 'Asset name'}
              className="rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px] focus:border-copper focus:outline-none sm:col-span-2" />
            <select value={form.asset_type} onChange={(e) => setForm({ ...form, asset_type: e.target.value })}
              className="rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px]">
              {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <Button onClick={create} disabled={busy || !form.asset_name.trim()}>{isAr ? 'إضافة' : 'Add'}</Button>
          </div>
        )}

        <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label={isAr ? 'الإجمالي' : 'Total'} value={rows.length} />
          <Stat label={isAr ? 'متاحة' : 'Available'} value={rows.filter((r) => r.usage_status === 'available').length} />
          <Stat label={isAr ? 'لم تُعالَج' : 'Unprocessed'} value={unprocessed} tone={unprocessed > 0 ? 'warn' : 'default'} />
          <Stat label={isAr ? 'حقوق منتهية' : 'Expired rights'} value={rows.filter((r) => r.usage_status === 'expired_rights').length} />
        </div>

        {rows.length === 0 ? <EmptyHint>{isAr ? 'لا مواد بعد' : 'No assets yet'}</EmptyHint> : (
          <ul className="divide-y divide-sand/40">
            {rows.map((a) => (
              <li key={String(a.id)} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
                  <span className="truncate text-[13px] text-charcoal">{String(a.asset_name)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-[11.5px] text-charcoal/50">
                  <span>{String(a.asset_type)}</span>
                  <span className={a.processing_status === 'not_attempted' ? 'text-amber-700' : ''}>
                    {String(a.processing_status)}
                  </span>
                  <span>{a.created_at ? fmtDate(String(a.created_at), isAr) : '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
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

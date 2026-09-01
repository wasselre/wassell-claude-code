/** Confirm links — FOCUS MODE. One decision fills the screen: the post on the
 *  left, the project it would link to (with enough detail to judge) on the right,
 *  and big Yes/No. Deciding jumps straight to the next. Keyboard: Y = yes, N = no. */
import { useCallback, useEffect, useState } from 'react';
import { fetchAttributionQueue, reviewAttribution, type QueueItem } from '@/lib/competitorWatch/client';

const UNIT_LABELS: Record<string, { ar: string; en: string }> = {
  floor: { ar: 'أدوار', en: 'Floors' }, apartment: { ar: 'شقق', en: 'Apartments' },
  villa: { ar: 'فلل', en: 'Villas' }, land: { ar: 'أراضٍ', en: 'Land' },
  townhouse: { ar: 'تاون هاوس', en: 'Townhouses' }, duplex: { ar: 'دوبلكس', en: 'Duplexes' },
  penthouse: { ar: 'بنتهاوس', en: 'Penthouses' }, studio: { ar: 'استوديو', en: 'Studios' },
  commercial: { ar: 'تجاري', en: 'Commercial' }, office: { ar: 'مكاتب', en: 'Offices' },
  building: { ar: 'مبانٍ', en: 'Buildings' }, chalet: { ar: 'شاليهات', en: 'Chalets' },
};
const STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  available_on_map: { ar: 'على الخارطة', en: 'Off-plan' }, off_plan: { ar: 'على الخارطة', en: 'Off-plan' },
  ready: { ar: 'جاهز', en: 'Ready' }, under_construction: { ar: 'تحت الإنشاء', en: 'Under construction' },
  available: { ar: 'متاح', en: 'Available' }, sold_out: { ar: 'نفد البيع', en: 'Sold out' },
  completed: { ar: 'مكتمل', en: 'Completed' }, unknown: { ar: 'غير محدّد', en: 'Unspecified' },
};
const humanize = (s: string) => s.replace(/_/g, ' ').trim();
const unitLabel = (code: string, isAr: boolean) => { const m = UNIT_LABELS[code]; return m ? (isAr ? m.ar : m.en) : humanize(code); };
const statusLabel = (code: string, isAr: boolean) => { const m = STATUS_LABELS[code]; return m ? (isAr ? m.ar : m.en) : humanize(code); };

function fmtPrice(p: { min?: number | null; max?: number | null } | null | undefined, isAr: boolean): string | null {
  if (!p || (p.min == null && p.max == null)) return null;
  const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));
  const unit = isAr ? 'ر.س' : 'SAR';
  if (p.min != null && p.max != null && p.max !== p.min) return `${compact(p.min)}–${compact(p.max)} ${unit}`;
  const one = p.min ?? p.max;
  return one != null ? `${compact(one)} ${unit}` : null;
}

export default function ConfirmSurface({ isAr }: { isAr: boolean }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAttributionQueue(30)
      .then((q) => { setItems(q.items); setRemaining(q.remaining); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!loading && !error && items.length === 0 && remaining > 0) load();
  }, [items.length, loading, error, remaining, load]);

  const current = items[0] ?? null;

  const decide = useCallback(async (accept: boolean) => {
    const it = items[0];
    if (!it || busy) return;
    setBusy(true);
    try {
      await reviewAttribution(it.post_id, it.project_id, accept);
      setItems((prev) => prev.slice(1));
      setRemaining((n) => Math.max(0, n - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [items, busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') { e.preventDefault(); void decide(true); }
      else if (e.key === 'n' || e.key === 'N' || e.key === 'Backspace') { e.preventDefault(); void decide(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide]);

  if (loading && items.length === 0) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!current) return <div className="cw-empty">{isAr ? 'لا شيء للمراجعة — تمّت مراجعة كل التخمينات 🎉' : 'Nothing to review — all caught up 🎉'}</div>;

  const it = current;
  const conf = typeof it.confidence === 'number' ? Math.round(it.confidence * 100) : null;
  const price = it.project ? fmtPrice(it.project.price, isAr) : null;

  return (
    <div className="cw-focus">
      <div className="cw-progress">
        <span>{isAr ? `${remaining.toLocaleString()} بانتظار المراجعة` : `${remaining.toLocaleString()} awaiting review`}</span>
        <span className="cw-kbd">{isAr ? 'اختصار: ' : 'keys: '}<kbd>Y</kbd> {isAr ? 'نعم' : 'yes'} · <kbd>N</kbd> {isAr ? 'لا' : 'no'}</span>
      </div>

      <div className="cw-focuscard">
        <div className="cw-fpost">
          <div className="cw-fmedia">
            {it.thumb_url
              ? <img src={it.thumb_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              : <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>}
            {it.format && <span className="cw-fmt">{it.format}</span>}
          </div>
          <div className="cw-fmeta">
            <span className="cw-co" dir="rtl">{it.org_name ?? '—'}</span>
            {it.platform && <span>· {it.platform}</span>}
            {it.post_url && <a className="cw-devlink" href={it.post_url} target="_blank" rel="noreferrer" style={{ border: 'none', padding: 0 }}>↗</a>}
          </div>
          {(it.caption || it.summary) && <p className="cw-ftext" dir="auto">{it.caption || it.summary}</p>}
          {it.names_read && (
            <div className="cw-fread"><span>{isAr ? 'الذكاء قرأ الاسم:' : 'AI read the name:'}</span> <b dir="rtl">{it.names_read}</b></div>
          )}
        </div>

        <div className="cw-fproj">
          <div className="cw-fq">{isAr ? 'هل هذا المنشور عن هذا المشروع؟' : 'Is this post about this project?'}</div>
          <a className="cw-fname" href={`/model/all_projects/${it.project_id}`} target="_blank" rel="noreferrer" dir="rtl">
            {it.project_name ?? '—'} <span aria-hidden="true">↗</span>
          </a>
          {conf !== null && <div className="cw-fconf">{isAr ? 'ثقة الذكاء' : "AI confidence"}: <b>{conf}%</b></div>}

          <div className="cw-ffacts">
            {it.project?.developer && <div><span>{isAr ? 'المطوّر' : 'Developer'}</span><b dir="rtl">{it.project.developer}</b></div>}
            {it.project?.city && <div><span>{isAr ? 'المدينة' : 'City'}</span><b dir="rtl">{it.project.city}</b></div>}
            {price && <div><span>{isAr ? 'السعر' : 'Price'}</span><b>{price}</b></div>}
            {it.project?.unit_types && it.project.unit_types.length > 0 && <div><span>{isAr ? 'الوحدات' : 'Units'}</span><b dir="rtl">{it.project.unit_types.map((u) => unitLabel(u, isAr)).join('، ')}</b></div>}
            {it.project?.status && it.project.status !== 'unknown' && <div><span>{isAr ? 'الحالة' : 'Status'}</span><b dir="rtl">{statusLabel(it.project.status, isAr)}</b></div>}
          </div>
          {it.project?.page_url && (
            <a className="cw-projlink" href={it.project.page_url} target="_blank" rel="noreferrer" style={{ marginTop: 4 }}>
              {isAr ? 'صفحة المشروع' : 'Project page'} <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      </div>

      <div className="cw-fbtns">
        <button className="cw-fbtn bad" type="button" disabled={busy} onClick={() => decide(false)}>✗ {isAr ? 'لا، ليس هذا' : 'No, not this'}</button>
        <button className="cw-fbtn ok" type="button" disabled={busy} onClick={() => decide(true)}>✓ {isAr ? 'نعم، اربطه' : 'Yes, link it'}</button>
      </div>
    </div>
  );
}

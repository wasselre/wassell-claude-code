/** Market Watch (أخبار السوق, 2026-10-04) — the news of the market, read off
 *  competitor posts: new projects, launches, new offers, price changes,
 *  events and sold-out announcements. Every item is derived from what the
 *  post reader already stored (`mkt_market_watch`, no AI call) and links to
 *  the posts that prove it. */
import { useEffect, useMemo, useState } from 'react';
import { fetchMarketWatch, type MarketItem, type MarketKind, type MarketWatch } from '@/lib/competitorWatch/client';
import { fmtDateTime } from './surfaceData';

const KINDS: Array<{ key: MarketKind; ar: string; en: string; color: string }> = [
  { key: 'new_project', ar: 'مشروع جديد', en: 'New project', color: '#3E6B7A' },
  { key: 'launch', ar: 'إطلاق', en: 'Launch', color: '#B8734F' },
  { key: 'offer', ar: 'عرض جديد', en: 'New offer', color: '#3F6B52' },
  { key: 'price', ar: 'تغيّر السعر المعلن', en: 'Stated price changed', color: '#9A6E15' },
  { key: 'event', ar: 'فعالية', en: 'Event', color: '#6A4A63' },
  { key: 'sold_out', ar: 'نفاد البيع', en: 'Sold out', color: '#8E2F45' },
];
const PERIODS = [7, 30, 90];

const OTHER_KIND = { key: 'event' as MarketKind, ar: 'خبر', en: 'News', color: '#6A6157' };
function kindMeta(k: MarketKind): { key: MarketKind; ar: string; en: string; color: string } {
  return KINDS.find((x) => x.key === k) ?? OTHER_KIND;
}

function headline(it: MarketItem, isAr: boolean): string {
  const project = it.project_name ?? it.name ?? null;
  const who = it.org_name ?? '—';
  switch (it.kind) {
    case 'new_project':
      return it.detail?.in_catalog
        ? (isAr ? `أول ظهور لمشروع ${project ?? ''} — ${who}` : `First appearance of ${project ?? ''} — ${who}`)
        : (isAr ? `مشروع غير مسجّل لدينا: ${project ?? ''} — ${who}` : `A project we do not have: ${project ?? ''} — ${who}`);
    case 'launch':
      return isAr ? `${who} تطلق ${project ?? 'مشروعًا'}` : `${who} launches ${project ?? 'a project'}`;
    case 'offer':
      return isAr ? `${who}: عرض جديد${project ? ` على ${project}` : ''}` : `${who}: new offer${project ? ` on ${project}` : ''}`;
    case 'price':
      return isAr ? `${who}: تغيّر السعر المعلن لـ${project ?? ''}` : `${who}: stated price changed for ${project ?? ''}`;
    case 'event':
      return isAr ? `${who}: فعالية${project ? ` — ${project}` : ''}` : `${who}: event${project ? ` — ${project}` : ''}`;
    case 'sold_out':
      return isAr ? `${who}: إعلان نفاد البيع${project ? ` — ${project}` : ''}` : `${who}: sold-out announcement${project ? ` — ${project}` : ''}`;
    default:
      return who;
  }
}

function detailLine(it: MarketItem, isAr: boolean): string | null {
  const d = it.detail;
  if (!d) return null;
  if (it.kind === 'offer') return [d.offer, d.price, d.payment_plan].filter(Boolean).join(' · ') || null;
  if (it.kind === 'price') {
    const pct = typeof d.change_pct === 'number' ? ` (${d.change_pct > 0 ? '+' : ''}${d.change_pct}%)` : '';
    return isAr ? `من «${d.previous ?? '—'}» إلى «${d.price ?? '—'}»${pct} — قد يكون لنوع وحدة مختلف` : `From «${d.previous ?? '—'}» to «${d.price ?? '—'}»${pct} — may be a different unit type`;
  }
  if (it.kind === 'event') return d.message ?? null;
  if (it.kind === 'new_project' && !d.in_catalog && (d.companies ?? 0) > 1) return isAr ? `تذكره ${d.companies} شركات` : `Named by ${d.companies} companies`;
  return null;
}

export default function MarketWatchSurface({ isAr }: { isAr: boolean }) {
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<MarketKind | null>(null);
  const [data, setData] = useState<MarketWatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchMarketWatch({ days })
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [days]);

  const items = useMemo(() => (data?.items ?? []).filter((i) => !kind || i.kind === kind), [data, kind]);
  const total = Object.values(data?.counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <div className="cw-surface">
      <div className="cw-filters">
        <button type="button" className={`cw-chip${kind === null ? ' on' : ''}`} onClick={() => setKind(null)}>
          {isAr ? 'الكل' : 'All'} {total ? `· ${total}` : ''}
        </button>
        {KINDS.map((k) => (
          <button key={k.key} type="button" className={`cw-chip${kind === k.key ? ' on' : ''}`} onClick={() => setKind(kind === k.key ? null : k.key)}>
            <span className="cw-sw" style={{ background: k.color, display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginInlineEnd: 6 }} />
            {isAr ? k.ar : k.en} · {data?.counts?.[k.key] ?? 0}
          </button>
        ))}
        <select className="cw-sort" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={isAr ? 'الفترة' : 'Period'}>
          {PERIODS.map((p) => <option key={p} value={p}>{isAr ? `آخر ${p} يومًا` : `Last ${p} days`}</option>)}
        </select>
      </div>
      <div className="cw-note" style={{ marginBottom: 10 }}>
        {isAr
          ? 'كل خبر مستخرج مما قرأناه في منشورات المنافسين، ومعه المنشورات التي تثبته.'
          : 'Every item is read off competitor posts, with the posts that prove it.'}
      </div>

      {loading && <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}
      {error && <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>}

      {!loading && !error && items.map((it, i) => {
        const k = kindMeta(it.kind);
        const line = detailLine(it, isAr);
        return (
          <div key={`${it.kind}-${i}`} className="cw-mwitem">
            <span className="cw-pill" style={{ background: k.color, color: '#fff' }}>{isAr ? k.ar : k.en}</span>
            <div className="cw-mwbody">
              <div className="cw-mwhead" dir="auto">
                {headline(it, isAr)}
                {it.project_id && (
                  <a className="cw-projlink" href={`/model/all_projects/${it.project_id}`} target="_blank" rel="noreferrer">↗</a>
                )}
              </div>
              {line && <div className="cw-mwdetail" dir="auto">{line}</div>}
              <div className="cw-mwposts">
                <span className="cw-mono cw-muted">{fmtDateTime(it.at, isAr)}</span>
                {(it.posts ?? []).map((p) => (
                  <a key={p.id} href={p.url ?? undefined} target="_blank" rel="noreferrer" className="cw-mwpost" title={`${p.platform} · ${fmtDateTime(p.at, isAr)}`}>
                    {p.thumb ? <img src={p.thumb} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} /> : <span>{p.platform}</span>}
                  </a>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {!loading && !error && items.length === 0 && <div className="cw-empty">{isAr ? 'لا أخبار في هذه الفترة.' : 'No news in this period.'}</div>}
    </div>
  );
}

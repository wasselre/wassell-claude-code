/**
 * Search results — design screen 44.
 *
 * One box, four kinds of object, grouped by kind rather than blended into one
 * relevance-ranked list. Grouping is the honest shape here: a campaign and a
 * photo are not competing for the same click.
 *
 * Two rules from the mockup govern everything:
 * — Every hit says WHY it matched («مطابقة في الموجز» plus the excerpt), so
 *   checking a result does not require opening the record.
 * — Results and the count chips are whatever RLS + the surface matrix let this
 *   person see. A hidden type is ABSENT — no chip, no counter, no «٣ نتائج
 *   محجوبة»: announcing that a hidden thing exists is itself the leak.
 *
 * The excerpt arrives as a server-built string with the hit wrapped in <mark>.
 * It is rendered through `renderExcerpt` — a splitter that recognises ONLY the
 * bare <mark>…</mark> pair and emits everything else as plain text nodes. No
 * dangerouslySetInnerHTML anywhere; any other markup renders as literal text.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CAMPAIGN_STATUS_LABELS, MosCampaign, MosContentRow, MosShootRequest,
  SHOOT_STATUS_LABELS, SearchHit, SearchHitType, SearchResponse, searchAll,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import {
  Empty, LoadError, PageHead, Pill, RoleChip, Skeleton, StatusPill, type Tone,
} from './components/kit';
import { IconSearch } from './components/icons';
import { money, num } from './lib/format';
import './styles/pages-remaining.css';

type Filter = 'all' | SearchHitType;

/** Group titles — the mockup's card headings, per hit type. */
const TYPE_LABELS: Record<SearchHitType, { ar: string; en: string }> = {
  content:  { ar: 'محتوى',  en: 'Content' },
  asset:    { ar: 'مواد',   en: 'Material' },
  campaign: { ar: 'حملات',  en: 'Campaigns' },
  shoot:    { ar: 'تصوير',  en: 'Shoots' },
};

/** The field nouns behind «مطابقة في …». Unknown fields render their raw key. */
const MATCH_FIELD_LABELS: Record<string, { ar: string; en: string }> = {
  title:    { ar: 'العنوان',   en: 'the title' },
  ref:      { ar: 'الرقم',     en: 'the reference' },
  goal:     { ar: 'الموجز',    en: 'the brief' },
  body:     { ar: 'النص',      en: 'the text' },
  caption:  { ar: 'النص',      en: 'the caption' },
  note:     { ar: 'الملاحظات', en: 'the notes' },
  location: { ar: 'الموقع',    en: 'the location' },
  tag:      { ar: 'الوسوم',    en: 'the tags' },
  tags:     { ar: 'الوسوم',    en: 'the tags' },
};

/** «مطابقة في العنوان والنص» — compound reasons ('title+body') join with و. */
function matchLabel(reason: string, isAr: boolean): string {
  const parts = reason.split(/[+,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const names = parts.map((p) => {
    const l = MATCH_FIELD_LABELS[p];
    return l ? (isAr ? l.ar : l.en) : p;
  });
  const joined = isAr
    ? names[0] + names.slice(1).map((n) => ` و${n}`).join('')
    : names.join(' & ');
  return isAr ? `مطابقة في ${joined}` : `Matched in ${joined}`;
}

/**
 * The safe excerpt renderer. Splits the server string on bare <mark>…</mark>
 * pairs only; odd segments become real <mark> elements, everything else is a
 * plain text node (React escapes it). Never raw HTML injection.
 */
function renderExcerpt(excerpt: string): ReactNode[] {
  const parts = excerpt.split(/<mark>([\s\S]*?)<\/mark>/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>);
}

const stripMarks = (s: string): string => s.replace(/<\/?mark>/g, '');

const SHOOT_TONE: Record<string, Tone> = {
  requested: 'idle', scheduled: 'now', shot: 'go', delivered: 'live', cancelled: 'idle',
};

export default function SearchPage() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  const [term, setTerm] = useState(q);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRes(await searchAll(q.trim()));
      setFilter('all');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setTerm(q); }, [q]);

  const results = useMemo(() => res?.results ?? [], [res]);
  const chips = useMemo(() => res?.chips ?? [], [res]);

  /** Hits grouped by type. Hidden types never arrive, so they never render. */
  const groups = useMemo(() => {
    const g = new Map<SearchHitType, SearchHit[]>();
    for (const h of results) {
      const arr = g.get(h.type) ?? [];
      arr.push(h);
      g.set(h.type, arr);
    }
    return g;
  }, [results]);

  // The legacy full rows, used ONLY to enrich a hit the caller may already see
  // (status pill, owner, spend). The server sends [] for hidden types.
  const contentById = useMemo(
    () => new Map<string, MosContentRow>((res?.content ?? []).map((r) => [r.id, r])),
    [res],
  );
  const campaignById = useMemo(
    () => new Map<string, MosCampaign>((res?.campaigns ?? []).map((c) => [c.id, c])),
    [res],
  );
  const shootById = useMemo(
    () => new Map<string, MosShootRequest>((res?.shoots ?? []).map((s) => [s.id, s])),
    [res],
  );

  const total = chips.length > 0
    ? chips.reduce((a, c) => a + c.count, 0)
    : results.length;
  const show = (k: SearchHitType): boolean => filter === 'all' || filter === k;

  const hitPath = (h: SearchHit): string => {
    switch (h.type) {
      case 'content':  return `/m/content/${h.id}`;
      case 'campaign': return `/m/campaigns/${h.id}`;
      case 'asset':    return `/m/library/${h.id}`;
      case 'shoot':    return `/m/shoots/${h.id}`;
    }
  };

  /** Title cell: when the excerpt IS the marked title, render it marked. */
  const titleNode = (h: SearchHit): ReactNode =>
    h.excerpt && stripMarks(h.excerpt) === h.title ? renderExcerpt(h.excerpt) : h.title;

  /** The «why it matched» line under a hit. Excerpt spares opening the record. */
  const matchLine = (h: SearchHit): ReactNode => {
    const label = matchLabel(h.match_reason, isAr);
    const excerptIsTitle = h.excerpt !== '' && stripMarks(h.excerpt) === h.title;
    if (!label && (!h.excerpt || excerptIsTitle)) return null;
    return (
      <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 3 }}>
        {label}
        {h.excerpt && !excerptIsTitle && <> · «{renderExcerpt(h.excerpt)}»</>}
      </div>
    );
  };

  const contentHits = groups.get('content') ?? [];
  const assetHits = groups.get('asset') ?? [];
  const campaignHits = groups.get('campaign') ?? [];
  const shootHits = groups.get('shoot') ?? [];

  return (
    <>
      <PageHead
        title={isAr ? 'نتائج البحث' : 'Search results'}
        sub={q
          ? isAr
            ? `«${q}» · ${num(total, true)} نتيجة · العرض حسب صلاحياتك`
            : `“${q}” · ${total} results · scoped to what you may see`
          : isAr ? 'اكتب للبحث' : 'Type to search'}
      >
        <form
          className="search"
          style={{ minWidth: 280, borderColor: 'var(--copper)' }}
          onSubmit={(e) => { e.preventDefault(); setParams({ q: term }, { replace: true }); }}
        >
          <IconSearch />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={isAr ? 'محتوى أو مواد أو حملات أو تصوير' : 'content, material, campaigns or shoots'}
            autoFocus
          />
        </form>
      </PageHead>

      <div className="body">
        {/* Count chips: «الكل» plus one chip PER TYPE THE SERVER SENT. A type
            whose surface is hidden is absent from `chips` — rendering only
            what arrives is what keeps hidden things unannounced. */}
        {chips.length > 0 && (
          <div className="filt">
            <button
              type="button"
              className={`fbtn${filter === 'all' ? ' on' : ''}`}
              onClick={() => setFilter('all')}
            >
              {isAr ? 'الكل' : 'All'} <span style={{ opacity: 0.7 }}>{num(total, isAr)}</span>
            </button>
            {chips.map((c) => (
              <button
                key={c.type}
                type="button"
                className={`fbtn${filter === c.type ? ' on' : ''}`}
                onClick={() => setFilter(c.type)}
              >
                {isAr ? TYPE_LABELS[c.type]?.ar : TYPE_LABELS[c.type]?.en}{' '}
                <span style={{ opacity: 0.7 }}>{num(c.count, isAr)}</span>
              </button>
            ))}
          </div>
        )}

        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={5} />}

        {!loading && q.trim() !== '' && results.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا نتائج' : 'Nothing found'}
            body={isAr
              ? 'جرّب رقم العنصر (مثل V-004) أو جزءًا من العنوان.'
              : 'Try the reference (like V-004) or part of the title.'}
          />
        )}

        {/* ── محتوى ─────────────────────────────────────────────────── */}
        {show('content') && contentHits.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <h4>{isAr ? TYPE_LABELS.content.ar : TYPE_LABELS.content.en}</h4>
              <span className="r">{num(contentHits.length, isAr)}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {contentHits.map((h) => {
                    const row = contentById.get(h.id);
                    return (
                      <tr key={h.id} className="click" onClick={() => navigate(hitPath(h))}>
                        <td className="id" style={{ width: 70 }}>{h.ref ?? '—'}</td>
                        <td>
                          <div className="ttl">{titleNode(h)}</div>
                          {matchLine(h)}
                        </td>
                        <td style={{ width: 150 }}>
                          {row ? <StatusPill row={row} isAr={isAr} /> : <span style={{ color: 'var(--mute)' }}>—</span>}
                        </td>
                        <td style={{ width: 140 }}>
                          {row
                            ? <RoleChip role={row.owner_role} isAr={isAr} />
                            : <span style={{ color: 'var(--mute)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── مواد — a thumbnail grid, not a table ──────────────────── */}
        {show('asset') && assetHits.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <h4>{isAr ? TYPE_LABELS.asset.ar : TYPE_LABELS.asset.en}</h4>
              <span className="r">{num(assetHits.length, isAr)}</span>
            </div>
            <div className="card-b">
              <div className="agrid">
                {assetHits.map((h) => (
                  <button key={h.id} type="button" className="ass" onClick={() => navigate(hitPath(h))}>
                    <div className="im" style={{ background: 'linear-gradient(135deg,#8E6A4F,#B8734F)' }}>
                      {h.thumb_url
                        ? <img src={h.thumb_url} alt="" />
                        : (isAr ? 'مادة' : 'Asset')}
                    </div>
                    <div className="mt2">
                      <b>{titleNode(h)}</b>
                      <span>{matchLabel(h.match_reason, isAr)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── حملات ─────────────────────────────────────────────────── */}
        {show('campaign') && campaignHits.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <h4>{isAr ? TYPE_LABELS.campaign.ar : TYPE_LABELS.campaign.en}</h4>
              <span className="r">{num(campaignHits.length, isAr)}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {campaignHits.map((h) => {
                    const c = campaignById.get(h.id);
                    return (
                      <tr key={h.id} className="click" onClick={() => navigate(hitPath(h))}>
                        <td className="id" style={{ width: 70 }}>{h.ref ?? '—'}</td>
                        <td>
                          <div className="ttl">{titleNode(h)}</div>
                          {matchLine(h)}
                        </td>
                        <td className="num" style={{ width: 130 }}>
                          {c ? money(c.total_spend, isAr) : '—'}
                        </td>
                        <td style={{ width: 110 }}>
                          {c
                            ? (
                              <Pill tone={c.status === 'active' ? 'now' : 'idle'}>
                                {(isAr ? CAMPAIGN_STATUS_LABELS[c.status]?.ar : CAMPAIGN_STATUS_LABELS[c.status]?.en) ?? c.status}
                              </Pill>
                            )
                            : <span style={{ color: 'var(--mute)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── تصوير — rows with a small thumbnail ───────────────────── */}
        {show('shoot') && shootHits.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <h4>{isAr ? TYPE_LABELS.shoot.ar : TYPE_LABELS.shoot.en}</h4>
              <span className="r">{num(shootHits.length, isAr)}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {shootHits.map((h) => {
                    const s = shootById.get(h.id);
                    return (
                      <tr key={h.id} className="click" onClick={() => navigate(hitPath(h))}>
                        <td style={{ width: 64 }}>
                          {h.thumb_url
                            ? <img className="pr-thumb" src={h.thumb_url} alt="" />
                            : <span className="pr-thumb" aria-hidden="true" />}
                        </td>
                        <td className="id" style={{ width: 70 }}>{h.ref ?? '—'}</td>
                        <td>
                          <div className="ttl">{titleNode(h)}</div>
                          {matchLine(h)}
                        </td>
                        <td style={{ width: 110 }}>
                          {s
                            ? (
                              <Pill tone={SHOOT_TONE[s.status] ?? 'idle'}>
                                {(isAr ? SHOOT_STATUS_LABELS[s.status]?.ar : SHOOT_STATUS_LABELS[s.status]?.en) ?? s.status}
                              </Pill>
                            )
                            : <span style={{ color: 'var(--mute)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

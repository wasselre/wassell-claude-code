/**
 * Search results — design screen 44.
 *
 * One box, three kinds of object, grouped by kind rather than blended into one
 * relevance-ranked list. Grouping is the honest shape here: a campaign and a
 * photo are not competing for the same click.
 *
 * Results are whatever RLS lets this person see — a viewer's 23 results and a
 * manager's 23 results are different sets, and that is correct.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ASSET_KIND_LABELS, CAMPAIGN_STATUS_LABELS, MosAsset, MosCampaign, MosContentRow, searchAll,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import {
  Empty, KindCell, LoadError, PageHead, Pill, RoleChip, Skeleton, StatusPill,
} from './components/kit';
import { IconSearch } from './components/icons';
import { money, num } from './lib/format';

type Filter = 'all' | 'content' | 'assets' | 'campaigns';

export default function SearchPage() {
  const { isAr, typeLabel, projectName } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  const [term, setTerm] = useState(q);
  const [content, setContent] = useState<MosContentRow[]>([]);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!q.trim()) {
      setContent([]); setAssets([]); setCampaigns([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await searchAll(q.trim());
      setContent(res.content);
      setAssets(res.assets);
      setCampaigns(res.campaigns);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setTerm(q); }, [q]);

  const total = content.length + assets.length + campaigns.length;
  const show = (k: Filter): boolean => filter === 'all' || filter === k;

  const FILTERS: Array<{ key: Filter; ar: string; en: string; n: number }> = [
    { key: 'all', ar: 'الكل', en: 'All', n: total },
    { key: 'content', ar: 'محتوى', en: 'Content', n: content.length },
    { key: 'assets', ar: 'مواد', en: 'Material', n: assets.length },
    { key: 'campaigns', ar: 'حملات', en: 'Campaigns', n: campaigns.length },
  ];

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
            placeholder={isAr ? 'محتوى أو مواد أو حملات' : 'content, material or campaigns'}
            autoFocus
          />
        </form>
      </PageHead>

      <div className="body">
        <div className="filt">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`fbtn${filter === f.key ? ' on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {isAr ? f.ar : f.en} <span style={{ opacity: 0.7 }}>{num(f.n, isAr)}</span>
            </button>
          ))}
        </div>

        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={5} />}

        {!loading && q.trim() !== '' && total === 0 && !error && (
          <Empty
            title={isAr ? 'لا نتائج' : 'Nothing found'}
            body={isAr
              ? 'جرّب رقم العنصر (مثل V-004) أو جزءًا من العنوان.'
              : 'Try the reference (like V-004) or part of the title.'}
          />
        )}

        {show('content') && content.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <h4>{isAr ? 'محتوى' : 'Content'}</h4>
              <span className="r">{num(content.length, isAr)}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {content.map((r) => (
                    <tr key={r.id} className="click" onClick={() => navigate(`/m/content/${r.id}`)}>
                      <td className="id" style={{ width: 70 }}>{r.ref}</td>
                      <td>
                        <div className="ttl">{r.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 3 }}>
                          {typeLabel(r.content_type_key)}
                          {r.project_id && <> · {projectName(r.project_id)}</>}
                        </div>
                      </td>
                      <td style={{ width: 96 }}><KindCell typeKey={r.content_type_key} /></td>
                      <td style={{ width: 150 }}><StatusPill row={r} isAr={isAr} /></td>
                      <td style={{ width: 140 }}><RoleChip role={r.owner_role} isAr={isAr} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {show('assets') && assets.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <h4>{isAr ? 'مواد' : 'Material'}</h4>
              <span className="r">{num(assets.length, isAr)}</span>
            </div>
            <div className="card-b">
              <div className="agrid">
                {assets.map((a) => (
                  <button key={a.id} type="button" className="ass" onClick={() => navigate('/m/library')}>
                    <div className="im" style={{ background: 'linear-gradient(135deg,#8E6A4F,#B8734F)' }}>
                      {a.thumb_url
                        ? <img src={a.thumb_url} alt="" />
                        : (isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
                    </div>
                    <div className="mt2">
                      <b>{a.title}</b>
                      <span className="ltr">{a.ref}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {show('campaigns') && campaigns.length > 0 && (
          <div className="card">
            <div className="card-h">
              <h4>{isAr ? 'حملات' : 'Campaigns'}</h4>
              <span className="r">{num(campaigns.length, isAr)}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="click" onClick={() => navigate(`/m/campaigns/${c.id}`)}>
                      <td className="id" style={{ width: 70 }}>{c.ref}</td>
                      <td className="ttl">{c.name}</td>
                      <td className="num" style={{ width: 130 }}>{money(c.total_spend, isAr)}</td>
                      <td style={{ width: 110 }}>
                        <Pill tone={c.status === 'active' ? 'now' : 'idle'}>
                          {(isAr ? CAMPAIGN_STATUS_LABELS[c.status]?.ar : CAMPAIGN_STATUS_LABELS[c.status]?.en) ?? c.status}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

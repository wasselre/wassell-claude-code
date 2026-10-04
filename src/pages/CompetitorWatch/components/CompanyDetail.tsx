/** One company, everything (2026-10-04).
 *
 *  Opens from the Companies list. Reads `mkt_company_profile` in one call:
 *  accounts and followers, how often they post, how their posts perform month
 *  by month, their best posts measured against THAT account's usual post (so a
 *  small account's hit is not buried under a big account's average), what they
 *  post about (purpose / format / platform), their projects, offers, messages,
 *  the projects they name that our catalog lacks, and their visual style when
 *  shots exist. Their full post list is the Content Library, pre-filtered.
 */
import { useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchCompanyProfile, type CompanyProfile, type ProfileTopPost } from '@/lib/competitorWatch/client';
import { useSurface, num, fmtDateTime, daysAgo } from './surfaceData';
import ContentLibrary, { PostNumbers } from './ContentLibrary';

const PURPOSE_LABEL: Record<string, { ar: string; en: string }> = {
  project_launch: { ar: 'إطلاق مشروع', en: 'Launch' }, offer: { ar: 'عرض', en: 'Offer' }, walkthrough: { ar: 'جولة', en: 'Walkthrough' },
  brand: { ar: 'علامة', en: 'Brand' }, teaser: { ar: 'تشويق', en: 'Teaser' }, event: { ar: 'فعالية', en: 'Event' },
  testimonial: { ar: 'شهادة', en: 'Testimonial' }, unknown: { ar: 'غير مصنّف', en: 'Unclassified' },
};
const FORMAT_LABEL: Record<string, { ar: string; en: string }> = {
  image: { ar: 'صورة', en: 'Image' }, carousel: { ar: 'كاروسيل', en: 'Carousel' }, video: { ar: 'فيديو', en: 'Video' },
  reel: { ar: 'ريلز', en: 'Reel' }, short: { ar: 'شورتس', en: 'Short' }, unknown: { ar: 'غير معروف', en: 'Unknown' },
};

function label(map: Record<string, { ar: string; en: string }>, k: string, isAr: boolean): string {
  const m = map[k];
  return m ? (isAr ? m.ar : m.en) : k;
}

function monthLabel(iso: string, isAr: boolean): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { month: 'short', year: '2-digit' });
}

function sortedEntries(o: Record<string, number> | null | undefined): Array<[string, number]> {
  return Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]);
}

export default function CompanyDetail({ orgId, isAr, onBack }: { orgId: string; isAr: boolean; onBack: () => void }) {
  const { data, loading, error } = useSurface<CompanyProfile>(() => fetchCompanyProfile(orgId));
  const [showPosts, setShowPosts] = useState(false);
  const Back = isAr ? ArrowRight : ArrowLeft;

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error || !data) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error ?? (isAr ? 'لا بيانات' : 'no data')}</div>;

  const o = data.organization;
  const name = (isAr ? o.name_ar : o.name_en) ?? o.name_ar ?? o.name_en ?? '—';
  const t = data.totals;
  const lastDays = daysAgo(t.last_post_at);

  return (
    <div className="cw-surface cw-company">
      <div className="cw-cohead">
        <button type="button" className="cw-chip" onClick={onBack}><Back size={14} /> {isAr ? 'كل الشركات' : 'All companies'}</button>
        <div>
          <h2 className="cw-coh2" dir="auto">{name}</h2>
          <div className="cw-mutedmono">
            {o.org_type === 'developer' ? (isAr ? 'مطوّر' : 'Developer') : (isAr ? 'مسوّق' : 'Marketer')}
            {o.hq_city ? ` · ${o.hq_city}` : ''}
            {o.website && <> · <a href={o.website} target="_blank" rel="noreferrer" dir="ltr">{o.website.replace(/^https?:\/\//, '')}</a></>}
            {o.developer_record_id && (
              <> · <a href={`/model/developers/${o.developer_record_id}`} target="_blank" rel="noreferrer">{isAr ? 'سجل الشركة' : 'Company record'} <ExternalLink size={11} /></a></>
            )}
          </div>
        </div>
      </div>

      <div className="cw-tiles cw-tiles4">
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'منشورات آخر 12 شهرًا' : 'Posts, last 12 months'}</div>
          <div className="cw-tilev">{num(t.posts_12m)}</div>
          <div className="cw-tilesub">{isAr ? `آخر 30 يومًا: ${num(t.posts_30d)}` : `last 30 days: ${num(t.posts_30d)}`}</div>
        </div>
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'متوسط المشاهدات' : 'Average views'}</div>
          <div className="cw-tilev">{num(t.avg_views_12m)}</div>
          <div className="cw-tilesub">{isAr ? 'للمنشورات التي لها مشاهدات' : 'posts that have views'}</div>
        </div>
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'متوسط الإعجابات' : 'Average likes'}</div>
          <div className="cw-tilev">{num(t.avg_likes_12m)}</div>
          <div className="cw-tilesub">{isAr ? 'آخر 12 شهرًا' : 'last 12 months'}</div>
        </div>
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'آخر نشر' : 'Last post'}</div>
          <div className="cw-tilev">{lastDays === null ? '—' : lastDays <= 0 ? (isAr ? 'اليوم' : 'today') : `${lastDays}${isAr ? ' ي' : 'd'}`}</div>
          <div className="cw-tilesub">{fmtDateTime(t.last_post_at, isAr)}</div>
        </div>
      </div>

      <div className="cw-panel">
        <div className="cw-panelh"><h3>{isAr ? 'الحسابات' : 'Accounts'}</h3></div>
        <div className="cw-tblwrap">
          <table className="cw-table">
            <thead><tr>
              <th>{isAr ? 'الحساب' : 'Account'}</th>
              <th className="cw-r">{isAr ? 'المتابعون' : 'Followers'}</th>
              <th className="cw-r">{isAr ? 'تغيّر 30 يومًا' : '30-day change'}</th>
              <th className="cw-r">{isAr ? 'منشورات 90 يومًا' : 'Posts, 90 days'}</th>
              <th className="cw-r">{isAr ? 'المنشور المعتاد' : 'Usual post'}</th>
              <th>{isAr ? 'آخر نشر' : 'Last post'}</th>
              <th>{isAr ? 'المتابعة' : 'Collection'}</th>
            </tr></thead>
            <tbody>
              {data.accounts.map((a) => {
                const delta = typeof a.followers === 'number' && typeof a.followers_30d_ago === 'number' ? a.followers - a.followers_30d_ago : null;
                return (
                  <tr key={a.id}>
                    <td dir="ltr">
                      <span className="cw-mono">{a.platform}</span>{' '}
                      {a.profile_url ? <a href={a.profile_url} target="_blank" rel="noreferrer">@{a.handle}</a> : <>@{a.handle}</>}
                    </td>
                    <td className="cw-r cw-mono">{num(a.followers)}</td>
                    <td className="cw-r cw-mono">{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`}</td>
                    <td className="cw-r cw-mono">{num(a.posts_90d)}</td>
                    <td className="cw-r cw-mono" title={isAr ? 'وسيط آخر 12 شهرًا' : '12-month median'}>
                      {a.usual_views !== null ? `▷ ${num(a.usual_views)}` : ''}{a.usual_views !== null && a.usual_likes !== null ? ' · ' : ''}{a.usual_likes !== null ? `♥ ${num(a.usual_likes)}` : ''}
                      {a.usual_views === null && a.usual_likes === null ? '—' : ''}
                    </td>
                    <td className="cw-mono">{fmtDateTime(a.last_post_at, isAr)}</td>
                    <td className="cw-muted">
                      {a.collection_enabled ? (a.cadence === 'weekly' ? (isAr ? 'أسبوعيًا' : 'weekly') : (isAr ? 'يوميًا' : 'daily')) : (isAr ? 'متوقف' : 'off')}
                      {a.history_done_at ? '' : (isAr ? ' · السجل قيد الجمع' : ' · history pending')}
                    </td>
                  </tr>
                );
              })}
              {data.accounts.length === 0 && <tr><td colSpan={7} className="cw-muted">{isAr ? 'لا حسابات مسجّلة.' : 'No accounts on file.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cw-cogrid">
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'وتيرة النشر — منشورات كل أسبوع' : 'Posting rhythm — posts per week'}</h3></div>
          <div className="cw-panelb" style={{ height: 200 }} dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.weeks.map((w) => ({ x: w.week.slice(5), posts: w.posts }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--cw-line2)" />
                <XAxis dataKey="x" tick={{ fontSize: 10 }} interval={3} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                <Tooltip />
                <Bar dataKey="posts" name={isAr ? 'منشورات' : 'Posts'} fill="#B8734F" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'الأداء شهريًا — متوسط المشاهدات' : 'Performance by month — average views'}</h3></div>
          <div className="cw-panelb" style={{ height: 200 }} dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.months.map((m) => ({ x: monthLabel(m.month, isAr), views: m.avg_views ?? 0, likes: m.avg_likes ?? 0, posts: m.posts }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--cw-line2)" />
                <XAxis dataKey="x" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="v" tick={{ fontSize: 10 }} width={44} />
                <YAxis yAxisId="p" orientation="right" allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                <Tooltip />
                <Bar yAxisId="p" dataKey="posts" name={isAr ? 'منشورات' : 'Posts'} fill="#D4B896" radius={[3, 3, 0, 0]} />
                <Line yAxisId="v" dataKey="views" name={isAr ? 'متوسط المشاهدات' : 'Avg views'} stroke="#4A2C2A" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="cw-panel">
        <div className="cw-panelh">
          <h3>{isAr ? 'أفضل منشوراتهم — مقارنةً بمنشورهم المعتاد' : 'Their best posts — against their own usual post'}</h3>
          <span className="cw-muted">{isAr ? 'آخر 12 شهرًا' : 'last 12 months'}</span>
        </div>
        <div className="cw-panelb cw-topgrid">
          {data.top_posts.map((p) => <TopPost key={p.id} p={p} isAr={isAr} />)}
          {data.top_posts.length === 0 && <div className="cw-muted">{isAr ? 'لا منشورات بأرقام بعد.' : 'No posts with numbers yet.'}</div>}
        </div>
      </div>

      <div className="cw-cogrid">
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'ماذا ينشرون' : 'What they post'}</h3></div>
          <div className="cw-panelb">
            <div className="cw-kv">{isAr ? 'الغرض' : 'Purpose'}</div>
            <div className="cw-chips" style={{ marginBottom: 10 }}>
              {sortedEntries(data.mix.content_type).map(([k, n]) => <span key={k} className="cw-softchip">{label(PURPOSE_LABEL, k, isAr)} <b>{n}</b></span>)}
            </div>
            <div className="cw-kv">{isAr ? 'الصيغة' : 'Format'}</div>
            <div className="cw-chips" style={{ marginBottom: 10 }}>
              {sortedEntries(data.mix.format).map(([k, n]) => <span key={k} className="cw-softchip">{label(FORMAT_LABEL, k, isAr)} <b>{n}</b></span>)}
            </div>
            <div className="cw-kv">{isAr ? 'المنصة' : 'Platform'}</div>
            <div className="cw-chips">
              {sortedEntries(data.mix.platform).map(([k, n]) => <span key={k} className="cw-softchip">{k} <b>{n}</b></span>)}
            </div>
            {data.visual_style.length > 0 && (
              <>
                <div className="cw-kv" style={{ marginTop: 10 }}>{isAr ? 'الأسلوب البصري (من لقطات الفيديو)' : 'Visual style (from video shots)'}</div>
                <div className="cw-chips">
                  {data.visual_style.slice(0, 12).map((v) => <span key={v.tag} className="cw-softchip" dir="ltr">{v.tag} <b>{v.shots}</b></span>)}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'مشاريعهم' : 'Their projects'}</h3></div>
          <div className="cw-tblwrap">
            <table className="cw-table">
              <thead><tr>
                <th>{isAr ? 'المشروع' : 'Project'}</th>
                <th className="cw-r">{isAr ? 'منشورات' : 'Posts'}</th>
                <th className="cw-r">{isAr ? 'متوسط المشاهدات' : 'Avg views'}</th>
                <th>{isAr ? 'آخر نشر' : 'Last post'}</th>
              </tr></thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.project_id}>
                    <td dir="rtl"><a href={`/model/all_projects/${p.project_id}`} target="_blank" rel="noreferrer">{p.name ?? '—'}</a></td>
                    <td className="cw-r cw-mono">{num(p.posts)}</td>
                    <td className="cw-r cw-mono">{num(p.avg_views)}</td>
                    <td className="cw-mono">{fmtDateTime(p.last_post_at, isAr)}</td>
                  </tr>
                ))}
                {data.projects.length === 0 && <tr><td colSpan={4} className="cw-muted">{isAr ? 'لم يُربط أي منشور بمشروع بعد.' : 'No post linked to a project yet.'}</td></tr>}
              </tbody>
            </table>
          </div>
          {data.unknown_projects.length > 0 && (
            <div className="cw-panelb">
              <div className="cw-kv">{isAr ? 'مشاريع يذكرونها وليست في الكتالوج' : 'Projects they name that are not in our catalog'}</div>
              <div className="cw-chips">
                {data.unknown_projects.map((u) => <span key={u.name} className="cw-softchip" dir="auto">{u.name} <b>{u.posts}</b></span>)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="cw-cogrid">
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'عروضهم الأخيرة' : 'Their latest offers'}</h3></div>
          <div className="cw-panelb">
            {data.offers.map((f) => (
              <div key={f.id} className="cw-statline" dir="auto">
                <b>{f.offer}</b>
                {f.project_name ? <span className="cw-muted"> · {f.project_name}</span> : null}
                {f.price ? <span className="cw-muted"> · {f.price}</span> : null}
                <span className="cw-mono cw-muted"> · {fmtDateTime(f.published_at, isAr)}</span>
              </div>
            ))}
            {data.offers.length === 0 && <div className="cw-muted">{isAr ? 'لا عروض مسجّلة.' : 'No offers on record.'}</div>}
          </div>
        </div>
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'رسائلهم الأخيرة' : 'Their latest messages'}</h3></div>
          <div className="cw-panelb">
            {data.messages.map((m) => (
              <div key={m.id} className="cw-statline" dir="auto">
                {m.message}
                <span className="cw-mono cw-muted"> · {label(PURPOSE_LABEL, m.content_type ?? 'unknown', isAr)} · {fmtDateTime(m.published_at, isAr)}</span>
              </div>
            ))}
            {data.messages.length === 0 && <div className="cw-muted">{isAr ? 'لا رسائل مسجّلة.' : 'No messages on record.'}</div>}
          </div>
        </div>
      </div>

      <div className="cw-panel">
        <div className="cw-panelh">
          <h3>{isAr ? `كل منشوراتهم (${num(t.posts)})` : `All their posts (${num(t.posts)})`}</h3>
          <button type="button" className="cw-chip" onClick={() => setShowPosts((v) => !v)}>
            {showPosts ? (isAr ? 'إخفاء' : 'Hide') : (isAr ? 'عرض' : 'Show')}
          </button>
        </div>
        {showPosts && <ContentLibrary isAr={isAr} presetOrg={{ id: o.id, name: name }} />}
      </div>
    </div>
  );
}

function TopPost({ p, isAr }: { p: ProfileTopPost; isAr: boolean }) {
  return (
    <a className="cw-toppost" href={p.post_url ?? undefined} target="_blank" rel="noreferrer">
      <div className="cw-topthumb">
        {p.thumb_url ? <img src={p.thumb_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} /> : null}
        {p.format && <span className="cw-fmt">{p.format}</span>}
      </div>
      <div className="cw-topbody">
        {p.project_name && <div className="cw-mutedmono" dir="rtl">{p.project_name}</div>}
        {p.summary && <div className="cw-topsum" dir="auto">{p.summary}</div>}
        <div className="cw-eng">
          <PostNumbers row={{ views: p.views, likes: p.likes, comments: p.comments, vs_usual: p.vs_usual, likely_paid: p.likely_paid, at_7d: null, at_30d: null, usual_views: null, usual_likes: null }} isAr={isAr} />
          <span className="cw-mono">{fmtDateTime(p.published_at, isAr)}</span>
        </div>
      </div>
    </a>
  );
}

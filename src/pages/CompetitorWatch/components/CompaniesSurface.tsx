/** Companies — who each competitor is, and what they actually market.
 *
 *  The old table answered "how much have we collected from them": accounts,
 *  posts, facts, and a «آخر نشاط» column that was really OUR last scrape. That
 *  says nothing about the competitor. This surface leads with the marketing
 *  read the enrichment pipeline already produces per post — how often they
 *  publish, in what format, for what purpose, about which projects and
 *  districts, whether they run offers, and how their posts perform — with the
 *  collection numbers kept, but demoted to where they belong.
 */
import { Fragment, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { fetchCompanyRoster, type CompanyRoster, type CompanyRow, type CompanyAccount, type PurposeKey } from '@/lib/competitorWatch/client';
import { useSurface, num, fmtDateTime, daysAgo } from './surfaceData';

type TypeFilter = 'all' | 'developer' | 'marketer';
type SortKey = 'active' | 'posts' | 'recent' | 'name';

const PURPOSES: Array<{ key: PurposeKey; ar: string; en: string; cls: string }> = [
  { key: 'project_launch', ar: 'إطلاق مشروع', en: 'Launch', cls: 'p1' },
  { key: 'offer', ar: 'عرض', en: 'Offer', cls: 'p2' },
  { key: 'walkthrough', ar: 'جولة', en: 'Walkthrough', cls: 'p3' },
  { key: 'brand', ar: 'علامة', en: 'Brand', cls: 'p4' },
  { key: 'teaser', ar: 'تشويق', en: 'Teaser', cls: 'p5' },
  { key: 'event', ar: 'فعالية', en: 'Event', cls: 'p6' },
  { key: 'testimonial', ar: 'شهادة', en: 'Testimonial', cls: 'p7' },
];
const PLATFORM_SHORT: Record<string, string> = { instagram: 'IG', tiktok: 'TT', youtube: 'YT', snapchat: 'SC', x: 'X', facebook: 'FB' };

function typeLabel(t: string | null, isAr: boolean): string {
  if (t === 'developer') return isAr ? 'مطوّر' : 'Developer';
  if (t === 'marketer' || t === 'agency') return isAr ? 'مسوّق' : 'Marketer';
  return t ?? '—';
}

/** When THEY last published. A dash means we have no dated post, never "quiet". */
function published(iso: string | null, isAr: boolean): { label: string; tone: string } {
  const days = daysAgo(iso);
  if (days === null) return { label: '—', tone: 'mute' };
  if (days <= 0) return { label: isAr ? 'اليوم' : 'today', tone: 'ok' };
  if (days === 1) return { label: isAr ? 'أمس' : 'yesterday', tone: 'ok' };
  if (days <= 7) return { label: isAr ? `قبل ${days} أيام` : `${days}d ago`, tone: 'ok' };
  if (days <= 30) return { label: isAr ? `قبل ${days} يومًا` : `${days}d ago`, tone: 'mute' };
  if (days <= 90) return { label: isAr ? `قبل ${Math.round(days / 30)} أشهر` : `${Math.round(days / 30)}mo ago`, tone: 'warn' };
  return { label: isAr ? `قبل ${Math.round(days / 30)} شهرًا` : `${Math.round(days / 30)}mo ago`, tone: 'bad' };
}

function topPurpose(row: CompanyRow): { key: PurposeKey; n: number; share: number } | null {
  const entries = PURPOSES.map((p) => ({ key: p.key, n: row.purposes?.[p.key] ?? 0 }));
  const total = entries.reduce((s, e) => s + e.n, 0);
  if (total === 0) return null;
  const best = entries.reduce((a, b) => (b.n > a.n ? b : a));
  return best.n === 0 ? null : { key: best.key, n: best.n, share: best.n / total };
}

/** A proportional bar. Renders nothing when there is no data, rather than an
 *  empty rail that reads as "zero of everything". */
function Bar({ parts }: { parts: Array<{ n: number; cls: string; title: string }> }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total === 0) return <span className="cw-muted">—</span>;
  return (
    <span className="cw-mixbar" role="img" aria-label={parts.filter((p) => p.n > 0).map((p) => `${p.title} ${Math.round((p.n / total) * 100)}%`).join(', ')}>
      {parts.filter((p) => p.n > 0).map((p, i) => (
        <span key={i} className={`cw-mixseg ${p.cls}`} style={{ width: `${(p.n / total) * 100}%` }} title={`${p.title}: ${p.n} (${Math.round((p.n / total) * 100)}%)`} />
      ))}
    </span>
  );
}

function AccountLine({ a, isAr }: { a: CompanyAccount; isAr: boolean }) {
  const lp = published(a.last_post, isAr);
  return (
    <div className="cw-acctrow">
      <span>
        <span className="cw-plat">{PLATFORM_SHORT[a.platform ?? ''] ?? a.platform ?? '—'}</span>
        <span dir="ltr">@{a.handle}</span>
        {!a.enabled && <span className="cw-tag mute" style={{ marginInlineStart: 8 }}>{isAr ? 'موقوف' : 'off'}</span>}
        {a.cadence === 'weekly' && <span className="cw-tag mute" style={{ marginInlineStart: 6 }}>{isAr ? 'أسبوعي' : 'weekly'}</span>}
      </span>
      <span className="cw-mono cw-muted">
        {num(a.posts ?? 0)} {isAr ? 'منشور' : 'posts'}
        {a.followers ? ` · ${num(a.followers)} ${isAr ? 'متابع' : 'followers'}` : ''}
        {` · ${isAr ? 'آخر نشر ' : 'last post '}${lp.label}`}
        {a.last_pull ? ` · ${isAr ? 'سُحب ' : 'pulled '}${fmtDateTime(a.last_pull, isAr)}` : ''}
      </span>
    </div>
  );
}

export default function CompaniesSurface({ isAr }: { isAr: boolean }) {
  const { data, loading, error } = useSurface<CompanyRoster>(fetchCompanyRoster);
  const [openId, setOpenId] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('active');

  const rows = useMemo(() => {
    const all = data?.companies ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = all.filter((c) => {
      const isMkt = c.org_type === 'marketer' || c.org_type === 'agency';
      if (type === 'developer' && c.org_type !== 'developer') return false;
      if (type === 'marketer' && !isMkt) return false;
      if (!needle) return true;
      const hay = [c.name, c.name_en, ...(c.top_projects ?? []).map((p) => p.name), ...(c.account_list ?? []).map((a) => a.handle)]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
    const byName = (a: CompanyRow, b: CompanyRow) => (a.name ?? '').localeCompare(b.name ?? '', isAr ? 'ar' : 'en');
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return byName(a, b);
      if (sort === 'posts') return b.posts - a.posts;
      if (sort === 'recent') return (b.last_post ?? '').localeCompare(a.last_post ?? '');
      return b.posts_90d - a.posts_90d || b.posts - a.posts;
    });
  }, [data, type, q, sort, isAr]);

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!data) return null;

  const counts = {
    all: data.companies.length,
    developer: data.companies.filter((c) => c.org_type === 'developer').length,
    marketer: data.companies.filter((c) => c.org_type === 'marketer' || c.org_type === 'agency').length,
  };

  return (
    <div className="cw-surface">
      <div className="cw-filters">
        <div className="cw-search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={isAr ? 'ابحث بالشركة أو الحساب أو المشروع…' : 'Search company, handle or project…'} />
        </div>
        {([['all', isAr ? 'الكل' : 'All'], ['developer', isAr ? 'مطوّر' : 'Developers'], ['marketer', isAr ? 'مسوّق' : 'Marketers']] as const).map(([k, label]) => (
          <button key={k} className={`cw-chip ${type === k ? 'on' : ''}`} onClick={() => setType(k as TypeFilter)}>
            {label} <span className="cw-mono">{num(counts[k as TypeFilter])}</span>
          </button>
        ))}
        <select className="cw-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="active">{isAr ? 'الأنشط (٩٠ يومًا)' : 'Most active (90d)'}</option>
          <option value="posts">{isAr ? 'الأكثر منشورات' : 'Most posts'}</option>
          <option value="recent">{isAr ? 'الأحدث نشرًا' : 'Most recent post'}</option>
          <option value="name">{isAr ? 'الاسم' : 'Name'}</option>
        </select>
      </div>

      <div className="cw-count">
        {num(rows.length)} {isAr ? 'شركة' : 'companies'}
        {rows.length !== data.companies.length ? ` ${isAr ? 'من' : 'of'} ${num(data.companies.length)}` : ''}
      </div>

      <div className="cw-panel">
        <div className="cw-tblwrap">
          <table className="cw-table cw-cotable">
            <thead>
              <tr>
                <th>{isAr ? 'الشركة' : 'Company'}</th>
                <th>{isAr ? 'النوع' : 'Type'}</th>
                <th>{isAr ? 'القنوات' : 'Channels'}</th>
                <th className="cw-r">{isAr ? 'نشر ٩٠ يومًا' : 'Posts 90d'}</th>
                <th className="cw-r">{isAr ? 'أسبوعيًا' : 'Per week'}</th>
                <th>{isAr ? 'آخر نشر' : 'Last post'}</th>
                <th>{isAr ? 'الشكل' : 'Format'}</th>
                <th>{isAr ? 'الرسالة الغالبة' : 'Main message'}</th>
                <th className="cw-r">{isAr ? 'عروض' : 'Offers'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((co) => {
                const open = openId === co.id;
                const last = published(co.last_post, isAr);
                const tp = topPurpose(co);
                const tpMeta = tp ? PURPOSES.find((p) => p.key === tp.key) : null;
                return (
                  <Fragment key={co.id}>
                    <tr className="cw-click" onClick={() => setOpenId(open ? null : co.id)}>
                      <td dir="rtl">
                        <div className="cw-coname">{co.name ?? co.name_en ?? '—'}</div>
                        {co.name_en && co.name && <div className="cw-mutedmono" dir="ltr">{co.name_en}</div>}
                      </td>
                      <td><span className={`cw-typebadge ${co.org_type === 'developer' ? 'dev' : 'mkt'}`}>{typeLabel(co.org_type, isAr)}</span></td>
                      <td>
                        <span className="cw-plats">
                          {(co.account_list ?? []).map((a, i) => (
                            <span key={i} className={`cw-plat ${a.enabled ? '' : 'off'}`} title={`@${a.handle}${a.posts ? ` · ${num(a.posts)}` : ''}`}>
                              {PLATFORM_SHORT[a.platform ?? ''] ?? a.platform}
                            </span>
                          ))}
                          {(co.account_list ?? []).length === 0 && <span className="cw-muted">—</span>}
                        </span>
                      </td>
                      <td className="cw-r cw-mono">{co.posts_90d > 0 ? num(co.posts_90d) : <span className="cw-muted">—</span>}</td>
                      <td className="cw-r cw-mono">{co.posts_per_week != null ? co.posts_per_week : <span className="cw-muted">—</span>}</td>
                      <td><span className={`cw-tag ${last.tone}`}>{last.tone === 'ok' && <span className="cw-d" />}{last.label}</span></td>
                      <td style={{ minWidth: 110 }}>
                        <Bar parts={[
                          { n: co.formats?.video ?? 0, cls: 'f-video', title: isAr ? 'فيديو' : 'Video' },
                          { n: co.formats?.image ?? 0, cls: 'f-image', title: isAr ? 'صورة' : 'Image' },
                          { n: co.formats?.carousel ?? 0, cls: 'f-carousel', title: isAr ? 'ألبوم' : 'Carousel' },
                        ]} />
                      </td>
                      <td>
                        {tp && tpMeta
                          ? <span className={`cw-purp ${tpMeta.cls}`}>{isAr ? tpMeta.ar : tpMeta.en} <span className="cw-mono">{Math.round(tp.share * 100)}%</span></span>
                          : <span className="cw-muted">—</span>}
                      </td>
                      <td className="cw-r cw-mono">{co.offer_posts > 0 ? num(co.offer_posts) : <span className="cw-muted">—</span>}</td>
                    </tr>

                    {open && (
                      <tr className="cw-detrow">
                        <td colSpan={9}>
                          <div className="cw-cogrid">
                            <div className="cw-cocard">
                              <div className="cw-accthead">{isAr ? 'ماذا ينشرون' : 'What they publish'}</div>
                              <div className="cw-purpwrap">
                                {PURPOSES.map((p) => {
                                  const n = co.purposes?.[p.key] ?? 0;
                                  const total = PURPOSES.reduce((s, x) => s + (co.purposes?.[x.key] ?? 0), 0);
                                  if (n === 0) return null;
                                  return (
                                    <div className="cw-purprow" key={p.key}>
                                      <span className="cw-purplab">{isAr ? p.ar : p.en}</span>
                                      <span className="cw-purpbar"><span className={`cw-purpfill ${p.cls}`} style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></span>
                                      <span className="cw-mono cw-muted">{num(n)}</span>
                                    </div>
                                  );
                                })}
                                {PURPOSES.every((p) => (co.purposes?.[p.key] ?? 0) === 0) && (
                                  <div className="cw-muted">{isAr ? 'لم تُقرأ رسائل منشوراتهم بعد' : 'Their posts have not been read yet'}</div>
                                )}
                              </div>
                              {co.offer_text && (
                                <div className="cw-offerbox">
                                  <span className="cw-tag info">{isAr ? 'آخر عرض' : 'Latest offer'}</span>
                                  <span dir="rtl">{co.offer_text}</span>
                                  {co.offer_at && <span className="cw-mutedmono">{fmtDateTime(co.offer_at, isAr)}</span>}
                                </div>
                              )}
                            </div>

                            <div className="cw-cocard">
                              <div className="cw-accthead">{isAr ? 'عمّ يتحدثون' : 'What they talk about'}</div>
                              <div className="cw-kv">{isAr ? 'المشاريع' : 'Projects'}</div>
                              <div className="cw-chips">
                                {(co.top_projects ?? []).length === 0 && <span className="cw-muted">{isAr ? 'لا مشروع مرتبط بعد' : 'No project linked yet'}</span>}
                                {(co.top_projects ?? []).map((p, i) => (
                                  <span className="cw-softchip" key={i} dir="rtl"
                                    title={p.role === 'developer' ? (isAr ? 'مطوّر المشروع' : 'Developer of this project')
                                      : p.role === 'marketer' ? (isAr ? 'مسوّق المشروع' : 'Marketer of this project')
                                      : (isAr ? 'ينشر عنه وليس مسجَّلًا على المشروع' : 'Posts about it; not listed on the project')}>
                                    {p.name}{' '}
                                    {p.posts > 0
                                      ? <span className="cw-mono">{num(p.posts)}</span>
                                      : <span className="cw-muted">{isAr ? 'بلا منشورات' : 'no posts'}</span>}
                                  </span>
                                ))}
                              </div>
                              <div className="cw-kv" style={{ marginTop: 10 }}>{isAr ? 'الأحياء' : 'Districts'}</div>
                              <div className="cw-chips">
                                {(co.top_districts ?? []).length === 0 && <span className="cw-muted">—</span>}
                                {(co.top_districts ?? []).map((d, i) => (
                                  <span className="cw-softchip" key={i} dir="rtl">{d.name} <span className="cw-mono">{num(d.posts)}</span></span>
                                ))}
                              </div>
                            </div>

                            <div className="cw-cocard">
                              <div className="cw-accthead">{isAr ? 'الأداء والقنوات' : 'Performance & channels'}</div>
                              <div className="cw-statline">
                                <span>{isAr ? 'متوسط المشاهدات' : 'Avg views'}</span>
                                <span className="cw-mono">{co.avg_views ? num(co.avg_views) : '—'}</span>
                              </div>
                              <div className="cw-statline">
                                <span>{isAr ? 'متوسط الإعجابات' : 'Avg likes'}</span>
                                <span className="cw-mono">{co.avg_likes ? num(co.avg_likes) : '—'}</span>
                              </div>
                              <div className="cw-statline">
                                <span>{isAr ? 'منشورات ٣٠ يومًا' : 'Posts 30d'}</span>
                                <span className="cw-mono">{num(co.posts_30d)}</span>
                              </div>
                              <div className="cw-statline">
                                <span>{isAr ? 'إجمالي ما جمعناه' : 'Collected in total'}</span>
                                <span className="cw-mono">{num(co.posts)} {isAr ? 'منشور' : 'posts'} · {num(co.facts)} {isAr ? 'حقيقة' : 'facts'}</span>
                              </div>
                              {co.website && (
                                <div className="cw-statline">
                                  <span>{isAr ? 'الموقع' : 'Website'}</span>
                                  <a className="cw-link" href={co.website} target="_blank" rel="noreferrer" dir="ltr">{co.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}</a>
                                </div>
                              )}
                              <div className="cw-accthead" style={{ marginTop: 10 }}>{isAr ? 'الحسابات' : 'Accounts'}</div>
                              {(co.account_list ?? []).length === 0 && <div className="cw-muted">{isAr ? 'لا حسابات نشطة' : 'No active accounts'}</div>}
                              {(co.account_list ?? []).map((a, i) => <AccountLine a={a} isAr={isAr} key={i} />)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="cw-muted" style={{ padding: 18 }}>{isAr ? 'لا شركة تطابق البحث' : 'No company matches'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="cw-note">
        {isAr
          ? '«آخر نشر» تاريخ نشرهم هم، لا تاريخ سحبنا — والسحب يظهر داخل كل حساب. الرسالة والشكل والمشاريع والأحياء مقروءة من منشوراتهم، والمتابعون يظهرون «—» حيث لم تُلتقط بعد بدل صفر زائف.'
          : '“Last post” is when THEY published, not when we pulled — the pull time sits inside each account. Message, format, projects and districts are read from their own posts; followers show “—” where we have not captured them, never a fake zero.'}
      </p>
    </div>
  );
}

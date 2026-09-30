/** Projects — who is behind each project, and who is actually talking about it.
 *
 *  The Companies surface answers "what does this company publish?". This one
 *  turns it around: for every project in our portfolio, or that anybody has
 *  posted about, it shows the developer and marketers the project record names
 *  and every company posting about it. A company that posts about a project the
 *  record does NOT list it on is flagged — that is usually a marketer nobody
 *  has recorded yet.
 */
import { Fragment, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { fetchProjectRoster, type ProjectRoster, type ProjectRosterRow, type ProjectCompany } from '@/lib/competitorWatch/client';
import { useSurface, num, fmtDateTime, daysAgo } from './surfaceData';

type Scope = 'all' | 'ours' | 'unrecorded' | 'silent';
type SortKey = 'posts' | 'recent' | 'name';

function roleLabel(role: ProjectCompany['role'], isAr: boolean): string {
  if (role === 'developer') return isAr ? 'المطوّر' : 'Developer';
  if (role === 'marketer') return isAr ? 'مسوّق' : 'Marketer';
  return isAr ? 'غير مسجَّل على المشروع' : 'Not listed on the project';
}

function lastPost(iso: string | null, isAr: boolean): { label: string; tone: string } {
  const days = daysAgo(iso);
  if (days === null) return { label: '—', tone: 'mute' };
  if (days <= 0) return { label: isAr ? 'اليوم' : 'today', tone: 'ok' };
  if (days <= 30) return { label: isAr ? `قبل ${days} يومًا` : `${days}d ago`, tone: 'ok' };
  if (days <= 90) return { label: isAr ? `قبل ${Math.round(days / 30)} أشهر` : `${Math.round(days / 30)}mo ago`, tone: 'warn' };
  return { label: isAr ? `قبل ${Math.round(days / 30)} شهرًا` : `${Math.round(days / 30)}mo ago`, tone: 'bad' };
}

/** Companies posting about the project that its record does not name. */
const unrecorded = (p: ProjectRosterRow): ProjectCompany[] => (p.companies ?? []).filter((c) => c.role === null && c.posts > 0);

export default function ProjectsSurface({ isAr }: { isAr: boolean }) {
  const { data, loading, error } = useSurface<ProjectRoster>(fetchProjectRoster);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('ours');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('posts');

  const rows = useMemo(() => {
    const all = data?.projects ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = all.filter((p) => {
      if (scope === 'ours' && !p.ours) return false;
      if (scope === 'unrecorded' && unrecorded(p).length === 0) return false;
      if (scope === 'silent' && !(p.ours && p.posts === 0)) return false;
      if (!needle) return true;
      const hay = [p.name, p.developer, ...(p.marketers ?? []), ...(p.companies ?? []).flatMap((c) => [c.name, c.name_en])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return (a.name ?? '').localeCompare(b.name ?? '', isAr ? 'ar' : 'en');
      if (sort === 'recent') return (b.last_post ?? '').localeCompare(a.last_post ?? '');
      return b.posts - a.posts || (a.name ?? '').localeCompare(b.name ?? '', isAr ? 'ar' : 'en');
    });
  }, [data, scope, q, sort, isAr]);

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!data) return null;

  const counts: Record<Scope, number> = {
    all: data.projects.length,
    ours: data.projects.filter((p) => p.ours).length,
    unrecorded: data.projects.filter((p) => unrecorded(p).length > 0).length,
    silent: data.projects.filter((p) => p.ours && p.posts === 0).length,
  };
  const SCOPES: Array<[Scope, string, string]> = [
    ['ours', 'مشاريعنا', 'Our projects'],
    ['all', 'الكل', 'All'],
    ['unrecorded', 'مسوّق غير مسجَّل', 'Unrecorded marketer'],
    ['silent', 'بلا منشورات', 'No posts'],
  ];

  return (
    <div className="cw-surface">
      <div className="cw-filters">
        <div className="cw-search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={isAr ? 'ابحث بالمشروع أو المطوّر أو المسوّق…' : 'Search project, developer or marketer…'} />
        </div>
        {SCOPES.map(([k, ar, en]) => (
          <button key={k} className={`cw-chip ${scope === k ? 'on' : ''}`} onClick={() => setScope(k)}>
            {isAr ? ar : en} <span className="cw-mono">{num(counts[k])}</span>
          </button>
        ))}
        <select className="cw-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="posts">{isAr ? 'الأكثر منشورات' : 'Most posts'}</option>
          <option value="recent">{isAr ? 'الأحدث نشرًا' : 'Most recent post'}</option>
          <option value="name">{isAr ? 'الاسم' : 'Name'}</option>
        </select>
      </div>

      <div className="cw-count">
        {num(rows.length)} {isAr ? 'مشروع' : 'projects'}
        {rows.length !== data.projects.length ? ` ${isAr ? 'من' : 'of'} ${num(data.projects.length)}` : ''}
      </div>

      <div className="cw-panel">
        <div className="cw-tblwrap">
          <table className="cw-table cw-cotable">
            <thead>
              <tr>
                <th>{isAr ? 'المشروع' : 'Project'}</th>
                <th>{isAr ? 'المطوّر' : 'Developer'}</th>
                <th>{isAr ? 'المسوّقون' : 'Marketers'}</th>
                <th>{isAr ? 'من ينشر عنه' : 'Who posts about it'}</th>
                <th className="cw-r">{isAr ? 'المنشورات' : 'Posts'}</th>
                <th className="cw-r">{isAr ? 'نشر ٩٠ يومًا' : 'Posts 90d'}</th>
                <th>{isAr ? 'آخر نشر' : 'Last post'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7}><span className="cw-muted">{isAr ? 'لا مشاريع مطابقة' : 'No matching projects'}</span></td></tr>
              )}
              {rows.map((p) => {
                const open = openId === p.id;
                const last = lastPost(p.last_post, isAr);
                const posting = (p.companies ?? []).filter((c) => c.posts > 0);
                const extra = unrecorded(p);
                return (
                  <Fragment key={p.id}>
                    <tr className="cw-click" onClick={() => setOpenId(open ? null : p.id)}>
                      <td dir="rtl">
                        <div className="cw-coname">{p.name ?? '—'}</div>
                        {p.ours && <span className="cw-tag info">{isAr ? 'من مشاريعنا' : 'Ours'}</span>}
                      </td>
                      <td dir="rtl">{p.developer ?? <span className="cw-muted">—</span>}</td>
                      <td dir="rtl">
                        {(p.marketers ?? []).length === 0
                          ? <span className="cw-muted">—</span>
                          : <span className="cw-chips">{p.marketers.map((m, i) => <span className="cw-softchip" key={i}>{m}</span>)}</span>}
                      </td>
                      <td dir="rtl">
                        {posting.length === 0
                          ? <span className="cw-muted">{isAr ? 'لا أحد' : 'Nobody'}</span>
                          : (
                            <span className="cw-chips">
                              {posting.map((c) => (
                                <span className="cw-softchip" key={c.org}>{c.name ?? c.name_en ?? '—'} <span className="cw-mono">{num(c.posts)}</span></span>
                              ))}
                            </span>
                          )}
                        {extra.length > 0 && <span className="cw-tag warn" style={{ marginInlineStart: 6 }}>{isAr ? 'مسوّق غير مسجَّل' : 'Unrecorded marketer'}</span>}
                      </td>
                      <td className="cw-r cw-mono">{p.posts > 0 ? num(p.posts) : <span className="cw-muted">—</span>}</td>
                      <td className="cw-r cw-mono">{p.posts_90d > 0 ? num(p.posts_90d) : <span className="cw-muted">—</span>}</td>
                      <td><span className={`cw-tag ${last.tone}`}>{last.tone === 'ok' && <span className="cw-d" />}{last.label}</span></td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7}>
                          <div className="cw-cocard">
                            <div className="cw-accthead">{isAr ? 'الشركات المرتبطة بالمشروع' : 'Companies on this project'}</div>
                            {(p.companies ?? []).length === 0 && <span className="cw-muted">{isAr ? 'لا شركة مرتبطة ولا منشورات' : 'No linked company and no posts'}</span>}
                            {(p.companies ?? []).map((c) => (
                              <div className="cw-acctrow" key={c.org}>
                                <span dir="rtl" className="cw-coname">{c.name ?? c.name_en ?? '—'}</span>
                                <span className={`cw-tag ${c.role === null ? 'warn' : 'mute'}`}>{roleLabel(c.role, isAr)}</span>
                                <span className="cw-mutedmono">
                                  {c.posts > 0
                                    ? `${num(c.posts)} ${isAr ? 'منشور' : 'posts'}${c.last_post ? ` · ${isAr ? 'آخرها ' : 'last '}${fmtDateTime(c.last_post, isAr)}` : ''}`
                                    : (isAr ? 'لم ينشر عنه' : 'has not posted about it')}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cw-count">
        {isAr
          ? 'المطوّر والمسوّقون من سجل المشروع نفسه. «من ينشر عنه» من منشوراتهم التي قرأناها. «مسوّق غير مسجَّل» يعني أن شركة تنشر عن المشروع وليست مذكورة في سجله.'
          : 'Developer and marketers come from the project record itself. “Who posts about it” comes from their own posts that we have read. “Unrecorded marketer” means a company posts about the project but is not named on its record.'}
      </div>
    </div>
  );
}

/** Companies — every competitor we watch, their accounts, and how much we've
 *  collected on each. Click a row to open its accounts. */
import { Fragment, useState } from 'react';
import { fetchCompanyRoster, type CompanyRoster, type CompanyRow } from '@/lib/competitorWatch/client';
import { useSurface, num, fmtDateTime, daysAgo } from './surfaceData';

function typeLabel(t: string | null, isAr: boolean): string {
  if (t === 'developer') return isAr ? 'مطوّر' : 'Developer';
  if (t === 'marketer' || t === 'agency') return isAr ? 'مسوّق' : 'Marketer';
  return t ?? '—';
}

function activity(iso: string | null, isAr: boolean): { label: string; tone: string } {
  const days = daysAgo(iso);
  if (days === null) return { label: '—', tone: 'mute' };
  if (days <= 0) return { label: isAr ? 'اليوم' : 'today', tone: 'ok' };
  if (days === 1) return { label: isAr ? 'أمس' : 'yesterday', tone: 'ok' };
  if (days <= 3) return { label: isAr ? `قبل ${days} أيام` : `${days} days ago`, tone: 'mute' };
  return { label: isAr ? `قبل ${days} يومًا` : `${days} days ago`, tone: 'warn' };
}

export default function CompaniesSurface({ isAr }: { isAr: boolean }) {
  const { data, loading, error } = useSurface<CompanyRoster>(fetchCompanyRoster);
  const [openId, setOpenId] = useState<string | null>(null);

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!data) return null;

  return (
    <div className="cw-surface">
      <div className="cw-count">{num(data.companies.length)} {isAr ? 'شركة مرصودة' : 'companies watched'}</div>
      <div className="cw-panel">
        <div className="cw-tblwrap">
          <table className="cw-table">
            <thead>
              <tr>
                <th>{isAr ? 'الشركة' : 'Company'}</th>
                <th>{isAr ? 'النوع' : 'Type'}</th>
                <th className="cw-r">{isAr ? 'حسابات' : 'Accounts'}</th>
                <th className="cw-r">{isAr ? 'منشورات' : 'Posts'}</th>
                <th className="cw-r">{isAr ? 'متابعون' : 'Followers'}</th>
                <th className="cw-r">{isAr ? 'حقائق' : 'Facts'}</th>
                <th>{isAr ? 'آخر نشاط' : 'Last activity'}</th>
              </tr>
            </thead>
            <tbody>
              {data.companies.map((co: CompanyRow) => {
                const act = activity(co.last_pull, isAr);
                const open = openId === co.id;
                return (
                  <Fragment key={co.id}>
                    <tr className="cw-click" onClick={() => setOpenId(open ? null : co.id)}>
                      <td dir="rtl">{co.name ?? '—'}</td>
                      <td><span className={`cw-typebadge ${co.org_type === 'developer' ? 'dev' : 'mkt'}`}>{typeLabel(co.org_type, isAr)}</span></td>
                      <td className="cw-r cw-mono">{num(co.accounts)}</td>
                      <td className="cw-r cw-mono">{num(co.posts)}</td>
                      <td className="cw-r cw-mono">{co.followers > 0 ? num(co.followers) : '—'}</td>
                      <td className="cw-r cw-mono">{num(co.facts)}</td>
                      <td><span className={`cw-tag ${act.tone}`}>{act.tone === 'ok' && <span className="cw-d" />}{act.label}</span></td>
                    </tr>
                    {open && (
                      <tr className="cw-detrow">
                        <td colSpan={7}>
                          <div className="cw-accts">
                            <div className="cw-accthead">{isAr ? 'الحسابات والبيانات المجمّعة' : 'Accounts & collected data'}</div>
                            {co.account_list.length === 0 && <div className="cw-muted">{isAr ? 'لا حسابات نشطة' : 'No active accounts'}</div>}
                            {co.account_list.map((a, i) => (
                              <div className="cw-acctrow" key={i}>
                                <span>{a.platform ? `${a.platform} · ` : ''}<span dir="ltr">@{a.handle}</span>{!a.enabled && <span className="cw-tag mute" style={{ marginInlineStart: 8 }}>{isAr ? 'موقوف' : 'off'}</span>}</span>
                                <span className="cw-mono cw-muted">
                                  {num(a.posts ?? 0)} {isAr ? 'منشور' : 'posts'}
                                  {a.followers ? ` · ${num(a.followers)} ${isAr ? 'متابع' : 'followers'}` : ''}
                                  {a.last_pull ? ` · ${isAr ? 'سُحب ' : 'pulled '}${fmtDateTime(a.last_pull, isAr)}` : ''}
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
      <p className="cw-note">
        {isAr
          ? 'المتابعون يظهرون «—» لأغلب الشركات لأن اللقطة لم تُلتقط مرتين بعد — يُعرض شرطة بدل صفر زائف.'
          : 'Followers show “—” for most companies because that snapshot hasn\'t been captured twice yet — a dash, never a fake zero.'}
      </p>
    </div>
  );
}

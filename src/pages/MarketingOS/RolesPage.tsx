/**
 * Roles — design screen 37.
 *
 * Workflow steps point at ROLES, never people. This is the one place the
 * role→person mapping lives, so replacing whoever fills a role is a single
 * change here rather than an edit to every workflow.
 *
 * Until a grant exists, `wassell_mos_role` falls back to 'viewer' — so a fresh
 * install is read-only for everyone except app admins. That is deliberate, and
 * this screen is what ends it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  fetchBootstrap,
  fetchRoles,
  grantRole,
  MosGrant,
  MosRole,
  MosUser,
  ROLE_LABELS,
} from '@/lib/marketingOS/client';

/** The roles a person can be given. `administrator` comes from app admin, not here. */
const ASSIGNABLE: MosRole[] = [
  'marketing_manager',
  'ops_supervisor',
  'writer',
  'montage',
  'ceo',
  'viewer',
];

export default function RolesPage() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  const [users, setUsers] = useState<MosUser[]>([]);
  const [grants, setGrants] = useState<MosGrant[]>([]);
  const [myRole, setMyRole] = useState<MosRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [roles, boot] = await Promise.all([fetchRoles(), fetchBootstrap()]);
      setUsers(roles.users);
      setGrants(roles.grants);
      setMyRole(boot.role);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = myRole === 'administrator' || myRole === 'marketing_manager';
  const roleOf = (userId: string): MosRole | null =>
    grants.find((g) => g.user_id === userId)?.mos_role ?? null;

  const set = async (userId: string, role: MosRole | null) => {
    setBusy(userId);
    try {
      const res = await grantRole(userId, role);
      setGrants(res.grants);
      addToast(isAr ? 'تم تحديث الدور' : 'Role updated', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const BackIcon = isAr ? ArrowRight : ArrowLeft;
  const granted = grants.length;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      <button
        type="button"
        onClick={() => navigate('/marketing-management')}
        className="flex items-center gap-1.5 text-xs text-charcoal/50 hover:text-copper"
      >
        <BackIcon className="h-3.5 w-3.5" />
        {isAr ? 'المحتوى' : 'Content'}
      </button>

      <header>
        <h1 className="text-2xl font-bold">{isAr ? 'الأدوار' : 'Roles'}</h1>
        <p className="mt-1 text-sm text-charcoal/60">
          {isAr
            ? 'خطوات مسار العمل تشير إلى أدوار لا إلى أشخاص. هنا يُحدَّد من يشغل كل دور.'
            : 'Workflow steps point at roles, not people. This is where you say who fills each one.'}
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {!loading && granted === 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-charcoal/80">
          {isAr
            ? 'لم يُمنح أي دور بعد، فكل من ليس مدير نظام يرى النظام للقراءة فقط. امنح دورًا واحدًا على الأقل لكل وظيفة قبل بدء العمل.'
            : 'No role has been granted yet, so everyone who is not an app admin sees this module read-only. Grant at least one person per function before the team starts.'}
        </div>
      )}

      {!canManage && !loading && (
        <div className="rounded-xl border border-sand bg-cream/60 px-4 py-3 text-sm text-charcoal/70">
          {isAr
            ? 'دورك لا يسمح بتعديل الأدوار — للاطلاع فقط.'
            : 'Your role cannot change grants — read-only.'}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-sand bg-white">
        {loading ? (
          <p className="p-10 text-center text-sm text-charcoal/50">
            {isAr ? 'جارٍ التحميل…' : 'Loading…'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sand bg-cream/50 text-xs text-charcoal/60">
                <th className="p-3 text-start font-semibold">{isAr ? 'الشخص' : 'Person'}</th>
                <th className="p-3 text-start font-semibold">{isAr ? 'الدور في التسويق' : 'Marketing role'}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const current = roleOf(u.id);
                return (
                  <tr key={u.id} className="border-b border-sand/50 last:border-0">
                    <td className="p-3">
                      <div className="font-semibold">
                        {(isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar ?? '—'}
                      </div>
                      <div className="text-xs text-charcoal/50" dir="ltr">{u.email ?? ''}</div>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1.5">
                        {ASSIGNABLE.map((r) => (
                          <button
                            key={r}
                            type="button"
                            disabled={!canManage || busy === u.id}
                            onClick={() => void set(u.id, current === r ? null : r)}
                            className={`rounded-full border px-2.5 py-1 text-xs ${
                              current === r
                                ? 'border-copper bg-copper font-semibold text-white'
                                : 'border-sand bg-white text-charcoal/70 hover:border-copper/50'
                            } ${!canManage ? 'opacity-60' : ''}`}
                          >
                            {isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-lg border border-sand bg-cream/50 px-4 py-3 text-xs leading-relaxed text-charcoal/70">
        {isAr
          ? 'الاعتماد مقسوم: مدير التسويق يعتمد الإبداع، ومشرف العمليات يعتمد الإجراءات، والرئيس التنفيذي يوقّع الميزانية ولا يعتمد محتوى. هذا التقسيم هو ما يمنع شخصًا واحدًا من أن يصبح طابور الجميع.'
          : 'Approval is split: the Marketing Manager approves creative, the Operations Supervisor approves process, and the CEO signs off budget and approves no content. That split is what stops one person becoming everyone else’s queue.'}
      </div>
    </div>
  );
}

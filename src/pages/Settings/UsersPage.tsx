import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { inviteUser, isAuthAvailable } from '@/lib/auth';
import { Users as UsersIcon, Plus, Pencil, Trash2, Shield, Mail, Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import UserRoleFields from './components/UserRoleFields';
import BackToSettings from './components/BackToSettings';
import type { User, UserRoleAssignment, StoreMutationReason } from '@/types';

function reasonToKey(reason: StoreMutationReason): string {
  switch (reason) {
    case 'self_delete': return 'access.cannot_delete_self';
    case 'last_admin': return 'access.cannot_delete_last_admin';
    case 'missing_profile': return 'access.profile_missing';
    case 'is_system': return 'access.cannot_delete_system_profile';
    case 'has_users': return 'access.cannot_delete_has_users';
  }
}

export default function UsersPage() {
  const { t } = useTranslation();
  const { users, profiles, roles, language, currentUserId, saveUser, deleteUser, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [profileId, setProfileId] = useState('');
  const [roleAssignments, setRoleAssignments] = useState<UserRoleAssignment[]>([]);

  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [deactivatingUser, setDeactivatingUser] = useState<User | null>(null);
  const [resendingFor, setResendingFor] = useState<string | null>(null);
  // Default the invite checkbox to ON only when auth is actually configured —
  // otherwise there's no email backend and sending would just fail.
  const [sendInvite, setSendInvite] = useState(isAuthAvailable());

  const openNew = () => {
    setEditing(null);
    setName('');
    setEmail('');
    setProfileId(profiles[0]?.id ?? '');
    setRoleAssignments([]);
    setSendInvite(isAuthAvailable());
    setShowModal(true);
  };

  const openEdit = (user: User) => {
    setEditing(user);
    setName(isAr ? user.name_ar : user.name_en);
    setEmail(user.email);
    setProfileId(user.profile_id);
    // Deep-copy so local edits don't mutate store state
    setRoleAssignments(user.role_assignments.map((ra) => ({ role_id: ra.role_id, field_values: { ...ra.field_values } })));
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!name.trim() || !email.trim() || !profileId) return;
    // User display names are proper nouns ("Mohamed", "محمد"). We do NOT
    // auto-translate them — translating "Mohamed" to "محمد" or vice-versa
    // is a transliteration choice the user owns. New users get the typed
    // name in both slots; the user can edit either side later from the
    // user-edit form.
    const labels = editing
      ? { name_ar: isAr ? name.trim() : editing.name_ar, name_en: isAr ? editing.name_en : name.trim() }
      : { name_ar: name.trim(), name_en: name.trim() };

    const trimmedEmail = email.trim();
    const user: User = {
      id: editing?.id ?? uuid(),
      ...labels,
      email: trimmedEmail,
      profile_id: profileId,
      role_assignments: roleAssignments,
      is_active: editing?.is_active ?? true,
      created_at: editing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const wasNew = editing === null;
    const result = saveUser(user);
    if (!result.ok) {
      addToast(t(reasonToKey(result.reason)), 'error');
      return;
    }
    setShowModal(false);

    // For newly-created users, optionally send a magic-link invite so they can
    // sign in without the admin touching the Supabase dashboard. Errors are
    // surfaced inline and do NOT roll back the user row — the row is still
    // valid and the admin can click "Resend invite" to retry.
    if (wasNew && sendInvite && isAuthAvailable()) {
      const { error } = await inviteUser(trimmedEmail);
      if (error) {
        addToast(
          isAr ? `تم إنشاء المستخدم، لكن فشل إرسال الدعوة: ${error}` : `User created, but failed to send invite: ${error}`,
          'error',
        );
      } else {
        addToast(
          isAr ? `تم إنشاء المستخدم وإرسال الدعوة إلى ${trimmedEmail}` : `User created and invite sent to ${trimmedEmail}`,
          'success',
        );
      }
    } else {
      addToast(t('toast.saved'), 'success');
    }
  };

  const handleResendInvite = async (user: User) => {
    if (!isAuthAvailable()) {
      addToast(isAr ? 'المصادقة غير مُهيأة في هذه البيئة' : 'Auth is not configured in this environment', 'error');
      return;
    }
    setResendingFor(user.id);
    const { error } = await inviteUser(user.email);
    setResendingFor(null);
    if (error) {
      addToast(isAr ? `فشل إرسال الدعوة: ${error}` : `Failed to send invite: ${error}`, 'error');
    } else {
      addToast(isAr ? `تم إرسال الدعوة إلى ${user.email}` : `Invite sent to ${user.email}`, 'success');
    }
  };

  const toggleRole = (roleId: string) => {
    setRoleAssignments((prev) => {
      const existing = prev.find((ra) => ra.role_id === roleId);
      if (existing) return prev.filter((ra) => ra.role_id !== roleId);
      return [...prev, { role_id: roleId, field_values: {} }];
    });
  };

  const updateRoleFields = (roleId: string, values: Record<string, unknown>) => {
    setRoleAssignments((prev) => prev.map((ra) => (ra.role_id === roleId ? { ...ra, field_values: values } : ra)));
  };

  const onToggleActiveClick = (user: User) => {
    // Activating is safe — fire immediately. Deactivating always confirms.
    if (!user.is_active) {
      const result = saveUser({ ...user, is_active: true, updated_at: new Date().toISOString() });
      if (!result.ok) addToast(t(reasonToKey(result.reason)), 'error');
      return;
    }
    setDeactivatingUser(user);
  };

  const confirmDeactivate = () => {
    if (!deactivatingUser) return;
    const result = saveUser({ ...deactivatingUser, is_active: false, updated_at: new Date().toISOString() });
    if (!result.ok) {
      addToast(t(reasonToKey(result.reason)), 'error');
    }
    setDeactivatingUser(null);
  };

  const confirmDelete = () => {
    if (!deletingUser) return;
    const result = deleteUser(deletingUser.id);
    if (!result.ok) {
      addToast(t(reasonToKey(result.reason)), 'error');
    } else {
      addToast(t('toast.deleted'), 'success');
    }
    setDeletingUser(null);
  };

  const canCreate = profiles.length > 0;

  return (
    <div className="max-w-4xl">
      <BackToSettings />
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center">
            <UsersIcon size={24} className="text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'المستخدمون' : 'Users'}</h1>
            <p className="text-sm text-charcoal/40">{isAr ? 'إدارة المستخدمين' : 'Manage users'}</p>
          </div>
        </div>
        <Button onClick={openNew} disabled={!canCreate} title={!canCreate ? (isAr ? 'أنشئ ملفاً شخصياً أولاً' : 'Create a profile first') : undefined}>
          <Plus size={16} />
          {isAr ? 'مستخدم جديد' : 'New User'}
        </Button>
      </div>

      <div className="grid gap-4">
        {users.map((user) => {
          const profile = profiles.find((p) => p.id === user.profile_id);
          const isSelf = user.id === currentUserId;
          return (
            <div key={user.id} className="card p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-11 h-11 rounded-full bg-copper/10 flex items-center justify-center text-base font-bold text-copper">
                  {(isAr ? user.name_ar : user.name_en).charAt(0)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-charcoal">{isAr ? user.name_ar : user.name_en}</h3>
                    {isSelf && <span className="text-xs text-copper font-bold">({isAr ? 'أنت' : 'you'})</span>}
                    {!user.is_active && <span className="text-xs text-red-400 font-bold">{isAr ? 'غير نشط' : 'Inactive'}</span>}
                  </div>
                  <div className="text-xs text-charcoal/40">{user.email}</div>
                  <div className="flex items-center gap-2 mt-1.5">
                    {profile && (
                      <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full font-bold">
                        <Shield size={10} />
                        {isAr ? profile.label_ar : profile.label_en}
                        {profile.is_admin && <span className="text-[10px] opacity-60">· {t('common.admin_badge')}</span>}
                      </span>
                    )}
                    {user.role_assignments.map((ra) => {
                      const role = roles.find((r) => r.id === ra.role_id);
                      return role ? <Badge key={ra.role_id} label={isAr ? role.label_ar : role.label_en} color="#14B8A6" /> : null;
                    })}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="relative inline-flex items-center cursor-pointer" title={user.is_active ? (isAr ? 'إلغاء التفعيل' : 'Deactivate') : (isAr ? 'تفعيل' : 'Activate')}>
                  <input type="checkbox" checked={user.is_active} onChange={() => onToggleActiveClick(user)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-sand/50 rounded-full peer peer-checked:bg-copper peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-4 after:w-4 after:transition-all" />
                </label>
                {isAuthAvailable() && (
                  <button
                    onClick={() => void handleResendInvite(user)}
                    disabled={resendingFor === user.id}
                    title={isAr ? 'إعادة إرسال الدعوة' : 'Resend invite'}
                    className="p-2 rounded-lg hover:bg-cream text-charcoal/30 hover:text-charcoal disabled:opacity-40"
                  >
                    {resendingFor === user.id ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                  </button>
                )}
                <button onClick={() => openEdit(user)} className="p-2 rounded-lg hover:bg-cream text-charcoal/30 hover:text-charcoal"><Pencil size={16} /></button>
                <button
                  onClick={() => setDeletingUser(user)}
                  disabled={isSelf}
                  title={isSelf ? t('access.cannot_delete_self') : undefined}
                  className="p-2 rounded-lg hover:bg-red-50 text-charcoal/30 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-charcoal/30 disabled:cursor-not-allowed"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          );
        })}
        {users.length === 0 && (
          <div className="text-center py-16 text-charcoal/30">
            <UsersIcon size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-bold">{isAr ? 'لا يوجد مستخدمون' : 'No users yet'}</p>
          </div>
        )}
      </div>

      {/* Create/edit user modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? (isAr ? 'تعديل المستخدم' : 'Edit User') : (isAr ? 'مستخدم جديد' : 'New User')}
        maxWidth="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowModal(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void handleSave()} disabled={!name.trim() || !email.trim() || !profileId}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="space-y-5">
          <Input
            label={isAr ? 'الاسم' : 'Name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            dir={isAr ? 'rtl' : 'ltr'}
          />
          <Input
            label={isAr ? 'البريد الإلكتروني' : 'Email'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            type="email"
            dir="ltr"
          />
          {/* Invite toggle — only meaningful for new users and only when auth
              is actually configured. Supabase's OTP call needs a live backend. */}
          {!editing && isAuthAvailable() && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sendInvite}
                onChange={(e) => setSendInvite(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-sand text-copper focus:ring-copper/30"
              />
              <span className="text-sm text-charcoal">
                <span className="font-bold block">{isAr ? 'إرسال دعوة للبريد الإلكتروني' : 'Send invite email'}</span>
                <span className="text-xs text-charcoal/50 block">
                  {isAr
                    ? 'سيتلقى المستخدم رابط تسجيل دخول فوري.'
                    : 'The user will receive a one-click sign-in link.'}
                </span>
              </span>
            </label>
          )}
          <div>
            <label className="block text-sm font-bold text-charcoal mb-1">
              {isAr ? 'الملف الشخصي' : 'Profile'} <span className="text-red-500">*</span>
            </label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="form-input text-sm" required>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {isAr ? p.label_ar : p.label_en}{p.is_admin ? ` · ${t('common.admin_badge')}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Roles — checkboxes with inline field editors */}
          <div>
            <label className="block text-sm font-bold text-charcoal mb-2">{isAr ? 'الأدوار' : 'Roles'}</label>
            <div className="space-y-2">
              {roles.map((role) => {
                const assignment = roleAssignments.find((ra) => ra.role_id === role.id);
                const checked = !!assignment;
                const fieldCount = role.schema.sections.reduce((acc, s) => acc + s.fields.length, 0);
                return (
                  <div key={role.id} className="rounded-xl border border-sand/30">
                    <label className="flex items-center gap-3 cursor-pointer py-2 px-3 rounded-xl hover:bg-cream/50">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRole(role.id)}
                        className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                      />
                      <span className="text-sm font-bold text-charcoal">{isAr ? role.label_ar : role.label_en}</span>
                      <span className="text-xs text-charcoal/30">{fieldCount} {isAr ? 'حقل' : 'fields'}</span>
                    </label>
                    {checked && assignment && fieldCount > 0 && (
                      <div className="px-4 pb-4 pt-1 border-t border-sand/20">
                        <UserRoleFields
                          role={role}
                          assignment={assignment}
                          onChange={(values) => updateRoleFields(role.id, values)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {roles.length === 0 && (
                <p className="text-sm text-charcoal/30">{isAr ? 'لا توجد أدوار بعد' : 'No roles yet'}</p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete user confirmation */}
      <Modal
        open={!!deletingUser}
        onClose={() => setDeletingUser(null)}
        title={isAr ? 'حذف مستخدم' : 'Delete User'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletingUser(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={confirmDelete}>{t('common.delete')}</Button>
          </>
        }
      >
        {deletingUser && (
          <p className="text-sm text-charcoal">
            {t('users.confirm_delete', { name: isAr ? deletingUser.name_ar : deletingUser.name_en })}
          </p>
        )}
      </Modal>

      {/* Deactivate confirmation */}
      <Modal
        open={!!deactivatingUser}
        onClose={() => setDeactivatingUser(null)}
        title={isAr ? 'إلغاء التفعيل' : 'Deactivate User'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeactivatingUser(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={confirmDeactivate}>{t('common.confirm')}</Button>
          </>
        }
      >
        {deactivatingUser && (
          <p className="text-sm text-charcoal">
            {t('users.confirm_deactivate', { name: isAr ? deactivatingUser.name_ar : deactivatingUser.name_en })}
          </p>
        )}
      </Modal>
    </div>
  );
}

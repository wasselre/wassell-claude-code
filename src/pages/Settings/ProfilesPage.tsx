import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { bilingualFromInput } from '@/lib/autoTranslate';
import { Shield, Plus, Pencil, Trash2, Users, ArrowRight, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import PermissionMatrix from './components/PermissionMatrix';
import type { Profile, ProfileModelPermissions, StoreMutationReason } from '@/types';

function reasonToKey(reason: StoreMutationReason): string {
  switch (reason) {
    case 'is_system': return 'access.cannot_delete_system_profile';
    case 'has_users': return 'access.cannot_delete_has_users';
    case 'self_delete': return 'access.cannot_delete_self';
    case 'last_admin': return 'access.cannot_delete_last_admin';
    case 'missing_profile': return 'access.profile_missing';
  }
}

export default function ProfilesPage() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const { profiles, users, language, saveProfile } = useAppStore();
  const isAr = language === 'ar';

  const editingProfile = profileId ? profiles.find((p) => p.id === profileId) : null;

  if (profileId) {
    return editingProfile ? (
      <ProfileEditor
        profile={editingProfile}
        onBack={() => navigate('/settings/profiles')}
      />
    ) : (
      <div className="text-center py-20 text-charcoal/30">404</div>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center">
            <Shield size={24} className="text-amber-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'الصلاحيات' : 'Profiles'}</h1>
            <p className="text-sm text-charcoal/40">{isAr ? 'إدارة صلاحيات الوصول' : 'Manage access permissions'}</p>
          </div>
        </div>
        <Button onClick={() => {
          const id = uuid();
          const labels = bilingualFromInput(isAr ? 'ملف جديد' : 'New Profile', language);
          saveProfile({
            id,
            label_ar: labels.label_ar,
            label_en: labels.label_en,
            is_system: false,
            is_admin: false,
            model_permissions: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          navigate(`/settings/profiles/${id}`);
        }}>
          <Plus size={16} />
          {isAr ? 'ملف جديد' : 'New Profile'}
        </Button>
      </div>

      <div className="grid gap-4">
        {profiles.map((profile) => {
          const userCount = users.filter((u) => u.profile_id === profile.id).length;
          return (
            <button
              key={profile.id}
              onClick={() => navigate(`/settings/profiles/${profile.id}`)}
              className="card p-5 flex items-center justify-between text-start w-full hover:border-copper/30 transition-colors"
            >
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-charcoal">{isAr ? profile.label_ar : profile.label_en}</h3>
                  {profile.is_system && (
                    <span className="text-[10px] font-bold text-charcoal/50 bg-charcoal/5 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                      <Lock size={9} />
                      {isAr ? 'نظام' : 'System'}
                    </span>
                  )}
                  {profile.is_admin && (
                    <span className="text-[10px] font-bold text-copper bg-copper/10 px-1.5 py-0.5 rounded-full">
                      {isAr ? 'مدير' : 'Admin'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-1 text-xs text-charcoal/40">
                  <Users size={12} />
                  {userCount} {isAr ? 'مستخدم' : 'user(s)'}
                </div>
              </div>
              <Pencil size={16} className="text-charcoal/20" />
            </button>
          );
        })}
        {profiles.length === 0 && (
          <div className="text-center py-16 text-charcoal/30">
            <Shield size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-bold">{isAr ? 'لا توجد ملفات' : 'No profiles yet'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Full-page profile editor */
function ProfileEditor({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const { t } = useTranslation();
  const { language, users, saveProfile, deleteProfile, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [name, setName] = useState(isAr ? profile.label_ar : profile.label_en);
  const [perms, setPerms] = useState<ProfileModelPermissions[]>([...profile.model_permissions]);
  const [hiddenViewIds, setHiddenViewIds] = useState<string[]>([...(profile.hidden_view_ids ?? [])]);
  const [hiddenButtonIds, setHiddenButtonIds] = useState<string[]>([...(profile.hidden_button_ids ?? [])]);
  const [showDelete, setShowDelete] = useState(false);

  const userCount = users.filter((u) => u.profile_id === profile.id).length;
  const blockedByUsers = userCount > 0;

  const handleSave = () => {
    const labels = { label_ar: isAr ? name : profile.label_ar, label_en: isAr ? profile.label_en : name };
    saveProfile({
      ...profile,
      ...labels,
      model_permissions: perms,
      // Persist deny-lists only when non-empty so unaffected profiles keep
      // a clean shape (matches the field_permissions / scope conventions).
      hidden_view_ids: hiddenViewIds.length > 0 ? hiddenViewIds : undefined,
      hidden_button_ids: hiddenButtonIds.length > 0 ? hiddenButtonIds : undefined,
      updated_at: new Date().toISOString(),
    });
    addToast(t('toast.saved'), 'success');
  };

  const handleDelete = () => {
    const result = deleteProfile(profile.id);
    if (!result.ok) {
      const key = reasonToKey(result.reason);
      addToast(t(key, { count: userCount }), 'error');
      setShowDelete(false);
      return;
    }
    addToast(t('toast.deleted'), 'success');
    setShowDelete(false);
    onBack();
  };

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal">
            <ArrowRight size={20} className="rtl:rotate-0 ltr:rotate-180" />
          </button>
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <Shield size={20} className="text-amber-600" />
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-xl font-bold border-0 bg-transparent p-0 focus:ring-0 w-64"
            dir={isAr ? 'rtl' : 'ltr'}
          />
          {profile.is_system && (
            <span className="text-xs font-bold text-charcoal/60 bg-charcoal/5 px-2 py-1 rounded-full flex items-center gap-1">
              <Lock size={11} />
              {t('common.system_badge')}
            </span>
          )}
          {profile.is_admin && (
            <span className="text-xs font-bold text-copper bg-copper/10 px-2 py-1 rounded-full">
              {t('common.admin_badge')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!profile.is_system && (
            <Button variant="danger" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} />
              {t('common.delete')}
            </Button>
          )}
          <Button onClick={handleSave}>
            {t('common.save')}
          </Button>
        </div>
      </div>

      {/* Permission Matrix */}
      <div className="card p-6">
        <h2 className="font-bold text-chocolate mb-4">{isAr ? 'صلاحيات النماذج' : 'Model Permissions'}</h2>
        <PermissionMatrix
          modelPermissions={perms}
          onChange={setPerms}
          hiddenViewIds={hiddenViewIds}
          onHiddenViewIdsChange={setHiddenViewIds}
          hiddenButtonIds={hiddenButtonIds}
          onHiddenButtonIdsChange={setHiddenButtonIds}
        />
      </div>

      {/* Delete confirmation */}
      <Modal
        open={showDelete}
        onClose={() => setShowDelete(false)}
        title={t('common.delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={blockedByUsers}
              title={blockedByUsers ? t('access.cannot_delete_has_users', { count: userCount }) : undefined}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {blockedByUsers ? (
          <p className="text-sm text-red-600">
            {t('profiles.has_users_body', { count: userCount })}
          </p>
        ) : (
          <p className="text-sm text-charcoal">
            {t('profiles.confirm_delete', { name: isAr ? profile.label_ar : profile.label_en })}
          </p>
        )}
      </Modal>
    </div>
  );
}

import { useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { MessageCircle, Globe, Link2, UserCheck, Ban, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type {
  Profile,
  ProfileModelPermissions,
  ScopeRule,
  ModelPermission,
  AppModel,
  ModelField,
} from '@/types';
import BackToSettings from './components/BackToSettings';

/**
 * Dedicated admin UI for WhatsApp (chats) visibility.
 *
 * The generic per-model permission matrix CAN technically express these scopes,
 * but building "only chats linked to a client I own" by hand — pick the mirrored
 * field, the operator, the current-user source — is fiddly and easy to get wrong.
 * This page collapses the whole thing into ONE choice per profile, and writes the
 * exact same `profiles.model_permissions[chats].view_scope` the matrix would.
 *
 * The four levels map to the chats view-scope (kept in sync with the DB triggers
 * from 2026-08-14_chat_client_owner_mirror.sql):
 *   full        → no scope (see every conversation)
 *   client_only → client_link is_not_empty (hide advertisers / contacts / unknown)
 *   own         → client_owner equals current_user (only my own clients' chats)
 *   none        → remove the chats model entry (no WhatsApp access at all)
 *
 * Message bodies follow automatically — `chat_messages` RLS defers to the chats
 * view-scope class, so restricting the list restricts the thread + live feed too.
 */

type Level = 'full' | 'client_only' | 'own' | 'none';

// The working set a WhatsApp-enabled profile needs (view to see, plus the
// actions the chat UI performs — start chat, link client, change status…).
const FULL_CHAT_PERMS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];

function findField(model: AppModel | undefined, slug: string): ModelField | undefined {
  return model?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === slug);
}

export default function WhatsAppPermissionsPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const profiles = useAppStore((s) => s.profiles);
  const users = useAppStore((s) => s.users);
  const saveProfile = useAppStore((s) => s.saveProfile);
  const addToast = useAppStore((s) => s.addToast);

  const chatsModel = useMemo(() => models.find((m) => m.name === 'chats'), [models]);
  const ownerField = useMemo(() => findField(chatsModel, 'client_owner'), [chatsModel]);
  const clientLinkField = useMemo(() => findField(chatsModel, 'client_link'), [chatsModel]);

  const activeUserCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const u of users) {
      if (u.is_active === false) continue;
      if (!u.profile_id) continue;
      counts.set(u.profile_id, (counts.get(u.profile_id) ?? 0) + 1);
    }
    return counts;
  }, [users]);

  const LEVELS: { key: Level; icon: typeof Globe; color: string; titleAr: string; titleEn: string; descAr: string; descEn: string }[] = [
    {
      key: 'full',
      icon: Globe,
      color: '#3B82F6',
      titleAr: 'كل المحادثات',
      titleEn: 'All conversations',
      descAr: 'يرى جميع محادثات واتساب دون قيود.',
      descEn: 'Sees every WhatsApp conversation, unrestricted.',
    },
    {
      key: 'client_only',
      icon: Link2,
      color: '#B8734F',
      titleAr: 'محادثات العملاء فقط',
      titleEn: 'Client conversations only',
      descAr: 'المحادثات المرتبطة بعميل فقط — تُخفى محادثات المعلنين وجهات الاتصال والأرقام غير المعروفة.',
      descEn: 'Only chats linked to a client — advertisers, contacts and unknown numbers are hidden.',
    },
    {
      key: 'own',
      icon: UserCheck,
      color: '#16A34A',
      titleAr: 'عملائي فقط',
      titleEn: 'My own clients only',
      descAr: 'محادثات العملاء الذين هذا الموظف هو مستشار مبيعاتهم فقط.',
      descEn: "Only chats for clients where this user is the assigned Sales Consultant.",
    },
    {
      key: 'none',
      icon: Ban,
      color: '#6B7280',
      titleAr: 'لا صلاحية',
      titleEn: 'No access',
      descAr: 'لا يظهر واتساب لهذا الدور إطلاقاً.',
      descEn: 'WhatsApp is hidden from this profile entirely.',
    },
  ];

  const editableProfiles = profiles.filter((p) => !p.is_admin);
  const adminProfiles = profiles.filter((p) => p.is_admin);

  // ---- read current level off a profile -------------------------------------
  const levelOf = (profile: Profile): Level | 'custom' => {
    if (!chatsModel) return 'custom';
    const mp = profile.model_permissions.find((m) => m.model_id === chatsModel.id);
    if (!mp || !mp.permissions?.includes('view')) return 'none';
    const vs = mp.view_scope;
    if (!vs || vs.mode === 'all') return 'full';
    if (vs.mode === 'filtered' && vs.conditions.length === 1) {
      const c = vs.conditions[0];
      if (!c) return 'custom';
      const targets = (slug: string, fieldId?: string) =>
        c.field.kind === 'field' && (c.field.field_slug === slug || (!!fieldId && c.field.field_id === fieldId));
      if (targets('client_owner', ownerField?.id) && c.operator === 'equals' && c.source.kind === 'current_user') return 'own';
      if (targets('client_link', clientLinkField?.id) && c.operator === 'is_not_empty') return 'client_only';
    }
    return 'custom';
  };

  // ---- build the new model_permissions for a chosen level -------------------
  const permsForLevel = (profile: Profile, level: Level): ProfileModelPermissions[] => {
    if (!chatsModel) return profile.model_permissions;
    const others = profile.model_permissions.filter((m) => m.model_id !== chatsModel.id);
    if (level === 'none') return others;

    const existing = profile.model_permissions.find((m) => m.model_id === chatsModel.id);
    const base = existing?.permissions?.length ? [...existing.permissions] : [...FULL_CHAT_PERMS];
    const permissions = base.includes('view') ? base : (['view', ...base] as ModelPermission[]);

    let view_scope: ScopeRule | undefined;
    if (level === 'full') {
      view_scope = undefined; // { mode: 'all' } is stored as absent, by convention
    } else if (level === 'client_only' && clientLinkField) {
      view_scope = {
        mode: 'filtered',
        conditions: [
          {
            id: uuid(),
            field: { kind: 'field', field_id: clientLinkField.id, field_slug: 'client_link' },
            operator: 'is_not_empty',
            source: { kind: 'literal', value: null },
          },
        ],
      };
    } else if (level === 'own' && ownerField) {
      view_scope = {
        mode: 'filtered',
        conditions: [
          {
            id: uuid(),
            field: { kind: 'field', field_id: ownerField.id, field_slug: 'client_owner' },
            operator: 'equals',
            source: { kind: 'current_user' },
          },
        ],
      };
    }

    const entry: ProfileModelPermissions = {
      ...(existing ?? { model_id: chatsModel.id, permissions }),
      model_id: chatsModel.id,
      permissions,
      view_scope,
    };
    return [...others, entry];
  };

  const applyLevel = (profile: Profile, level: Level) => {
    if (levelOf(profile) === level) return;
    saveProfile({
      ...profile,
      model_permissions: permsForLevel(profile, level),
      updated_at: new Date().toISOString(),
    });
    const lvl = LEVELS.find((l) => l.key === level);
    const name = isAr ? profile.label_ar : profile.label_en;
    addToast(
      isAr
        ? `تم تحديث صلاحية واتساب لـ «${name}»: ${lvl?.titleAr}`
        : `WhatsApp access for "${name}" set to: ${lvl?.titleEn}`,
      'success',
    );
  };

  // ---- missing-schema guard (should not happen on prod) ---------------------
  if (!chatsModel || !ownerField || !clientLinkField) {
    return (
      <div className="p-6 md:p-8 max-w-4xl mx-auto">
        <BackToSettings />
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-800">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <div className="text-sm">
            {isAr
              ? 'تعذّر تحميل حقول نموذج المحادثات المطلوبة (client_owner / client_link). حدّث الصفحة، وإن استمرت المشكلة فقد لا يكون النظام محدثاً بعد.'
              : 'Could not resolve the required chats model fields (client_owner / client_link). Reload the page; if it persists, the schema may not be up to date yet.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto">
      <BackToSettings />

      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: '#25D36614' }}>
          <MessageCircle size={24} style={{ color: '#25D366' }} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-chocolate">
            {isAr ? 'صلاحيات واتساب' : 'WhatsApp Permissions'}
          </h1>
          <p className="text-sm text-charcoal/50 mt-0.5">
            {isAr
              ? 'حدّد لكل دور أي محادثات واتساب يمكنه رؤيتها. يسري ذلك على القائمة والرسائل معاً.'
              : 'Choose which WhatsApp conversations each profile can see. Applies to the list and the messages alike.'}
          </p>
        </div>
      </div>

      <p className="text-xs text-charcoal/50 mb-6 leading-relaxed">
        {isAr
          ? '«عملائي فقط» يعتمد على مستشار المبيعات المسؤول عن كل عميل (يُحدَّد تلقائياً من آخر متابعة). المديرون يرون كل المحادثات دائماً بغضّ النظر عن هذا الإعداد.'
          : '"My own clients only" is driven by each client\'s assigned Sales Consultant (derived automatically from the latest follow-up). Administrators always see every conversation regardless of this setting.'}
      </p>

      {/* Editable (non-admin) profiles */}
      <div className="space-y-4">
        {editableProfiles.map((profile) => {
          const current = levelOf(profile);
          const name = isAr ? profile.label_ar : profile.label_en;
          const count = activeUserCount.get(profile.id) ?? 0;
          return (
            <div key={profile.id} className="rounded-2xl border border-sand/40 bg-white p-5">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="font-semibold text-chocolate">{name}</div>
                  <div className="text-xs text-charcoal/45 mt-0.5">
                    {count === 0
                      ? isAr ? 'لا مستخدمين نشطين' : 'No active users'
                      : isAr ? `${count} مستخدم نشط` : `${count} active user${count === 1 ? '' : 's'}`}
                  </div>
                </div>
                {current === 'custom' && (
                  <span className="shrink-0 rounded-full bg-amber-100 text-amber-700 text-[11px] font-medium px-2.5 py-1">
                    {isAr ? 'إعداد مخصّص' : 'Custom rule'}
                  </span>
                )}
              </div>

              {current === 'custom' && (
                <p className="text-[11px] text-amber-700/80 mb-3">
                  {isAr
                    ? 'هذا الدور لديه قاعدة رؤية مخصّصة للمحادثات أُنشئت من شاشة الصلاحيات. اختيار أحد الخيارات أدناه سيستبدلها.'
                    : 'This profile has a custom chats visibility rule set in Profiles. Picking an option below will replace it.'}
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {LEVELS.map((lvl) => {
                  const selected = current === lvl.key;
                  const Icon = lvl.icon;
                  return (
                    <button
                      key={lvl.key}
                      type="button"
                      onClick={() => applyLevel(profile, lvl.key)}
                      aria-pressed={selected}
                      className={`text-start rounded-xl border p-3 transition ${
                        selected
                          ? 'border-transparent ring-2 shadow-sm'
                          : 'border-sand/50 hover:border-sand hover:bg-cream/40'
                      }`}
                      style={selected ? { background: `${lvl.color}0F` , boxShadow: `0 0 0 2px ${lvl.color}` } : undefined}
                    >
                      <div className="flex items-center gap-2">
                        <Icon size={16} style={{ color: lvl.color }} />
                        <span className="font-medium text-sm text-chocolate">{isAr ? lvl.titleAr : lvl.titleEn}</span>
                      </div>
                      <p className="text-[11px] text-charcoal/50 mt-1 leading-snug">
                        {isAr ? lvl.descAr : lvl.descEn}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Admin profiles — informational, always full access */}
      {adminProfiles.length > 0 && (
        <div className="mt-6 space-y-2">
          {adminProfiles.map((profile) => (
            <div
              key={profile.id}
              className="flex items-center gap-3 rounded-xl border border-sand/30 bg-cream/30 px-4 py-3"
            >
              <ShieldCheck size={18} className="text-charcoal/40 shrink-0" />
              <div className="flex-1 text-sm">
                <span className="font-medium text-chocolate">{isAr ? profile.label_ar : profile.label_en}</span>
                <span className="text-charcoal/45">
                  {' — '}
                  {isAr ? 'مدير النظام يرى كل المحادثات دائماً' : 'administrator — always sees every conversation'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

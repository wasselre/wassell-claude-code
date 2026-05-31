import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { emptyRoleSchema, roleFields } from '@/lib/roleSchema';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { Briefcase, Plus, Pencil, Users, ArrowRight, Trash2, Settings, Save, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import SectionManager from '@/pages/Builder/components/SectionManager';
import BackToSettings from './components/BackToSettings';
import { MAPS_CONFIG_DEFAULT } from '@/types';
import type { Role, AppModel, StoreMutationReason } from '@/types';

function reasonToKey(reason: StoreMutationReason): string {
  switch (reason) {
    case 'is_system': return 'access.cannot_delete_system_role';
    case 'has_users': return 'access.cannot_delete_has_users';
    case 'self_delete': return 'access.cannot_delete_self';
    case 'last_admin': return 'access.cannot_delete_last_admin';
    case 'missing_profile': return 'access.profile_missing';
  }
}

/**
 * Wrap a Role as an AppModel-shaped object so the Model Builder's
 * SectionManager + FieldEditor can edit the role's schema without any changes
 * to those components. The builder only reads `schema`, `id`, `name`, and a
 * handful of cosmetic fields — everything else is filler and ignored.
 */
function roleAsModel(role: Role): AppModel {
  return {
    id: role.id,
    name: `role_${role.id}`,
    label_ar: role.label_ar,
    label_en: role.label_en,
    icon: 'briefcase',
    color: '#0D9488',
    schema: role.schema,
    card_config: { title_field_id: null, subtitle_field_id: null, badge_field_id: null, shown_field_ids: [] },
    maps_config: { ...MAPS_CONFIG_DEFAULT },
    group_id: null,
    is_system: role.is_system,
    created_at: role.created_at,
    updated_at: role.updated_at,
  };
}

export default function RolesPage() {
  const { roleId } = useParams();
  const navigate = useNavigate();
  const { roles, users, language, saveRole } = useAppStore();
  const isAr = language === 'ar';

  const editingRole = roleId ? roles.find((r) => r.id === roleId) : null;

  if (roleId) {
    return editingRole ? (
      <RoleEditor
        role={editingRole}
        onBack={() => navigate('/settings/roles')}
      />
    ) : (
      <div className="text-center py-20 text-charcoal/30">404</div>
    );
  }

  return (
    <div className="max-w-4xl">
      <BackToSettings />
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-teal-500/10 flex items-center justify-center">
            <Briefcase size={24} className="text-teal-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'الأدوار' : 'Roles'}</h1>
            <p className="text-sm text-charcoal/40">{isAr ? 'إدارة الأدوار وحقولها' : 'Manage roles and their fields'}</p>
          </div>
        </div>
        <Button onClick={() => {
          const id = uuid();
          // Hardcoded placeholder in both languages — user renames in the
          // role editor where translation kicks in via the rename flow.
          saveRole({
            id,
            label_ar: 'دور جديد',
            label_en: 'New Role',
            is_system: false,
            schema: emptyRoleSchema(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          navigate(`/settings/roles/${id}`);
        }}>
          <Plus size={16} />
          {isAr ? 'دور جديد' : 'New Role'}
        </Button>
      </div>

      <div className="grid gap-4">
        {roles.map((role) => {
          const memberCount = users.filter((u) => u.role_assignments.some((ra) => ra.role_id === role.id)).length;
          const fieldCount = role.schema.sections.reduce((acc, s) => acc + s.fields.length, 0);
          const sectionCount = role.schema.sections.length;
          return (
            <button
              key={role.id}
              onClick={() => navigate(`/settings/roles/${role.id}`)}
              className="card p-5 flex items-center justify-between text-start w-full hover:border-copper/30 transition-colors"
            >
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-charcoal">{isAr ? role.label_ar : role.label_en}</h3>
                  {role.is_system && (
                    <span className="text-[10px] font-bold text-charcoal/50 bg-charcoal/5 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                      <Lock size={9} />
                      {isAr ? 'نظام' : 'System'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 mt-1 text-xs text-charcoal/40">
                  <span>{sectionCount} {isAr ? 'قسم' : 'section(s)'}</span>
                  <span>{fieldCount} {isAr ? 'حقل' : 'field(s)'}</span>
                  <span className="flex items-center gap-1"><Users size={12} /> {memberCount} {isAr ? 'عضو' : 'member(s)'}</span>
                </div>
              </div>
              <Pencil size={16} className="text-charcoal/20" />
            </button>
          );
        })}
        {roles.length === 0 && (
          <div className="text-center py-16 text-charcoal/30">
            <Briefcase size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-bold">{isAr ? 'لا توجد أدوار' : 'No roles yet'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Full-page role editor with Settings + Members tabs. Reuses the Model
 * Builder's SectionManager so roles get sections, all field types, and all
 * per-field options exactly like models. */
function RoleEditor({ role, onBack }: { role: Role; onBack: () => void }) {
  const { t } = useTranslation();
  const { language, workflows, saveRole, deleteRole, users, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [activeTab, setActiveTab] = useState<'settings' | 'members'>('settings');
  const [name, setName] = useState(isAr ? role.label_ar : role.label_en);
  // Local working copy of the role's schema. Persisted on Save.
  const [schema, setSchema] = useState(role.schema);
  const [showDelete, setShowDelete] = useState(false);

  const members = users.filter((u) => u.role_assignments.some((ra) => ra.role_id === role.id));

  const handleSave = () => {
    const labels = { label_ar: isAr ? name : role.label_ar, label_en: isAr ? role.label_en : name };
    saveRole({ ...role, ...labels, schema, updated_at: new Date().toISOString() });
    addToast(t('toast.saved'), 'success');
  };

  const handleDelete = () => {
    const referring = workflows.filter((w) =>
      w.actions.some((a) => a.type === 'assign_user' && a.role_id === role.id),
    ).length;
    const result = deleteRole(role.id);
    if (!result.ok) {
      addToast(t(reasonToKey(result.reason)), 'error');
      setShowDelete(false);
      return;
    }
    addToast(t('toast.deleted'), 'success');
    if (referring > 0) {
      addToast(t('roles.delete_warn_workflows', { count: referring }), 'info');
    }
    setShowDelete(false);
    onBack();
  };

  // Adapter: SectionManager expects an AppModel + onChange(AppModel). We wrap
  // the role's schema in a synthetic AppModel, and on each change we extract
  // just the schema back into our local state. `ownerKind='role'` tells
  // FieldEditor to skip the model-specific rename propagation path.
  const wrappedModel = { ...roleAsModel(role), schema };
  const handleSchemaChange = (m: AppModel) => setSchema(m.schema);

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal">
            <ArrowRight size={20} className="rtl:rotate-0 ltr:rotate-180" />
          </button>
          <div className="w-10 h-10 rounded-xl bg-teal-500/10 flex items-center justify-center">
            <Briefcase size={20} className="text-teal-600" />
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-xl font-bold border-0 bg-transparent p-0 focus:ring-0 w-64"
            dir={isAr ? 'rtl' : 'ltr'}
          />
          {role.is_system && (
            <span className="text-xs font-bold text-charcoal/60 bg-charcoal/5 px-2 py-1 rounded-full flex items-center gap-1">
              <Lock size={11} />
              {t('common.system_badge')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!role.is_system && (
            <Button variant="danger" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} />
            </Button>
          )}
          <Button onClick={handleSave}>
            <Save size={16} />
            {t('common.save')}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-cream/50 p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-colors ${
            activeTab === 'settings' ? 'bg-white text-copper shadow-sm' : 'text-charcoal/50 hover:text-charcoal'
          }`}
        >
          <Settings size={15} />
          {isAr ? 'الإعدادات' : 'Settings'}
        </button>
        <button
          onClick={() => setActiveTab('members')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-colors ${
            activeTab === 'members' ? 'bg-white text-copper shadow-sm' : 'text-charcoal/50 hover:text-charcoal'
          }`}
        >
          <Users size={15} />
          {isAr ? 'الأعضاء' : 'Members'}
          <span className="text-xs bg-cream px-1.5 py-0.5 rounded-full">{members.length}</span>
        </button>
      </div>

      {/* Settings Tab: full builder — sections, all field types, all options */}
      {activeTab === 'settings' && (
        <div className="h-[calc(100vh-250px)]">
          <SectionManager model={wrappedModel} onChange={handleSchemaChange} ownerKind="role" />
        </div>
      )}

      {/* Members Tab: read-only directory */}
      {activeTab === 'members' && (
        <MembersTable
          role={role}
          members={members}
        />
      )}

      {/* Delete confirmation */}
      <Modal
        open={showDelete}
        onClose={() => setShowDelete(false)}
        title={t('common.delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={handleDelete}>{t('common.delete')}</Button>
          </>
        }
      >
        <p className="text-sm text-charcoal">
          {t('roles.confirm_delete', { name: isAr ? role.label_ar : role.label_en, n_members: members.length })}
        </p>
      </Modal>
    </div>
  );
}

/** Members table — read-only. Role-field values are edited in the User modal
 * (Settings > Users > edit). Flat field list sorted by (section, field order). */
function MembersTable({
  role,
  members,
}: {
  role: Role;
  members: ReturnType<typeof useAppStore.getState>['users'];
}) {
  const { language, records, models } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();

  const sortedFields = roleFields(role);

  if (members.length === 0) {
    return (
      <div className="card p-8 text-center text-charcoal/30">
        <Users size={36} className="mx-auto mb-3 opacity-30" />
        <p className="font-bold">{isAr ? 'لا يوجد أعضاء بعد' : 'No members yet'}</p>
        <p className="text-sm mt-1">{isAr ? 'أضف هذا الدور لمستخدم من صفحة المستخدمين' : 'Assign this role to a user from the Users page'}</p>
      </div>
    );
  }

  return (
    <div className="card overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>{isAr ? 'العضو' : 'Member'}</th>
            {sortedFields.map((f) => (
              <th key={f.id}>{isAr ? f.label_ar : f.label_en}</th>
            ))}
            <th className="w-20">{isAr ? 'إجراءات' : 'Actions'}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((user) => {
            const assignment = user.role_assignments.find((ra) => ra.role_id === role.id);
            if (!assignment) return null;
            const values = assignment.field_values;

            return (
              <tr key={user.id}>
                <td>
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center text-xs font-bold text-copper shrink-0">
                      {(isAr ? user.name_ar : user.name_en).charAt(0)}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-charcoal">{isAr ? user.name_ar : user.name_en}</div>
                      <div className="text-xs text-charcoal/30">{user.email}</div>
                    </div>
                  </div>
                </td>

                {/* Field values — display only. Covers common types; complex
                    types (mirror, formula, auto_id, assignee) render a dash. */}
                {sortedFields.map((field) => {
                  const val = values[field.name];
                  return (
                    <td key={field.id}>
                      {field.type === 'checkbox' ? (
                        <span className={`text-sm font-bold ${val ? 'text-green-600' : 'text-charcoal/30'}`}>
                          {val ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No')}
                        </span>
                      ) : (field.type === 'dropdown' || field.type === 'multiselect') && field.options ? (
                        (() => {
                          const vals = Array.isArray(val) ? val : val !== undefined ? [val] : [];
                          if (vals.length === 0) return <span className="text-charcoal/20">—</span>;
                          return (
                            <div className="flex flex-wrap gap-1">
                              {vals.map((v, i) => {
                                const opt = field.options!.find((o) => o.value === v);
                                return opt ? (
                                  <span key={i} className="badge" style={{ backgroundColor: `${opt.color ?? '#6B7280'}20`, color: opt.color ?? '#6B7280' }}>
                                    {isAr ? opt.label_ar : opt.label_en}
                                  </span>
                                ) : <span key={i} className="text-charcoal/20">{String(v)}</span>;
                              })}
                            </div>
                          );
                        })()
                      ) : field.type === 'lookup' ? (
                        (() => {
                          if (!field.lookup_model_id || !field.lookup_display_field) return <span className="text-charcoal/20">—</span>;
                          const lookupRecords = records[field.lookup_model_id] ?? [];
                          const targetModel = models.find((m) => m.id === field.lookup_model_id);
                          const ids = Array.isArray(val) ? (val as string[]) : val ? [val as string] : [];
                          if (ids.length === 0) return <span className="text-charcoal/20">—</span>;
                          const labels = ids.map((id) => {
                            const rec = lookupRecords.find((r) => r.id === id);
                            const display = rec
                              ? resolveLookupDisplayValue(rec, field.lookup_display_field!, { targetModel, allModels: models, allRecords: records })
                              : undefined;
                            return display !== undefined && display !== null && String(display).trim() !== '' ? String(display) : '—';
                          });
                          return <span className="text-sm text-charcoal">{labels.join(', ')}</span>;
                        })()
                      ) : field.type === 'date' || field.type === 'datetime' ? (
                        <span className="text-sm text-charcoal">{val ? String(val) : <span className="text-charcoal/20">—</span>}</span>
                      ) : field.type === 'currency' ? (
                        <span className="text-sm text-charcoal">{val !== undefined && val !== null && val !== '' ? `${val} ${isAr ? 'ر.س' : 'SAR'}` : <span className="text-charcoal/20">—</span>}</span>
                      ) : field.type === 'range' ? (
                        <span className="text-sm text-charcoal">{val !== undefined && val !== null && val !== '' ? `${val}${field.range_unit_ar && isAr ? ' ' + field.range_unit_ar : field.range_unit_en && !isAr ? ' ' + field.range_unit_en : ''}` : <span className="text-charcoal/20">—</span>}</span>
                      ) : field.type === 'formula' || field.type === 'auto_id' || field.type === 'mirror' || field.type === 'section_mirror' || field.type === 'assignee' || field.type === 'notes' ? (
                        <span className="text-xs text-charcoal/20 italic">—</span>
                      ) : (
                        <span className="text-sm text-charcoal">{val !== undefined && val !== null && val !== '' ? String(val) : <span className="text-charcoal/20">—</span>}</span>
                      )}
                    </td>
                  );
                })}

                <td>
                  <button
                    onClick={() => navigate(`/settings/users`)}
                    className="p-1.5 rounded-lg hover:bg-cream text-charcoal/30 hover:text-copper"
                    title={isAr ? 'فتح صفحة المستخدم' : 'Open user page'}
                  >
                    <ArrowRight size={14} className="rtl:rotate-0 ltr:rotate-180" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Which WhatsApp conversations an access level (profile) can see — read off
 * `profiles.model_permissions[chats].view_scope`. Shared by the WhatsApp
 * visibility picker (Team & Access → Access levels) and the People list, so
 * the two can never describe the same profile differently.
 *
 * Levels (kept in sync with 2026-08-14_chat_client_owner_mirror.sql):
 *   full        → no scope (every conversation)
 *   client_only → client_link is_not_empty
 *   own         → client_owner equals current_user
 *   none        → no chats entry / no view
 *   custom      → any other hand-built rule from the permission matrix
 * An admin profile always sees everything regardless of the stored rule.
 */
import type { AppModel, ModelField, Profile } from '@/types';

export type ChatAccessLevel = 'full' | 'client_only' | 'own' | 'none' | 'custom';

function findField(model: AppModel | undefined, slug: string): ModelField | undefined {
  return model?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === slug);
}

export function chatAccessLevel(profile: Profile, chatsModel: AppModel | undefined): ChatAccessLevel {
  if (profile.is_admin) return 'full';
  if (!chatsModel) return 'custom';
  const ownerField = findField(chatsModel, 'client_owner');
  const clientLinkField = findField(chatsModel, 'client_link');
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
}

export const CHAT_ACCESS_LABELS: Record<ChatAccessLevel, { ar: string; en: string }> = {
  full: { ar: 'كل المحادثات', en: 'All conversations' },
  client_only: { ar: 'محادثات العملاء فقط', en: 'Client conversations only' },
  own: { ar: 'عملائي فقط', en: 'My own clients only' },
  none: { ar: 'لا صلاحية', en: 'No access' },
  custom: { ar: 'إعداد مخصّص', en: 'Custom rule' },
};

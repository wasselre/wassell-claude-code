// Kill switch for the BUILT-IN notifications (hot lead, customer replied, new
// inbound WhatsApp message).
//
// They are produced by database triggers — `tg_records_enqueue_push` on
// `records` for the first two, `tg_chat_messages_enqueue_push` on
// `chat_messages` for the third — not by a workflow. Now that a Notification
// action can be configured per workflow, someone building their own "new lead"
// rule would receive TWO alerts for one event. This switch lets the built-ins
// be turned off so a hand-built rule can replace them, instead of forcing a
// choice between an editable rule and a working one.
//
// Workspace-wide and admin-only: one rep turning it off would silence every
// other rep. RLS enforces that (push_builtin_admin_update) — this module is
// only the read/write path.

import { supabase } from '@/lib/supabase';

export interface PushBuiltinSettings {
  hot_lead_enabled: boolean;
  customer_replied_enabled: boolean;
  /** «💬 رسالة واتساب جديدة» — added 2026-08-18. */
  whatsapp_inbound_enabled: boolean;
  /**
   * Fallback recipient (public.users.id) for a new inbound WhatsApp message
   * when NO sales rep is assigned to the chat — an unlinked conversation, or a
   * client with no follow-up yet. NULL = no fallback (assigned chats always go
   * to their consultant regardless). Added 2026-08-18.
   */
  whatsapp_inbox_user_id: string | null;
}

/**
 * Toggles ON, inbox user unset — matches the database defaults and the
 * triggers' own fallback (a missing settings row degrades to all toggles ON,
 * no inbox fallback).
 */
export const PUSH_BUILTIN_DEFAULTS: PushBuiltinSettings = {
  hot_lead_enabled: true,
  customer_replied_enabled: true,
  whatsapp_inbound_enabled: true,
  whatsapp_inbox_user_id: null,
};

/**
 * Load the switch state.
 *
 * FAIL-SAFE ON: a read failure returns them all enabled, which is what the
 * triggers themselves do when the row is missing. The alternative — off —
 * would make a transient read error look identical to "notifications are
 * disabled", and the UI would tell an admin their alerts are off when they are
 * not. Reporting ON matches what the server will actually do.
 */
export async function loadPushBuiltinSettings(): Promise<PushBuiltinSettings> {
  if (!supabase) return PUSH_BUILTIN_DEFAULTS;
  try {
    const { data, error } = await supabase
      .from('push_builtin_settings')
      .select('hot_lead_enabled, customer_replied_enabled, whatsapp_inbound_enabled, whatsapp_inbox_user_id')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return PUSH_BUILTIN_DEFAULTS;
    return {
      hot_lead_enabled: data.hot_lead_enabled !== false,
      customer_replied_enabled: data.customer_replied_enabled !== false,
      whatsapp_inbound_enabled: data.whatsapp_inbound_enabled !== false,
      whatsapp_inbox_user_id: data.whatsapp_inbox_user_id ?? null,
    };
  } catch (err) {
    console.error(
      '[push] LOUD: failed to read push_builtin_settings — reporting both built-ins as ENABLED, ' +
        'which is what the database trigger falls back to. The UI may therefore show ON while ' +
        'an admin has switched something off.',
      err,
    );
    return PUSH_BUILTIN_DEFAULTS;
  }
}

/**
 * Flip the switch. Returns an error message on failure — never swallows it,
 * because a silently-failed save would leave an admin believing they had turned
 * the built-ins off while every rep keeps getting them.
 */
export async function savePushBuiltinSettings(
  patch: Partial<PushBuiltinSettings>,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase not configured' };

  const { data: session } = await supabase.auth.getSession();
  const authUid = session.session?.user?.id ?? null;

  // `.select()` is LOAD-BEARING, not decoration. An RLS-denied UPDATE does not
  // raise — it silently matches zero rows (verified against production: a
  // non-admin's update returned no error and changed nothing). Without reading
  // the affected rows back, this function would report success while the switch
  // stayed exactly as it was, and the UI would leave the toggle flipped.
  const { data, error } = await supabase
    .from('push_builtin_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: authUid })
    .eq('id', 1)
    .select('id');

  if (error) {
    console.error('[push] failed to save push_builtin_settings:', error);
    return {
      ok: false,
      error: error.message.includes('row-level security')
        ? 'Only an admin can change this.'
        : error.message,
    };
  }

  if (!data || data.length === 0) {
    console.error(
      '[push] push_builtin_settings update matched 0 rows — RLS denied it (not an admin), ' +
        'or the singleton row is missing.',
    );
    return { ok: false, error: 'Only an admin can change this.' };
  }

  return { ok: true };
}

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * WhatsApp follow-up suggestion queue — browser client.
 *
 * `wa_followup_suggestions` is a bespoke ops table (NOT an app model), so it
 * can't ride the Zustand records store. Reading it directly in a hook is the
 * sanctioned pattern for bespoke tables (same as `useAiNotifications`). RLS
 * gates the rows to authenticated staff.
 *
 * Nothing here sends a WhatsApp message. The page pre-fills the chat composer
 * with `suggested_message` and the rep sends through the normal chat path;
 * this module only records what happened to the suggestion.
 */

export type SuggestionCategory = 'reply' | 'visited' | 'promised' | 'nudge' | 'revive';
export type SuggestionStatus = 'pending' | 'sent' | 'dismissed' | 'snoozed';

export interface FollowupSuggestion {
  id: string;
  created_at: string;
  updated_at: string;
  batch_id: string;
  batch_label: string | null;
  chat_record_id: string;
  chat_wid: string | null;
  client_record_id: string | null;
  client_name: string | null;
  phone: string | null;
  category: SuggestionCategory;
  priority: 1 | 2 | 3;
  project: string | null;
  chat_summary: string;
  reason: string;
  suggested_message: string;
  last_client_message_at: string | null;
  last_message_at: string | null;
  last_message_flow: 'in' | 'out' | null;
  status: SuggestionStatus;
  final_message: string | null;
  sent_at: string | null;
  sent_by_user_id: string | null;
  sent_message_id: string | null;
  dismissed_at: string | null;
  dismissed_by_user_id: string | null;
  dismiss_reason: string | null;
  snoozed_until: string | null;
  rep_note: string | null;
}

const SELECT_COLS =
  'id, created_at, updated_at, batch_id, batch_label, chat_record_id, chat_wid, client_record_id, client_name, phone, ' +
  'category, priority, project, chat_summary, reason, suggested_message, last_client_message_at, last_message_at, ' +
  'last_message_flow, status, final_message, sent_at, sent_by_user_id, sent_message_id, dismissed_at, ' +
  'dismissed_by_user_id, dismiss_reason, snoozed_until, rep_note';

export const CATEGORY_ORDER: SuggestionCategory[] = ['reply', 'visited', 'promised', 'nudge', 'revive'];

export function useFollowupSuggestions() {
  const [rows, setRows] = useState<FollowupSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    const { data, error: err } = await supabase
      .from('wa_followup_suggestions')
      .select(SELECT_COLS)
      .order('priority', { ascending: true })
      .order('last_client_message_at', { ascending: true, nullsFirst: false })
      .limit(1000);
    if (err) {
      setError(err.message);
    } else {
      // The table has no generated Supabase types; the explicit column list
      // above is the contract, so the cast goes through `unknown`.
      setRows((data ?? []) as unknown as FollowupSuggestion[]);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Optimistic patch + DB update; refetches on failure so the UI never lies. */
  const patch = useCallback(async (id: string, changes: Partial<FollowupSuggestion>) => {
    if (!supabase) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes } : r)));
    const { error: err } = await supabase.from('wa_followup_suggestions').update(changes).eq('id', id);
    if (err) {
      console.error('[followupSuggestions] update failed:', err);
      setError(err.message);
      void refresh();
    }
  }, [refresh]);

  const markSent = useCallback(
    (id: string, input: { finalMessage: string; sentByUserId: string | null; sentMessageId: string | null }) =>
      patch(id, {
        status: 'sent',
        final_message: input.finalMessage,
        sent_at: new Date().toISOString(),
        sent_by_user_id: input.sentByUserId,
        sent_message_id: input.sentMessageId,
      }),
    [patch],
  );

  const dismiss = useCallback(
    (id: string, input: { reason: string | null; byUserId: string | null }) =>
      patch(id, {
        status: 'dismissed',
        dismissed_at: new Date().toISOString(),
        dismissed_by_user_id: input.byUserId,
        dismiss_reason: input.reason,
      }),
    [patch],
  );

  const restore = useCallback(
    (id: string) =>
      patch(id, {
        status: 'pending',
        dismissed_at: null,
        dismissed_by_user_id: null,
        dismiss_reason: null,
        sent_at: null,
        sent_by_user_id: null,
        sent_message_id: null,
        final_message: null,
      }),
    [patch],
  );

  const saveMessage = useCallback(
    (id: string, text: string) => patch(id, { suggested_message: text }),
    [patch],
  );

  const saveNote = useCallback(
    (id: string, note: string) => patch(id, { rep_note: note.trim() ? note : null }),
    [patch],
  );

  return { rows, loading, error, refresh, markSent, dismiss, restore, saveMessage, saveNote };
}

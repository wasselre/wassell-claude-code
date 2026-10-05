import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * The daily "review the AI agent's WhatsApp work" list (ai_chat_reviews).
 *
 * A bespoke table (not an app model), read directly — same sanctioned pattern
 * as useAiNotifications. RLS shows a rep their own review rows and an admin all
 * of them. The latest review day's rows plus any older ones still pending.
 */
export interface AiChatReview {
  id: string;
  review_day: string;
  chat_wid: string;
  chat_record_id: string | null;
  client_id: string | null;
  reviewer_user_id: string | null;
  ai_messages: number;
  last_ai_at: string | null;
  status: 'pending' | 'done';
  rating: number | null;
  note: string | null;
}

const COLS = 'id, review_day, chat_wid, chat_record_id, client_id, reviewer_user_id, ai_messages, last_ai_at, status, rating, note';

export function useAiChatReviews() {
  const [reviews, setReviews] = useState<AiChatReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    // The last 7 days is plenty: pending rows carry over, done rows of today show as done.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const { data, error: err } = await supabase
      .from('ai_chat_reviews')
      .select(COLS)
      .gte('review_day', since)
      .order('review_day', { ascending: false })
      .order('last_ai_at', { ascending: false });
    if (err) {
      console.error('[useAiChatReviews] load failed:', err.message);
      setError(err.message);
    } else {
      setReviews((data ?? []) as AiChatReview[]);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = useCallback(async (id: string, rating: number, note: string): Promise<boolean> => {
    if (!supabase) return false;
    const { data, error: err } = await supabase.rpc('ai_chat_review_submit', { p_id: id, p_rating: rating, p_note: note });
    if (err) {
      console.error('[useAiChatReviews] submit failed:', err.message);
      throw new Error(err.message);
    }
    if (data === true) {
      setReviews((prev) => prev.map((r) => (r.id === id ? { ...r, status: 'done', rating, note: note.trim() || null } : r)));
    }
    return data === true;
  }, []);

  return { reviews, loading, error, refresh, submit };
}

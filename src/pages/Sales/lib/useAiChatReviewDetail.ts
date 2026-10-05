import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { callJson } from '@/pages/Chats/lib/cardHttp';

/**
 * Everything the AI chat review pop-up needs about ONE review: the notes the
 * reviewer wrote, the per-card verdicts, and what the AI did in the chat —
 * places and preferences saved, portal steps, visits booked/recorded
 * (api/ai-chat-review.ts). Writes go through the reviewer-gated RPCs.
 */

export type ReviewCardKey = 'places' | 'preferences' | 'portal' | 'visits';

export interface ReviewNote { id: string; message_ids: string[]; note: string; created_at: string }
export interface ReviewCardVerdict {
  card: ReviewCardKey; verdict: 'accepted' | 'rejected'; reason: string | null;
  corrections: Record<string, unknown> | null; decided_at: string;
}
export interface ReviewAiChange {
  id: string; kind: 'place' | 'pref'; field: string | null;
  before_value: unknown; after_value: unknown; added: unknown;
  applied: boolean; note: string | null; quote: string | null; label: string | null;
  profile_name: string | null; created_at: string; undone_at: string | null;
}
export interface ReviewPortal {
  kind: 'interest' | 'job'; id: string; project: string | null; portal?: string | null;
  source?: string | null; status?: string; phase_ar?: string | null; phase_en?: string | null;
  result: unknown; error?: string | null; at: string;
}
export interface ReviewBooking {
  kind: 'appointment' | 'visit'; id: string; at: string; project: string | null; data: Record<string, unknown>;
}
export interface ReviewDetail {
  notes: ReviewNote[]; cards: ReviewCardVerdict[]; changes: ReviewAiChange[];
  portals: ReviewPortal[]; bookings: ReviewBooking[];
}

const EMPTY: ReviewDetail = { notes: [], cards: [], changes: [], portals: [], bookings: [] };

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`[useAiChatReviewDetail] ${fn} failed:`, error.message);
    throw new Error(error.message);
  }
  return data as T;
}

export function useAiChatReviewDetail(reviewId: string) {
  const [detail, setDetail] = useState<ReviewDetail>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await callJson<ReviewDetail>(`/api/ai-chat-review?id=${encodeURIComponent(reviewId)}`, { method: 'GET' });
      setDetail({ ...EMPTY, ...r });
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[useAiChatReviewDetail] load failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [reviewId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addNote = useCallback(async (messageIds: string[], note: string) => {
    const id = await rpc<string>('ai_chat_review_note_add', { p_review: reviewId, p_message_ids: messageIds, p_note: note });
    setDetail((d) => ({ ...d, notes: [...d.notes, { id, message_ids: messageIds, note: note.trim(), created_at: new Date().toISOString() }] }));
  }, [reviewId]);

  const deleteNote = useCallback(async (id: string) => {
    await rpc<boolean>('ai_chat_review_note_delete', { p_id: id });
    setDetail((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) }));
  }, []);

  const setCard = useCallback(async (
    card: ReviewCardKey, verdict: 'accepted' | 'rejected', reason: string | null, corrections: Record<string, unknown> | null,
  ) => {
    await rpc<string>('ai_chat_review_card_set', {
      p_review: reviewId, p_card: card, p_verdict: verdict, p_reason: reason, p_corrections: corrections,
    });
    setDetail((d) => ({
      ...d,
      cards: [...d.cards.filter((c) => c.card !== card), { card, verdict, reason, corrections, decided_at: new Date().toISOString() }],
    }));
  }, [reviewId]);

  return { detail, loading, error, refresh, addNote, deleteNote, setCard };
}

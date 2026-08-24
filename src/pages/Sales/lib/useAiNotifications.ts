import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * AI notifications feed for the My Tasks → "AI notifications" tab.
 *
 * `ai_notifications` is a bespoke ops table (NOT an app model), so it can't ride
 * the Zustand records store — it has no model_id/data shape. Reading it directly
 * here is the sanctioned pattern for bespoke tables (same as WhatsAppAiPage's
 * settings fetch); RLS gates the rows (authenticated-only) and the mark-read
 * RPC is SECURITY DEFINER. Kept in a hook, never inline in a component.
 */

export interface AiNotification {
  id: string;
  created_at: string;
  source: string;
  severity: 'info' | 'action' | 'warning';
  title: string | null;
  body: string;
  chat_wid: string | null;
  chat_record_id: string | null;
  client_record_id: string | null;
  read_at: string | null;
}

const SELECT_COLS =
  'id, created_at, source, severity, title, body, chat_wid, chat_record_id, client_record_id, read_at';

export function useAiNotifications() {
  const [notifications, setNotifications] = useState<AiNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    const { data, error: err } = await supabase
      .from('ai_notifications')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(200);
    if (err) {
      setError(err.message);
    } else {
      setNotifications((data ?? []) as AiNotification[]);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const markRead = useCallback(async (id: string) => {
    if (!supabase) return;
    const stamp = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: stamp } : n)));
    const { error: err } = await supabase.rpc('ai_notification_mark_read', { p_id: id });
    if (err) { setError(err.message); void refresh(); }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    if (!supabase) return;
    const stamp = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: stamp })));
    const { error: err } = await supabase.rpc('ai_notification_mark_read', { p_id: null });
    if (err) { setError(err.message); void refresh(); }
  }, [refresh]);

  const unreadCount = notifications.reduce((n, x) => n + (x.read_at ? 0 : 1), 0);

  return { notifications, unreadCount, loading, error, refresh, markRead, markAllRead };
}

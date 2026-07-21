import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';

/**
 * App-level watcher for the two sales moments where seconds matter
 * (2026-07-21 — sales-process improvement plan, Workstream B):
 *
 *  1. HOT LEAD — a NEW first-call task lands (client still جديد): the rep must
 *     call within 5 minutes. Fires on followup INSERT of an
 *     appointment_booking_call for a fresh client.
 *  2. CUSTOMER REPLIED — a WhatsApp task flips to 'replied' (or a fresh task
 *     gets client_messaged_at stamped) via the inbound webhook reconciler.
 *
 * Both fire a toast + a browser Notification. Rides the store's existing
 * realtime merge — no extra subscription. The first pass after boot only
 * seeds the diff baseline (no notification storm on page load).
 */
export default function SalesNotifications() {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const language = useAppStore((s) => s.language);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = language === 'ar';

  // followupId → last-seen "signal" state; null until first seeding pass.
  const seenRef = useRef<Map<string, string> | null>(null);

  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');
  const followups = followupsModel ? records[followupsModel.id] : undefined;
  const clients = clientsModel ? records[clientsModel.id] : undefined;

  useEffect(() => {
    if (!followups) return;

    const clientStage = (id: unknown): string | null => {
      if (typeof id !== 'string' || !clients) return null;
      const c = clients.find((r) => r.id === id);
      const stage = c?.data?.client_stage;
      return typeof stage === 'string' ? stage : null;
    };

    const signalOf = (d: Record<string, unknown>): string => {
      const status = typeof d.followup_status === 'string' && d.followup_status ? d.followup_status : 'open';
      if (['completed', 'cancelled', 'skipped'].includes(status)) return 'done';
      const wa = typeof d.whatsapp_state === 'string' ? d.whatsapp_state : '';
      if (wa === 'replied' || (!wa && typeof d.client_messaged_at === 'string' && d.client_messaged_at)) return 'replied';
      return 'open';
    };

    const firstId = (v: unknown): string | null => {
      if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
      return typeof v === 'string' && v ? v : null;
    };

    const mine = (d: Record<string, unknown>): boolean => {
      const rep = firstId(d.sales_rep);
      return !rep || rep === currentUserId;
    };

    // First pass: seed the baseline silently.
    if (seenRef.current === null) {
      const seed = new Map<string, string>();
      for (const r of followups) seed.set(r.id, signalOf(r.data as Record<string, unknown>));
      seenRef.current = seed;
      return;
    }

    const seen = seenRef.current;
    const notify = (title: string, body: string, followupId: string) => {
      addToast(`${title} — ${body}`, 'info');
      try {
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'default') void Notification.requestPermission();
          if (Notification.permission === 'granted') {
            const n = new Notification(title, { body, tag: `followup-${followupId}` });
            n.onclick = () => {
              window.focus();
              navigate(`/model/followups/${followupId}?returnTo=${encodeURIComponent('/sales/my-tasks')}`);
              n.close();
            };
          }
        }
      } catch (err) {
        // Notification API unavailable (unsupported browser / insecure context)
        // — the toast above already surfaced the event.
        console.error('[SalesNotifications] Notification failed:', err);
      }
    };

    for (const r of followups) {
      const d = r.data as Record<string, unknown>;
      const sig = signalOf(d);
      const prev = seen.get(r.id);
      seen.set(r.id, sig);
      if (!mine(d)) continue;

      // NEW row → hot-lead check (first booking call for a brand-new client).
      if (prev === undefined && sig === 'open') {
        const type = Array.isArray(d.followup_type) ? d.followup_type[0] : d.followup_type;
        const stage = clientStage(firstId(d.client_id));
        const ageMs = Date.now() - Date.parse(r.created_at);
        if (type === 'appointment_booking_call' && (!stage || stage === 'جديد') && ageMs < 10 * 60 * 1000) {
          const name = typeof d.client_name === 'string' && d.client_name ? d.client_name : (isAr ? 'عميل جديد' : 'New lead');
          notify(
            isAr ? '🔥 عميل جديد — اتصل خلال ٥ دقائق' : '🔥 New lead — call within 5 minutes',
            name,
            r.id,
          );
        }
        continue;
      }

      // Transition → customer replied / messaged.
      if (prev !== undefined && prev !== 'replied' && sig === 'replied') {
        const name = typeof d.client_name === 'string' && d.client_name ? d.client_name : (isAr ? 'عميل' : 'A client');
        notify(
          isAr ? '💬 العميل رد — دورك الآن' : '💬 Customer replied — your turn',
          name,
          r.id,
        );
      }
    }

    // Drop rows that vanished (deleted) so the map doesn't grow forever.
    if (seen.size > followups.length * 2) {
      const live = new Set(followups.map((r) => r.id));
      for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
    }
  }, [followups, clients, currentUserId, isAr, addToast, navigate]);

  return null;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { enqueueRegaLookup } from './client';

/**
 * Shared "التواصل مع المعلن" state machine for a market_listings record —
 * used by the record-form panel AND the compact Contact button on Project
 * Finder cards / client option cards. One flow:
 *   • Advertiser phone already on the listing → open the WhatsApp chat
 *     immediately (no scrape).
 *   • Otherwise → enqueue a REGA lookup job; the Fly worker scrapes the
 *     official advertising-license page and writes advertiser_phone onto the
 *     listing. The store's Realtime subscription merges that write (slimmed)
 *     into records[market_listings], this hook sees it land, and auto-opens
 *     the chat. Later clicks hit the cached phone and open the chat directly.
 *
 * The worker owns all record writes; this hook only READS the store record.
 * The listing is resolved by id from the market_listings slim store (which
 * carries advertiser_phone / rega_lookup_* / advertiser / external_id), so
 * callers only need the record id — no full record load required.
 */
export function useContactAdvertiser(listingId: string) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const tr = (ar: string, en: string) => (isAr ? ar : en);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);
  // The listing's rega_lookup_at BEFORE this run — a fresh terminal result is
  // detected by this server-authored timestamp CHANGING (no client/server clock
  // comparison). Only terminal outcomes write rega_lookup_at.
  const prevRegaAtRef = useRef<string | null>(null);

  const model = models.find((m) => m.name === 'market_listings');
  const listing = model ? (records[model.id] ?? []).find((r) => r.id === listingId) : undefined;
  const data = (listing?.data ?? {}) as Record<string, unknown>;

  const advertiserPhone = typeof data.advertiser_phone === 'string' ? data.advertiser_phone.trim() : '';
  const advertiserName = typeof data.advertiser_name === 'string' ? data.advertiser_name : '';
  const status = typeof data.rega_lookup_status === 'string' ? data.rega_lookup_status : '';
  const regaError = typeof data.rega_lookup_error === 'string' ? data.rega_lookup_error : '';
  const regaAt = typeof data.rega_lookup_at === 'string' ? data.rega_lookup_at : null;
  const advertiserId = typeof data.advertiser === 'string' ? data.advertiser : '';
  const sourceUrl = typeof data.source_url === 'string' ? data.source_url : '';
  const externalId = typeof data.external_id === 'string' ? data.external_id : String(data.external_id ?? '');

  const aqarLink = sourceUrl || (externalId ? `https://sa.aqar.fm/ad/${externalId}/ar` : '');
  const chatBody = aqarLink
    ? tr(`السلام عليكم، بخصوص إعلانكم على عقار:\n${aqarLink}`, `Hello, regarding your Aqar listing:\n${aqarLink}`)
    : '';

  // Watch for a fresh terminal result while a lookup is in flight.
  useEffect(() => {
    if (!pending) return;
    if (advertiserPhone && status === 'done') {
      setPending(false);
      setShowChat(true);
      return;
    }
    if ((status === 'no_license' || status === 'failed') && regaAt && regaAt !== prevRegaAtRef.current) {
      setPending(false);
      setError(regaError || tr('تعذّر جلب رقم المعلن.', 'Could not fetch the advertiser phone.'));
    }
  }, [pending, advertiserPhone, status, regaAt, regaError, tr]);

  const clearError = useCallback(() => setError(null), []);

  const startContact = async () => {
    setError(null);
    // Cached — skip the scrape and open the chat immediately.
    if (advertiserPhone) {
      setShowChat(true);
      return;
    }
    prevRegaAtRef.current = regaAt;
    setPending(true);
    try {
      await enqueueRegaLookup(listingId);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    advertiserPhone,
    advertiserName,
    advertiserId,
    pending,
    error,
    clearError,
    showChat,
    setShowChat,
    chatBody,
    startContact,
  };
}

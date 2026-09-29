import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, Loader2, ChevronUp, ChevronDown, RefreshCw, Check, AlertTriangle, Map as MapIcon, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { pruneGeoExpression, type PrunableExpression } from '@/lib/geo/pruneGeoExpression';
import { shouldAutoRead } from '@/lib/geo/geoCardAutoRead';
import { callJson, HttpError } from '../lib/cardHttp';
import PrefSuggestionsSection, { type PrefsCardDTO } from './PrefSuggestionsSection';
import CallAuditSection from './CallAuditSection';
import GeoLineGroups from './GeoLineGroups';
import { buildGeoRows, GEO_OPEN, GEO_SAVED, type GeoCardDTO, type GeoRow } from '../lib/geoRows';

const GeoPrefMap = lazy(() => import('@/pages/GeoGrade/components/GeoPrefMap'));

/**
 * «تفضيلات العميل» — the preference confirm card (geography + specs/budget) inside a client-linked WhatsApp chat.
 *
 * The geography ability reads THIS conversation and says where the customer
 * wants to buy (and where not). The rep ticks/unticks each line and taps
 * «احفظ في ملف العميل» — the rep's tap is the safety check: nothing reaches
 * the client record without it. Saving goes through
 * POST /api/geo-preference/review (confirm = all lines, edit = the pruned
 * expression; dismiss = reject). Reading the chat goes through
 * /api/geo-preference/chat-card, which never writes a client record.
 *
 * The same reading also runs the PREFERENCE agent (budget, unit type, area,
 * bedrooms, purpose, amenities); its proposal renders below the places
 * (PrefSuggestionsSection) and saves through /api/client-prefs/review. The
 * card reads on its own when the customer has written something unread
 * (trigger 'open'); the per-minute cron reads the rest.
 *
 * The CALL AUDIT's proposals for this client (preferences the customer said on
 * a Hatif call that are EMPTY on the client) render just above the chat's own
 * preference section (CallAuditSection) and save fill-empty-only. Since
 * 2026-09-29 each call block also carries the PLACES the audit read from the
 * call (only proposed for a client with no places; the save refuses once the
 * client has places). Both the chat's lines and a call's lines render through
 * the shared GeoLineGroups / buildGeoRows.
 */

interface ChatCardDTO extends GeoCardDTO {
  prefs: PrefsCardDTO;
}

interface ReadResultDTO {
  outcome: string;
  geo: { ran: boolean; mode?: string; error?: string };
  prefs: { ran: boolean; proposalId?: string | null; fields?: number; error?: string };
}

const SAVED = GEO_SAVED;
const OPEN = GEO_OPEN;

export default function GeoPrefCard({ clientId, chatWid }: { clientId: string; chatWid: string }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const { t } = useTranslation();
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const [card, setCard] = useState<ChatCardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [showMap, setShowMap] = useState(false);
  // Call-audit saves in this session: the fields skipped because they were
  // logged since the call, per proposal (the section unmounts on reload).
  const [callSkipped, setCallSkipped] = useState<Record<string, string[]>>({});
  const onCallSaved = useCallback((proposalId: string, skipped: string[]) => {
    setCallSkipped((prev) => ({ ...prev, [proposalId]: skipped }));
  }, []);

  // Collapse state, persisted GLOBALLY (one preference across all chats), like the study card.
  const COLLAPSE_KEY = 'wassell_geo_pref_card_collapsed';
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const setCollapsedPersist = (v: boolean) => {
    // Private mode / blocked storage: the preference just isn't remembered.
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch (err) { console.error('[GeoPrefCard] could not persist collapse state:', err); }
    setCollapsed(v);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = `clientId=${encodeURIComponent(clientId)}&chatWid=${encodeURIComponent(chatWid)}`;
      const c = await callJson<ChatCardDTO>(`/api/geo-preference/chat-card?${q}`, { method: 'GET' });
      setCard(c);
      setUnticked(new Set());
      setPrefsError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeoPrefCard] load failed:', err);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [clientId, chatWid]);

  useEffect(() => { void load(); }, [load]);

  const analyze = async (trigger: 'open' | 'manual') => {
    setAnalyzing(true);
    try {
      const c = await callJson<ChatCardDTO & { mode: string; read: ReadResultDTO }>('/api/geo-preference/chat-card', {
        method: 'POST', body: JSON.stringify({ action: 'analyze', clientId, chatWid, trigger }),
      });
      setCard(c);
      setUnticked(new Set());
      setLoadError(null);
      // An agent failure is not an HTTP error — the reading reports it per agent.
      setPrefsError(c.read?.prefs?.error ?? null);
      if (c.read?.geo?.error) {
        console.error('[GeoPrefCard] geography agent failed:', c.read.geo.error);
        addToast(isAr ? `تعذّرت قراءة المواقع: ${c.read.geo.error}` : `Could not read the locations: ${c.read.geo.error}`, 'error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeoPrefCard] analyze failed:', err);
      addToast(isAr ? `تعذّرت قراءة المحادثة: ${msg}` : `Could not read the chat: ${msg}`, 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  // Read on its own when there is something new to read (geoCardAutoRead.ts),
  // at most once per mount so a failed reading can't loop.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!card || loading || analyzing || autoTried.current) return;
    if (!shouldAutoRead({ ...card, unread_customer_messages: card.prefs?.unread_customer_messages ?? 0 })) return;
    autoTried.current = true;
    void analyze('open');
    // analyze is recreated each render; the ref guard is what bounds this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, loading, analyzing]);

  const rows: GeoRow[] = useMemo(() => buildGeoRows(card, isAr), [card, isAr]);

  const ticked = (r: GeoRow) => r.savable && !unticked.has(r.evidenceId);
  const tickedRows = rows.filter(ticked);
  const mapItems = useMemo(() => {
    const p = card?.proposal;
    if (!p) return [];
    return rows.filter((r) => r.savable && !unticked.has(r.evidenceId)).flatMap((r) => p.items_by_evidence[r.evidenceId] ?? []);
  }, [card, rows, unticked]);

  const review = async (action: 'confirm' | 'edit' | 'reject', finalExpression?: PrunableExpression) => {
    const p = card?.proposal;
    if (!p) return;
    setSaving(true);
    try {
      await callJson<unknown>('/api/geo-preference/review', {
        method: 'POST',
        body: JSON.stringify({ proposalId: p.id, action, expectedVersion: p.version, ...(finalExpression ? { finalExpression } : {}) }),
      });
      addToast(
        action === 'reject'
          ? (isAr ? 'تم تجاهل القراءة' : 'Reading dismissed')
          : (isAr ? 'حُفظت في تفضيلات العميل' : 'Saved to the client’s preferences'),
        'success',
      );
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeoPrefCard] review failed:', err);
      if (err instanceof HttpError && err.status === 409) {
        addToast(isAr ? `تغيّرت القراءة (حسمها شخص آخر) — أعدنا تحميلها: ${msg}` : `This reading changed (someone else resolved it) — reloaded: ${msg}`, 'error');
        await load();
      } else {
        addToast(isAr ? `تعذّر الحفظ: ${msg}` : `Save failed: ${msg}`, 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const p = card?.proposal;
    if (!p || tickedRows.length === 0) return;
    const drop = rows.filter((r) => !ticked(r)).map((r) => r.evidenceId);
    if (drop.length === 0) void review('confirm');
    else void review('edit', pruneGeoExpression(p.expression, drop));
  };

  const toggle = (id: string) => setUnticked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const status = card?.status ?? null;
  const statusLabel = (() => {
    if (loading) return '';
    if (analyzing) return isAr ? 'يقرأ…' : 'reading…';
    if (!status) return '';
    if (status === 'none') return isAr ? 'لم تُقرأ' : 'not read';
    if (status === 'empty') return isAr ? 'لا أماكن' : 'no places';
    if (OPEN.has(status)) return rows.length ? (isAr ? 'بانتظار حفظك' : 'awaiting your save') : (isAr ? 'لا أماكن' : 'no places');
    if (SAVED.has(status)) return isAr ? '✓ محفوظة' : '✓ saved';
    return isAr ? 'متجاهلة' : 'dismissed';
  })();

  if (collapsed) {
    return (
      <div className="px-3 pt-1 shrink-0">
        <button
          onClick={() => setCollapsedPersist(false)}
          className="w-full flex items-center justify-center gap-1 rounded-md border border-sand/60 bg-cream/40 py-0.5 text-[10px] text-charcoal/45 hover:text-copper hover:border-copper/40 transition-colors"
          title={t('chats.prefs.card_show')}
        >
          <ChevronDown size={11} />
          <MapPin size={10} />
          {t('chats.prefs.card_title')}
          {(status && OPEN.has(status) && rows.length > 0) || card?.prefs?.proposal?.status === 'pending'
            || (card?.prefs?.call_proposals ?? []).some((p) => p.status === 'pending')
            || (card?.prefs?.call_geo ?? []).some((g) => g.card.proposal?.id === g.proposal_id && OPEN.has(g.card.proposal.status))
            ? <span className="text-copper font-bold">•</span>
            : null}
        </button>
      </div>
    );
  }

  const reread = (label?: string) => (
    <button
      onClick={() => void analyze('manual')}
      disabled={analyzing || !card?.can_reanalyze}
      title={!card?.can_reanalyze ? (isAr ? 'قُرئت قبل لحظات — انتظر دقيقة' : 'Read a moment ago — wait a minute') : undefined}
      className="inline-flex items-center gap-1 rounded-full border border-copper/40 px-2.5 py-1 text-[11px] font-medium text-copper hover:bg-copper/10 transition-colors disabled:opacity-40"
    >
      <RefreshCw size={11} />
      {label ?? (isAr ? 'أعد القراءة' : 'Read again')}
    </button>
  );

  const open = !!status && OPEN.has(status);
  const saved = !!status && SAVED.has(status);
  const missed = card?.proposal?.verifier?.missed ?? [];

  return (
    <div className="px-3 pt-2 shrink-0" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Capped at ~40% of the viewport with its own scroll — at full height a
          nine-place reading (plus the map) pushed the conversation off screen
          (seen live 2026-09-27). The chat must always stay readable. */}
      <div className="rounded-xl border border-sand bg-white px-3 py-2 max-h-[40vh] overflow-y-auto overscroll-contain">
        {/* Header */}
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-copper shrink-0" />
          <span className="text-[12px] font-bold text-chocolate">{t('chats.prefs.card_title')}</span>
          {statusLabel && <span className="text-[10.5px] text-charcoal/50">· {statusLabel}</span>}
          {(card?.prefs?.unread_voice_notes ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"
              title={t('chats.prefs.voice_notes', { count: card?.prefs?.unread_voice_notes ?? 0 })}
            >
              <Mic size={10} />
              {card?.prefs?.unread_voice_notes}
            </span>
          )}
          <button
            onClick={() => setCollapsedPersist(true)}
            className="ms-auto text-charcoal/30 hover:text-copper transition-colors"
            title={t('chats.prefs.card_hide')}
          >
            <ChevronUp size={14} />
          </button>
        </div>

        {/* Loading / load error */}
        {loading && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-charcoal/50">
            <Loader2 size={12} className="animate-spin text-copper" />
            {isAr ? 'تحميل…' : 'Loading…'}
          </p>
        )}
        {!loading && loadError && (
          <div className="mt-1 flex items-center gap-2 text-[11px] text-red-600">
            <AlertTriangle size={12} className="shrink-0" />
            <span className="flex-1">{isAr ? `تعذّر التحميل: ${loadError}` : `Load failed: ${loadError}`}</span>
            <button onClick={() => void load()} className="text-copper hover:underline">{isAr ? 'إعادة المحاولة' : 'Retry'}</button>
          </div>
        )}

        {/* Analyzing */}
        {analyzing && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-charcoal/60">
            <Loader2 size={12} className="animate-spin text-copper" />
            {isAr ? 'أقرأ المحادثة… قد يأخذ دقيقة' : 'Reading the chat… this can take a minute'}
          </p>
        )}

        {!loading && !loadError && card && !analyzing && (card.prefs?.pending_transcripts ?? 0) > 0 && (
          <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-amber-700">
            <Mic size={11} className="shrink-0" />
            {t('chats.prefs.transcribing')}
          </p>
        )}

        {!loading && !loadError && card && !analyzing && (
          <>
            {/* Stale — on any state */}
            {card.stale && status !== 'none' && (
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-charcoal/55">
                <span className="flex-1">
                  {isAr ? 'رسائل جديدة منذ آخر قراءة' : 'New messages since the last reading'}
                  {card.graded && (isAr ? ' — هذه المحادثة مقيَّمة، فلن تُعاد قراءتها من جديد' : ' — this conversation is graded, so it will not be re-read from scratch')}
                </span>
                {!card.graded && reread(isAr ? 'حدّث' : 'Refresh')}
              </div>
            )}

            {/* Never read */}
            {status === 'none' && (
              <div className="mt-1 flex items-center gap-2">
                <span className="flex-1 text-[11px] text-charcoal/60">{isAr ? 'لم تُقرأ هذه المحادثة بعد' : 'This chat has not been read yet'}</span>
                <Button className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void analyze('manual')} disabled={analyzing}>
                  <MapPin size={12} />
                  {isAr ? 'اقرأ المواقع' : 'Read locations'}
                </Button>
              </div>
            )}

            {/* Read, nothing placed */}
            {(status === 'empty' || (open && rows.length === 0)) && (
              <div className="mt-1 flex items-center gap-2">
                <span className="flex-1 text-[11px] text-charcoal/60">{isAr ? 'لم يذكر العميل أماكن بعد' : 'The customer has not mentioned any places yet'}</span>
                {reread()}
              </div>
            )}

            {/* Open proposal — tick/untick, save, dismiss */}
            {open && rows.length > 0 && (
              <>
                {status === 'must_confirm' && (
                  <p className="mt-1 text-[10.5px] text-amber-700">{isAr ? 'عُلِّمت: تحتاج تأكيد العميل أولًا' : 'Marked: the customer must confirm first'}</p>
                )}
                <GeoLineGroups rows={rows} withBox isTicked={ticked} onToggle={toggle} disabled={saving} isAr={isAr} />
                {missed.length > 0 && (
                  <p className="mt-1 text-[10.5px] text-charcoal/45">
                    {isAr ? 'قد يكون العميل ذكر أيضًا: ' : 'The customer may also have mentioned: '}
                    {missed.map((m) => `«${m.span}»`).join(isAr ? '، ' : ', ')}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Button className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={save} disabled={saving || tickedRows.length === 0}>
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    {isAr ? 'احفظ في ملف العميل' : 'Save to client'}
                  </Button>
                  <Button variant="ghost" className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void review('reject')} disabled={saving}>
                    {isAr ? 'تجاهل' : 'Dismiss'}
                  </Button>
                  <button
                    onClick={() => setShowMap((v) => !v)}
                    className="ms-auto inline-flex items-center gap-1 text-[11px] text-charcoal/50 hover:text-copper"
                  >
                    <MapIcon size={11} />
                    {showMap ? (isAr ? 'إخفاء الخريطة' : 'Hide map') : (isAr ? 'إظهار الخريطة' : 'Show map')}
                  </button>
                </div>
              </>
            )}

            {/* Saved */}
            {saved && (
              <>
                <p className="mt-1 text-[11px] font-bold text-green-700">{isAr ? '✓ حُفظت في تفضيلات العميل' : '✓ Saved to the client’s preferences'}</p>
                <GeoLineGroups rows={rows} withBox={false} isTicked={ticked} onToggle={toggle} disabled isAr={isAr} />
                <div className="mt-1.5 flex items-center gap-2">
                  {card.stale && !card.graded && reread()}
                  {rows.length > 0 && (
                    <button
                      onClick={() => setShowMap((v) => !v)}
                      className="ms-auto inline-flex items-center gap-1 text-[11px] text-charcoal/50 hover:text-copper"
                    >
                      <MapIcon size={11} />
                      {showMap ? (isAr ? 'إخفاء الخريطة' : 'Hide map') : (isAr ? 'إظهار الخريطة' : 'Show map')}
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Dismissed / replaced */}
            {(status === 'rejected' || status === 'superseded') && (
              <div className="mt-1 flex items-center gap-2">
                <span className="flex-1 text-[11px] text-charcoal/60">{isAr ? 'تم تجاهل القراءة' : 'The reading was dismissed'}</span>
                {reread()}
              </div>
            )}

            {/* Map (of the ticked / saved lines) */}
            {showMap && (open || saved) && rows.length > 0 && (
              <div className="mt-2">
                <Suspense fallback={<Loader2 size={14} className="animate-spin text-copper" />}>
                  <GeoPrefMap items={saved ? (card.proposal?.items ?? []) : mapItems} isAr={isAr} height={220} />
                </Suspense>
              </div>
            )}

            {/* Preferences the customer said on a call but the client does not have (call audit) */}
            {((card.prefs?.call_proposals ?? []).length > 0 || (card.prefs?.call_geo ?? []).length > 0) && (
              <CallAuditSection
                proposals={card.prefs.call_proposals ?? []}
                geo={card.prefs.call_geo ?? []}
                onReload={load}
                skippedById={callSkipped}
                onSaved={onCallSaved}
              />
            )}

            {/* Preferences read from the same conversation (budget, unit type, …) */}
            {card.prefs && <PrefSuggestionsSection prefs={card.prefs} prefsError={prefsError} onReload={load} />}
          </>
        )}
      </div>
    </div>
  );
}

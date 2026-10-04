import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MapPin, Loader2, ChevronUp, ChevronDown, RefreshCw, AlertTriangle, Map as MapIcon, Mic, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { pruneGeoExpression, type PrunableExpression } from '@/lib/geo/pruneGeoExpression';
import { shouldAutoRead } from '@/lib/geo/geoCardAutoRead';
import { dateTimeShort, num } from '@/pages/Marketing/lib/format';
import type { AppRecord } from '@/types';
import type { ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';
import ChatSpecsSlide, { type PrefsCardDTO } from './PrefSuggestionsSection';
import { CallPlacesSlide, CallSpecsSlide } from './CallAuditSection';
import PlaceTiles from './PlaceTiles';
import PrefCardSlider, { type SliderSlide } from './PrefCardSlider';
import { SlideBody, SlideDoneView, SlideFooter } from './SlideParts';
import OutcomeSuggestionSlide from './OutcomeSuggestionSlide';
import AiChangesSection from './AiChangesSection';
import { AI_TABS, defaultAiTab, type AiTab } from '../lib/aiSuggestions';
import type { ChatOutcomeSuggestionState } from '../lib/useChatOutcomeSuggestion';
import { buildGeoRows, GEO_OPEN, type GeoCardDTO, type GeoRow } from '../lib/geoRows';
import {
  buildCardSlides, callDayMonth, mergeDoneSlides,
  type DoneEntry, type SlideDone, type VisibleSlide,
} from '../lib/cardSlides';

const GeoPrefMap = lazy(() => import('@/pages/GeoGrade/components/GeoPrefMap'));

/**
 * «اقتراحات الذكاء الاصطناعي» — the AI card inside a client-linked WhatsApp chat
 * (2026-09-29; it was «تفضيلات العميل» until then). Two tabs in its header:
 *   - «تفضيلات العميل» — the preference confirm slider (geography + specs/budget), below;
 *   - «النتائج» — the AI's suggested outcome of the current follow-up
 *     (OutcomeSuggestionSlide). Its data comes from ChatDetail
 *     (useChatOutcomeSuggestion — loaded once per chat, shared with the task bar).
 * Each tab's badge counts what is left to act on; the card opens on the first
 * tab with something (aiSuggestions.defaultAiTab) and then keeps the rep's
 * choice. The task bar's chip asks for «النتائج» through `openTab`.
 *
 * The preferences tab: since 2026-09-29 it is a SLIDER of small topic cards (cardSlides.ts):
 * one slide per thing the rep can still act on — the chat's places, the chat's
 * specs, and per call (newest first) the call audit's places and specs — each
 * a grid of tiles with its own «احفظ المحدد (n)» / «تجاهل». The strip on top
 * carries the pills, ‹ › and «١ / ٤»; with no slides it says «لا جديد».
 *
 * The geography ability reads THIS conversation and says where the customer
 * wants to buy (and where not). The rep ticks/unticks each place and saves —
 * the rep's tap is the safety check: nothing reaches the client record
 * without it. Saving goes through POST /api/geo-preference/review (confirm =
 * all lines, edit = the pruned expression; dismiss = reject). Reading the chat
 * goes through /api/geo-preference/chat-card, which never writes a client record.
 *
 * The same reading also runs the PREFERENCE agent (budget, unit type, area,
 * bedrooms, purpose, amenities); its proposal is the chat's specs slide
 * (ChatSpecsSlide) and saves through /api/client-prefs/review. The card reads
 * on its own when the customer has written something unread (trigger 'open');
 * the per-minute cron reads the rest.
 *
 * The CALL AUDIT's proposals for this client (preferences / places the customer
 * said on a Hatif call that are EMPTY on the client) are the call slides
 * (CallSpecsSlide / CallPlacesSlide) and save fill-empty-only.
 */

interface ChatCardDTO extends GeoCardDTO {
  prefs: PrefsCardDTO;
}

interface ReadResultDTO {
  outcome: string;
  geo: { ran: boolean; mode?: string; error?: string };
  prefs: { ran: boolean; proposalId?: string | null; fields?: number; error?: string };
}

const OPEN = GEO_OPEN;
const COMPACT_BTN = '!px-2.5 !py-0.5 !text-[11px] !rounded-full !gap-1';

interface Props {
  clientId: string;
  chatWid: string;
  /** The client's current follow-up (the «النتائج» tab's task), or null. */
  task: AppRecord | null;
  /** The AI's suggested outcome for `task` (useChatOutcomeSuggestion in ChatDetail). */
  outcome: ChatOutcomeSuggestionState;
  /** Open the completion modal — same contract as the task bar's. */
  onRecordOutcome: (suggestion: ChatOutcomeSuggestion | null, preselect: boolean) => void;
  /** A request to show a tab (un-collapses the card); acknowledged via onOpenTabHandled. */
  openTab?: AiTab | null;
  onOpenTabHandled?: () => void;
}

export default function GeoPrefCard({ clientId, chatWid, task, outcome, onRecordOutcome, openTab, onOpenTabHandled }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const { t } = useTranslation();
  const { fieldLabel } = usePrefFieldFormat();
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const [card, setCard] = useState<ChatCardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [showMap, setShowMap] = useState(false);
  // Slides the rep saved / dismissed in this session: kept (compact) until the
  // chat is re-read, although the post-decision reload no longer returns them.
  const [done, setDone] = useState<Record<string, DoneEntry>>({});

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

  // The tab the rep chose (component state: per chat, for this visit). Until
  // they choose, the card shows the default once both tabs have loaded.
  const [chosenTab, setChosenTab] = useState<AiTab | null>(null);
  // The slide in view on the preferences tab, so switching tabs doesn't lose it.
  const prefSlideKey = useRef<string | null>(null);

  // The task bar's chip: open the card on «النتائج».
  useEffect(() => {
    if (!openTab) return;
    if (collapsed) setCollapsedPersist(false);
    setChosenTab(openTab);
    onOpenTabHandled?.();
    // Only a new request should act; collapsed / the callbacks are read as they are now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab]);

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
      // A new reading replaces what was decided before it.
      setDone({});
      // An agent failure is not an HTTP error — the reading reports it per agent.
      setPrefsError(c.read?.prefs?.error ?? null);
      if (c.read?.geo?.error) {
        console.error('[GeoPrefCard] geography agent failed:', c.read.geo.error);
        addToast(t('chats.prefs.geo_read_failed', { msg: c.read.geo.error }), 'error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeoPrefCard] analyze failed:', err);
      addToast(t('chats.prefs.chat_read_failed', { msg }), 'error');
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
  const freshSlides = useMemo(() => buildCardSlides(card), [card]);
  const slides: VisibleSlide[] = useMemo(() => mergeDoneSlides(freshSlides, done), [freshSlides, done]);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;

  // Remember what the rep did to a slide (snapshot of the slide as it was).
  const markDone = useCallback((key: string, info: SlideDone) => {
    const slide = slidesRef.current.find((s) => s.key === key);
    if (!slide) return;
    // mergeDoneSlides overrides the snapshot's own `done`, so it can be kept as is.
    setDone((prev) => ({ ...prev, [key]: { slide, done: info } }));
  }, []);

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
      markDone('chat-places', { action: action === 'reject' ? 'dismissed' : 'saved' });
      addToast(action === 'reject' ? t('chats.prefs.geo_dismissed') : t('chats.prefs.geo_saved'), 'success');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeoPrefCard] review failed:', err);
      if (err instanceof HttpError && err.status === 409) {
        addToast(t('chats.prefs.geo_conflict', { msg }), 'error');
        await load();
      } else {
        addToast(t('chats.prefs.save_failed', { msg }), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const p = card?.proposal;
    if (!p || tickedRows.length === 0) return;
    const drop = rows.filter((r) => !ticked(r)).flatMap((r) => r.evidenceIds);
    if (drop.length === 0) void review('confirm');
    else void review('edit', pruneGeoExpression(p.expression, drop));
  };

  const toggle = (id: string) => setUnticked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const status = card?.status ?? null;

  // The tabs' badges: what is left to act on in each.
  const prefCount = slides.filter((s) => !s.done).length;
  const outcomeCount = outcome.live ? 1 : 0;
  const counts: Record<AiTab, number> = { prefs: prefCount, outcome: outcomeCount };
  // Settle the default once both tabs have loaded; from then on it is the rep's.
  const prefsLoaded = !loading || !!card;
  useEffect(() => {
    if (chosenTab || !prefsLoaded || !outcome.loaded) return;
    setChosenTab(defaultAiTab(prefCount, outcomeCount));
  }, [chosenTab, prefsLoaded, outcome.loaded, prefCount, outcomeCount]);
  // Until both sides have loaded, stay on the preferences tab (it carries the
  // loading state) — falling back to defaultAiTab here showed «النتائج» for a
  // moment and then jumped to the preferences once they arrived (seen live
  // 2026-09-29).
  const tab: AiTab = chosenTab ?? (prefsLoaded && outcome.loaded ? defaultAiTab(prefCount, outcomeCount) : 'prefs');

  if (collapsed) {
    return (
      <div className="px-3 pt-1 shrink-0">
        <button
          onClick={() => setCollapsedPersist(false)}
          className="w-full flex items-center justify-center gap-1 rounded-md border border-sand/60 bg-cream/40 py-0.5 text-[10px] text-charcoal/45 hover:text-copper hover:border-copper/40 transition-colors"
          title={t('chats.ai.card_show')}
        >
          <ChevronDown size={11} />
          <Sparkles size={10} />
          {t('chats.ai.card_title')}
          {freshSlides.length > 0 || outcomeCount > 0 ? <span className="text-copper font-bold">•</span> : null}
        </button>
      </div>
    );
  }

  const open = !!status && OPEN.has(status);
  const missed = card?.proposal?.verifier?.missed ?? [];
  const staleText = card?.stale && status !== 'none'
    ? t(card.graded ? 'chats.prefs.stale_graded' : 'chats.prefs.stale')
    : null;
  const lastReadAt = card?.prefs?.read_state?.last_read_at ?? card?.analyzed_at ?? null;

  const rereadButton = (compact: boolean) => (
    <button
      onClick={() => void analyze('manual')}
      disabled={analyzing || !card?.can_reanalyze}
      title={!card?.can_reanalyze ? t('chats.prefs.reread_wait') : (staleText ?? t('chats.prefs.reread'))}
      aria-label={t('chats.prefs.reread')}
      className={`relative inline-flex items-center gap-1 rounded-full border border-copper/40 text-[11px] font-medium text-copper hover:bg-copper/10 transition-colors disabled:opacity-40 ${compact ? 'p-1' : 'px-2.5 py-0.5'}`}
    >
      <RefreshCw size={11} />
      {!compact && t('chats.prefs.reread')}
      {compact && staleText && <span className="absolute -top-0.5 -end-0.5 h-1.5 w-1.5 rounded-full bg-copper" />}
    </button>
  );
  const readButton = (
    <Button className={COMPACT_BTN} onClick={() => void analyze('manual')} disabled={analyzing}>
      <MapPin size={12} />
      {t('chats.prefs.read_locations')}
    </Button>
  );
  // With slides on screen the re-read shows where it always did: nothing to act
  // on in the chat's own reading, or new messages on a reading that can be redone.
  const rereadWithSlides = !!card && (
    status === 'empty' || status === 'rejected' || status === 'superseded' || (open && rows.length === 0)
    || (!!card.stale && status !== 'none' && !card.graded)
  );

  // The card's own header: icon, title, voice-note badge, the two tabs, collapse.
  const header = (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <Sparkles size={14} className="text-copper shrink-0" />
      <span className="text-[12px] font-bold text-chocolate whitespace-nowrap">{t('chats.ai.card_title')}</span>
      {(card?.prefs?.unread_voice_notes ?? 0) > 0 && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"
          title={t('chats.prefs.voice_notes', { count: card?.prefs?.unread_voice_notes ?? 0 })}
        >
          <Mic size={10} />
          {card?.prefs?.unread_voice_notes}
        </span>
      )}
      <div
        className="inline-flex items-center rounded-full border border-sand bg-cream/40 p-0.5"
        role="tablist"
        aria-label={t('chats.ai.card_title')}
      >
        {AI_TABS.map((k) => {
          const active = k === tab;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setChosenTab(k)}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold transition-colors ${
                active ? 'bg-copper text-white' : 'text-charcoal/70 hover:text-copper'
              }`}
            >
              <span className="whitespace-nowrap">{t(k === 'prefs' ? 'chats.ai.tab_prefs' : 'chats.ai.tab_outcome')}</span>
              <span
                className={`rounded-full px-1 text-[9.5px] leading-4 ${
                  active ? 'bg-white/25 text-white' : counts[k] > 0 ? 'bg-copper/15 text-copper' : 'bg-sand/50 text-chocolate'
                }`}
              >
                {num(counts[k], isAr)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="ms-auto flex items-center gap-1.5">
        <button
          onClick={() => setCollapsedPersist(true)}
          className="text-charcoal/30 hover:text-copper transition-colors"
          title={t('chats.ai.card_hide')}
          aria-label={t('chats.ai.card_hide')}
        >
          <ChevronUp size={14} />
        </button>
      </div>
    </div>
  );

  // The preferences tab's strip end: loading, read / re-read.
  const tail = (
    <>
      {loading && card && <Loader2 size={12} className="animate-spin text-copper" />}
      {slides.length > 0 && card && !analyzing && (status === 'none' ? readButton : rereadWithSlides ? rereadButton(true) : null)}
    </>
  );

  // The strip's middle when nothing is left to act on.
  const emptyLine: ReactNode = !card || analyzing || loadError ? null : status === 'none' ? (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-charcoal/60">{t('chats.prefs.never_read')}</span>
      {readButton}
    </span>
  ) : (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-charcoal/55">
        {staleText ?? t('chats.prefs.nothing_new')}
        {lastReadAt && <> · {t('chats.prefs.last_read', { when: dateTimeShort(lastReadAt, isAr) })}</>}
      </span>
      {rereadButton(false)}
    </span>
  );

  const notices = (
    <>
      {loading && !card && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-charcoal/50">
          <Loader2 size={12} className="animate-spin text-copper" />
          {t('chats.prefs.loading')}
        </p>
      )}
      {!loading && loadError && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-red-600">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="flex-1">{t('chats.prefs.load_failed', { msg: loadError })}</span>
          <button onClick={() => void load()} className="text-copper hover:underline">{t('chats.prefs.retry')}</button>
        </div>
      )}
      {analyzing && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-charcoal/60">
          <Loader2 size={12} className="animate-spin text-copper" />
          {t('chats.prefs.analyzing')}
        </p>
      )}
      {!loadError && card && !analyzing && (card.prefs?.pending_transcripts ?? 0) > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-amber-700">
          <Mic size={11} className="shrink-0" />
          {t('chats.prefs.transcribing')}
        </p>
      )}
      {!loadError && card && !analyzing && prefsError && (
        <p className="mt-1 text-[10.5px] text-amber-700" title={prefsError}>{t('chats.prefs.partial')}</p>
      )}
    </>
  );

  const chatPlacesBody = (
    <SlideBody
      top={status === 'must_confirm' ? (
        <p className="mb-1 text-[10.5px] text-amber-700">{t('chats.prefs.must_confirm')}</p>
      ) : undefined}
      bottom={missed.length > 0 ? (() => {
        const text = t('chats.prefs.missed', { spans: missed.map((m) => `«${m.span}»`).join(isAr ? '، ' : ', ') });
        return <p className="mt-1 truncate text-[10.5px] text-charcoal/45" title={text}>{text}</p>;
      })() : undefined}
      footer={(
        <SlideFooter
          tickedCount={tickedRows.length}
          saving={saving}
          onSave={save}
          onDismiss={() => void review('reject')}
          info={t('chats.prefs.places_info')}
          extra={(
            <button
              type="button"
              onClick={() => setShowMap((v) => !v)}
              className={`inline-flex items-center rounded-full p-1 transition-colors ${showMap ? 'bg-copper/10 text-copper' : 'text-charcoal/45 hover:text-copper'}`}
              title={showMap ? t('chats.prefs.hide_map') : t('chats.prefs.show_map')}
              aria-label={showMap ? t('chats.prefs.hide_map') : t('chats.prefs.show_map')}
              aria-pressed={showMap}
            >
              <MapIcon size={13} />
            </button>
          )}
          isAr={isAr}
        />
      )}
    >
      <PlaceTiles rows={rows} names={card?.names ?? {}} isTicked={ticked} onToggle={toggle} disabled={saving} isAr={isAr} />
    </SlideBody>
  );

  const doneDetail = (d: SlideDone): ReactNode => {
    const labels = (slugs: readonly string[]) => slugs.map((s) => fieldLabel(s)).join(isAr ? '، ' : ', ');
    return (
      <>
        {d.action === 'saved' && d.nothingAdded && (
          <p className="text-[10.5px] text-charcoal/55">{t('chats.prefs.call_nothing_added')}</p>
        )}
        {d.skipped && d.skipped.length > 0 && (
          <p className="text-[10.5px] text-amber-700">{t('chats.prefs.call_skipped', { fields: labels(d.skipped) })}</p>
        )}
      </>
    );
  };

  const slideBody = (s: VisibleSlide): ReactNode => {
    if (s.done) return <SlideDoneView action={s.done.action} detail={doneDetail(s.done)} />;
    if (!card) return null;
    switch (s.kind) {
      case 'chat-places':
        return chatPlacesBody;
      case 'chat-specs':
        return <ChatSpecsSlide key={s.proposalId} prefs={card.prefs} onReload={load} onDone={(action) => markDone(s.key, { action })} />;
      case 'call-specs':
        return <CallSpecsSlide key={s.proposalId} proposal={s.proposal} onReload={load} onDone={(d) => markDone(s.key, d)} />;
      case 'call-places':
        return <CallPlacesSlide key={s.proposalId} geo={s.geo} onReload={load} onDone={(d) => markDone(s.key, d)} />;
    }
  };

  const sliderSlides: SliderSlide[] = slides.map((s) => {
    const topic = s.kind === 'chat-places' || s.kind === 'call-places' ? 'places' : 'specs';
    const source = s.kind === 'chat-places' || s.kind === 'chat-specs'
      ? t('chats.prefs.pill_chat')
      : t('chats.prefs.pill_call', { date: callDayMonth(s.callAt, isAr) }).trim();
    return {
      key: s.key,
      icon: topic,
      label: `${t(topic === 'places' ? 'chats.prefs.pill_places' : 'chats.prefs.pill_specs')} · ${source}`,
      count: s.count,
      done: !!s.done,
      body: slideBody(s),
    };
  });

  return (
    <div className="px-3 pt-2 shrink-0" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Each slide caps its own height (~260 px) so the whole card stays well
          under the chat; the outer cap only matters when the map is open. */}
      <div className="rounded-xl border border-sand bg-white px-3 py-2 max-h-[70vh] overflow-y-auto overscroll-contain">
        {header}
        <div className="mt-1.5" role="tabpanel">
          {tab === 'outcome' ? (
            <OutcomeSuggestionSlide
              key={outcome.live?.id ?? 'none'}
              live={outcome.live}
              task={task}
              dismissing={outcome.dismissing}
              onDismiss={() => void outcome.dismiss()}
              onRecordOutcome={onRecordOutcome}
              isAr={isAr}
            />
          ) : (
            <PrefCardSlider
              slides={sliderSlides}
              lead={<AiChangesSection clientId={clientId} refreshKey={card?.analyzed_at ?? ''} isAr={isAr} />}
              tail={tail}
              emptyLine={emptyLine}
              notices={notices}
              hideSlides={analyzing || !!loadError}
              below={(activeKey) => {
                const s = slides.find((x) => x.key === activeKey);
                if (!showMap || !s || s.kind !== 'chat-places' || s.done || rows.length === 0) return null;
                return (
                  <div className="mt-2">
                    <Suspense fallback={<Loader2 size={14} className="animate-spin text-copper" />}>
                      <GeoPrefMap items={mapItems} isAr={isAr} height={220} />
                    </Suspense>
                  </div>
                );
              }}
              initialKey={prefSlideKey.current}
              onActiveChange={(k) => { prefSlideKey.current = k; }}
              isAr={isAr}
            />
          )}
        </div>
      </div>
    </div>
  );
}

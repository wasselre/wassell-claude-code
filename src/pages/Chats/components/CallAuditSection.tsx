import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { PREF_SLUG_ORDER, isEmptyPrefValue } from '@/lib/clientPrefs/mergePrefs';
import { pruneGeoExpression } from '@/lib/geo/pruneGeoExpression';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';
import { buildGeoRows, GEO_OPEN, type GeoRow } from '../lib/geoRows';
import type { SlideDone } from '../lib/cardSlides';
import PlaceTiles from './PlaceTiles';
import SpecTiles, { type SpecTileItem } from './SpecTiles';
import { SlideBody, SlideFooter } from './SlideParts';
import type { CallGeoDTO, CallProposalDTO } from './PrefSuggestionsSection';

/**
 * The CALL AUDIT's slides inside the chat's preference card — per call, a
 * «الأماكن · مكالمة ٣١/٨» slide (CallPlacesSlide) and a «المواصفات · مكالمة ٣١/٨»
 * slide (CallSpecsSlide); the card's slider (cardSlides.ts) decides which exist.
 *
 * The audit reads each finished Hatif call once and proposes ONLY what the
 * customer said that is EMPTY on the client. Saving (POST
 * /api/client-prefs/review) is fill-empty-only too: a field someone filled
 * since the call is skipped on the server, never overwritten. Here such a tile
 * already shows unticked + disabled («سُجّلت بعد المكالمة»), because the card
 * carries each proposal's FRESH current values.
 *
 * PLACES (2026-09-29): each call also has the places the audit read from the
 * call — the same tiles as the chat's own places (PlaceTiles), tick + save /
 * dismiss through POST /api/geo-preference/review (confirm / edit with the
 * pruned expression / reject — the chat card's request shapes). The audit
 * proposes places ONLY for a client with none, and the server refuses the save
 * (409 `client_has_places`) once the client has places — so when the card
 * already knows the client has places, save is disabled and says why.
 */

interface ReviewOutcomeDTO {
  saved_fields: string[];
  skipped_filled?: string[];
}

/** The server's 409 message for a call-audit geo save on a client that now has places (api/geo-preference/review.ts CLIENT_HAS_PLACES). */
const CLIENT_HAS_PLACES = 'client_has_places';

/** A call's «المواصفات» slide: the audit's six fields, fill-empty-only. */
export function CallSpecsSlide({ proposal, onReload, onDone }: {
  proposal: CallProposalDTO;
  onReload: () => Promise<void>;
  /** The rep saved / dismissed — the card shows a done state (with the skipped fields) in its place. */
  onDone: (done: SlideDone) => void;
}) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { isAr, fieldLabel, formatValue } = usePrefFieldFormat();
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const rows = PREF_SLUG_ORDER
    .filter((slug) => proposal.suggestions?.[slug])
    .map((slug) => ({
      slug,
      sug: proposal.suggestions[slug]!,
      // Filled since the call ⇒ never saved from here (the server skips it too).
      filled: !isEmptyPrefValue(proposal.current_values?.[slug]),
    }));
  const isTicked = (r: { slug: string; filled: boolean }): boolean => !r.filled && !unticked.has(r.slug);
  const tickedSlugs = rows.filter(isTicked).map((r) => r.slug);
  const labels = (slugs: readonly string[]): string => slugs.map((s) => fieldLabel(s)).join(isAr ? '، ' : ', ');

  const toggle = (slug: string) => setUnticked((prev) => {
    const next = new Set(prev);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    return next;
  });

  const decide = async (action: 'save' | 'dismiss') => {
    setSaving(true);
    try {
      const res = await callJson<ReviewOutcomeDTO>('/api/client-prefs/review', {
        method: 'POST',
        body: JSON.stringify({
          proposalId: proposal.id, action, expectedVersion: proposal.version,
          ...(action === 'save' ? { fields: tickedSlugs } : {}),
        }),
      });
      if (action === 'save') {
        const skippedNow = res.skipped_filled ?? [];
        onDone({ action: 'saved', skipped: skippedNow, nothingAdded: (res.saved_fields ?? []).length === 0 });
        addToast(
          skippedNow.length
            ? `${t('chats.prefs.call_added')} — ${t('chats.prefs.call_skipped', { fields: labels(skippedNow) })}`
            : t('chats.prefs.call_added'),
          'success',
        );
      } else {
        onDone({ action: 'dismissed' });
        addToast(t('chats.prefs.call_dismissed'), 'success');
      }
      await onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[CallSpecsSlide] review failed:', err);
      if (err instanceof HttpError && err.status === 409) {
        addToast(`${t('chats.prefs.conflict')}: ${msg}`, 'error');
        await onReload();
      } else {
        addToast(t('chats.prefs.save_failed', { msg }), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  if (proposal.status !== 'pending') return null;

  const items: SpecTileItem[] = rows.map((r) => ({
    slug: r.slug,
    label: fieldLabel(r.slug),
    value: formatValue(r.slug, r.sug.value),
    quote: r.sug.quote,
    ticked: isTicked(r),
    locked: r.filled,
    chip: r.filled ? { text: t('chats.prefs.call_logged_since'), tone: 'warn' } : undefined,
  }));

  return (
    <SlideBody
      footer={(
        <SlideFooter
          tickedCount={tickedSlugs.length}
          saving={saving}
          onSave={() => void decide('save')}
          onDismiss={() => void decide('dismiss')}
          info={t('chats.prefs.call_fill_hint')}
          isAr={isAr}
        />
      )}
    >
      <SpecTiles items={items} onToggle={toggle} disabled={saving} isAr={isAr} />
    </SlideBody>
  );
}

/**
 * A call's «الأماكن» slide: the audit's geo proposal for this call.
 * Save = confirm (all lines) or edit (the pruned expression), dismiss = reject —
 * the same requests the chat's own places send. Fill-empty-only: when the
 * client already has places, save is disabled (and the server refuses it with
 * 409 `client_has_places` if that happened after the card loaded).
 */
export function CallPlacesSlide({ geo, onReload, onDone }: {
  geo: CallGeoDTO;
  onReload: () => Promise<void>;
  onDone: (done: SlideDone) => void;
}) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language === 'ar');
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // A save refused because places appeared after the card loaded (the card reload shows it too).
  const [refused, setRefused] = useState(false);

  const p = geo.card.proposal && geo.card.proposal.id === geo.proposal_id ? geo.card.proposal : null;
  const rows: GeoRow[] = useMemo(() => (p ? buildGeoRows(geo.card, isAr) : []), [p, geo.card, isAr]);
  if (!p || rows.length === 0 || !GEO_OPEN.has(p.status)) return null;

  const hasPlaces = geo.has_places || refused;
  const ticked = (r: GeoRow): boolean => r.savable && !unticked.has(r.evidenceId);
  const tickedCount = rows.filter(ticked).length;
  const toggle = (id: string) => setUnticked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const review = async (action: 'confirm' | 'edit' | 'reject', finalExpression?: typeof p.expression) => {
    setSaving(true);
    try {
      await callJson<unknown>('/api/geo-preference/review', {
        method: 'POST',
        body: JSON.stringify({ proposalId: p.id, action, expectedVersion: p.version, ...(finalExpression ? { finalExpression } : {}) }),
      });
      onDone({ action: action === 'reject' ? 'dismissed' : 'saved' });
      addToast(action === 'reject' ? t('chats.prefs.call_geo_dismissed') : t('chats.prefs.call_geo_saved'), 'success');
      await onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[CallPlacesSlide] places review failed:', err);
      if (err instanceof HttpError && err.status === 409 && msg === CLIENT_HAS_PLACES) {
        setRefused(true);
        addToast(t('chats.prefs.call_geo_has_places'), 'error');
        await onReload();
      } else if (err instanceof HttpError && err.status === 409) {
        addToast(`${t('chats.prefs.conflict')}: ${msg}`, 'error');
        await onReload();
      } else {
        addToast(t('chats.prefs.save_failed', { msg }), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (tickedCount === 0 || hasPlaces) return;
    const drop = rows.filter((r) => !ticked(r)).flatMap((r) => r.evidenceIds);
    if (drop.length === 0) void review('confirm');
    else void review('edit', pruneGeoExpression(p.expression, drop));
  };

  return (
    <SlideBody
      footer={(
        <SlideFooter
          tickedCount={tickedCount}
          saving={saving}
          saveDisabled={hasPlaces}
          onSave={save}
          onDismiss={() => void review('reject')}
          info={t('chats.prefs.call_geo_hint')}
          note={hasPlaces ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-amber-700">
              <AlertTriangle size={11} className="shrink-0" />
              {t('chats.prefs.call_geo_has_places')}
            </span>
          ) : undefined}
          isAr={isAr}
        />
      )}
    >
      <PlaceTiles rows={rows} names={geo.card.names} isTicked={ticked} onToggle={toggle} disabled={saving || hasPlaces} isAr={isAr} />
    </SlideBody>
  );
}

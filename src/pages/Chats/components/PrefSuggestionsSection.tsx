import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { PREF_FIELD_KINDS, PREF_SLUG_ORDER, isSameAsSaved } from '@/lib/clientPrefs/mergePrefs';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';
import type { GeoCardDTO } from '../lib/geoRows';
import SpecTiles, { type SpecTileItem } from './SpecTiles';
import { SlideBody, SlideFooter } from './SlideParts';

/**
 * «المواصفات · المحادثة» — the chat's preference slide of the in-chat card
 * (and the card's shared DTO types).
 *
 * The chat auto-read's preference agent turns the conversation into ONE
 * proposal (budget, unit type, area, bedrooms, purpose, amenities), each line
 * with the customer's own words. Nothing reaches the client until the rep
 * ticks tiles and presses save (POST /api/client-prefs/review): set fields are
 * ADDED to what is saved, ranges REPLACE it (the ⓘ says so). A line that would
 * change nothing starts unticked and carries «مطابق للمحفوظ».
 */

export interface PrefSuggestionDTO {
  slug: string;
  value: unknown;
  quote: string | null;
  confidence: number;
}

/** A call-audit proposal (api/_lib/clientPrefs/card.ts PrefsCardCallProposal). */
export interface CallProposalDTO {
  id: string;
  version: number;
  status: 'pending' | 'saved' | 'dismissed' | 'superseded';
  call_id: string | null;
  call_at: string | null;
  suggestions: Record<string, PrefSuggestionDTO>;
  /** FRESH from the client, this proposal's slugs only — non-empty ⇒ logged since the call. */
  current_values: Record<string, unknown>;
  created_at: string;
  decided_at: string | null;
  saved_fields: string[] | null;
}

export interface PrefsCardDTO {
  proposal: {
    id: string;
    version: number;
    status: 'pending' | 'saved' | 'dismissed' | 'superseded';
    suggestions: Record<string, PrefSuggestionDTO>;
    current_values: Record<string, unknown>;
    model: string;
    created_at: string;
    decided_at: string | null;
    saved_fields: string[] | null;
  } | null;
  read_state: {
    last_read_at: string | null;
    last_trigger: string | null;
    last_outcome: string | null;
    last_error: string | null;
    geo_read_through: string | null;
    pref_read_through: string | null;
  } | null;
  unread_customer_messages: number;
  pending_transcripts: number;
  unread_voice_notes: number;
  current_values: Record<string, unknown>;
  /** The call audit's proposals for this client (optional: an older API build omits it). */
  call_proposals?: CallProposalDTO[];
  /** The call audit's PLACES for this client (optional: an older API build omits it). */
  call_geo?: CallGeoDTO[];
}

/** The places the call audit read from one call (api/_lib/clientPrefs/card.ts PrefsCardCallGeo). */
export interface CallGeoDTO {
  call_id: string;
  call_at: string | null;
  /** The geo proposal the audit minted — the card's proposal is shown only when it IS this one. */
  proposal_id: string;
  card: GeoCardDTO;
  /** FRESH: the client has places now ⇒ saving is refused (fill-empty-only). */
  has_places: boolean;
}

interface Props {
  prefs: PrefsCardDTO;
  onReload: () => Promise<void>;
  /** The rep saved / dismissed this proposal — the card shows a done state in its place. */
  onDone: (action: 'saved' | 'dismissed') => void;
}

/** The chat's «المواصفات» slide: the pending proposal's lines as tiles + save / dismiss. */
export default function ChatSpecsSlide({ prefs, onReload, onDone }: Props) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { isAr, fieldLabel, formatValue } = usePrefFieldFormat();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const proposal = prefs.proposal;
  useEffect(() => { setToggled({}); }, [proposal?.id]);

  const rows = useMemo(() => {
    if (!proposal) return [];
    return PREF_SLUG_ORDER
      .filter((slug) => proposal.suggestions?.[slug])
      .map((slug) => {
        const sug = proposal.suggestions[slug]!;
        const current = prefs.current_values?.[slug] ?? null;
        const same = isSameAsSaved(slug, current, sug.value);
        return { slug, sug, current, same };
      });
  }, [proposal, prefs.current_values]);

  const isTicked = (slug: string, same: boolean): boolean => toggled[slug] ?? !same;
  const tickedSlugs = rows.filter((r) => isTicked(r.slug, r.same)).map((r) => r.slug);

  const decide = async (action: 'save' | 'dismiss') => {
    if (!proposal) return;
    setSaving(true);
    try {
      await callJson<unknown>('/api/client-prefs/review', {
        method: 'POST',
        body: JSON.stringify({
          proposalId: proposal.id, action, expectedVersion: proposal.version,
          ...(action === 'save' ? { fields: tickedSlugs } : {}),
        }),
      });
      addToast(action === 'save' ? t('chats.prefs.saved') : t('chats.prefs.dismissed'), 'success');
      onDone(action === 'save' ? 'saved' : 'dismissed');
      await onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ChatSpecsSlide] review failed:', err);
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

  if (!proposal || proposal.status !== 'pending' || rows.length === 0) return null;

  const items: SpecTileItem[] = rows.map((r) => {
    const currentText = formatValue(r.slug, r.current);
    const hint = PREF_FIELD_KINDS[r.slug] === 'set' ? t('chats.prefs.union_hint') : t('chats.prefs.replace_hint');
    return {
      slug: r.slug,
      label: fieldLabel(r.slug),
      value: formatValue(r.slug, r.sug.value),
      quote: r.sug.quote,
      ticked: isTicked(r.slug, r.same),
      locked: false,
      chip: r.same ? { text: t('chats.prefs.same_as_saved'), tone: 'muted' } : undefined,
      title: `${t('chats.prefs.current')}: ${currentText || t('chats.prefs.none_saved')} · ${hint}`,
    };
  });

  return (
    <SlideBody
      footer={(
        <SlideFooter
          tickedCount={tickedSlugs.length}
          saving={saving}
          onSave={() => void decide('save')}
          onDismiss={() => void decide('dismiss')}
          info={t('chats.prefs.specs_info')}
          isAr={isAr}
        />
      )}
    >
      <SpecTiles
        items={items}
        onToggle={(slug) => {
          const r = rows.find((x) => x.slug === slug);
          if (!r) return;
          const ticked = isTicked(r.slug, r.same);
          setToggled((prev) => ({ ...prev, [slug]: !ticked }));
        }}
        disabled={saving}
        isAr={isAr}
      />
    </SlideBody>
  );
}

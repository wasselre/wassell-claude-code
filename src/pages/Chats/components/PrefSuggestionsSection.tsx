import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { PREF_FIELD_KINDS, PREF_SLUG_ORDER, isSameAsSaved } from '@/lib/clientPrefs/mergePrefs';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';

/**
 * «تفضيلات العميل من المحادثة» — the preference half of the in-chat card.
 *
 * The chat auto-read's preference agent turns the conversation into ONE
 * proposal (budget, unit type, area, bedrooms, purpose, amenities), each line
 * with the customer's own words. Nothing reaches the client until the rep
 * ticks lines and presses save (POST /api/client-prefs/review): set fields are
 * ADDED to what is saved, ranges REPLACE it. A line that would change nothing
 * starts unticked and says «مطابق للمحفوظ».
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
}

interface Props {
  prefs: PrefsCardDTO;
  /** The preference agent's error from the last reading (the geography half succeeded). */
  prefsError: string | null;
  onReload: () => Promise<void>;
}

export default function PrefSuggestionsSection({ prefs, prefsError, onReload }: Props) {
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
      await onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PrefSuggestionsSection] review failed:', err);
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

  const status = proposal?.status ?? null;
  const hasRead = Boolean(prefs.read_state?.last_read_at);
  if (!proposal && !hasRead && !prefsError) return null;

  return (
    <div className="mt-2 border-t border-sand/60 pt-2" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-1.5">
        <SlidersHorizontal size={12} className="text-copper shrink-0" />
        <span className="text-[11.5px] font-bold text-chocolate">{t('chats.prefs.title')}</span>
      </div>

      {prefsError && (
        <p className="mt-1 text-[10.5px] text-amber-700" title={prefsError}>{t('chats.prefs.partial')}</p>
      )}

      {(!proposal || status === 'superseded' || (status === 'pending' && rows.length === 0)) && hasRead && (
        <p className="mt-1 text-[11px] text-charcoal/60">{t('chats.prefs.empty')}</p>
      )}

      {status === 'pending' && rows.length > 0 && (
        <>
          <ul className="mt-1 space-y-1.5">
            {rows.map((r) => {
              const ticked = isTicked(r.slug, r.same);
              const currentText = formatValue(r.slug, r.current);
              return (
                <li key={r.slug} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 accent-copper shrink-0"
                    checked={ticked}
                    disabled={saving}
                    onChange={() => setToggled((prev) => ({ ...prev, [r.slug]: !ticked }))}
                    aria-label={fieldLabel(r.slug)}
                  />
                  <div className="min-w-0 flex-1 text-start">
                    <p className={`text-[12px] leading-snug ${ticked ? 'text-charcoal' : 'text-charcoal/45'}`}>
                      <span className="font-bold text-chocolate">{fieldLabel(r.slug)}</span>
                      {': '}
                      <span dir="auto">{formatValue(r.slug, r.sug.value)}</span>
                      {r.same && <span className="ms-1.5 text-[10px] text-charcoal/45">({t('chats.prefs.same_as_saved')})</span>}
                    </p>
                    {r.sug.quote && (
                      <p className="text-[10.5px] text-charcoal/55" dir="auto">«{r.sug.quote}»</p>
                    )}
                    <p className="text-[10px] text-charcoal/45">
                      {t('chats.prefs.current')}: {currentText || t('chats.prefs.none_saved')}
                      {' · '}
                      {PREF_FIELD_KINDS[r.slug] === 'set' ? t('chats.prefs.union_hint') : t('chats.prefs.replace_hint')}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Button className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void decide('save')} disabled={saving || tickedSlugs.length === 0}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('chats.prefs.save')}
            </Button>
            <Button variant="ghost" className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void decide('dismiss')} disabled={saving}>
              {t('chats.prefs.dismiss')}
            </Button>
          </div>
        </>
      )}

      {status === 'saved' && (
        <div className="mt-1">
          <p className="text-[11px] font-bold text-green-700">✓ {t('chats.prefs.saved')}</p>
          {(proposal?.saved_fields ?? []).length > 0 && (
            <p className="text-[10.5px] text-charcoal/55">
              {(proposal?.saved_fields ?? []).map(fieldLabel).join(isAr ? '، ' : ', ')}
            </p>
          )}
        </div>
      )}

      {status === 'dismissed' && (
        <p className="mt-1 text-[11px] text-charcoal/60">{t('chats.prefs.dismissed')}</p>
      )}
    </div>
  );
}

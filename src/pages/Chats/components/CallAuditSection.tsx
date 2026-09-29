import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, PhoneCall } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { PREF_SLUG_ORDER, isEmptyPrefValue } from '@/lib/clientPrefs/mergePrefs';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';
import type { CallProposalDTO } from './PrefSuggestionsSection';

/**
 * «من مكالمة … — قالها العميل ولم تُسجَّل» — the CALL AUDIT's proposals inside
 * the chat's preference card.
 *
 * The audit reads each finished Hatif call once and proposes ONLY what the
 * customer said that is EMPTY on the client. Saving (POST
 * /api/client-prefs/review) is fill-empty-only too: a field someone filled
 * since the call is skipped on the server, never overwritten. Here such a row
 * already shows unticked + disabled («سُجّلت بعد المكالمة»), because the card
 * carries each proposal's FRESH current values.
 */

interface ReviewOutcomeDTO {
  saved_fields: string[];
  skipped_filled?: string[];
}

interface Props {
  proposals: CallProposalDTO[];
  onReload: () => Promise<void>;
  /**
   * Fields skipped at save (logged since the call), per proposal id, from saves
   * in THIS session. Kept by the parent because this section unmounts while the
   * card reloads.
   */
  skippedById: Record<string, string[]>;
  onSaved: (proposalId: string, skipped: string[]) => void;
}

export default function CallAuditSection({ proposals, onReload, skippedById, onSaved }: Props) {
  const visible = proposals.filter((p) => p.status !== 'superseded');
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((p) => (
        <CallProposalBlock key={p.id} proposal={p} onReload={onReload} skipped={skippedById[p.id] ?? null} onSaved={onSaved} />
      ))}
    </>
  );
}

function formatCallDate(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', calendar: 'gregory' }).format(d);
}

function CallProposalBlock({ proposal, onReload, skipped, onSaved }: {
  proposal: CallProposalDTO;
  onReload: () => Promise<void>;
  skipped: string[] | null;
  onSaved: (proposalId: string, skipped: string[]) => void;
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
        onSaved(proposal.id, skippedNow);
        addToast(
          skippedNow.length
            ? `${t('chats.prefs.call_added')} — ${t('chats.prefs.call_skipped', { fields: labels(skippedNow) })}`
            : t('chats.prefs.call_added'),
          'success',
        );
      } else {
        addToast(t('chats.prefs.call_dismissed'), 'success');
      }
      await onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[CallAuditSection] review failed:', err);
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

  const savedFields = proposal.saved_fields ?? [];

  return (
    <div className="mt-2 border-t border-sand/60 pt-2" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-1.5">
        <PhoneCall size={12} className="text-copper shrink-0" />
        <span className="text-[11.5px] font-bold text-chocolate">
          {t('chats.prefs.call_title', { date: formatCallDate(proposal.call_at ?? proposal.created_at, isAr) })}
        </span>
      </div>

      {proposal.status === 'pending' && (
        <>
          <ul className="mt-1 space-y-1.5">
            {rows.map((r) => {
              const ticked = isTicked(r);
              return (
                <li key={r.slug} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 accent-copper shrink-0"
                    checked={ticked}
                    disabled={saving || r.filled}
                    onChange={() => toggle(r.slug)}
                    aria-label={fieldLabel(r.slug)}
                  />
                  <div className="min-w-0 flex-1 text-start">
                    <p className={`text-[12px] leading-snug ${ticked ? 'text-charcoal' : 'text-charcoal/45'}`}>
                      <span className="font-bold text-chocolate">{fieldLabel(r.slug)}</span>
                      {': '}
                      <span dir="auto">{formatValue(r.slug, r.sug.value)}</span>
                      {r.filled && (
                        <span className="ms-1.5 text-[10px] text-amber-700">({t('chats.prefs.call_logged_since')})</span>
                      )}
                    </p>
                    {r.sug.quote && (
                      <p className="text-[10.5px] text-charcoal/55" dir="auto">«{r.sug.quote}»</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[10px] text-charcoal/45">{t('chats.prefs.call_fill_hint')}</p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Button className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void decide('save')} disabled={saving || tickedSlugs.length === 0}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('chats.prefs.call_save')}
            </Button>
            <Button variant="ghost" className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void decide('dismiss')} disabled={saving}>
              {t('chats.prefs.dismiss')}
            </Button>
          </div>
        </>
      )}

      {proposal.status === 'saved' && (
        <div className="mt-1">
          {savedFields.length > 0 ? (
            <>
              <p className="text-[11px] font-bold text-green-700">✓ {t('chats.prefs.call_added')}</p>
              <p className="text-[10.5px] text-charcoal/55">{labels(savedFields)}</p>
            </>
          ) : (
            <p className="text-[11px] text-charcoal/60">{t('chats.prefs.call_nothing_added')}</p>
          )}
          {skipped && skipped.length > 0 && (
            <p className="text-[10.5px] text-amber-700">{t('chats.prefs.call_skipped', { fields: labels(skipped) })}</p>
          )}
        </div>
      )}

      {proposal.status === 'dismissed' && (
        <p className="mt-1 text-[11px] text-charcoal/60">{t('chats.prefs.call_dismissed')}</p>
      )}
    </div>
  );
}

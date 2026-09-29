import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, MapPin, PhoneCall } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { PREF_SLUG_ORDER, isEmptyPrefValue } from '@/lib/clientPrefs/mergePrefs';
import { pruneGeoExpression } from '@/lib/geo/pruneGeoExpression';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';
import { buildGeoRows, GEO_OPEN, GEO_SAVED, type GeoRow } from '../lib/geoRows';
import { groupCallBlocks, type CallBlockData } from '../lib/callBlocks';
import GeoLineGroups from './GeoLineGroups';
import type { CallGeoDTO, CallProposalDTO } from './PrefSuggestionsSection';

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
 *
 * PLACES (2026-09-29): each call block also shows the places the audit read
 * from the call — the same lines as the chat's own places (GeoLineGroups), tick
 * + save / dismiss through POST /api/geo-preference/review (confirm / edit with
 * the pruned expression / reject — the chat card's request shapes). The audit
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

interface Props {
  proposals: CallProposalDTO[];
  /** The call audit's places, per call (a call may have places, preferences, or both). */
  geo: CallGeoDTO[];
  onReload: () => Promise<void>;
  /**
   * Fields skipped at save (logged since the call), per proposal id, from saves
   * in THIS session. Kept by the parent because this section unmounts while the
   * card reloads.
   */
  skippedById: Record<string, string[]>;
  onSaved: (proposalId: string, skipped: string[]) => void;
}

export default function CallAuditSection({ proposals, geo, onReload, skippedById, onSaved }: Props) {
  const blocks = groupCallBlocks(proposals, geo);
  if (blocks.length === 0) return null;
  return (
    <>
      {blocks.map((b) => (
        <CallBlock key={b.key} block={b} onReload={onReload} skippedById={skippedById} onSaved={onSaved} />
      ))}
    </>
  );
}

/** One call: its header, then what the audit found — preferences and / or places. */
function CallBlock({ block, onReload, skippedById, onSaved }: {
  block: CallBlockData;
  onReload: () => Promise<void>;
  skippedById: Record<string, string[]>;
  onSaved: (proposalId: string, skipped: string[]) => void;
}) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <div className="mt-2 border-t border-sand/60 pt-2" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-1.5">
        <PhoneCall size={12} className="text-copper shrink-0" />
        <span className="text-[11.5px] font-bold text-chocolate">
          {t('chats.prefs.call_title', { date: formatCallDate(block.callAt, isAr) })}
        </span>
      </div>
      {block.pref && (
        <CallPrefPart proposal={block.pref} onReload={onReload} skipped={skippedById[block.pref.id] ?? null} onSaved={onSaved} />
      )}
      {block.geo && <CallGeoPart geo={block.geo} onReload={onReload} />}
    </div>
  );
}

function formatCallDate(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', calendar: 'gregory' }).format(d);
}

/** The preference part of a call block (the audit's six fields, fill-empty-only). */
function CallPrefPart({ proposal, onReload, skipped, onSaved }: {
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
    <>
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
    </>
  );
}

/**
 * The places part of a call block: the audit's geo proposal for this call.
 * Save = confirm (all lines) or edit (the pruned expression), dismiss = reject —
 * the same requests the chat's own places send. Fill-empty-only: when the
 * client already has places, save is disabled (and the server refuses it with
 * 409 `client_has_places` if that happened after the card loaded).
 */
function CallGeoPart({ geo, onReload }: { geo: CallGeoDTO; onReload: () => Promise<void> }) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language === 'ar');
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // A save refused because places appeared after the card loaded (the card reload shows it too).
  const [refused, setRefused] = useState(false);

  const p = geo.card.proposal && geo.card.proposal.id === geo.proposal_id ? geo.card.proposal : null;
  const rows: GeoRow[] = useMemo(() => (p ? buildGeoRows(geo.card, isAr) : []), [p, geo.card, isAr]);
  if (!p || rows.length === 0) return null;

  const open = GEO_OPEN.has(p.status);
  const saved = GEO_SAVED.has(p.status);
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
      addToast(action === 'reject' ? t('chats.prefs.call_geo_dismissed') : t('chats.prefs.call_geo_saved'), 'success');
      await onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[CallAuditSection] places review failed:', err);
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
    const drop = rows.filter((r) => !ticked(r)).map((r) => r.evidenceId);
    if (drop.length === 0) void review('confirm');
    else void review('edit', pruneGeoExpression(p.expression, drop));
  };

  return (
    <div className="mt-1.5">
      <p className="flex items-center gap-1 text-[11px] font-bold text-chocolate">
        <MapPin size={11} className="text-copper shrink-0" />
        {t('chats.prefs.call_geo_title')}
      </p>

      {open && (
        <>
          <GeoLineGroups rows={rows} withBox isTicked={ticked} onToggle={toggle} disabled={saving || hasPlaces} isAr={isAr} />
          {hasPlaces ? (
            <p className="mt-1 flex items-center gap-1 text-[10.5px] text-amber-700">
              <AlertTriangle size={11} className="shrink-0" />
              {t('chats.prefs.call_geo_has_places')}
            </p>
          ) : (
            <p className="mt-1 text-[10px] text-charcoal/45">{t('chats.prefs.call_geo_hint')}</p>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Button className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={save} disabled={saving || hasPlaces || tickedCount === 0}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('chats.prefs.call_geo_save')}
            </Button>
            <Button variant="ghost" className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={() => void review('reject')} disabled={saving}>
              {t('chats.prefs.dismiss')}
            </Button>
          </div>
        </>
      )}

      {saved && (
        <>
          <p className="mt-1 text-[11px] font-bold text-green-700">✓ {t('chats.prefs.call_geo_saved')}</p>
          <GeoLineGroups rows={rows} withBox={false} isTicked={ticked} onToggle={toggle} disabled isAr={isAr} />
        </>
      )}

      {p.status === 'rejected' && (
        <p className="mt-1 text-[11px] text-charcoal/60">{t('chats.prefs.call_geo_dismissed')}</p>
      )}
    </div>
  );
}

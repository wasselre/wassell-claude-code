/**
 * The client's preferences, one tap away on EVERY step of a follow-up
 * (operator, 2026-10-05): a small floating circle that opens the preferences
 * editor in a pop-up — in the Workspace (context / outreach / qualify /
 * outcome), in the follow-up's project finder, and above any window opened from
 * them (a project's units, a unit's details).
 *
 * It edits the SAME draft as the inline panel (the qualification session) and
 * the page saves it (usePreferencesAutosave) — this component owns no copy and
 * no saver. The circle sits above modal overlays (z-[55] over the overlay's 50)
 * so it stays reachable while a units window is open; the pop-up itself is a
 * normal Modal opened later, so it lands on top of that window.
 */
import { useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { EDITABLE_PREF_SLUGS } from '@/lib/clientPrefs/prefSlugs';
import type { ExtractionInput, FieldMeta } from '@/lib/salesProcess/qualificationDraft';
import PreferenceSummary from './PreferenceSummary';
import type { PrefSaveState } from '../hooks/usePreferencesAutosave';

interface Props {
  isAr: boolean;
  clientId: string | null;
  draft: Record<string, unknown>;
  meta: Record<string, FieldMeta>;
  onFieldChange: (slug: string, value: unknown) => void;
  onApplyRepText: (extraction: ExtractionInput) => void;
  saveState: PrefSaveState;
  /** Opens the full client record (defaults to the client page in a new tab). */
  onEditFull?: () => void;
  /** The pop-up closed; `changed` = the preferences differ from when it opened. */
  onClosed?: (changed: boolean, draft: Record<string, unknown>) => void;
}

const KEYS = [...EDITABLE_PREF_SLUGS, 'location_items', 'preference_constraints'];
const keyOf = (d: Record<string, unknown>) => JSON.stringify(KEYS.map((k) => d[k] ?? null));

export default function ClientPrefsFab({ isAr, clientId, draft, meta, onFieldChange, onApplyRepText, saveState, onEditFull, onClosed }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [open, setOpen] = useState(false);
  const openedWith = useRef<string>('');
  if (!clientId) return null;

  const pendingReview = Object.values(meta).filter((m) => m.provenance === 'ai_filled' || m.provenance === 'ai_changed').length;

  const show = () => { openedWith.current = keyOf(draft); setOpen(true); };
  const close = () => {
    setOpen(false);
    onClosed?.(keyOf(draft) !== openedWith.current, draft);
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        title={L('تفضيلات العميل', 'Client preferences')}
        aria-label={L('تفضيلات العميل', 'Client preferences')}
        className="fixed bottom-6 left-6 z-[55] flex h-14 w-14 items-center justify-center rounded-full bg-copper text-white shadow-xl ring-4 ring-white transition hover:scale-105 hover:bg-terracotta"
      >
        <SlidersHorizontal size={22} />
        {pendingReview > 0 && (
          <span className="absolute -top-1 -end-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white"
            title={L('حقول عبّأها الذكاء الاصطناعي بانتظار مراجعتك', 'AI-filled fields waiting for your review')}>
            {pendingReview}
          </span>
        )}
      </button>
      {open && (
        <Modal open onClose={close} title={L('تفضيلات العميل', 'Client preferences')} maxWidth="max-w-4xl">
          <PreferenceSummary
            clientId={clientId}
            onEditFull={onEditFull ?? (() => window.open(`/model/clients/${clientId}`, '_blank', 'noopener'))}
            draft={draft}
            onFieldChange={onFieldChange}
            meta={meta}
            onApplyRepText={onApplyRepText}
            saveState={saveState}
          />
        </Modal>
      )}
    </>
  );
}

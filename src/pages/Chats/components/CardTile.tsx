import { useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * One small, clickable item of the «تفضيلات العميل» slider — a place or a spec.
 * The whole tile toggles the tick (the checkbox sits at the start corner); a
 * verifier doubt is a small amber chip that expands its explanation under the
 * tile WITHOUT toggling. Presentational: the slide body owns the ticked state.
 */

export interface TileChip {
  text: string;
  tone: 'include' | 'exclude' | 'warn' | 'muted';
}

interface Props {
  /** Stable id for the aria wiring. */
  id: string;
  /** false ⇒ muted, no checkbox (e.g. an unresolved place). */
  tickable: boolean;
  ticked: boolean;
  /** Box shown but not changeable (saving, logged since the call, …). */
  disabled: boolean;
  onToggle: () => void;
  /** Small muted line ABOVE the main line (a spec's field label). */
  eyebrow?: string;
  main: string;
  /** Tooltip of the main line (e.g. the full placement sentence). */
  mainTitle?: string;
  chips?: TileChip[];
  /** The customer's words — one truncated line, full text in the tooltip. */
  quote?: string | null;
  /** The verifier's doubt — collapsed behind a chip. */
  doubt?: string | null;
  /** Tooltip of the whole tile (e.g. what is saved today). */
  title?: string;
  ariaLabel: string;
  isAr: boolean;
}

const CHIP_TONE: Record<TileChip['tone'], string> = {
  include: 'bg-emerald-50 text-emerald-700',
  exclude: 'bg-red-50 text-red-700',
  warn: 'bg-amber-50 text-amber-700',
  muted: 'bg-cream text-charcoal/55',
};

export function Chip({ chip }: { chip: TileChip }) {
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-bold leading-4 ${CHIP_TONE[chip.tone]}`}>{chip.text}</span>
  );
}

export default function CardTile({
  id, tickable, ticked, disabled, onToggle, eyebrow, main, mainTitle, chips, quote, doubt, title, ariaLabel, isAr,
}: Props) {
  const { t } = useTranslation();
  const [showDoubt, setShowDoubt] = useState(false);
  const canToggle = tickable && !disabled;
  const on = tickable && ticked;

  const frame = on
    ? 'border-copper bg-copper/5'
    : tickable
      ? 'border-sand bg-white'
      : 'border-sand/70 bg-cream/40';

  return (
    <div
      onClick={canToggle ? onToggle : undefined}
      title={title}
      className={`rounded-lg border px-2 py-1.5 text-start transition-colors ${frame} ${canToggle ? 'cursor-pointer hover:border-copper/60' : ''}`}
    >
      <div className="flex items-start gap-1.5">
        {tickable && (
          <input
            id={`tile-${id}`}
            type="checkbox"
            className="mt-0.5 accent-copper shrink-0"
            checked={ticked}
            disabled={disabled}
            onChange={onToggle}
            // The tile's own click handler toggles too — keep one toggle per click.
            onClick={(e) => e.stopPropagation()}
            aria-label={ariaLabel}
          />
        )}
        <div className={`min-w-0 flex-1 ${tickable ? '' : 'opacity-70'}`}>
          {eyebrow && <p className="truncate text-[10.5px] leading-tight text-charcoal/50">{eyebrow}</p>}
          <div className="flex items-center gap-1 min-w-0">
            <p
              className={`min-w-0 truncate text-[12px] font-bold leading-snug ${on || !tickable ? 'text-chocolate' : 'text-charcoal/45'}`}
              title={mainTitle ?? main}
              dir="auto"
            >
              {main}
            </p>
            {(chips ?? []).map((c) => <Chip key={c.text} chip={c} />)}
            {doubt && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowDoubt((v) => !v); }}
                className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-px text-[9.5px] font-bold leading-4 text-amber-700 hover:bg-amber-100"
                aria-expanded={showDoubt}
                title={t('chats.prefs.doubt_show')}
              >
                <AlertTriangle size={9} />
                {t('chats.prefs.doubt')}
              </button>
            )}
          </div>
          {quote && (
            <p className="truncate text-[11px] leading-tight text-charcoal/55" title={quote} dir="auto">«{quote}»</p>
          )}
        </div>
      </div>
      {doubt && showDoubt && (
        <p
          // Reading the explanation must not flip the tick.
          onClick={(e) => e.stopPropagation()}
          className="mt-1 rounded-md bg-amber-50 px-1.5 py-1 text-[10.5px] leading-snug text-amber-800 cursor-default"
          dir={isAr ? 'rtl' : 'ltr'}
        >
          {doubt}
        </p>
      )}
    </div>
  );
}

/** The tile grid of a slide. */
export function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">{children}</div>;
}

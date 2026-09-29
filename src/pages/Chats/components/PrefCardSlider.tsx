import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, MapPin, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { num } from '@/pages/Marketing/lib/format';

/**
 * The «تفضيلات العميل» tab of the «اقتراحات الذكاء الاصطناعي» card — its strip + slider: one pill per slide (icon,
 * short label, item count; the active one filled copper), ‹ › arrows and
 * «١ / ٤», then a horizontal scroll-snap container with one slide per topic —
 * so touch swipe works natively and the card stays short above the chat.
 *
 * RTL-safe on purpose: the active slide is tracked with an
 * IntersectionObserver (no scrollLeft maths), and navigation scrolls to the
 * slide's `offsetLeft` inside the positioned scroller — in RTL both
 * `offsetLeft` and `scrollLeft` run negative from the start edge, so the same
 * number is right in both directions.
 */

export interface SliderSlide {
  key: string;
  icon: 'places' | 'specs';
  label: string;
  count: number;
  /** Decided this session — the pill shows a check instead of the count. */
  done: boolean;
  body: ReactNode;
}

interface Props {
  slides: SliderSlide[];
  /** The start of the strip: card icon, title, voice badge. */
  lead: ReactNode;
  /** The end of the strip: re-read, collapse. */
  tail: ReactNode;
  /** The strip's middle when there are no slides («لا جديد» …). */
  emptyLine: ReactNode;
  /** Notices under the strip (loading, errors, reading…). */
  notices?: ReactNode;
  /** Hide the slides (e.g. while the chat is being re-read). */
  hideSlides?: boolean;
  /** Rendered under the slider for the active slide (the chat places' map). */
  below?: (activeKey: string | null) => ReactNode;
  /** The slide to start on (e.g. the one in view before the rep switched tabs). */
  initialKey?: string | null;
  /** Told whenever the slide in view changes. */
  onActiveChange?: (key: string | null) => void;
  isAr: boolean;
}

export default function PrefCardSlider({
  slides, lead, tail, emptyLine, notices, hideSlides, below, initialKey, onActiveChange, isAr,
}: Props) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const slideEls = useRef(new Map<string, HTMLDivElement>());
  const [activeKey, setActiveKey] = useState<string | null>(
    initialKey && slides.some((s) => s.key === initialKey) ? initialKey : slides[0]?.key ?? null,
  );

  const keysSig = slides.map((s) => s.key).join('|');
  const showSlides = slides.length > 0 && !hideSlides;

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  useEffect(() => { onActiveChangeRef.current?.(activeKey); }, [activeKey]);

  // Starting on a slide other than the first: jump there without animating.
  const startedAt = useRef(activeKey);
  useEffect(() => {
    const key = startedAt.current;
    const root = scroller.current;
    const el = key ? slideEls.current.get(key) : undefined;
    if (root && el && el.offsetLeft !== 0) root.scrollTo({ left: el.offsetLeft });
  }, []);

  // Keep the active key valid when the slide list changes.
  useEffect(() => {
    if (slides.length === 0) { setActiveKey(null); return; }
    setActiveKey((k) => (k && slides.some((s) => s.key === k) ? k : slides[0]!.key));
    // keysSig is the slide list's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig]);

  // Track the slide in view — direction-agnostic, so RTL needs no special case.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !showSlides || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      let best: { key: string; ratio: number } | null = null;
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.slideKey;
        if (!key || !e.isIntersecting) continue;
        if (!best || e.intersectionRatio > best.ratio) best = { key, ratio: e.intersectionRatio };
      }
      if (best && best.ratio >= 0.55) setActiveKey(best.key);
    }, { root, threshold: [0.55, 0.9] });
    for (const el of slideEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [keysSig, showSlides]);

  const goTo = useCallback((key: string) => {
    const root = scroller.current;
    const el = slideEls.current.get(key);
    setActiveKey(key);
    if (!root || !el) return;
    root.scrollTo({ left: el.offsetLeft, behavior: 'smooth' });
  }, []);

  const index = Math.max(0, slides.findIndex((s) => s.key === activeKey));
  const step = (d: 1 | -1) => {
    const next = slides[index + d];
    if (next) goTo(next.key);
  };
  // «‹ ›» follow the reading direction: in Arabic "next" points left.
  const PrevIcon = isAr ? ChevronRight : ChevronLeft;
  const NextIcon = isAr ? ChevronLeft : ChevronRight;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {lead}
        {slides.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t('chats.ai.tab_prefs')}>
            {slides.map((s) => {
              const active = s.key === activeKey && showSlides;
              const Icon = s.icon === 'places' ? MapPin : SlidersHorizontal;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => goTo(s.key)}
                  disabled={hideSlides}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-bold transition-colors disabled:opacity-40 ${
                    active
                      ? 'border-copper bg-copper text-white'
                      : 'border-sand bg-cream/40 text-charcoal/70 hover:border-copper/50 hover:text-copper'
                  }`}
                >
                  <Icon size={10} className="shrink-0" />
                  <span className="whitespace-nowrap">{s.label}</span>
                  {s.done ? (
                    <Check size={10} className={active ? 'text-white' : 'text-green-700'} />
                  ) : (
                    <span className={`rounded-full px-1 text-[9.5px] leading-4 ${active ? 'bg-white/25 text-white' : 'bg-sand/50 text-chocolate'}`}>
                      {num(s.count, isAr)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          emptyLine
        )}
        {slides.length > 1 && (
          <div className="flex items-center gap-0.5 text-charcoal/50">
            <button type="button" onClick={() => step(-1)} disabled={index === 0 || hideSlides} className="rounded p-0.5 hover:text-copper disabled:opacity-30" aria-label={t('chats.prefs.prev')} title={t('chats.prefs.prev')}>
              <PrevIcon size={14} />
            </button>
            <span className="text-[10.5px] tabular-nums">{num(index + 1, isAr)} / {num(slides.length, isAr)}</span>
            <button type="button" onClick={() => step(1)} disabled={index >= slides.length - 1 || hideSlides} className="rounded p-0.5 hover:text-copper disabled:opacity-30" aria-label={t('chats.prefs.next')} title={t('chats.prefs.next')}>
              <NextIcon size={14} />
            </button>
          </div>
        )}
        <div className="ms-auto flex items-center gap-1.5">{tail}</div>
      </div>

      {notices}

      {showSlides && (
        <div
          ref={scroller}
          className="relative mt-1.5 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {slides.map((s) => (
            <div
              key={s.key}
              data-slide-key={s.key}
              ref={(el) => { if (el) slideEls.current.set(s.key, el); else slideEls.current.delete(s.key); }}
              className="w-full shrink-0 snap-start"
              role="tabpanel"
              aria-label={s.label}
            >
              {s.body}
            </div>
          ))}
        </div>
      )}

      {showSlides && below?.(activeKey)}
    </>
  );
}

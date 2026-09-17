/**
 * Shared UI primitives for the recruitment walkthrough (redesign pass).
 *
 * Direction: SCALE + CONTINUITY + INTERACTION. Each step shows ONE enlarged,
 * focused product surface — no repeated app sidebar — so a candidate reads the
 * detail without zooming, and the seven steps read as one continuous customer
 * journey rather than seven screenshots.
 *
 * We reuse the real design tokens (copper/sand/charcoal, Amiri, `.card` /
 * `.form-input` / `.badge`) and the pure `Button`/`Badge` components; store-bound
 * screens are transcribed as static markup.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, MapPin, ChevronLeft } from 'lucide-react';

// ── Fade-up-on-scroll wrapper ─────────────────────────────────────────────────
export function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) { setShown(true); io.disconnect(); }
    }, { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`${shown ? 'hire-reveal' : 'opacity-0'} ${className}`}>{children}</div>;
}

// ── Focused screen frame (NO sidebar) ─────────────────────────────────────────
// A single elevated panel with a slim contextual header. The content area is the
// star — full width, generous padding, larger type.
export function Screen({
  title, icon, right, children, bodyClassName = 'p-4 sm:p-6',
}: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-sand/40 bg-white shadow-2xl ring-1 ring-black/[0.02]">
      <div className="flex items-center gap-2 border-b border-sand/30 bg-white px-4 py-3 sm:px-5">
        {icon && <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-copper/10 text-copper">{icon}</span>}
        <span className="text-sm font-bold text-chocolate sm:text-base">{title}</span>
        {right && <span className="ms-auto">{right}</span>}
      </div>
      <div className={`bg-cream-light ${bodyClassName}`}>{children}</div>
    </div>
  );
}

// ── Invitation progress rail (sticky) ─────────────────────────────────────────
// التعريف ← الفيديو ← التجربة ← العرض ← القرار
const STAGES = ['التعريف', 'الفيديو', 'التجربة', 'العرض', 'القرار'];

export function ProgressRail({ active = 0 }: { active?: number }) {
  return (
    <div className="sticky top-0 z-30 border-b border-sand/40 bg-cream-light/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-center gap-1 px-3 py-2.5 sm:gap-2">
        {STAGES.map((s, i) => (
          <div key={s} className="flex items-center gap-1 sm:gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold transition-colors sm:text-sm ${
                i === active
                  ? 'bg-copper text-white shadow-sm'
                  : i < active
                    ? 'text-copper'
                    : 'text-charcoal/40'
              }`}
            >
              {i === active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              {s}
            </span>
            {i < STAGES.length - 1 && <ChevronLeft size={14} className="shrink-0 text-charcoal/25" />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── A journey step (connected timeline node) ──────────────────────────────────
// A continuous copper spine runs down the start edge (RTL: right); each step
// hangs off a numbered node, so the seven steps read as ONE journey.
export function JourneyStep({
  n, title, blurb, last, children,
}: {
  n: number; title: string; blurb: string; last?: boolean; children: ReactNode;
}) {
  return (
    <div className="relative ps-10 sm:ps-14">
      {/* spine */}
      {!last && <span className="absolute inset-y-0 start-4 top-3 w-0.5 bg-gradient-to-b from-copper/60 to-sand/40 sm:start-5" />}
      {/* node */}
      <span className="absolute start-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-gold to-copper text-sm font-bold text-white shadow-md sm:h-10 sm:w-10 sm:text-base">
        {n}
      </span>
      <div className="pb-2">
        <h3 className="text-lg font-bold text-chocolate sm:text-2xl">{title}</h3>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-charcoal/70 sm:text-base">{blurb}</p>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

// ── A short causal bridge between steps ("preferences → recommendations") ─────
export function FlowConnector({ children }: { children: string }) {
  return (
    <div className="relative my-5 ps-10 sm:ps-14">
      {/* spine continues through the connector so the journey reads unbroken */}
      <span className="absolute inset-y-0 start-4 w-0.5 bg-sand/40 sm:start-5" />
      <div className="relative inline-flex items-center gap-2 rounded-full border border-copper/25 bg-copper/10 px-3.5 py-1.5 text-xs font-semibold text-copper sm:text-sm">
        <span className="flex h-4 w-4 animate-bounce items-center justify-center">
          <ChevronLeft size={14} className="-rotate-90" />
        </span>
        {children}
      </div>
    </div>
  );
}

// ── KPI tile (from ProjectDetailPage `Kpi`) ───────────────────────────────────
export function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card p-3 text-center">
      <div className="text-lg font-bold sm:text-xl" style={{ color: tone ?? '#4A2C2A' }}>{value}</div>
      <div className="mt-0.5 text-[11px] text-charcoal/50 sm:text-xs">{label}</div>
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-sand/30 py-2 text-sm last:border-0 sm:text-base">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-end font-medium text-charcoal">{value}</span>
    </div>
  );
}

export function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((c) => (
        <span key={c} className="rounded-md border border-sand/50 bg-cream px-2 py-0.5 text-xs text-charcoal/70 sm:text-sm">
          {c}
        </span>
      ))}
    </div>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-sand/30 py-2 text-sm last:border-0 sm:text-base">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-end font-medium text-charcoal">{value}</span>
    </div>
  );
}

export function SourcePill({ source }: { source: 'ours' | 'general' }) {
  return source === 'ours' ? (
    <span className="rounded-full bg-green-600 px-2.5 py-0.5 text-xs font-bold text-white">مشاريعنا</span>
  ) : (
    <span className="rounded-full bg-charcoal/70 px-2.5 py-0.5 text-xs font-bold text-white">مشروع عام</span>
  );
}

const BAND: Record<'strong' | 'good' | 'partial', { label: string; cls: string }> = {
  strong: { label: 'مطابقة قوية', cls: 'bg-green-100 text-green-700 border-green-200' },
  good: { label: 'مطابقة جيدة', cls: 'bg-copper/15 text-copper border-copper/30' },
  partial: { label: 'مطابقة جزئية', cls: 'bg-charcoal/10 text-charcoal/60 border-charcoal/20' },
};

export function BandBadge({ band, score }: { band: 'strong' | 'good' | 'partial'; score: number }) {
  const b = BAND[band];
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${b.cls}`}>
      {b.label} · {score}
    </span>
  );
}

export function OffPlanPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-700">
      <MapPin size={12} /> على الخارطة
    </span>
  );
}

export function Spec({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <span className="text-copper">{icon}</span>
      <span className="text-charcoal/50">{label}:</span>
      <span className="font-medium text-charcoal/90">{value}</span>
    </div>
  );
}

export function FromCallChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ backgroundColor: '#10B98120', color: '#10B981' }}>
      <CheckCircle2 size={11} /> من المكالمة
    </span>
  );
}

// ── Real-looking architectural render (self-contained SVG "photo") ────────────
// Layered scene — sky + sun/moon + massed building with lit windows + palms +
// ground — so cards and heroes show a genuine-looking project image, never an
// empty placeholder, and stay crisp at any size.
export type RenderVariant = 'villaDay' | 'villaDusk' | 'tower' | 'pool';

export function ProjectImage({ variant, className = '' }: { variant: RenderVariant; className?: string }) {
  const id = useId().replace(/:/g, '');
  const g = (s: string) => `${id}-${s}`;

  const palettes: Record<RenderVariant, { sky: [string, string]; orb: string; orbY: number; wall: string; wallDark: string; win: string; ground: string }> = {
    villaDay:  { sky: ['#CFE3F2', '#F3E7D2'], orb: '#FFE7B0', orbY: 52, wall: '#F3EDE3', wallDark: '#E4D6C2', win: '#8FB9D8', ground: '#CBB489' },
    villaDusk: { sky: ['#3B3A63', '#B8734F'], orb: '#FFD9A0', orbY: 60, wall: '#6B5A57', wallDark: '#4A3E3C', win: '#FFCE7A', ground: '#4A2C2A' },
    tower:     { sky: ['#BFD9EE', '#EAD9C2'], orb: '#FFEFC2', orbY: 44, wall: '#EAE2D6', wallDark: '#CDBEA6', win: '#7FB0D6', ground: '#C9B58C' },
    pool:      { sky: ['#CFE7EA', '#F3E7D2'], orb: '#FFEAB4', orbY: 48, wall: '#F1EADF', wallDark: '#DECFB8', win: '#A9D2D6', ground: '#D8C79E' },
  };
  const p = palettes[variant];

  const palm = (x: number, y: number, s = 1) => (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x="-2" y="0" width="4" height="34" rx="2" fill="#7A5A3A" />
      {[-40, -20, 0, 20, 40, 70, 110, 160, 200, 220].map((a) => (
        <path key={a} d="M0 0 Q 14 -8 30 -4" stroke="#3E7C4F" strokeWidth="4" fill="none" strokeLinecap="round" transform={`rotate(${a})`} />
      ))}
    </g>
  );

  return (
    <svg viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice" className={className} role="img" aria-label="صورة المشروع">
      <defs>
        <linearGradient id={g('sky')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={p.sky[0]} />
          <stop offset="1" stopColor={p.sky[1]} />
        </linearGradient>
        <radialGradient id={g('orb')} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={p.orb} stopOpacity="0.95" />
          <stop offset="1" stopColor={p.orb} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* sky + sun/moon */}
      <rect width="400" height="240" fill={`url(#${g('sky')})`} />
      <circle cx="300" cy={p.orbY} r="60" fill={`url(#${g('orb')})`} />
      <circle cx="300" cy={p.orbY} r="16" fill={p.orb} />

      {/* ground */}
      <rect y="176" width="400" height="64" fill={p.ground} />
      <ellipse cx="200" cy="182" rx="220" ry="12" fill="#000" opacity="0.05" />

      {variant === 'tower' ? (
        <g>
          <rect x="150" y="40" width="110" height="140" fill={p.wall} />
          <rect x="150" y="40" width="24" height="140" fill={p.wallDark} opacity="0.6" />
          {Array.from({ length: 9 }).map((_, r) =>
            Array.from({ length: 5 }).map((_, c) => (
              <rect key={`${r}-${c}`} x={160 + c * 19} y={50 + r * 14} width="12" height="8" rx="1" fill={p.win} opacity={(r + c) % 3 === 0 ? 0.95 : 0.55} />
            )),
          )}
          <rect x="150" y="34" width="110" height="8" fill={p.wallDark} />
        </g>
      ) : variant === 'pool' ? (
        <g>
          <rect x="60" y="70" width="180" height="70" fill={p.wall} />
          <rect x="60" y="70" width="180" height="12" fill={p.wallDark} />
          {[80, 120, 160, 200].map((x) => <rect key={x} x={x} y="92" width="26" height="30" rx="2" fill={p.win} opacity="0.8" />)}
          <rect x="250" y="150" width="120" height="40" rx="8" fill="#6FB7C9" />
          <rect x="250" y="150" width="120" height="40" rx="8" fill="#ffffff" opacity="0.12" />
          {[268, 300, 332].map((x) => <line key={x} x1={x} y1="150" x2={x} y2="190" stroke="#fff" strokeWidth="2" opacity="0.4" />)}
          {palm(360, 150, 1)}
          {palm(40, 150, 0.9)}
        </g>
      ) : (
        <g>
          {/* two-storey modern villa */}
          <rect x="96" y="150" width="150" height="30" fill={p.wallDark} />
          <rect x="110" y="96" width="150" height="84" fill={p.wall} />
          <rect x="110" y="96" width="150" height="12" fill={p.wallDark} opacity="0.7" />
          <rect x="230" y="70" width="70" height="110" fill={p.wallDark} />
          <rect x="236" y="70" width="70" height="110" fill={p.wall} />
          {/* windows (upper) */}
          {[124, 156, 188].map((x) => <rect key={`u${x}`} x={x} y="114" width="22" height="24" rx="2" fill={p.win} opacity="0.9" />)}
          {/* windows (tower block) */}
          {[86, 122].map((y) => [246, 276].map((x) => <rect key={`t${x}-${y}`} x={x} y={y} width="22" height="26" rx="2" fill={p.win} opacity="0.9" />))}
          {/* door + entrance light */}
          <rect x="150" y="150" width="26" height="30" rx="2" fill={p.wallDark} />
          <rect x="188" y="150" width="40" height="30" rx="2" fill={p.win} opacity="0.85" />
          {palm(320, 150, 1.05)}
          {palm(78, 152, 0.95)}
          {/* lawn */}
          <rect y="176" width="400" height="8" fill="#5E8B57" opacity="0.5" />
        </g>
      )}
    </svg>
  );
}

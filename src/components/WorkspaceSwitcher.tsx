/**
 * The workspace switcher — the one control that makes Sales and Marketing feel
 * like two rooms of one building rather than two apps. It sits at the top of
 * BOTH shells (the Sales sidebar and the Marketing rail) as a segmented toggle:
 * the workspace you're in is the active segment; clicking the other jumps you
 * across (Sales `/`, Marketing `/m`). This replaces the old "Marketing space"
 * nav item on the Sales side and the small "switch to Sales" button on the
 * Marketing side — a switch, not a button off to the side.
 *
 * Both segments carry the Wassel castle logo (one company, two workspaces); the
 * Arabic/English label beside it is what tells them apart. When the Sales rail is
 * collapsed the switch shrinks to a single logo button that jumps you to the
 * other workspace.
 *
 * Self-contained (inline-styled, RTL-safe via logical properties) so it renders
 * identically inside the Tailwind Sales shell and the `.mos-root`-scoped
 * Marketing rail without depending on either stylesheet. Two visual variants:
 * light (Sales cream/copper) and dark (Marketing charcoal rail).
 */
import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

/** The official Wassel castle mark (served from /public/assets). */
const LOGO = '/assets/logo-castle.png';

interface WorkspaceSwitcherProps {
  /** Which shell it renders in — decides theme AND which segment is active. */
  variant: 'sales' | 'marketing';
  /** Sales-side gate: hide the whole switcher when the user can't reach Marketing. */
  canAccessMarketing: boolean;
  isAr: boolean;
  /** Sales rail collapsed → single logo button to the other workspace. */
  collapsed?: boolean;
}

type Key = 'sales' | 'marketing';

const SALES = { key: 'sales' as const, to: '/', ar: 'المبيعات', en: 'Sales' };
const MARKETING = { key: 'marketing' as const, to: '/m', ar: 'التسويق', en: 'Marketing' };
const SEGMENTS = [SALES, MARKETING];

function Logo({ size }: { size: number }): JSX.Element {
  return (
    <img
      src={LOGO}
      alt="Wassel"
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

export default function WorkspaceSwitcher({
  variant, canAccessMarketing, isAr, collapsed = false,
}: WorkspaceSwitcherProps): JSX.Element | null {
  const navigate = useNavigate();
  const [hover, setHover] = useState<Key | null>(null);

  // On the Sales side there's nothing to switch TO unless the user can reach
  // the Marketing workspace — render nothing rather than a dead one-option toggle.
  if (variant === 'sales' && !canAccessMarketing) return null;

  const dark = variant === 'marketing';
  const current: Key = variant;

  // Collapsed (Sales rail only): a single Wassel-logo button that jumps to the
  // other workspace. Collapse only happens in Sales, so "other" is Marketing.
  if (collapsed) {
    const other = current === 'sales' ? MARKETING : SALES;
    return (
      <button
        type="button"
        onClick={() => navigate(other.to)}
        title={isAr ? `الانتقال إلى مساحة ${other.ar}` : `Switch to the ${other.en} workspace`}
        aria-label={isAr ? `الانتقال إلى مساحة ${other.ar}` : `Switch to the ${other.en} workspace`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          minHeight: 40,
          marginBlock: 6,
          borderRadius: 10,
          border: '1px solid rgba(184,115,79,0.20)',
          background: 'rgba(74,44,42,0.05)',
          cursor: 'pointer',
        }}
      >
        <Logo size={26} />
      </button>
    );
  }

  const container: CSSProperties = {
    display: 'flex',
    gap: 3,
    padding: 3,
    borderRadius: 12,
    marginBlock: 10,
    background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(74,44,42,0.06)',
    border: dark ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(184,115,79,0.18)',
  };

  const segStyle = (active: boolean, hovered: boolean): CSSProperties => ({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 42,
    padding: '0 10px',
    borderRadius: 9,
    border: 'none',
    cursor: active ? 'default' : 'pointer',
    fontFamily: 'inherit',
    fontSize: 15,
    fontWeight: active ? 700 : 500,
    whiteSpace: 'nowrap',
    transition: 'background .12s, color .12s',
    background: active
      ? (dark ? '#B8734F' : '#FFFFFF')
      : hovered
        ? (dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.55)')
        : 'transparent',
    color: active
      ? (dark ? '#FFFFFF' : '#8E4E3A')
      : (dark ? 'rgba(255,255,255,0.62)' : 'rgba(74,78,84,0.62)'),
    boxShadow: active && !dark ? '0 1px 2px rgba(0,0,0,0.07)' : 'none',
  });

  return (
    <div style={container} role="group"
      aria-label={isAr ? 'التبديل بين المساحات' : 'Switch workspace'}>
      {SEGMENTS.map((seg) => {
        const active = seg.key === current;
        return (
          <button
            key={seg.key}
            type="button"
            aria-current={active ? 'page' : undefined}
            disabled={active}
            onClick={() => { if (!active) navigate(seg.to); }}
            onMouseEnter={() => setHover(seg.key)}
            onMouseLeave={() => setHover((h) => (h === seg.key ? null : h))}
            style={segStyle(active, hover === seg.key)}
            title={
              active
                ? (isAr ? `أنت في مساحة ${seg.ar}` : `You're in the ${seg.en} workspace`)
                : (isAr ? `الانتقال إلى مساحة ${seg.ar}` : `Switch to the ${seg.en} workspace`)
            }
          >
            {/* Dim the logo on the inactive segment so the active one reads as "here". */}
            <span style={{ display: 'inline-flex', opacity: active ? 1 : 0.65 }}>
              <Logo size={20} />
            </span>
            <span>{isAr ? seg.ar : seg.en}</span>
          </button>
        );
      })}
    </div>
  );
}

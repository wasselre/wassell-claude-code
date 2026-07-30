/**
 * Marketing Workspace — icon set.
 *
 * These are the exact paths drawn in the approved screens, not Lucide
 * substitutes. The stroke weights and shapes are part of what makes the rail
 * and the kind column read as the design rather than as a generic admin panel.
 *
 * Every icon inherits `currentColor` and is sized by CSS (`.navi svg`,
 * `.kind svg`, `.btn svg`), so no component here sets its own width.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': true,
} as const;

export const IconOverview = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);

export const IconMyWork = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 11l3 3 6-6" />
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
  </svg>
);

export const IconContent = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />
  </svg>
);

export const IconCalendar = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2.5" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const IconLibrary = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="14" rx="2.5" />
    <path d="M3 14l4.5-4 4 3.5L15 10l6 5.5" />
    <circle cx="8.5" cy="8.5" r="1.4" />
  </svg>
);

export const IconCampaigns = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 11v3l14 5V6L3 11z" />
    <path d="M17 9a3 3 0 010 6" />
  </svg>
);

export const IconSettings = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2.2" />
    <circle cx="10" cy="17" r="2.2" />
  </svg>
);

export const IconTeam = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20a6 6 0 0112 0" />
    <path d="M16 5.5a3 3 0 010 5.6M17 20a6 6 0 00-2.2-4.6" />
  </svg>
);

export const IconShoot = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 8.5A2.5 2.5 0 015.5 6h2L9 4h6l1.5 2h2A2.5 2.5 0 0121 8.5v8A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-8z" />
    <circle cx="12" cy="12.5" r="3.4" />
  </svg>
);

export const IconMetrics = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);

export const IconRoles = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3l7 3v5.5c0 4.2-2.9 7.7-7 8.5-4.1-.8-7-4.3-7-8.5V6l7-3z" />
    <path d="M9.5 12l1.8 1.8L15 10" />
  </svg>
);

/* ── content kinds ─────────────────────────────────────────────────── */

export const IconVideo = (p: P) => (
  <svg {...base} {...p}>
    <path d="M15 10l5-3v10l-5-3M3 7h12v10H3z" />
  </svg>
);

export const IconPost = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 14l5-4 4 3 3-2 6 5" />
  </svg>
);

export const IconCarousel = (p: P) => (
  <svg {...base} {...p}>
    <rect x="7" y="4" width="13" height="16" rx="2" />
    <path d="M4 7v13" />
  </svg>
);

export const IconStory = (p: P) => (
  <svg {...base} {...p}>
    <rect x="6" y="3" width="12" height="18" rx="2.5" />
    <path d="M12 7v6M12 16.5v.5" />
  </svg>
);

/** The kind glyph for a content-type key. Unknown types get the generic post. */
export function kindIcon(key: string): (p: P) => JSX.Element {
  switch (key) {
    case 'video': return IconVideo;
    case 'carousel': return IconCarousel;
    case 'story': return IconStory;
    default: return IconPost;
  }
}

/* ── controls ──────────────────────────────────────────────────────── */

export const IconPlus = (p: P) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base} {...p}><path d="M5 12.5l4.5 4.5L19 7" /></svg>
);
export const IconX = (p: P) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconBack = (p: P) => (
  <svg {...base} {...p}><path d="M15 5l-7 7 7 7" /></svg>
);
export const IconForward = (p: P) => (
  <svg {...base} {...p}><path d="M9 5l7 7-7 7" /></svg>
);
export const IconSwap = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </svg>
);
export const IconMenu = (p: P) => (
  <svg {...base} {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </svg>
);
export const IconClock = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IconSend = (p: P) => (
  <svg {...base} {...p}><path d="M4 12l16-7-6 16-3-6-7-3z" /></svg>
);
export const IconInbox = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5 5h14l2 8v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4l2-8z" />
  </svg>
);

/** The Wassel mark used in the rail — the castle silhouette, in gold. */
export const BrandMark = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden {...p}>
    <path d="M3 21V9.5L7 7V4l2.5 1.5L12 2l2.5 3.5L17 4v3l4 2.5V21H3z" stroke="#D9B57F" strokeWidth="1.3" />
    <path d="M10 21v-5.5h4V21" stroke="#D9B57F" strokeWidth="1.3" />
  </svg>
);

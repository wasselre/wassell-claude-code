/**
 * Marketing Workspace — the shared primitives every screen is built from.
 *
 * These map one-to-one onto the design's classes (.phead, .stat, .pill,
 * .empty, .modal, .sk). Keeping them here means a spacing decision is made once
 * and every screen inherits it, which is what stops a 20-screen module drifting
 * into 20 slightly different headers.
 */
import { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  MosContentRow,
  MosRole,
  ROLE_LABELS,
  SYNTHETIC_STATUS_LABELS,
  statusLabel,
  isOverdue,
} from '@/lib/marketingOS/client';
import { initial, num, roleAvatarClass } from '../lib/format';
import { IconCheck, IconInbox, IconX, kindIcon } from './icons';

/* ── Page header ─────────────────────────────────────────────────────── */

export function PageHead({
  title, sub, crumb, children,
}: {
  title: string;
  sub?: ReactNode;
  crumb?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="phead">
      <div style={{ minWidth: 0 }}>
        {crumb && <div className="crumb">{crumb}</div>}
        <h3>{title}</h3>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="acts">{children}</div>}
    </div>
  );
}

/* ── Status vocabulary ───────────────────────────────────────────────── */

/**
 * The five pill tones carry meaning, not decoration:
 * now = with someone right now, wait = waiting on a person, go = cleared,
 * late = past due, live = out in the world, idle = not started.
 */
export type Tone = 'now' | 'wait' | 'go' | 'late' | 'idle' | 'live';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill p-${tone}`}>{children}</span>;
}

/** Tone for a content row, derived — never stored, never set by hand. */
export function rowTone(row: MosContentRow): Tone {
  if (isOverdue(row)) return 'late';
  if (row.status_key === 'done') return 'live';
  if (row.status_key === 'draft') return 'idle';
  if (row.owner_role === 'marketing_manager' || row.owner_role === 'ceo') return 'wait';
  return 'now';
}

export function StatusPill({ row, isAr }: { row: MosContentRow; isAr: boolean }) {
  return <Pill tone={rowTone(row)}>{statusLabel(row, isAr)}</Pill>;
}

export function KindCell({ typeKey, label }: { typeKey: string; label?: string }) {
  const Icon = kindIcon(typeKey);
  return (
    <span className="kind">
      <Icon />
      {label}
    </span>
  );
}

export function RoleChip({ role, isAr }: { role: MosRole | null; isAr: boolean }) {
  if (!role) return <span style={{ color: 'var(--mute)' }}>—</span>;
  const label = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;
  return (
    <div className="who">
      <span className={`av ${roleAvatarClass(role)}`}>{initial(label)}</span>
      {label}
    </div>
  );
}

/** The synthetic statuses, for filter chips. */
export const SYNTHETIC_KEYS = Object.keys(SYNTHETIC_STATUS_LABELS);

/* ── Stat card ───────────────────────────────────────────────────────── */

export function Stat({
  label, value, detail, meter, alert, isAr,
}: {
  label: string;
  value: number | null;
  detail?: ReactNode;
  meter?: Array<{ pct: number; color: string }>;
  alert?: boolean;
  isAr: boolean;
}) {
  return (
    <div className={`stat${alert ? ' alert' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{num(value, isAr)}</div>
      {detail && <div className="d">{detail}</div>}
      {meter && meter.length > 0 && (
        <div className="meter">
          {meter.map((m, i) => (
            <i key={i} style={{ width: `${Math.max(0, Math.min(100, m.pct))}%`, background: m.color }} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Empty / loading / error ─────────────────────────────────────────── */

export function Empty({
  title, body, children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <IconInbox />
      <h4>{title}</h4>
      {body && <p>{body}</p>}
      {children && <div className="opts">{children}</div>}
    </div>
  );
}

/** A shape while data loads, so a slow network never looks like an empty system. */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="sk sk-row" />
      ))}
    </div>
  );
}

/**
 * Load failures are shown, never swallowed — the repo's hardest rule. The retry
 * is right here so a transient failure costs one click, not a page reload.
 */
export function LoadError({
  message, onRetry, isAr,
}: {
  message: string;
  onRetry?: () => void;
  isAr: boolean;
}) {
  return (
    <div className="notice bad" role="alert">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        {isAr ? 'تعذّر تحميل هذه الشاشة' : 'This screen could not load'}
      </div>
      <div style={{ overflowWrap: 'anywhere' }}>{message}</div>
      {onRetry && (
        <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={onRetry}>
          {isAr ? 'إعادة المحاولة' : 'Try again'}
        </button>
      )}
    </div>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────── */

export function Modal({
  title, sub, onClose, footer, wide, children,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Rendered into <body> so the workspace's own scroll container can never clip
  // it — the failure mode where a dialog opens but is painted off-screen.
  return createPortal(
    <div className="mos-root mos-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <h4>{title}</h4>
              {sub && <p>{sub}</p>}
            </div>
            <button
              type="button"
              className="btn btn-d btn-sm"
              style={{ marginInlineStart: 'auto' }}
              onClick={onClose}
              aria-label="close"
            >
              <IconX />
            </button>
          </div>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ── Field ───────────────────────────────────────────────────────────── */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="lbl">
        {label}
        {hint && <span style={{ fontWeight: 400, color: 'var(--mute)' }}> · {hint}</span>}
      </span>
      <div style={{ marginTop: 6 }}>{children}</div>
    </label>
  );
}

export function ReadField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fld">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  );
}

export function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className={`chk ${ok ? 'ok' : 'no'}`}>
      {ok ? <IconCheck /> : <IconX />}
      <span>{children}</span>
    </div>
  );
}

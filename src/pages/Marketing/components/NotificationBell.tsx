/**
 * The notification bell + centre — design screen 43's right column, plus the
 * workspace-level bell this task mounts in the rail's brand row.
 *
 * One hook (`useMosNotifications`) owns the inbox state for both surfaces:
 * the bell polls every 60 s (bootstrap's `unread_notifications` is a stub, so
 * `notifications_list` is the truth for the badge), the settings page fetches
 * once. Rows deep-link with `navigate(url)` — every emitted url is an in-app
 * `/m/...` path.
 *
 * The dropdown is PORTALED to <body> and positioned fixed off the button's
 * rect: the rail scrolls (`overflow-y: auto`), so an absolutely-positioned
 * panel inside it would be clipped to the rail's 214px.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { MosNotification, fetchNotifications, markNotificationsRead } from '@/lib/marketingOS/client';
import { initial, num, shortDate } from '../lib/format';
import '../styles/settings-engine.css';

/* ------------------------------------------------------------------ */
/* time-ago — «قبل ٤ دقائق» / «قبل ساعتين» / «أمس» (mockup shapes)      */
/* ------------------------------------------------------------------ */

export function timeAgo(iso: string, isAr: boolean): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return isAr ? 'الآن' : 'now';
  if (mins < 60) {
    if (isAr) {
      if (mins === 1) return 'قبل دقيقة';
      if (mins === 2) return 'قبل دقيقتين';
      if (mins <= 10) return `قبل ${num(mins, true)} دقائق`;
      return `قبل ${num(mins, true)} دقيقة`;
    }
    return `${mins} min ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    if (isAr) {
      if (hours === 1) return 'قبل ساعة';
      if (hours === 2) return 'قبل ساعتين';
      if (hours <= 10) return `قبل ${num(hours, true)} ساعات`;
      return `قبل ${num(hours, true)} ساعة`;
    }
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return isAr ? 'أمس' : 'yesterday';
  if (days < 30) {
    if (isAr) {
      if (days === 2) return 'قبل يومين';
      if (days <= 10) return `قبل ${num(days, true)} أيام`;
      return `قبل ${num(days, true)} يومًا`;
    }
    return `${days} d ago`;
  }
  return shortDate(iso, isAr);
}

/* ------------------------------------------------------------------ */
/* shared inbox state                                                  */
/* ------------------------------------------------------------------ */

export interface MosNotificationsState {
  rows: MosNotification[];
  unread: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Marks EVERY unread row, paging past the list cap — never a silent cap. */
  markAll: () => Promise<void>;
  markOne: (id: string) => Promise<void>;
}

export function useMosNotifications(pollMs?: number): MosNotificationsState {
  const [rows, setRows] = useState<MosNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchNotifications({ limit: 30 });
      setRows(res.rows);
      setUnread(res.unread);
      setError(null);
    } catch (e) {
      // Surfaced in the panel (and the badge hides) rather than toasted — a
      // background poll must not raise a toast every 60 s while offline.
      console.error('[marketing] notifications refresh failed', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!pollMs) return undefined;
    const t = window.setInterval(() => { void refresh(); }, pollMs);
    return () => window.clearInterval(t);
  }, [refresh, pollMs]);

  const markAll = useCallback(async () => {
    // The server caps one read at 200 rows — loop until the unread set is
    // empty so "mark all" means ALL (bounded: 20 × 200 = 4,000 rows).
    for (let i = 0; i < 20; i += 1) {
      const pending = await fetchNotifications({ unread_only: true, limit: 200 });
      const ids = pending.rows.map((r) => r.id);
      if (ids.length === 0) break;
      await markNotificationsRead(ids);
      if (ids.length < 200) break;
    }
    await refresh();
  }, [refresh]);

  const markOne = useCallback(async (id: string) => {
    // Optimistic — the row must dim on click, not after the round-trip.
    setRows((rs) => rs.map((r) => (r.id === id && !r.read_at
      ? { ...r, read_at: new Date().toISOString() }
      : r)));
    setUnread((u) => Math.max(0, u - 1));
    await markNotificationsRead([id]);
  }, []);

  return { rows, unread, loading, error, refresh, markAll, markOne };
}

/* ------------------------------------------------------------------ */
/* one inbox row — shared by the bell dropdown and screen 43's card    */
/* ------------------------------------------------------------------ */

export function NotificationRow({
  n, isAr, onOpen,
}: {
  n: MosNotification;
  isAr: boolean;
  onOpen: (n: MosNotification) => void;
}) {
  const title = isAr ? n.title_ar : (n.title_en ?? n.title_ar);
  const body = isAr ? n.body_ar : (n.body_en ?? n.body_ar);
  return (
    <button
      type="button"
      className={`se-notif${n.read_at ? '' : ' unread'}`}
      onClick={() => onOpen(n)}
    >
      <span className="av a-c">{initial(title)}</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="se-notif-t" style={{ display: 'block' }}>{title}</span>
        {body && <span className="se-notif-b" style={{ display: 'block' }}>{body}</span>}
        <span className="se-notif-w" style={{ display: 'block' }}>{timeAgo(n.created_at, isAr)}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* the bell                                                            */
/* ------------------------------------------------------------------ */

function IconBell() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20h4" />
    </svg>
  );
}

export default function NotificationBell() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const { rows, unread, loading, error, refresh, markAll, markOne } = useMosNotifications(60_000);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const toggle = (): void => {
    if (open) { setOpen(false); return; }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rtl = document.documentElement.dir === 'rtl';
    setPos(rtl
      ? { top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) }
      : { top: rect.bottom + 8, left: Math.max(8, rect.left) });
    setOpen(true);
    void refresh();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n: MosNotification): void => {
    if (!n.read_at) {
      markOne(n.id).catch((e: unknown) =>
        addToast(e instanceof Error ? e.message : String(e), 'error'));
    }
    setOpen(false);
    if (n.url && n.url.startsWith('/')) navigate(n.url);
  };

  const markAllClick = async (): Promise<void> => {
    setMarking(true);
    try {
      await markAll();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setMarking(false);
    }
  };

  return (
    <span className="se-bell">
      <button
        ref={btnRef}
        type="button"
        className="se-bell-btn rail"
        onClick={toggle}
        aria-label={isAr ? 'الإشعارات' : 'Notifications'}
        title={isAr ? 'الإشعارات' : 'Notifications'}
      >
        <IconBell />
        {unread > 0 && <span className="se-bell-badge">{num(unread, isAr)}</span>}
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="mos-root se-bell-fly"
          style={pos}
          role="dialog"
          aria-label={isAr ? 'مركز الإشعارات' : 'Notification centre'}
        >
          <div className="card-h">
            <h4>{isAr ? 'الإشعارات' : 'Notifications'}</h4>
            {unread > 0 && (
              <span className="pill p-now" style={{ marginInlineStart: 'auto' }}>
                {num(unread, isAr)}
              </span>
            )}
          </div>
          <div className="se-bell-list">
            {error && (
              <div className="se-notif-b" style={{ padding: '12px 14px' }}>
                {isAr ? 'تعذّر تحميل الإشعارات: ' : 'Notifications could not load: '}{error}
              </div>
            )}
            {!error && loading && (
              <div className="se-notif-b" style={{ padding: '12px 14px' }}>
                {isAr ? 'يُحمَّل…' : 'Loading…'}
              </div>
            )}
            {!error && !loading && rows.length === 0 && (
              <div className="se-notif-b" style={{ padding: '12px 14px' }}>
                {isAr ? 'لا إشعارات بعد.' : 'No notifications yet.'}
              </div>
            )}
            {!error && rows.map((n) => (
              <NotificationRow key={n.id} n={n} isAr={isAr} onOpen={openItem} />
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--line-soft)', padding: '10px 14px' }}>
            <button
              type="button"
              className="btn btn-d btn-sm"
              disabled={unread === 0 || marking}
              onClick={() => void markAllClick()}
            >
              {isAr ? 'تعليم الكل كمقروء' : 'Mark all as read'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

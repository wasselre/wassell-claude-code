/**
 * What the customer does on a tracked page → /api/tracked-link (action 'track').
 *
 * - One SESSION per page view (random id) — the server counts sessions and days.
 * - Events are queued and flushed every few seconds with fetch(keepalive); when
 *   the page is hidden or closed the rest goes by navigator.sendBeacon, so a
 *   customer who reads and leaves is still counted.
 * - Time on page is counted only while the tab is VISIBLE, as short beats.
 * - A tracking failure never breaks the page: it is logged, not thrown — the
 *   customer's experience matters more than one lost event. (Scoped: this is the
 *   only place that swallows, and it logs.)
 */

export type TrackKind = 'view' | 'photo_open' | 'video_play' | 'video_progress' | 'time' | 'brochure_page' | 'map_open' | 'unit_open';
export type TrackSection = 'photos' | 'videos' | 'brochure' | 'units' | 'location' | 'unit';
interface TrackEvent { kind: TrackKind; section: TrackSection; item?: string; value?: number }

const FLUSH_MS = 5000;
const BEAT_MS = 15000;
const ENDPOINT = '/api/tracked-link';

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

export class Tracker {
  private queue: TrackEvent[] = [];
  private readonly session = randomId();
  private flushTimer: number | null = null;
  private beatTimer: number | null = null;
  private visibleSince: number | null = null;
  private readonly seen = new Set<string>();
  private stopped = false;

  constructor(private readonly token: string, private readonly section: TrackSection) {}

  start(): void {
    this.push({ kind: 'view', section: this.section });
    if (document.visibilityState === 'visible') this.visibleSince = Date.now();
    this.flushTimer = window.setInterval(() => this.flush(false), FLUSH_MS);
    this.beatTimer = window.setInterval(() => this.beat(), BEAT_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onHide);
    this.flush(false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.beat();
    this.flush(true);
    if (this.flushTimer !== null) window.clearInterval(this.flushTimer);
    if (this.beatTimer !== null) window.clearInterval(this.beatTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onHide);
  }

  /** Record an event; `once` de-duplicates within this page view (e.g. a unit opened twice). */
  track(kind: TrackKind, opts: { item?: string; value?: number; section?: TrackSection; once?: boolean } = {}): void {
    const section = opts.section ?? this.section;
    if (opts.once) {
      const key = `${kind}|${section}|${opts.item ?? ''}|${opts.value ?? ''}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.push({ kind, section, item: opts.item, value: opts.value });
  }

  /** Send now (e.g. right before leaving for Google Maps). */
  flushNow(): void {
    this.flush(true);
  }

  private push(e: TrackEvent): void {
    if (!this.stopped) this.queue.push(e);
  }

  private beat(): void {
    if (this.visibleSince === null) return;
    const seconds = Math.round((Date.now() - this.visibleSince) / 1000);
    this.visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
    if (seconds > 0) this.queue.push({ kind: 'time', section: this.section, value: Math.min(seconds, 120) });
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.beat();
      this.visibleSince = null;
      this.flush(true);
    } else {
      this.visibleSince = Date.now();
    }
  };

  private readonly onHide = () => {
    this.beat();
    this.flush(true);
  };

  private flush(leaving: boolean): void {
    if (!this.queue.length) return;
    const events = this.queue.splice(0, 40);
    const body = JSON.stringify({ token: this.token, action: 'track', session: this.session, events });
    try {
      if (leaving && typeof navigator.sendBeacon === 'function') {
        const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        if (ok) return;
      }
      void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
        .catch((e: unknown) => console.error('[tracked-link] track failed:', e));
    } catch (e) {
      console.error('[tracked-link] track failed:', e);
    }
  }
}

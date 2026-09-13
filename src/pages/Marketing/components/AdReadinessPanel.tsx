/**
 * The pre-approval gate for the FINAL manager approval.
 *
 * Until now every requirement for a Meta ad — both design slots, the caption,
 * the project link, the ad set, the saved audience, the welcome template — was
 * discovered MINUTES AFTER the approval, as a worker job failure. The manager
 * tapped «اعتماد», the ad silently did not appear, and a task came back with a
 * reason. Five of C-042's eight creatives failed exactly that way.
 *
 * This renders the same checks BEFORE the tap, live from
 * `content_ad_readiness`, and lets the caller disable the approve button while
 * anything is missing. Approving is still possible — but as «اعتماد بدون
 * إعلان», an explicit choice, never a silent one.
 *
 * Blocker codes are resolved server-side and arrive bilingual, so a new check
 * added in SQL shows up here with no client change.
 */
import { useEffect, useState } from 'react';
import { fetchAdReadiness, type MosAdReadiness } from '@/lib/marketingOS/client';

export interface AdReadinessState {
  loading: boolean;
  readiness: MosAdReadiness | null;
  error: string | null;
}

/**
 * Load the readiness for a content item. `enabled` should be false when the
 * step does not create an ad, so we never spend a round-trip on it.
 */
export function useAdReadiness(
  contentId: string | null,
  enabled: boolean,
  executionId?: string | null,
): AdReadinessState {
  const [state, setState] = useState<AdReadinessState>({ loading: false, readiness: null, error: null });

  useEffect(() => {
    if (!contentId || !enabled) { setState({ loading: false, readiness: null, error: null }); return; }
    let alive = true;
    setState({ loading: true, readiness: null, error: null });
    fetchAdReadiness(contentId, executionId ?? null)
      .then((r) => { if (alive) setState({ loading: false, readiness: r.readiness, error: null }); })
      .catch((e) => {
        // A readiness check that cannot run must NOT silently read as "ready" —
        // it reads as unknown, and the caller keeps the approve button live.
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[ad-readiness] failed', msg);
        if (alive) setState({ loading: false, readiness: null, error: msg });
      });
    return () => { alive = false; };
  }, [contentId, enabled, executionId]);

  return state;
}

export default function AdReadinessPanel({
  state, isAr,
}: {
  state: AdReadinessState;
  isAr: boolean;
}) {
  if (state.loading) {
    return (
      <div className="note" style={{ fontSize: 12.5 }}>
        {isAr ? 'يتحقق من متطلبات الإعلان…' : 'Checking the ad requirements…'}
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="note note-w" style={{ fontSize: 12.5 }}>
        {isAr
          ? 'تعذّر التحقق من متطلبات الإعلان — الاعتماد ما زال ممكنًا، وقد يفشل إنشاء الإعلان لاحقًا.'
          : 'The ad requirements could not be checked — approval is still possible, and ad creation may fail later.'}
      </div>
    );
  }
  if (!state.readiness) return null;

  const { ok, blockers } = state.readiness;
  if (ok) {
    return (
      <div className="note note-ok" style={{ fontSize: 12.5 }}>
        {isAr
          ? 'كل متطلبات الإعلان مكتملة — سيُنشأ الإعلان بعد الاعتماد.'
          : 'Every ad requirement is met — the ad will be created after approval.'}
      </div>
    );
  }

  return (
    <div className="note note-w" style={{ fontSize: 12.5 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        {isAr
          ? 'ينقص الإعلان ما يلي — الاعتماد الآن لن يُنشئ إعلانًا:'
          : 'The ad is missing the following — approving now will not create one:'}
      </div>
      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
        {blockers.map((b) => (
          <li key={b.code} style={{ lineHeight: 1.8 }}>
            {isAr ? b.label_ar : b.label_en}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** True when the item is ad-bound and something is genuinely missing. */
export function hasAdBlockers(state: AdReadinessState): boolean {
  return Boolean(state.readiness && !state.readiness.ok && state.readiness.blockers.length > 0);
}

import { describe, it, expect, vi } from 'vitest';
import {
  createGeoObserver,
  scrubPii,
  pseudonymizeCoordinate,
  redactPreferenceForRole,
  nullObserver,
  type GeoEvent,
  type PreferenceReviewRow,
} from '../observability';

/**
 * Observability + PII redaction safeguards.
 *
 * Two guarantees under test:
 *  1. structured events carry latency + outcome + failure, and time() NEVER
 *     swallows an error (CLAUDE.md silent-failure rule);
 *  2. the redaction helpers keep phone/name out of the meaning-reviewer view and
 *     hand the geo operator PSEUDONYMIZED coordinates only.
 */

function capture() {
  const events: GeoEvent[] = [];
  const observer = createGeoObserver((e) => events.push(e));
  return { events, observer };
}

describe('geoObserver.time — records latency + outcome, never swallows', () => {
  it('emits an ok event with latency for a successful stage', async () => {
    const { events, observer } = capture();
    const out = await observer.time('resolution', { client_id: 'c1', detail: { anchors: 2 } }, async () => 42);
    expect(out).toBe(42);
    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe('resolution');
    expect(events[0].outcome).toBe('ok');
    expect(typeof events[0].latency_ms).toBe('number');
    expect(events[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(events[0].detail).toEqual({ anchors: 2 });
  });

  it('re-throws on failure AND records an error event with the message (never swallows)', async () => {
    const { events, observer } = capture();
    await expect(
      observer.time('review_outcome', { client_id: 'c1' }, async () => {
        throw new Error('createProposal failed');
      }),
    ).rejects.toThrow('createProposal failed');

    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('error');
    expect(events[0].error).toBe('createProposal failed');
    expect(typeof events[0].latency_ms).toBe('number');
  });

  it('a throwing SINK never breaks the pipeline (logging is best-effort)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observer = createGeoObserver(() => {
      throw new Error('sink is down');
    });
    // The pipeline result must still come through even though the sink threw.
    const out = await observer.time('gating', {}, async () => 'ok');
    expect(out).toBe('ok');
    spy.mockRestore();
  });
});

describe('scrubPii — drops PII-ish keys from a detail payload', () => {
  it('removes phone/name/coordinates/utterance keys, keeps counts + versions', () => {
    const scrubbed = scrubPii({
      phone: '+966500000000',
      client_name: 'تركي',
      lat: 24.6,
      lng: 46.5,
      mention_span: 'أبي المهدية',
      anchors: 2,
      resolver_version: 'v7',
    });
    expect(scrubbed).toEqual({ anchors: 2, resolver_version: 'v7' });
  });

  it('undefined in ⇒ undefined out', () => {
    expect(scrubPii(undefined)).toBeUndefined();
  });
});

describe('pseudonymizeCoordinate — reduced precision + stable non-identifying pseudonym', () => {
  it('truncates to the grid precision and never exposes the exact pin', () => {
    const p = pseudonymizeCoordinate({ lat: 24.63719, lng: 46.55234 }, 'client-123', { precision: 2 });
    expect(p).not.toBeNull();
    expect(p!.lat).toBe(24.63);
    expect(p!.lng).toBe(46.55);
    // precision 2 ⇒ at most 2 decimals of leak.
    expect(p!.lat.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('the pseudonym is stable per client and does NOT contain the client id', () => {
    const a = pseudonymizeCoordinate({ lat: 1, lng: 2 }, 'client-123')!;
    const b = pseudonymizeCoordinate({ lat: 9, lng: 9 }, 'client-123')!;
    expect(a.pseudonym).toBe(b.pseudonym); // same client ⇒ same pseudonym
    expect(a.pseudonym).not.toContain('client-123');
    const other = pseudonymizeCoordinate({ lat: 1, lng: 2 }, 'client-999')!;
    expect(other.pseudonym).not.toBe(a.pseudonym); // different client ⇒ different pseudonym
  });

  it('null / malformed coordinate ⇒ null', () => {
    expect(pseudonymizeCoordinate(null, 'c')).toBeNull();
    // @ts-expect-error deliberately malformed
    expect(pseudonymizeCoordinate({ lat: 'x', lng: 1 }, 'c')).toBeNull();
  });
});

describe('redactPreferenceForRole — role-scoped PII/coordinate access', () => {
  const full: PreferenceReviewRow = {
    proposal_id: 'prop-1',
    client_id: 'client-123',
    client_phone: '+966500000000',
    client_name: 'تركي',
    mention_span: 'أبي المهدية شمال الرياض',
    meaning: { preference_role: 'positive', applicability: 'active' },
    coordinate: { lat: 24.63719, lng: 46.55234 },
    proposed_action: 'confirm',
  };

  it('meaning_reviewer: gets meaning + action, but NO phone/name/coordinates/utterance', () => {
    const r = redactPreferenceForRole(full, 'meaning_reviewer');
    expect(r.meaning).toEqual({ preference_role: 'positive', applicability: 'active' });
    expect(r.proposed_action).toBe('confirm');
    // redacted away entirely:
    expect(r.client_phone).toBeUndefined();
    expect(r.client_name).toBeUndefined();
    expect(r.client_id).toBeUndefined();
    expect(r.mention_span).toBeUndefined();
    expect(r.coordinate).toBeUndefined();
    expect(r.pseudo_coordinate).toBeUndefined();
  });

  it('geo_operator: gets PSEUDONYMIZED coordinates only — no phone/name/precise pin/meaning', () => {
    const r = redactPreferenceForRole(full, 'geo_operator');
    expect(r.pseudo_coordinate).not.toBeNull();
    expect(r.pseudo_coordinate!.lat).toBe(24.63); // truncated, not the exact 24.63719
    expect(r.pseudo_coordinate!.pseudonym).toBeTruthy();
    // no PII, no precise coordinate, no meaning, no raw utterance:
    expect(r.client_phone).toBeUndefined();
    expect(r.client_name).toBeUndefined();
    expect(r.client_id).toBeUndefined();
    expect(r.coordinate).toBeUndefined();
    expect(r.meaning).toBeUndefined();
    expect(r.mention_span).toBeUndefined();
  });

  it('admin: sees the full, unredacted row', () => {
    const r = redactPreferenceForRole(full, 'admin');
    expect(r.client_phone).toBe('+966500000000');
    expect(r.client_name).toBe('تركي');
    expect(r.coordinate).toEqual({ lat: 24.63719, lng: 46.55234 });
    expect(r.mention_span).toBe('أبي المهدية شمال الرياض');
  });
});

describe('nullObserver — silences the pipeline without altering results', () => {
  it('runs the fn and returns its value, emitting nothing', async () => {
    const out = await nullObserver.time('extraction', {}, async () => 'result');
    expect(out).toBe('result');
    nullObserver.event({ stage: 'gating', outcome: 'ok' }); // no throw, no effect
  });
});

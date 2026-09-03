import { describe, it, expect } from 'vitest';
import {
  ClaimLedger,
  dedupKey,
  setDoneStore,
  type BackfillItem,
} from '../backfillClaim';

/**
 * Backfill idempotency + concurrency. Two failure modes it must prevent:
 *  - two workers racing the SAME item both processing it (double LLM spend / dup
 *    evidence);
 *  - a re-run reprocessing items a prior run already finished.
 */

const ITEM: BackfillItem = { conversation_id: 'conv-1', extraction_version: 'geo-extract/v7', channel: 'chat' };

describe('dedupKey — deterministic per (conversation, version, channel)', () => {
  it('is stable and version-sensitive', () => {
    expect(dedupKey(ITEM)).toBe('chat:conv-1@geo-extract/v7');
    expect(dedupKey(ITEM)).toBe(dedupKey({ ...ITEM }));
    // a NEW extractor version is a DIFFERENT key ⇒ intentional reprocessing
    expect(dedupKey({ ...ITEM, extraction_version: 'geo-extract/v8' })).not.toBe(dedupKey(ITEM));
  });

  it('channel qualifies the key when present', () => {
    expect(dedupKey({ conversation_id: 'x', extraction_version: 'v7' })).toBe('x@v7');
    expect(dedupKey({ conversation_id: 'x', extraction_version: 'v7', channel: 'call' })).toBe('call:x@v7');
  });
});

describe('ClaimLedger — concurrency: exactly one worker claims a key', () => {
  it('two concurrent claims for the same key ⇒ only ONE succeeds', () => {
    const ledger = new ClaimLedger();
    const key = dedupKey(ITEM);
    const first = ledger.claim(key);
    const second = ledger.claim(key); // racing worker, same tick
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'in_flight' });
    expect(ledger.stats().claimed).toBe(1);
  });

  it('simulated two-worker race: the item is processed exactly once', () => {
    const ledger = new ClaimLedger();
    const key = dedupKey(ITEM);
    let processed = 0;
    const worker = () => { if (ledger.claim(key).ok) { processed += 1; ledger.complete(key); } };
    worker();
    worker();
    expect(processed).toBe(1);
  });

  it('a released (failed) claim can be re-claimed by a later run', () => {
    const ledger = new ClaimLedger();
    const key = dedupKey(ITEM);
    expect(ledger.claim(key).ok).toBe(true);
    ledger.release(key); // item failed — not marked done
    const retry = ledger.claim(key);
    expect(retry.ok).toBe(true);
  });
});

describe('ClaimLedger — idempotency: re-runs skip done work', () => {
  it('a key done by a PRIOR run (DoneStore) is never re-claimed', () => {
    const done = new Set<string>([dedupKey(ITEM)]);
    const ledger = new ClaimLedger(setDoneStore(done));
    expect(ledger.claim(dedupKey(ITEM))).toEqual({ ok: false, reason: 'already_done' });
  });

  it('a key completed EARLIER THIS run is never re-claimed', () => {
    const ledger = new ClaimLedger();
    const key = dedupKey(ITEM);
    expect(ledger.claim(key).ok).toBe(true);
    ledger.complete(key);
    expect(ledger.claim(key)).toEqual({ ok: false, reason: 'completed' });
    expect(ledger.isDone(key)).toBe(true);
  });

  it('completing is idempotent and different keys are independent', () => {
    const ledger = new ClaimLedger();
    const k1 = dedupKey(ITEM);
    const k2 = dedupKey({ ...ITEM, conversation_id: 'conv-2' });
    ledger.claim(k1); ledger.complete(k1); ledger.complete(k1); // idempotent
    expect(ledger.claim(k2).ok).toBe(true); // independent item unaffected
    expect(ledger.stats().completed).toBe(1);
  });
});

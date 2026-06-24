import { describe, it, expect } from 'vitest';
import { isModelServerEnrolled } from '../serverWorkflowEnrollment';

describe('isModelServerEnrolled', () => {
  it('returns true when the model is in the enrolled set (client must skip)', () => {
    expect(isModelServerEnrolled('m1', new Set(['m1', 'm2']))).toBe(true);
  });

  it('returns false when the model is not enrolled (client keeps firing)', () => {
    expect(isModelServerEnrolled('m3', new Set(['m1', 'm2']))).toBe(false);
  });

  it('returns false for an empty set — the fail-safe default (load failure → client keeps existing behavior)', () => {
    expect(isModelServerEnrolled('m1', new Set<string>())).toBe(false);
  });
});

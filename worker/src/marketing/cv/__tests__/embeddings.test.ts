import { describe, it, expect } from 'vitest';
import { cosineDistance, l2Normalise, meanEmbedding, parseVector } from '../embeddings.js';

describe('parseVector', () => {
  it('reads the PostgREST string literal and plain arrays', () => {
    expect(parseVector('[0.1, -2,3e-1]')).toEqual([0.1, -2, 0.3]);
    expect(parseVector([1, '2', 3])).toEqual([1, 2, 3]);
    expect(parseVector('[]')).toEqual([]);
  });
  it('returns null for anything else', () => {
    expect(parseVector(null)).toBeNull();
    expect(parseVector('nope')).toBeNull();
    expect(parseVector('[1,x]')).toBeNull();
    expect(parseVector({})).toBeNull();
  });
});

describe('meanEmbedding', () => {
  it('averages element-wise', () => {
    expect(meanEmbedding([[1, 2, 3], [3, 2, 1], [2, 2, 2]])).toEqual([2, 2, 2]);
    expect(meanEmbedding([[0.5, 1.5]])).toEqual([0.5, 1.5]);
  });
  it('is null for no input and throws on a dimension mismatch', () => {
    expect(meanEmbedding([])).toBeNull();
    expect(() => meanEmbedding([[1, 2], [1, 2, 3]])).toThrow(/dimension mismatch/);
  });
});

describe('cosineDistance', () => {
  it('is 0 for parallel, 1 for orthogonal, 2 for opposite vectors', () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0, 10);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 10);
  });
  it('treats a zero vector as orthogonal and rejects mismatched dims', () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1);
    expect(() => cosineDistance([1], [1, 2])).toThrow(/dimension mismatch/);
  });
});

describe('l2Normalise', () => {
  it('yields a unit vector and leaves zeros alone', () => {
    const n = l2Normalise([3, 4]);
    expect(n).toEqual([0.6, 0.8]);
    expect(l2Normalise([0, 0])).toEqual([0, 0]);
  });
});

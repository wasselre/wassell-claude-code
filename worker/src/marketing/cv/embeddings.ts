// ============================================================================
// Vector helpers. pgvector columns come back from PostgREST as a string literal
// ("[0.1,0.2,…]"), and go in as a JSON number array. Pure — unit tested.
// ============================================================================

/** Parse a pgvector value (string literal, JSON array, or null) to number[]. */
export function parseVector(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const out = v.map(Number);
    return out.every(Number.isFinite) ? out : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s.startsWith('[') || !s.endsWith(']')) return null;
    if (s === '[]') return [];
    const out = s.slice(1, -1).split(',').map((x) => Number(x.trim()));
    return out.every(Number.isFinite) ? out : null;
  }
  return null;
}

/**
 * Element-wise mean of equal-length vectors. Throws on a dimension mismatch —
 * averaging a 768-d SigLIP vector with a 1024-d text vector is a bug, not data.
 * Returns null for an empty input (a shot with no embedded keyframes).
 */
export function meanEmbedding(vectors: readonly (readonly number[])[]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  if (dim === 0) return null;
  const acc = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) throw new Error(`meanEmbedding: dimension mismatch (${v.length} vs ${dim})`);
    for (let i = 0; i < dim; i++) acc[i]! += v[i]!;
  }
  const n = vectors.length;
  for (let i = 0; i < dim; i++) acc[i] = acc[i]! / n;
  return acc;
}

/** Cosine distance (1 − cosine similarity) in [0, 2]. Throws on a dimension
 *  mismatch; returns 1 (orthogonal) when either vector is all zeros. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosineDistance: dimension mismatch (${a.length} vs ${b.length})`);
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2-normalise in place-free form (cosine search is scale-invariant, but a
 *  unit vector keeps HNSW distances comparable across shots). */
export function l2Normalise(v: readonly number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return [...v];
  return v.map((x) => x / norm);
}

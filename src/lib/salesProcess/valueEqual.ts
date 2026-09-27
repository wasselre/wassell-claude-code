// Value helpers shared by the qualification draft (SPA) and the chat preference
// review (server, via src/lib/clientPrefs/mergePrefs.ts). PURE and import-free
// on purpose: it is bundled into api/** functions, which must not pull in the
// SPA store or `@/` value imports.

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('min' in o || 'max' in o) return o.min == null && o.max == null;
    return Object.keys(o).length === 0;
  }
  return false;
}

/** Order-insensitive, key-stable stringify so array unions and range key order don't
 *  produce spurious "changes". */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).sort().join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function valueEqual(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return stableStringify(a) === stableStringify(b);
}

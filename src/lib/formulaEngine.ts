// Formula field engine: parses and evaluates math/text/logic/date expressions
// that can reference other fields in the same record via `{field_slug}` tokens.
// Evaluates at save time (snapshot into record.data) and in the record form's
// live preview (recomputed against current form state).
//
// Grammar:
//   expression = compare
//   compare    = addsub (('=' | '==' | '!=' | '<>' | '<=' | '>=' | '<' | '>') addsub)?
//   addsub     = muldiv (('+' | '-') muldiv)*
//   muldiv     = unary (('*' | '/') unary)*
//   unary      = '-' unary | primary
//   primary    = number | string | bool | '{' slug ('.' segment)* '}' | identifier '(' args? ')' | '(' expression ')'
//
// Dot-path refs (e.g. `{area.min}`) address sub-values of structured fields —
// currently only range (`{slug.min}` / `{slug.max}`).
// Functions: IF, CONCAT/CONCATENATE, DAYS, ADD_DAYS.
// Error sentinels: "#DIV0", "#REF", "#ERR", "#CYCLE" — returned as strings so
// cells render them without special casing.

import type { AppModel, ModelField } from '@/types';

export type FormulaError = '#DIV0' | '#REF' | '#ERR' | '#CYCLE';
export type FormulaValue = number | string | boolean | null;

// ── AST ──────────────────────────────────────────────────────────────────────

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'ref'; slug: string; path: string[] }
  | { kind: 'neg'; child: Node }
  | { kind: 'bin'; op: BinOp; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

type BinOp = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '>' | '<=' | '>=';

// ── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'punct'; v: string }
  | { t: 'eof' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '{') {
      let j = i + 1;
      while (j < src.length && src[j] !== '}') j++;
      if (j >= src.length) throw new Error('Unterminated field reference');
      out.push({ t: 'ref', v: src.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let val = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          val += src[j + 1];
          j += 2;
        } else {
          val += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error('Unterminated string literal');
      out.push({ t: 'str', v: val });
      i = j + 1;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && ((src[j]! >= '0' && src[j]! <= '9') || src[j] === '.')) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    // Two-char punct first
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<>' || two === '<=' || two === '>=') {
      out.push({ t: 'punct', v: two === '==' ? '=' : two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }
    if ('+-*/()=<>,'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character: ${c}`);
  }
  out.push({ t: 'eof' });
  return out;
}

// ── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  private peek(): Token { return this.toks[this.pos]!; }
  private eatPunct(v: string): boolean {
    const t = this.peek();
    if (t.t === 'punct' && t.v === v) { this.pos++; return true; }
    return false;
  }
  private expectPunct(v: string): void {
    if (!this.eatPunct(v)) throw new Error(`Expected '${v}'`);
  }

  parse(): Node {
    const node = this.expression();
    if (this.peek().t !== 'eof') throw new Error('Trailing tokens');
    return node;
  }

  private expression(): Node { return this.compare(); }

  private compare(): Node {
    let left = this.addsub();
    const t = this.peek();
    if (t.t === 'punct' && ['=', '!=', '<', '>', '<=', '>='].includes(t.v)) {
      const op = t.v as BinOp;
      this.pos++;
      const right = this.addsub();
      left = { kind: 'bin', op, left, right };
    }
    return left;
  }

  private addsub(): Node {
    let left = this.muldiv();
    while (true) {
      const t = this.peek();
      if (t.t === 'punct' && (t.v === '+' || t.v === '-')) {
        this.pos++;
        const right = this.muldiv();
        left = { kind: 'bin', op: t.v as BinOp, left, right };
      } else break;
    }
    return left;
  }

  private muldiv(): Node {
    let left = this.unary();
    while (true) {
      const t = this.peek();
      if (t.t === 'punct' && (t.v === '*' || t.v === '/')) {
        this.pos++;
        const right = this.unary();
        left = { kind: 'bin', op: t.v as BinOp, left, right };
      } else break;
    }
    return left;
  }

  private unary(): Node {
    if (this.eatPunct('-')) return { kind: 'neg', child: this.unary() };
    return this.primary();
  }

  private primary(): Node {
    const t = this.peek();
    if (t.t === 'num') { this.pos++; return { kind: 'num', value: t.v }; }
    if (t.t === 'str') { this.pos++; return { kind: 'str', value: t.v }; }
    if (t.t === 'ref') {
      this.pos++;
      const segs = t.v.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
      if (segs.length === 0) throw new Error('Empty field reference');
      return { kind: 'ref', slug: segs[0]!, path: segs.slice(1) };
    }
    if (t.t === 'id') {
      this.pos++;
      const name = t.v;
      if (name.toLowerCase() === 'true') return { kind: 'bool', value: true };
      if (name.toLowerCase() === 'false') return { kind: 'bool', value: false };
      // Function call — identifier followed by '('
      if (this.eatPunct('(')) {
        const args: Node[] = [];
        if (!this.eatPunct(')')) {
          args.push(this.expression());
          while (this.eatPunct(',')) args.push(this.expression());
          this.expectPunct(')');
        }
        return { kind: 'call', name: name.toUpperCase(), args };
      }
      throw new Error(`Unexpected identifier: ${name}`);
    }
    if (t.t === 'punct' && t.v === '(') {
      this.pos++;
      const inner = this.expression();
      this.expectPunct(')');
      return inner;
    }
    throw new Error('Unexpected token');
  }
}

// ── Public helpers ───────────────────────────────────────────────────────────

const compileCache = new Map<string, Node>();

function compile(expression: string): Node {
  const cached = compileCache.get(expression);
  if (cached) return cached;
  const toks = tokenize(expression);
  const ast = new Parser(toks).parse();
  compileCache.set(expression, ast);
  return ast;
}

/**
 * Extract the base slugs referenced by a formula (sub-paths are stripped). Returns
 * unique slugs. Used for dependency tracking — topoSort and cycle detection
 * operate on whole fields, not sub-values.
 */
export function extractReferences(expression: string): string[] {
  const set = new Set<string>();
  try {
    const ast = compile(expression);
    walk(ast, (n) => { if (n.kind === 'ref') set.add(n.slug); });
  } catch {
    // Fallback: extract with regex so callers can still warn about refs in malformed expressions.
    const re = /\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expression)) !== null) {
      const raw = m[1]!.trim();
      const base = raw.split('.')[0]!.trim();
      if (base) set.add(base);
    }
  }
  return [...set];
}

function walk(n: Node, visit: (n: Node) => void): void {
  visit(n);
  if (n.kind === 'neg') walk(n.child, visit);
  else if (n.kind === 'bin') { walk(n.left, visit); walk(n.right, visit); }
  else if (n.kind === 'call') n.args.forEach((a) => walk(a, visit));
}

/** Verify a formula parses without throwing. Returns null on success or an error message. */
export function validateFormula(expression: string): string | null {
  if (!expression.trim()) return 'Empty expression';
  try { compile(expression); return null; }
  catch (e) { return e instanceof Error ? e.message : 'Invalid formula'; }
}

/**
 * Rewrite `{oldSlug}` and `{oldSlug.sub}` tokens to use `newSlug`, leaving the
 * sub-path and surrounding whitespace untouched. String literals and function
 * names are never matched because slugs only appear inside `{...}` tokens.
 * Returns the expression unchanged if no references exist.
 */
export function rewriteFormulaSlug(expression: string, oldSlug: string, newSlug: string): string {
  if (!expression || oldSlug === newSlug) return expression;
  const escaped = oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\{\\s*${escaped}(\\.[^}]*)?\\s*\\}`, 'g');
  return expression.replace(re, (_m, tail) => `{${newSlug}${tail ?? ''}}`);
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function coerceNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (v.trim() === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  if (v === null || v === undefined) return 0;
  return NaN;
}

function coerceString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function coerceBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (v === '' || v === '0' || v.toLowerCase() === 'false') return false;
    return true;
  }
  return !!v;
}

function coerceDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function isErrorValue(v: unknown): v is FormulaError {
  return typeof v === 'string' && (v === '#DIV0' || v === '#REF' || v === '#ERR' || v === '#CYCLE');
}

class EvalError extends Error { constructor(public code: FormulaError) { super(code); } }

function evalNode(n: Node, data: Record<string, unknown>): FormulaValue {
  switch (n.kind) {
    case 'num': return n.value;
    case 'str': return n.value;
    case 'bool': return n.value;
    case 'ref': {
      if (!(n.slug in data)) throw new EvalError('#REF');
      let v: unknown = data[n.slug];
      if (isErrorValue(v)) throw new EvalError(v);
      for (const key of n.path) {
        if (v === null || v === undefined || typeof v !== 'object') return null;
        v = (v as Record<string, unknown>)[key];
        if (isErrorValue(v)) throw new EvalError(v);
      }
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
      // Arrays / objects aren't meaningful as terminal values in formulas.
      return null;
    }
    case 'neg': {
      const c = evalNode(n.child, data);
      const num = coerceNumber(c);
      if (!Number.isFinite(num)) throw new EvalError('#ERR');
      return -num;
    }
    case 'bin': return evalBin(n, data);
    case 'call': return evalCall(n, data);
  }
}

function evalBin(n: Extract<Node, { kind: 'bin' }>, data: Record<string, unknown>): FormulaValue {
  const L = evalNode(n.left, data);
  const R = evalNode(n.right, data);

  // '+' doubles as string concat when either side is a string (non-empty or
  // the other side is also a string). Otherwise numeric.
  if (n.op === '+') {
    if (typeof L === 'string' || typeof R === 'string') return coerceString(L) + coerceString(R);
    return coerceNumber(L) + coerceNumber(R);
  }
  if (n.op === '-' || n.op === '*' || n.op === '/') {
    const a = coerceNumber(L);
    const b = coerceNumber(R);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new EvalError('#ERR');
    if (n.op === '-') return a - b;
    if (n.op === '*') return a * b;
    if (b === 0) throw new EvalError('#DIV0');
    return a / b;
  }
  // Comparisons — numeric when both sides are numeric, otherwise string.
  const bothNumeric =
    (typeof L === 'number' || (typeof L === 'string' && L !== '' && Number.isFinite(Number(L)))) &&
    (typeof R === 'number' || (typeof R === 'string' && R !== '' && Number.isFinite(Number(R))));
  const a = bothNumeric ? coerceNumber(L) : coerceString(L);
  const b = bothNumeric ? coerceNumber(R) : coerceString(R);
  switch (n.op) {
    case '=':  return a === b;
    case '!=': return a !== b;
    case '<':  return a <  b;
    case '>':  return a >  b;
    case '<=': return a <= b;
    case '>=': return a >= b;
  }
  throw new EvalError('#ERR');
}

function evalCall(n: Extract<Node, { kind: 'call' }>, data: Record<string, unknown>): FormulaValue {
  switch (n.name) {
    case 'IF': {
      if (n.args.length !== 3) throw new EvalError('#ERR');
      const cond = evalNode(n.args[0]!, data);
      return coerceBoolean(cond)
        ? evalNode(n.args[1]!, data)
        : evalNode(n.args[2]!, data);
    }
    case 'CONCAT':
    case 'CONCATENATE': {
      return n.args.map((a) => coerceString(evalNode(a, data))).join('');
    }
    case 'DAYS': {
      if (n.args.length !== 2) throw new EvalError('#ERR');
      const end = coerceDate(evalNode(n.args[0]!, data));
      const start = coerceDate(evalNode(n.args[1]!, data));
      if (!end || !start) throw new EvalError('#ERR');
      const ms = end.getTime() - start.getTime();
      return Math.round(ms / (1000 * 60 * 60 * 24));
    }
    case 'ADD_DAYS': {
      if (n.args.length !== 2) throw new EvalError('#ERR');
      const d = coerceDate(evalNode(n.args[0]!, data));
      const days = coerceNumber(evalNode(n.args[1]!, data));
      if (!d || !Number.isFinite(days)) throw new EvalError('#ERR');
      const out = new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
      return out.toISOString().slice(0, 10);
    }
    case 'ROUND': {
      if (n.args.length < 1 || n.args.length > 2) throw new EvalError('#ERR');
      const num = coerceNumber(evalNode(n.args[0]!, data));
      const digits = n.args.length === 2 ? coerceNumber(evalNode(n.args[1]!, data)) : 0;
      if (!Number.isFinite(num) || !Number.isFinite(digits)) throw new EvalError('#ERR');
      const mult = Math.pow(10, digits);
      return Math.round(num * mult) / mult;
    }
    case 'ABS': {
      if (n.args.length !== 1) throw new EvalError('#ERR');
      const num = coerceNumber(evalNode(n.args[0]!, data));
      if (!Number.isFinite(num)) throw new EvalError('#ERR');
      return Math.abs(num);
    }
    case 'MIN':
    case 'MAX': {
      if (n.args.length === 0) throw new EvalError('#ERR');
      const nums = n.args.map((a) => coerceNumber(evalNode(a, data)));
      if (nums.some((x) => !Number.isFinite(x))) throw new EvalError('#ERR');
      return n.name === 'MIN' ? Math.min(...nums) : Math.max(...nums);
    }
    case 'SUM': {
      let total = 0;
      for (const a of n.args) {
        const x = coerceNumber(evalNode(a, data));
        if (!Number.isFinite(x)) throw new EvalError('#ERR');
        total += x;
      }
      return total;
    }
  }
  throw new EvalError('#ERR');
}

/**
 * Evaluate a single formula expression against the given record data.
 * Never throws — returns a `FormulaError` string on failure.
 */
export function evaluateFormula(expression: string, data: Record<string, unknown>): FormulaValue | FormulaError {
  try {
    const ast = compile(expression);
    return evalNode(ast, data);
  } catch (e) {
    if (e instanceof EvalError) return e.code;
    return '#ERR';
  }
}

// ── Topological compute for a whole model ────────────────────────────────────

type FormulaSpec = { slug: string; expression: string; refs: Set<string> };

function collectFormulaFields(model: AppModel): FormulaSpec[] {
  const out: FormulaSpec[] = [];
  for (const section of model.schema.sections) {
    for (const f of section.fields) {
      if (f.type === 'formula' && f.formula_expression) {
        out.push({
          slug: f.name,
          expression: f.formula_expression,
          refs: new Set(extractReferences(f.formula_expression)),
        });
      }
    }
  }
  return out;
}

/**
 * Topologically sort formula fields so that each formula is evaluated after
 * its dependencies. Nodes involved in a cycle are returned in `cycle` — the
 * caller stamps `#CYCLE` into their values.
 */
function topoSort(specs: FormulaSpec[]): { order: FormulaSpec[]; cycle: Set<string> } {
  const bySlug = new Map(specs.map((s) => [s.slug, s]));
  const state = new Map<string, 'white' | 'gray' | 'black'>();
  const order: FormulaSpec[] = [];
  const cycle = new Set<string>();

  const visit = (slug: string): void => {
    const spec = bySlug.get(slug);
    if (!spec) return;
    const s = state.get(slug) ?? 'white';
    if (s === 'black') return;
    if (s === 'gray') { cycle.add(slug); return; }
    state.set(slug, 'gray');
    for (const ref of spec.refs) {
      if (bySlug.has(ref)) {
        visit(ref);
        if (cycle.has(ref)) cycle.add(slug);
      }
    }
    state.set(slug, 'black');
    if (!cycle.has(slug)) order.push(spec);
  };

  for (const spec of specs) visit(spec.slug);
  return { order, cycle };
}

/**
 * Compute all formula fields on `model` against `data`, respecting dependency
 * order. Returns a map of `{ [slug]: computed_value }` which the caller merges
 * into record data. Cyclic formulas get `"#CYCLE"`; failed evaluations get
 * `"#ERR"` / `"#DIV0"` / `"#REF"` as appropriate.
 */
export function computeAllFormulas(
  model: AppModel,
  data: Record<string, unknown>,
): Record<string, FormulaValue | FormulaError> {
  const specs = collectFormulaFields(model);
  if (specs.length === 0) return {};
  const { order, cycle } = topoSort(specs);
  const out: Record<string, FormulaValue | FormulaError> = {};
  const working: Record<string, unknown> = { ...data };
  for (const spec of order) {
    const val = evaluateFormula(spec.expression, working);
    out[spec.slug] = val;
    working[spec.slug] = val;
  }
  for (const slug of cycle) out[slug] = '#CYCLE';
  return out;
}

/**
 * Evaluate one formula field within the model's full dependency graph. Unlike
 * `evaluateFormula`, this recomputes every formula on the model against the
 * given `data` first, so references to other formula fields resolve correctly
 * regardless of save order — perfect for live preview in the record form.
 */
export function evaluateFormulaInModel(
  field: ModelField,
  model: AppModel,
  data: Record<string, unknown>,
): FormulaValue | FormulaError {
  if (field.type !== 'formula' || !field.formula_expression) return null;
  const all = computeAllFormulas(model, data);
  if (field.name in all) return all[field.name]!;
  // Fallback — shouldn't happen, but don't return a stale or empty value.
  return evaluateFormula(field.formula_expression, data);
}

/**
 * Detect error sentinels like `#REF` / `#DIV0` so renderers can style them
 * uniformly.
 */
export function isFormulaErrorValue(v: unknown): v is FormulaError {
  return isErrorValue(v);
}

/**
 * Format a computed formula value for display — applies decimals, thousands
 * separator, currency suffix, or percentage suffix per the field's output
 * config. Errors pass through unchanged so the renderer can highlight them.
 * Falsy (null/undefined) renders as an em-dash.
 */
export function formatFormulaValue(
  value: FormulaValue | FormulaError | null | undefined,
  field: ModelField,
  locale: string,
): string {
  if (value === null || value === undefined) return '—';
  if (isErrorValue(value)) return value;
  if (typeof value === 'boolean') return String(value);
  const outputType = field.formula_output_type ?? 'number';
  // Plain text output — stringify, don't format.
  if (outputType === 'text') return String(value);
  // Coerce to a number; if that fails, show the raw string (e.g. date strings).
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  const decimals = clampDecimals(field.formula_decimals);
  const useGrouping = field.formula_thousands_separator !== false; // default true
  if (outputType === 'percentage') {
    const pct = num * 100;
    const body = pct.toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping,
    });
    return `${body}%`;
  }
  const body = num.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping,
  });
  if (outputType === 'currency') {
    const code = (field.formula_currency ?? 'SAR').trim() || 'SAR';
    // Suffix the currency code — symbol localization (ر.س vs SAR) is done at
    // the renderer for the SAR-specific short label; everything else shows
    // the code.
    if (code.toUpperCase() === 'SAR') {
      const isAr = locale.startsWith('ar');
      return `${body} ${isAr ? 'ر.س' : 'SAR'}`;
    }
    return `${body} ${code}`;
  }
  return body;
}

function clampDecimals(d: number | undefined): number {
  if (d === undefined || d === null || !Number.isFinite(d)) return 2;
  const r = Math.round(d);
  return Math.max(0, Math.min(6, r));
}

/** Whether a dot-path on a field is addressable. Empty path is always OK. */
function isValidRefPath(field: ModelField, path: string[]): boolean {
  if (path.length === 0) return true;
  if (field.type === 'range' && path.length === 1 && (path[0] === 'min' || path[0] === 'max')) return true;
  return false;
}

/**
 * Check whether referenced slugs on a formula all resolve to existing fields
 * on the model (and that any dot-path suffix is addressable on that field).
 * Returns the list of unknown refs — formatted as `slug` or `slug.path` to
 * match how the user typed them.
 */
export function findUnknownReferences(expression: string, model: AppModel): string[] {
  const byName = new Map<string, ModelField>();
  for (const s of model.schema.sections) for (const f of s.fields) byName.set(f.name, f);
  const unknown = new Set<string>();
  try {
    const ast = compile(expression);
    walk(ast, (n) => {
      if (n.kind !== 'ref') return;
      const f = byName.get(n.slug);
      const displayed = n.path.length === 0 ? n.slug : `${n.slug}.${n.path.join('.')}`;
      if (!f || !isValidRefPath(f, n.path)) unknown.add(displayed);
    });
  } catch {
    // Fallback: regex-extract raw refs so callers can still warn while the
    // expression is malformed. Reject anything that doesn't match a known field.
    const re = /\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expression)) !== null) {
      const raw = m[1]!.trim();
      const parts = raw.split('.').map((s) => s.trim());
      const base = parts[0]!;
      const path = parts.slice(1);
      const f = base ? byName.get(base) : undefined;
      if (!f || !isValidRefPath(f, path)) unknown.add(raw);
    }
  }
  return [...unknown];
}

/**
 * Detect cycles that would be introduced if `candidateField` (a formula) were
 * saved with `expression` onto `model`. Returns the cycle path as slugs or null.
 */
export function detectFormulaCycle(
  model: AppModel,
  candidateField: Pick<ModelField, 'id' | 'name'>,
  expression: string,
): string[] | null {
  // Build the would-be spec list, overwriting the candidate's entry if it exists.
  const specs = collectFormulaFields(model).filter((s) => s.slug !== candidateField.name);
  specs.push({
    slug: candidateField.name,
    expression,
    refs: new Set(extractReferences(expression)),
  });
  const bySlug = new Map(specs.map((s) => [s.slug, s]));
  const visited = new Map<string, 'gray' | 'black'>();
  const stack: string[] = [];

  const dfs = (slug: string): string[] | null => {
    const state = visited.get(slug);
    if (state === 'black') return null;
    if (state === 'gray') {
      const idx = stack.indexOf(slug);
      return stack.slice(idx).concat(slug);
    }
    const spec = bySlug.get(slug);
    if (!spec) return null;
    visited.set(slug, 'gray');
    stack.push(slug);
    for (const r of spec.refs) {
      if (bySlug.has(r)) {
        const cycle = dfs(r);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visited.set(slug, 'black');
    return null;
  };

  return dfs(candidateField.name);
}

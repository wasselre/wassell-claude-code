// ---------------------------------------------------------------------------
// Test doubles for the cv modules: an in-memory PostgREST-shaped Supabase fake
// (filters are APPLIED, updates MUTATE rows, every call is recorded) and a
// scripted CvAi. No network, no vitest globals — plain helpers.
// ---------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallRoleInput, CallRoleResult, CvAi, EmbedInput, EmbedResult, RoleKey } from '../types.js';

export type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in' | 'lt' | 'not'; col: string; val: unknown };
export interface RpcCall { fn: string; params: Record<string, unknown> }
export interface UpdateCall { table: string; patch: Row; filters: Filter[] }

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Scripted RPC responses; default resolves {data:null}. */
  rpc?: (fn: string, params: Record<string, unknown>, calls: RpcCall[]) => { data: unknown; error: { message: string } | null };
  rpcCalls: RpcCall[];
  updates: UpdateCall[];
  inserts: Array<{ table: string; row: Row }>;
}

export function makeDb(tables: Record<string, Row[]>, rpc?: FakeDb['rpc']): FakeDb {
  return { tables, rpc, rpcCalls: [], updates: [], inserts: [] };
}

let seq = 0;
const nextId = () => `gen-${++seq}`;

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.kind) {
    case 'eq': return v === f.val;
    case 'in': return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
    case 'lt': return typeof v === 'string' && typeof f.val === 'string' ? v < f.val : Number(v) < Number(f.val);
    case 'not': return v !== f.val;
  }
}

function builder(db: FakeDb, table: string, op: 'select' | 'update' | 'insert' | 'upsert', payload: Row | null) {
  const filters: Filter[] = [];
  let single = false;
  const b: Record<string, unknown> = {};
  const self = () => b;
  b.select = self; b.order = self; b.limit = self; b.range = self;
  b.eq = (col: string, val: unknown) => { filters.push({ kind: 'eq', col, val }); return b; };
  b.in = (col: string, val: unknown) => { filters.push({ kind: 'in', col, val }); return b; };
  b.lt = (col: string, val: unknown) => { filters.push({ kind: 'lt', col, val }); return b; };
  b.not = (col: string, _op: string, val: unknown) => { filters.push({ kind: 'not', col, val }); return b; };
  b.maybeSingle = () => { single = true; return b; };
  b.single = () => { single = true; return b; };
  const run = () => {
    const rows = db.tables[table] ?? (db.tables[table] = []);
    if (op === 'select') {
      const hit = rows.filter((r) => filters.every((f) => matches(r, f)));
      return { data: single ? (hit[0] ?? null) : hit, error: null };
    }
    if (op === 'update') {
      const hit = rows.filter((r) => filters.every((f) => matches(r, f)));
      for (const r of hit) Object.assign(r, payload);
      db.updates.push({ table, patch: payload ?? {}, filters });
      return { data: single ? (hit[0] ?? null) : hit, error: null };
    }
    const row: Row = { id: nextId(), ...(payload ?? {}) };
    rows.push(row);
    db.inserts.push({ table, row });
    return { data: single ? row : [row], error: null };
  };
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    try { return resolve(run()); } catch (e) { if (reject) return reject(e); throw e; }
  };
  return b;
}

export function makeFakeSb(db: FakeDb): SupabaseClient {
  const sb = {
    from(table: string) {
      return {
        select: () => builder(db, table, 'select', null),
        update: (patch: Row) => builder(db, table, 'update', patch),
        insert: (row: Row) => builder(db, table, 'insert', row),
        upsert: (row: Row) => builder(db, table, 'upsert', row),
      };
    },
    rpc: (fn: string, params: Record<string, unknown> = {}) => {
      db.rpcCalls.push({ fn, params });
      const r = db.rpc ? db.rpc(fn, params, db.rpcCalls) : { data: null, error: null };
      return Promise.resolve(r);
    },
  };
  return sb as unknown as SupabaseClient;
}

// ── scripted AI ──────────────────────────────────────────────────────────────
export interface AiCall { role: RoleKey; images: number; user: string }

export function frameOutput(n: number): { frames: Array<Record<string, unknown>> } {
  return { frames: Array.from({ length: n }, (_, i) => ({
    index: i, description: `frame ${i}`, main_subject: 'villa facade', secondary_objects: ['palm'], people_activity: null,
    room_class: null, shot_size: 'wide', camera_angle: 'eye_level', composition: 'centered', subject_position: 'center', foreground: 'road', background: 'sky',
    lighting: 'day', palette: ['beige'], style: 'cinematic', text_placement: null, typography: null, branding: [], graphic_elements: [], confidence: 0.9,
    tags: ['shot_size:wide', 'setting:exterior_facade', 'setting:garden'],
  })) };
}

export function shotOutput(purpose = 'hook'): Record<string, unknown> {
  return {
    summary_ar: 'لقطة جوية للواجهة', summary_en: 'Aerial reveal of the facade',
    purpose, angle: 'grand arrival', camera_movement: 'drone', pace: 'medium', visual_progression: 'drone reveals the facade',
    emotional_effect: 'aspiration', intended_audience: 'families', production_method: 'drone', production_difficulty: 'moderate', production_resources: ['drone', 'pilot'],
    reproducibility: 'moderate', suitable_platforms: ['instagram_reel'], suitable_content_types: ['project_launch'], mood: 'aspirational', confidence: 0.8,
    tags: ['motion:drone', 'setting:exterior_facade', 'bogus:tag'],
  };
}

export function makeFakeAi(opts: { failRole?: RoleKey; costUsd?: number | null } = {}): { ai: CvAi; calls: AiCall[] } {
  const calls: AiCall[] = [];
  const ai: CvAi = {
    async callRole<T>(role: RoleKey, input: CallRoleInput): Promise<CallRoleResult<T>> {
      calls.push({ role, images: input.images?.length ?? 0, user: input.user });
      if (opts.failRole === role) throw new Error(`provider:anthropic scripted failure for ${role}`);
      const output = role === 'frame_describer' ? frameOutput(input.images?.length ?? 0) : shotOutput();
      return { output: output as T, usage: { in: 100, out: 50 }, cost_usd: opts.costUsd === undefined ? 0.01 : opts.costUsd, provider: 'anthropic', model: 'test-model', version: null, latency_ms: 5 };
    },
    async embed(role: RoleKey, input: EmbedInput): Promise<EmbedResult> {
      calls.push({ role, images: input.image_urls?.length ?? 0, user: (input.texts ?? []).join('|') });
      const n = (input.texts ?? input.image_urls ?? []).length;
      const dim = role === 'embed_text' ? 1024 : 768;
      return { vectors: Array.from({ length: n }, () => new Array<number>(dim).fill(0.5)), model: 'bge-m3', version: '1', dim };
    },
  };
  return { ai, calls };
}

/** A 768-d vector with a single non-zero coordinate — cheap and distinct. */
export function unit(dim: number, at: number, scale = 1): number[] {
  const v = new Array<number>(dim).fill(0);
  v[at] = scale;
  return v;
}

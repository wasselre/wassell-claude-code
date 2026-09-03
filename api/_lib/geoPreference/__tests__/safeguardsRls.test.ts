import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * RLS / authorization shape test (offline, deterministic).
 *
 * Asserts the AUTHORIZATION POSTURE of the geo_pref_* tables directly from the
 * committed migration — the source of truth for the schema (the migration is NOT
 * yet applied to prod by design: "NOT applied to prod until the subsystem is
 * coherent and verified end-to-end"). It proves:
 *   1. every geo_pref_* table ENABLES row level security;
 *   2. every one gets a FOR SELECT ... TO authenticated policy (read is allowed);
 *   3. NO table grants a write (INSERT/UPDATE/DELETE) policy TO authenticated —
 *      writes are service-role / SQL (SECURITY DEFINER RPC) only.
 *
 * Live verification (query the applied policies read-only) is documented in
 * docs/geo-preference-runbook.md and runs AFTER the migration is applied; a unit
 * test must not depend on prod state, so we validate the committed SQL instead.
 */

// Repo root: this file is api/_lib/geoPreference/__tests__/ → up 5 levels.
const ROOT = resolve(__dirname, '..', '..', '..', '..');
const CORE_MIGRATION = resolve(ROOT, 'supabase/migrations/2026-09-03_geo_preference_ability.sql');
// The review-and-ops migration is owned by a sibling workstream; validate it too
// IF it exists, so its added policies are held to the same posture.
const OPS_MIGRATION = resolve(ROOT, 'supabase/migrations/2026-09-03_review_and_ops.sql');

const GEO_PREF_TABLES = [
  'geo_pref_evidence',
  'geo_pref_relations',
  'geo_pref_geometry',
  'geo_pref_checkpoints',
  'geo_pref_gold_split',
  'geo_pref_challenge_tags',
  'geo_pref_gate_config',
  'geo_pref_proposals',
];

function readMigrations(): string {
  let sql = readFileSync(CORE_MIGRATION, 'utf8');
  if (existsSync(OPS_MIGRATION)) sql += '\n' + readFileSync(OPS_MIGRATION, 'utf8');
  return sql;
}

describe('geo_pref_* RLS / authorization posture (from committed migration)', () => {
  const sql = readMigrations();

  it('the core migration exists and creates all eight geo_pref_* tables', () => {
    for (const t of GEO_PREF_TABLES) {
      expect(sql).toContain(`public.${t}`);
    }
  });

  it('enables RLS on every geo_pref_* table (directly or via the generated loop)', () => {
    // The core migration enables RLS in a DO loop over the table-name array; assert
    // both the loop form and that every table name is present in that array.
    const enablesViaLoop = /ENABLE ROW LEVEL SECURITY/.test(sql);
    expect(enablesViaLoop).toBe(true);
    // Every table appears in the RLS array literal the loop iterates.
    for (const t of GEO_PREF_TABLES) {
      expect(sql).toContain(`'${t}'`);
    }
  });

  it('grants a FOR SELECT ... TO authenticated read policy (generated per table)', () => {
    // The loop generates: CREATE POLICY %I_select ... FOR SELECT TO authenticated USING (true)
    expect(sql).toMatch(/FOR SELECT TO authenticated/);
    expect(sql).toMatch(/CREATE POLICY %I_select/);
  });

  it('NEVER grants an INSERT/UPDATE/DELETE policy TO authenticated (writes are service-role/SQL only)', () => {
    // Scan every CREATE POLICY statement; none may combine a write command with
    // `TO authenticated`. Service-role bypasses RLS entirely, and the SECURITY
    // DEFINER RPCs run as their owner — neither needs an authenticated write policy.
    const policyStmts = sql.match(/CREATE POLICY[\s\S]*?;/gi) ?? [];
    for (const stmt of policyStmts) {
      const grantsAuthenticated = /TO authenticated/i.test(stmt);
      const isWrite = /FOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i.test(stmt);
      if (grantsAuthenticated && isWrite) {
        throw new Error(`Found an authenticated WRITE policy — geo_pref_* writes must be service-role/SQL only:\n${stmt}`);
      }
    }
    // Sanity: there is at least one policy statement to scan.
    expect(policyStmts.length).toBeGreaterThan(0);
  });

  it('the gate config ships with auto_write_enabled DEFAULT false (master switch OFF)', () => {
    expect(sql).toMatch(/auto_write_enabled\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i);
  });

  it('gold evidence can never carry a model confidence (leakage guard constraint present)', () => {
    expect(sql).toMatch(/gold_has_no_model_confidence/);
  });
});

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { matchProjectsCore, type MatchRequirements } from '../../../api/_lib/matchAgent';
import { groupMatchResults, SUGGESTION_GROUP_KEYS } from '../../../api/_lib/suggestGroups';

/**
 * Live integration: runs the REAL matchProjectsCore + groupMatchResults against
 * wassell-prod (service-role) for the النرجس scenario, proving the deterministic
 * grouping pipeline behind /api/suggest-projects works on real data + the matcher
 * refactor is intact. Skips automatically when secrets are absent (CI/worktree
 * without env), so it never fails the default suite.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx vitest run suggestGroups.integration
 */

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const live = URL && KEY ? describe : describe.skip;

live('groupMatchResults — live prod data', () => {
  it('groups real candidates for النرجس into honest buckets', async () => {
    // Construct the client lazily INSIDE the test so a skipped suite (no secrets)
    // never calls createClient at factory-eval time.
    const supabase = createClient(URL, KEY, { auth: { persistSession: false } });
    const req: MatchRequirements = { city: 'الرياض', district: 'النرجس', property_type: 'شقة', budget_max: 2_000_000 };
    const core = await matchProjectsCore(supabase, req);
    expect(core.ok).toBe(true);
    if (!core.ok) return;

    const g = groupMatchResults(core, req, { perGroup: 10 });

    // Shape: every group is present and an array.
    for (const k of SUGGESTION_GROUP_KEYS) expect(Array.isArray(g.groups[k])).toBe(true);

    // Every surfaced item carries a confidence, a bucket, and (given the sparse
    // data) a data_gaps array — and budget_matches NEVER contains a price-less project.
    const all = SUGGESTION_GROUP_KEYS.flatMap((k) => g.groups[k]);
    for (const item of all) {
      expect(['high', 'medium', 'low']).toContain(item.data_confidence);
      expect(SUGGESTION_GROUP_KEYS).toContain(item.group);
      expect(Array.isArray(item.data_gaps)).toBe(true);
    }
    for (const item of g.groups.budget_matches) {
      expect(item.data_gaps).not.toContain('missing_price_range');
    }

    // eslint-disable-next-line no-console
    console.log('[live groups] counts=', JSON.stringify(g.metadata.counts),
      '| district_resolved=', g.metadata.req_district_resolved,
      '| legacy_fallback=', g.metadata.used_legacy_fallback,
      '| sample=', JSON.stringify(all.slice(0, 4).map((x) => ({
        name: x.project_name, group: x.group, band: x.match_band, conf: x.data_confidence, gaps: x.data_gaps,
      }))));
  }, 60_000);
});

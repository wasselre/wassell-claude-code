import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { matchProjects, type MatchRequirements } from '../../../api/_lib/matchAgent';

const REPORT: string[] = [];

/**
 * Tool-level integration test: runs the REAL match_projects against the live
 * wassell-prod DB (service-role client) for the five Arabic review scenarios.
 * Skips automatically when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent
 * (CI without secrets) so it never fails the suite.
 *
 * Run locally with the prod secrets exported:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx vitest run matchProjects.integration
 */

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const live = URL && KEY ? describe : describe.skip;

interface Parsed {
  district_exact_match: boolean;
  used_fallback: boolean;
  our_projects: { count: number; results: Array<Record<string, unknown>> };
  all_projects: { count: number; requires_verification: boolean; results: Array<Record<string, unknown>> } | null;
}

const SCENARIOS: Array<{ label: string; requirements: MatchRequirements }> = [
  {
    label: 'شقة في الفاروق بالرياض، مليون، 3 غرف',
    requirements: { city: 'الرياض', district: 'الفاروق', property_type: 'شقة', budget_max: 1_000_000, bedrooms: 3 },
  },
  {
    label: 'تاون هاوس في النرجس، مليونين',
    requirements: { district: 'النرجس', property_type: 'تاون هاوس', budget_max: 2_000_000 },
  },
  {
    label: 'فيلا في العارض مع خصوصية',
    requirements: { district: 'العارض', property_type: 'فيلا', lifestyle: ['privacy'], amenities: ['خصوصية'] },
  },
  {
    label: 'مشروع في الرياض بدون ميزانية',
    requirements: { city: 'الرياض' },
  },
  {
    label: 'شيء قريب من النرجس',
    requirements: { district: 'النرجس' },
  },
];

live('match_projects — live Arabic scenarios', () => {
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  afterAll(() => {
    // Write to the OS temp dir so a local run never litters the repo. Path is
    // printed so you can read the full per-scenario report after the run.
    const out = join(tmpdir(), 'wassel-match-scenarios.txt');
    writeFileSync(out, REPORT.join('\n\n'));
    // eslint-disable-next-line no-console
    console.log(`match_projects scenario report → ${out}`);
  });

  for (const sc of SCENARIOS) {
    it(sc.label, async () => {
      const raw = await matchProjects(supabase, sc.requirements);
      const p = JSON.parse(raw) as Parsed;

      const fmt = (r: Record<string, unknown>) => {
        const bd = (r.score_breakdown ?? {}) as Record<string, unknown>;
        return `${r.project_name} | score=${r.score} | band=${r.match_band} | ${r.match_type} | type_sub=${bd.type}`;
      };
      const list = (g: { results: Array<Record<string, unknown>> } | null) =>
        g && g.results.length ? g.results.map((r) => `    - ${fmt(r)}`).join('\n') : '    (none)';

      REPORT.push(
        `=== ${sc.label} ===\n` +
          `requirements: ${JSON.stringify(sc.requirements)}\n` +
          `district_exact_match: ${p.district_exact_match}\n` +
          `used_fallback: ${p.used_fallback} → searched ${p.used_fallback ? 'our_projects + all_projects (fallback)' : 'our_projects ONLY'}\n` +
          `our_projects (count=${p.our_projects.count}):\n${list(p.our_projects)}\n` +
          `all_projects: ${p.all_projects ? `count=${p.all_projects.count} | requires_verification=${p.all_projects.requires_verification}\n${list(p.all_projects)}` : 'null (NOT searched/shown)'}`,
      );

      // Invariant 1: all_projects is only present when the fallback fired.
      if (!p.used_fallback) expect(p.all_projects).toBeNull();
      // Invariant 2: when fallback fired, EVERY all_projects result is flagged.
      if (p.all_projects) {
        expect(p.all_projects.requires_verification).toBe(true);
        for (const r of p.all_projects.results) {
          expect(r.data_source).toBe('all_projects');
          expect(r.requires_verification).toBe(true);
          expect(typeof r.verification_warning).toBe('string');
        }
      }
      // Invariant 3: our_projects results are never flagged for verification.
      for (const r of p.our_projects.results) {
        expect(r.data_source).toBe('our_projects');
        expect(r.requires_verification).toBeUndefined();
      }
    });
  }
});

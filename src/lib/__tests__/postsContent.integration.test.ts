import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { resolveFacts, writeOnePost } from '../../../api/templates/posts-content';
import { rankAngles, assignAngles } from '../../../src/lib/postsContent/planning';
import {
  buildFactCatalog, evidenceHaystack, unknownFactIds, composeSpecBlock,
} from '../../../src/lib/postsContent/facts';

/**
 * Live integration: runs the REAL fact resolution + the REAL model call against
 * wassell-prod (service-role) for a data-rich project, a sold-out project and a
 * weak project. Proves the two anti-fabrication gates and the available-only
 * pricing rule hold on real data, not fixtures.
 *
 * Skips automatically when secrets are absent, so it never fails the default
 * suite (CI / a worktree without env).
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *     npx vitest run postsContent.integration
 */

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const HAS_LLM = !!(process.env.ANTHROPIC_API_KEY || process.env.CLOUDFLARE_API_TOKEN);
const live = URL && KEY ? describe : describe.skip;
const liveLlm = URL && KEY && HAS_LLM ? describe : describe.skip;

const OUR_PROJECTS_MODEL = '6609286a-f95a-45db-94e6-48cfa915ccbd';

function client() {
  return createClient(URL, KEY, { auth: { persistSession: false } });
}

/** Find the our_projects id whose linked master has the given project_name. */
async function findOurProjectByName(name: string): Promise<string | null> {
  const svc = client();
  const { data } = await svc
    .from('unified_records').select('id, data').eq('model_id', OUR_PROJECTS_MODEL);
  for (const row of (data ?? []) as Array<{ id: string; data: Record<string, unknown> }>) {
    const apId = typeof row.data?.project === 'string' ? row.data.project : null;
    if (!apId) continue;
    const { data: ap } = await svc.from('unified_records').select('data').eq('id', apId).maybeSingle();
    if ((ap as { data?: Record<string, unknown> } | null)?.data?.project_name === name) return row.id;
  }
  return null;
}

live('posts-content — live fact resolution', () => {
  it('resolves a data-rich project into a citable fact catalog', async () => {
    const svc = client();
    const id = await findOurProjectByName('ستون الندى');
    expect(id).toBeTruthy();
    const r = await resolveFacts(svc, svc, id!, {});
    expect('facts' in r).toBe(true);
    if (!('facts' in r)) return;
    const { facts } = r;

    expect(facts.name).toBe('ستون الندى');
    expect(facts.unitTypes.length).toBeGreaterThan(0);
    expect(facts.features.length).toBeGreaterThan(5);
    expect(facts.guarantees.length).toBeGreaterThan(5);
    // Guarantee durations parse into years (drives «ضمان يصل حتى»).
    expect(facts.guarantees.some((g) => (g.years ?? 0) >= 10)).toBe(true);

    const catalog = buildFactCatalog(facts);
    expect(catalog.length).toBeGreaterThan(15);
    // Every id is unique and parseable.
    expect(new Set(catalog.map((f) => f.id)).size).toBe(catalog.length);
  }, 60_000);

  it('ranks only the angles the real data can back', async () => {
    const svc = client();
    const id = await findOurProjectByName('ستون الندى');
    const r = await resolveFacts(svc, svc, id!, {});
    if (!('facts' in r)) throw new Error('facts unavailable');
    const ranked = rankAngles(evidenceHaystack(r.facts), r.facts.unitTypeValues);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThan(15); // never all 15
    expect(ranked.every((a) => a.evidence.length > 0)).toBe(true);
    // Reused angles only appear once supply is exhausted.
    const assigned = assignAngles(ranked, ranked.length + 2);
    expect(assigned).toHaveLength(ranked.length + 2);
    expect(assigned.slice(0, ranked.length).every((a) => a.variationIndex === 0)).toBe(true);
    expect(assigned[ranked.length]?.variationIndex).toBe(1);
  }, 60_000);

  it('quotes NO price or area for a sold-out project', async () => {
    const svc = client();
    // يمام فلورز 8 had available_units = 0 at the time of writing; skip if the
    // inventory changed rather than asserting on stale reality.
    const id = await findOurProjectByName('يمام فلورز 8');
    if (!id) return;
    const r = await resolveFacts(svc, svc, id, {});
    if (!('facts' in r)) throw new Error('facts unavailable');
    const { facts } = r;
    if ((facts.availableUnits ?? 0) > 0) return; // inventory came back — nothing to assert

    expect(facts.priceRange).toBeNull();
    expect(facts.areaRange).toBeNull();
    const spec = composeSpecBlock(facts, 'short', 'ar');
    expect(spec).not.toContain('ر.س');
    expect(spec).not.toMatch(/المساحة/);
    expect(facts.missing).toContain('price');
  }, 60_000);
});

liveLlm('posts-content — live generation gates', () => {
  it('writes a grounded Arabic post that cites only real facts and no numbers', async () => {
    const svc = client();
    const id = await findOurProjectByName('ستون الندى');
    const r = await resolveFacts(svc, svc, id!, {});
    if (!('facts' in r)) throw new Error('facts unavailable');
    const { facts } = r;
    const catalog = buildFactCatalog(facts);
    const ranked = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    const top = ranked[0]!;

    const post = await writeOnePost({
      facts, catalog, tone: 'short', language: 'ar', evidence: top.evidence,
      item: { key: 'test:1', angle: top.angleId, variation_index: 0, post_number: 1 },
    });

    // Structural gate — no specification numbers in the model-written text.
    expect(post.prose_ar).not.toMatch(/\d{3,}/);
    expect(post.prose_ar).not.toMatch(/ر\.?\s?س|SAR|م²/);
    expect(post.headline_ar).not.toMatch(/\d{3,}/);
    // Referential gate — every cited fact exists.
    expect(post.used_fact_ids.length).toBeGreaterThan(0);
    expect(unknownFactIds(post.used_fact_ids, catalog)).toEqual([]);
    // Arabic-only: no English body generated, no tokens wasted.
    expect(post.body_en).toBe('');
    expect(post.prose_en).toBe('');
    // The spec block IS in the body, rendered from the database.
    expect(post.body_ar).toContain('نوع العقار');
    expect(post.body_ar).toContain(String(Math.round(facts.priceRange!.min).toLocaleString('en-US')));
    expect(post.grounded).toBe(true);
  }, 120_000);

  it('writes English only, with English place names and no Arabic leak', async () => {
    const svc = client();
    const id = await findOurProjectByName('ستون الندى');
    const r = await resolveFacts(svc, svc, id!, {});
    if (!('facts' in r)) throw new Error('facts unavailable');
    const { facts } = r;
    const catalog = buildFactCatalog(facts);
    const ranked = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    const top = ranked[0]!;

    const post = await writeOnePost({
      facts, catalog, tone: 'long', language: 'en', evidence: top.evidence,
      item: { key: 'test:2', angle: top.angleId, variation_index: 0, post_number: 1 },
    });

    expect(post.body_ar).toBe('');
    expect(post.prose_en.length).toBeGreaterThan(20);
    expect(unknownFactIds(post.used_fact_ids, catalog)).toEqual([]);
    // The English spec block must carry the English district, not the Arabic.
    if (facts.district) {
      expect(post.spec_en).toContain(facts.district.en);
      expect(post.spec_en).not.toContain(facts.district.ar);
    }
  }, 120_000);

  it('writes both languages from the same verified facts', async () => {
    const svc = client();
    const id = await findOurProjectByName('ستون الندى');
    const r = await resolveFacts(svc, svc, id!, {});
    if (!('facts' in r)) throw new Error('facts unavailable');
    const { facts } = r;
    const catalog = buildFactCatalog(facts);
    const ranked = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);

    const post = await writeOnePost({
      facts, catalog, tone: 'short', language: 'both', evidence: ranked[0]!.evidence,
      item: { key: 'test:3', angle: ranked[0]!.angleId, variation_index: 0, post_number: 1 },
    });

    expect(post.prose_ar.length).toBeGreaterThan(10);
    expect(post.prose_en.length).toBeGreaterThan(10);
    expect(post.body_ar).toContain('نوع العقار');
    expect(post.body_en).toContain('Property type');
    expect(unknownFactIds(post.used_fact_ids, catalog)).toEqual([]);
  }, 120_000);

  it('produces a materially different post when an angle is reused', async () => {
    const svc = client();
    const id = await findOurProjectByName('ستون الندى');
    const r = await resolveFacts(svc, svc, id!, {});
    if (!('facts' in r)) throw new Error('facts unavailable');
    const { facts } = r;
    const catalog = buildFactCatalog(facts);
    const ranked = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    const angle = ranked[0]!;

    const first = await writeOnePost({
      facts, catalog, tone: 'short', language: 'ar', evidence: angle.evidence,
      item: { key: 'v:1', angle: angle.angleId, variation_index: 0, post_number: 1 },
    });
    const second = await writeOnePost({
      facts, catalog, tone: 'short', language: 'ar', evidence: angle.evidence,
      item: {
        key: 'v:2', angle: angle.angleId, variation_index: 1, post_number: 2,
        avoid_headlines: [first.headline_ar],
      },
    });

    expect(second.headline_ar).not.toBe(first.headline_ar);
    expect(second.prose_ar).not.toBe(first.prose_ar);
  }, 180_000);
});

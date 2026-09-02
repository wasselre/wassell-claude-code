/**
 * Reads-on-publish hook (Post Creative Director, contracts §12 A-VIS).
 *
 * Called by A-API's publish path right after a Wassel publication goes live.
 * NO new tables and NO job writes: it verifies the published assets exist
 * (the internal org's collected post + its stored media) and returns the
 * subjects the design-read sweep will pick up:
 *
 *   post  level → subject_kind 'wassel_content', subject_id = mkt_content_posts.id
 *   slide level → subject_kind 'wassel_file',    subject_id = mkt_content_media.id
 *
 * When collection has not picked the post up yet (or its media is not stored),
 * ok=false with a reason — the state-driven design-read lane catches it later
 * (self-healing, same posture as the content sweep). The lane's Wassel sweep
 * reads tier 5 of creative_design_read_targets, so this hook never enqueues
 * anything itself.
 *
 * NOTE: worker/src/creative/designRead/wasselOnPublish.ts carries the same
 * resolution logic for the worker package (which api/_lib cannot import).
 * Keep the two in sync.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReadLevel, ReadSubjectKind } from '../../../../src/lib/creative/contracts.js';

export interface WasselReadSubject {
  subject_kind: ReadSubjectKind;
  subject_id: string;
  level: ReadLevel;
  post_id: string;
  slide_index: number | null;
  stored_url: string | null;
}

export interface WasselReadsOnPublishResult {
  ok: boolean;
  reason?: 'publication_not_found' | 'wassel_org_not_registered' | 'no_external_ref' | 'not_collected_yet' | 'assets_not_stored_yet';
  publication_id: string;
  post_id: string | null;
  /** Post subject first, then one slide subject per stored image (carousel order). */
  subjects: WasselReadSubject[];
}

/** The only slice of a Supabase client this module needs. */
export type ServiceClient = Pick<SupabaseClient, 'from'>;

/**
 * Verify the published assets of `publicationId` exist as collected
 * internal-org media and return the design-read subjects. Never throws for
 * ordinary "not there yet" states (those are the `reason` enum); a genuine
 * query failure throws `provider:supabase …` so the caller can log it.
 */
export async function enqueueWasselReadsOnPublish(
  svc: ServiceClient,
  publicationId: string,
): Promise<WasselReadsOnPublishResult> {
  const none = (reason: NonNullable<WasselReadsOnPublishResult['reason']>): WasselReadsOnPublishResult =>
    ({ ok: false, reason, publication_id: publicationId, post_id: null, subjects: [] });

  const { data: pub, error: pubErr } = await svc
    .from('mos_publications')
    .select('id, content_id, platform, external_id, external_url, status')
    .eq('id', publicationId)
    .maybeSingle();
  if (pubErr) throw new Error(`provider:supabase publication lookup failed: ${pubErr.message}`);
  if (!pub) return none('publication_not_found');

  const { data: org, error: orgErr } = await svc
    .from('mkt_organizations')
    .select('id')
    .eq('org_type', 'internal')
    .limit(1)
    .maybeSingle();
  if (orgErr) throw new Error(`provider:supabase internal-org lookup failed: ${orgErr.message}`);
  if (!org) return none('wassel_org_not_registered');

  const pubRow = pub as { platform: string; external_id: string | null; external_url: string | null };
  let q = svc.from('mkt_content_posts')
    .select('id')
    .eq('organization_id', (org as { id: string }).id)
    .eq('platform', pubRow.platform);
  if (pubRow.external_id) q = q.eq('external_id', pubRow.external_id);
  else if (pubRow.external_url) q = q.eq('post_url', pubRow.external_url);
  else return none('no_external_ref');
  const { data: posts, error: postErr } = await q.limit(1);
  if (postErr) throw new Error(`provider:supabase collected-post lookup failed: ${postErr.message}`);
  const post = (posts?.[0] ?? null) as { id: string } | null;
  if (!post) return none('not_collected_yet');

  const { data: media, error: mediaErr } = await svc
    .from('mkt_content_media')
    .select('id, carousel_index, stored_url')
    .eq('content_post_id', post.id)
    .eq('media_kind', 'image')
    .eq('download_status', 'stored')
    .not('stored_url', 'is', null)
    .order('carousel_index', { ascending: true });
  if (mediaErr) throw new Error(`provider:supabase publication media lookup failed: ${mediaErr.message}`);
  if (!media || media.length === 0) return { ...none('assets_not_stored_yet'), post_id: post.id };

  const rows = media as Array<{ id: string; carousel_index: number; stored_url: string }>;
  const subjects: WasselReadSubject[] = [
    {
      subject_kind: 'wassel_content',
      subject_id: post.id,
      level: 'post',
      post_id: post.id,
      slide_index: null,
      stored_url: rows[0]?.stored_url ?? null,
    },
    ...rows.map((m) => ({
      subject_kind: 'wassel_file' as const,
      subject_id: m.id,
      level: 'slide' as const,
      post_id: post.id,
      slide_index: m.carousel_index,
      stored_url: m.stored_url,
    })),
  ];
  return { ok: true, publication_id: publicationId, post_id: post.id, subjects };
}

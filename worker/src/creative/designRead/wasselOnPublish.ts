/**
 * Wassel-side design-read helpers (worker path).
 *
 * The internal organisation (mkt_organizations org_type='internal', seeded by
 * migration _23) is Wassel itself. Its COLLECTED posts are read with the same
 * pipeline as competitors but under the wassel_* subject vocabulary
 * (documented in docs/creative-director/design-read-vocab.md):
 *
 *   slide level → subject_kind 'wassel_file',    subject_id = mkt_content_media.id
 *   post  level → subject_kind 'wassel_content', subject_id = mkt_content_posts.id
 *
 * Two surfaces use this module:
 *  - the design-read lane's Wassel sweep (part (b): published Wassel
 *    assets/content lacking reads) via wasselReadTargets (tier 5 of
 *    creative_design_read_targets);
 *  - the publish hook twin (api/_lib/marketing/creative/onPublished.ts — a
 *    COPY of resolveWasselPublicationSubjects; api/_lib cannot import worker
 *    code, keep both in sync).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReadLevel, ReadSubjectKind } from '../contracts.js';
import type { SlideReadItem } from './readSlide.js';
import type { PostReadPost } from './readPost.js';

/** Subject-kind mapping by owning org type — internal org (Wassel) → wassel_*. */
export function subjectKindForOrgType(level: ReadLevel, orgType: string | null | undefined): ReadSubjectKind {
  const internal = orgType === 'internal';
  if (level === 'slide') return internal ? 'wassel_file' : 'competitor_media';
  return internal ? 'wassel_content' : 'competitor_post';
}

interface TargetRow {
  subject_kind: string;
  subject_id: string;
  post_id: string;
  slide_index: number | null;
  organization_id: string | null;
  stored_url: string | null;
  post_type: string | null;
}

/** Wassel (internal-org) subjects lacking a read — tier 5 of the targets RPC. */
export async function wasselReadTargets(
  sb: SupabaseClient,
  level: ReadLevel,
  modelUsed: string,
  ruleVersion: string,
  limit: number,
): Promise<{ slides: SlideReadItem[]; posts: PostReadPost[] }> {
  const { data, error } = await sb.rpc('creative_design_read_targets', {
    p_subject_kind: null,
    p_level: level,
    p_rule_version: ruleVersion,
    p_model_used: modelUsed,
    p_tier: 5,
    p_limit: limit,
  });
  if (error) throw new Error(`provider:supabase creative_design_read_targets (tier 5, ${level}) failed: ${error.message}`);
  const rows = (data ?? []) as TargetRow[];
  const slides: SlideReadItem[] = [];
  const posts: PostReadPost[] = [];
  for (const r of rows) {
    if (level === 'slide') {
      if (!r.stored_url) continue;
      slides.push({
        subject_kind: subjectKindForOrgType('slide', 'internal'),
        subject_id: r.subject_id,
        post_id: r.post_id,
        slide_index: r.slide_index,
        organization_id: r.organization_id,
        stored_url: r.stored_url,
      });
    } else {
      posts.push({
        subject_kind: subjectKindForOrgType('post', 'internal'),
        subject_id: r.subject_id,
        organization_id: r.organization_id,
        post_type: r.post_type,
      });
    }
  }
  return { slides, posts };
}

export interface WasselPublishSubject {
  subject_kind: ReadSubjectKind;
  subject_id: string;
  level: ReadLevel;
  post_id: string;
  slide_index: number | null;
  stored_url: string | null;
}

export interface WasselPublicationSubjects {
  ok: boolean;
  reason?: 'publication_not_found' | 'wassel_org_not_registered' | 'no_external_ref' | 'not_collected_yet' | 'assets_not_stored_yet';
  publication_id: string;
  post_id: string | null;
  subjects: WasselPublishSubject[];
}

/**
 * The subjects the design-read sweep will pick up for one JUST-PUBLISHED
 * Wassel publication. No new tables, no job writes: it verifies the published
 * assets exist (collected post + stored media of the internal org) and returns
 * the (post + slide) subjects. When the collection lane has not picked the
 * post up yet, ok=false with a reason — the state-driven sweep catches it
 * later (self-healing, same posture as the content sweep).
 */
export async function resolveWasselPublicationSubjects(
  sb: SupabaseClient,
  publicationId: string,
): Promise<WasselPublicationSubjects> {
  const none = (reason: NonNullable<WasselPublicationSubjects['reason']>): WasselPublicationSubjects =>
    ({ ok: false, reason, publication_id: publicationId, post_id: null, subjects: [] });

  const { data: pub, error: pubErr } = await sb
    .from('mos_publications')
    .select('id, content_id, platform, external_id, external_url, status')
    .eq('id', publicationId)
    .maybeSingle();
  if (pubErr) throw new Error(`provider:supabase publication lookup failed: ${pubErr.message}`);
  if (!pub) return none('publication_not_found');

  const { data: org, error: orgErr } = await sb
    .from('mkt_organizations')
    .select('id')
    .eq('org_type', 'internal')
    .limit(1)
    .maybeSingle();
  if (orgErr) throw new Error(`provider:supabase internal-org lookup failed: ${orgErr.message}`);
  if (!org) return none('wassel_org_not_registered');

  const pubRow = pub as { platform: string; external_id: string | null; external_url: string | null };
  let q = sb.from('mkt_content_posts')
    .select('id')
    .eq('organization_id', (org as { id: string }).id)
    .eq('platform', pubRow.platform);
  if (pubRow.external_id) q = q.eq('external_id', pubRow.external_id);
  else if (pubRow.external_url) q = q.eq('post_url', pubRow.external_url);
  else return none('no_external_ref');
  const { data: posts, error: postErr } = await q.limit(1);
  if (postErr) throw new Error(`provider:supabase collected-post lookup failed: ${postErr.message}`);
  const post = posts?.[0] as { id: string } | undefined;
  if (!post) return none('not_collected_yet');

  const { data: media, error: mediaErr } = await sb
    .from('mkt_content_media')
    .select('id, carousel_index, stored_url')
    .eq('content_post_id', post.id)
    .eq('media_kind', 'image')
    .eq('download_status', 'stored')
    .not('stored_url', 'is', null)
    .order('carousel_index', { ascending: true });
  if (mediaErr) throw new Error(`provider:supabase publication media lookup failed: ${mediaErr.message}`);
  if (!media || media.length === 0) return { ...none('assets_not_stored_yet'), post_id: post.id };

  const subjects: WasselPublishSubject[] = [
    {
      subject_kind: 'wassel_content',
      subject_id: post.id,
      level: 'post',
      post_id: post.id,
      slide_index: null,
      stored_url: (media[0] as { stored_url: string }).stored_url,
    },
    ...media.map((m) => ({
      subject_kind: 'wassel_file' as const,
      subject_id: (m as { id: string }).id,
      level: 'slide' as const,
      post_id: post.id,
      slide_index: (m as { carousel_index: number }).carousel_index,
      stored_url: (m as { stored_url: string }).stored_url,
    })),
  ];
  return { ok: true, publication_id: publicationId, post_id: post.id, subjects };
}

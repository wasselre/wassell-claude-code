/**
 * Post-level design read (worker path).
 *
 * ALL slides of a post (in carousel order) + the slide reads already stored
 * for them → one PostRead via the `design_read_post` creative role → validated
 * against the real slide count → upserted (level 'post').
 */

import { callCreativeRole } from '../roles.js';
import type { PostRead, ReadSubjectKind, SlideRead } from '../contracts.js';
import { assertValidRead, POST_READ_SCHEMA } from './schemas.js';
import { POST_READ_SYSTEM, postReadUserPrompt } from './prompts.js';
import { DESIGN_READ_RULE_VERSION, upsertDesignRead } from './persist.js';
import type { DesignReadDeps, ReadOutcome } from './readSlide.js';

export interface PostReadPost {
  subject_kind: ReadSubjectKind;      // 'competitor_post' | 'wassel_content'
  subject_id: string;                 // mkt_content_posts.id
  organization_id: string | null;
  post_type: string | null;           // 'image' | 'carousel'
  platform?: string | null;
}

export interface PostReadSlide {
  media_id: string;
  carousel_index: number;
  stored_url: string;                 // permanent public URL
  slide_read?: SlideRead | null;      // the stored slide-level read, when present
}

export async function readPost(post: PostReadPost, slides: PostReadSlide[], deps: DesignReadDeps): Promise<ReadOutcome> {
  if (slides.length === 0) {
    throw new Error(`validation_unrepaired: post read for ${post.subject_id} needs at least one slide`);
  }
  const ordered = [...slides].sort((a, b) => a.carousel_index - b.carousel_index);
  const callRole = deps.callRole ?? callCreativeRole;
  const res = await callRole<PostRead>('design_read_post', {
    system: POST_READ_SYSTEM,
    user: postReadUserPrompt(
      ordered.map((s) => ({ media_id: s.media_id, carousel_index: s.carousel_index, slide_read: s.slide_read ?? null })),
      { post_type: post.post_type, platform: post.platform ?? null },
    ),
    images: ordered.map((s) => ({ url: s.stored_url })),
    schema: POST_READ_SCHEMA,
  }, { sb: deps.sb, ...deps.ctx });

  assertValidRead('post', res.output, ordered.length);

  const modelUsed = `${res.provider}:${res.model}`;
  const id = await upsertDesignRead(deps.sb, {
    subject_kind: post.subject_kind,
    subject_id: post.subject_id,
    level: 'post',
    post_id: post.subject_id,
    slide_index: null,
    organization_id: post.organization_id,
    model_task: 'design_read_post',
    model_used: modelUsed,
    rule_version: DESIGN_READ_RULE_VERSION,
    read: res.output as unknown as Record<string, unknown>,
    cost_usd: res.cost_usd,
  });
  deps.log?.('designRead: post read persisted', { subject_id: post.subject_id, model_used: modelUsed });
  return { read_row_id: id, model_used: modelUsed, cost_usd: res.cost_usd, latency_ms: res.latency_ms };
}

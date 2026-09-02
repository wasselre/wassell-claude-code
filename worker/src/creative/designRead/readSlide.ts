/**
 * Slide-level design read (worker path).
 *
 * One image → one SlideRead via the `design_read_slide` creative role
 * (callCreativeRole with the public stored_url as an image — competitor media
 * is permanently public, never a signed URL) → validated → upserted with
 * model_used from the result. Optional SigLIP-2 embedding via
 * embed('embed_image') when MODAL_CV_URL is set — never fatal.
 *
 * Provider 'runner' is handled UPSTREAM (the lane enqueues a claude_jobs row
 * instead of calling readSlide); here the role resolves to a direct LLM call.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { embed } from '../../ai/index.js';
import { callCreativeRole, type CreativeAiContext } from '../roles.js';
import type { ReadSubjectKind, SlideRead } from '../contracts.js';
import { assertValidRead, SLIDE_READ_SCHEMA } from './schemas.js';
import { SLIDE_READ_SYSTEM, slideReadUserPrompt } from './prompts.js';
import { DESIGN_READ_RULE_VERSION, upsertDesignRead } from './persist.js';

export interface SlideReadItem {
  subject_kind: ReadSubjectKind;      // 'competitor_media' | 'wassel_file'
  subject_id: string;                 // mkt_content_media.id
  post_id: string;
  slide_index: number | null;         // carousel_index
  organization_id: string | null;
  stored_url: string;                 // permanent public URL
  platform?: string | null;
  slide_count?: number | null;
}

export interface DesignReadDeps {
  sb: SupabaseClient;
  /** Extra context for callCreativeRole (creativeRoles overrides, runner opts). */
  ctx?: Omit<CreativeAiContext, 'sb'>;
  /** Test injection — defaults to the real callCreativeRole. */
  callRole?: typeof callCreativeRole;
  /** Test injection — defaults to embed('embed_image') when MODAL_CV_URL is set. */
  embedImage?: (imageUrl: string) => Promise<number[] | null>;
  log?: (msg: string, extra?: unknown) => void;
}

export interface ReadOutcome {
  read_row_id: string;
  model_used: string;
  cost_usd: number | null;
  latency_ms: number;
}

/** SigLIP-2 image embedding — null when the visual system is not configured. */
async function embedSlideImage(imageUrl: string, deps: DesignReadDeps): Promise<number[] | null> {
  if (deps.embedImage) return deps.embedImage(imageUrl);
  if (!process.env.MODAL_CV_URL) return null;
  const res = await embed('embed_image', { image_urls: [imageUrl] }, { sb: deps.sb });
  return res.vectors?.[0] ?? null;
}

export async function readSlide(item: SlideReadItem, deps: DesignReadDeps): Promise<ReadOutcome> {
  const callRole = deps.callRole ?? callCreativeRole;
  const res = await callRole<SlideRead>('design_read_slide', {
    system: SLIDE_READ_SYSTEM,
    user: slideReadUserPrompt({
      platform: item.platform ?? null,
      slide_index: item.slide_index,
      slide_count: item.slide_count ?? null,
    }),
    images: [{ url: item.stored_url }],
    schema: SLIDE_READ_SCHEMA,
  }, { sb: deps.sb, ...deps.ctx });

  assertValidRead('slide', res.output, 1);

  // Embedding is best-effort: a Modal outage must never lose the read itself.
  // The catch is scoped to THIS call and logged — the read persists without a vector.
  let embedding: number[] | null = null;
  try {
    embedding = await embedSlideImage(item.stored_url, deps);
  } catch (e) {
    console.error(
      `[designRead] embed_image failed for ${item.subject_id} — persisting the read without an embedding:`,
      e instanceof Error ? e.message : e,
    );
  }

  const modelUsed = `${res.provider}:${res.model}`;
  const id = await upsertDesignRead(deps.sb, {
    subject_kind: item.subject_kind,
    subject_id: item.subject_id,
    level: 'slide',
    post_id: item.post_id,
    slide_index: item.slide_index,
    organization_id: item.organization_id,
    model_task: 'design_read_slide',
    model_used: modelUsed,
    rule_version: DESIGN_READ_RULE_VERSION,
    read: res.output as unknown as Record<string, unknown>,
    cost_usd: res.cost_usd,
    embedding,
  });
  deps.log?.('designRead: slide read persisted', { subject_id: item.subject_id, model_used: modelUsed });
  return { read_row_id: id, model_used: modelUsed, cost_usd: res.cost_usd, latency_ms: res.latency_ms };
}

/**
 * Browser-side client for the Posts Content writer.
 *
 * Generation is fanned out over small requests (up to 4 posts each, 3 requests
 * in flight) instead of one long call: each request finishes well inside the
 * endpoint's 60 s ceiling and results stream into the page as they land, so the
 * user watches posts appear. No queue/worker — text generation is fast, unlike
 * the deck / image / document pipelines that genuinely need one.
 */

import { supabase } from '@/lib/supabase';
import type { PostTone } from './templates';
import { assignAngles, type AngleScore, type PostLanguage } from './planning';
import type { GeneratedPost, PostsProjectFacts } from './facts';

const ITEMS_PER_REQUEST = 4;
const MAX_IN_FLIGHT = 3;

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/templates/posts-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `posts-content failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface ProjectFactsResult {
  our_project_id: string;
  facts?: PostsProjectFacts;
  catalog_size?: number;
  ranked?: AngleScore[];
  error?: string;
}

/**
 * Resolve facts + the RANKED supported angles for each project, WITHOUT
 * spending tokens. Drives the setup stage's distribution preview, the
 * "supported angles" counts, and the shortfall warnings.
 */
export async function fetchProjectsPlan(projectIds: string[]): Promise<ProjectFactsResult[]> {
  const r = await post<{ projects: ProjectFactsResult[] }>({
    mode: 'facts',
    our_project_ids: projectIds,
  });
  return r.projects ?? [];
}

export interface WorkItem {
  key: string;
  ourProjectId: string;
  angle: string;
  variationIndex: number;
  postNumber: number;
  evidence: string[];
}

export interface ProjectWorkPlan {
  ourProjectId: string;
  requested: number;
  ranked: AngleScore[];
}

/**
 * Turn each project's requested count + ranked angles into concrete work items.
 *
 * A project whose data supports NO angle produces no items — reported as a
 * shortfall so the caller can say so explicitly rather than inventing claims.
 */
export function buildWorkItems(plans: ProjectWorkPlan[]): {
  items: WorkItem[];
  shortfalls: Array<{ ourProjectId: string; requested: number; possible: number }>;
} {
  const items: WorkItem[] = [];
  const shortfalls: Array<{ ourProjectId: string; requested: number; possible: number }> = [];
  for (const p of plans) {
    const assignments = assignAngles(p.ranked, p.requested);
    if (assignments.length < p.requested) {
      shortfalls.push({ ourProjectId: p.ourProjectId, requested: p.requested, possible: assignments.length });
    }
    for (const a of assignments) {
      items.push({
        key: `${p.ourProjectId}:${a.postNumber}`,
        ourProjectId: p.ourProjectId,
        angle: a.angleId,
        variationIndex: a.variationIndex,
        postNumber: a.postNumber,
        evidence: a.evidence,
      });
    }
  }
  return { items, shortfalls };
}

export interface GenerateChunkResponse {
  facts: PostsProjectFacts;
  posts: GeneratedPost[];
  errors: Array<{ key: string; angle: string; error: string }>;
}

export interface RunCallbacks {
  onPosts: (posts: GeneratedPost[]) => void;
  onErrors: (errors: Array<{ key: string; angle: string; error: string }>) => void;
}

/**
 * Run a set of work items with bounded concurrency.
 *
 * Chunks are grouped BY PROJECT so each request resolves that project's facts
 * once. Failures are reported through `onErrors` and never abort the run — a
 * provider hiccup on one post must not cost the rest of the batch.
 *
 * `avoidHeadlines` accumulates as posts land and is passed to later requests,
 * so a reused angle sees what has already been written for that project. Chunks
 * that start early necessarily see less of it; the deterministic
 * `variationIndex` in the prompt is the primary variation driver.
 */
export async function runWorkItems(
  items: WorkItem[],
  tone: PostTone,
  language: PostLanguage,
  cb: RunCallbacks,
): Promise<void> {
  const byProject = new Map<string, WorkItem[]>();
  for (const it of items) {
    const list = byProject.get(it.ourProjectId) ?? [];
    list.push(it);
    byProject.set(it.ourProjectId, list);
  }

  const chunks: Array<{ ourProjectId: string; items: WorkItem[] }> = [];
  for (const [ourProjectId, list] of byProject) {
    for (let i = 0; i < list.length; i += ITEMS_PER_REQUEST) {
      chunks.push({ ourProjectId, items: list.slice(i, i + ITEMS_PER_REQUEST) });
    }
  }

  const headlinesByProject = new Map<string, string[]>();
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      const chunk = chunks[idx];
      if (!chunk) return;
      const avoid = headlinesByProject.get(chunk.ourProjectId) ?? [];
      try {
        const r = await post<GenerateChunkResponse>({
          mode: 'write',
          our_project_id: chunk.ourProjectId,
          tone,
          language,
          items: chunk.items.map((i) => ({
            key: i.key,
            angle: i.angle,
            variation_index: i.variationIndex,
            post_number: i.postNumber,
            avoid_headlines: avoid.slice(-6),
          })),
        });
        if (r.posts.length > 0) {
          const list = headlinesByProject.get(chunk.ourProjectId) ?? [];
          for (const p of r.posts) {
            const h = p.headline_ar || p.headline_en;
            if (h) list.push(h);
          }
          headlinesByProject.set(chunk.ourProjectId, list);
          cb.onPosts(r.posts);
        }
        if (r.errors.length > 0) cb.onErrors(r.errors);
      } catch (err) {
        // A whole chunk died (network / 500). Report every item in it so the
        // page shows retryable cards rather than silent gaps.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[postsContent] chunk failed:', msg);
        cb.onErrors(chunk.items.map((i) => ({ key: i.key, angle: i.angle, error: msg })));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, chunks.length) }, runner));
}

export interface RegenerateArgs {
  ourProjectId: string;
  tone: PostTone;
  language: PostLanguage;
  item: WorkItem;
  avoidHeadlines?: string[];
  feedback?: {
    reason?: string;
    note?: string;
    previous_headline?: string;
    previous_prose?: string;
  };
}

/** Rewrite ONE post, optionally carrying the reviewer's rejection feedback. */
export async function regeneratePost(args: RegenerateArgs): Promise<GenerateChunkResponse> {
  const { ourProjectId, tone, language, item, avoidHeadlines, feedback } = args;
  return post<GenerateChunkResponse>({
    mode: 'write',
    our_project_id: ourProjectId,
    tone,
    language,
    items: [{
      key: item.key,
      angle: item.angle,
      variation_index: item.variationIndex,
      post_number: item.postNumber,
      avoid_headlines: avoidHeadlines?.slice(-6),
      feedback,
    }],
  });
}

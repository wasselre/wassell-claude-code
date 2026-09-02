// Client for the Competitor Watch workspace.
// Thin, bearer-attached; talks to the shared /api/marketing dispatch endpoint
// (the data layer is reused; the UI is a separate, new module).
import { supabase } from '@/lib/supabase';
import type { VisualDesignReadRow } from '@/lib/creative/contracts';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** One assembled Content Library entry — the labels the enrichment AI already
 *  computed, gathered from mkt_content_posts + mkt_content_enrichment + transcripts. */
export interface LibraryRow {
  id: string;
  org_name: string | null;
  organization_id: string | null;
  platform: string | null;
  format: string | null;        // post_type: image / video / reel / carousel
  shelf: string | null;         // content_type (the "purpose" shelf)
  summary: string | null;       // campaign message, else caption head
  caption: string | null;
  selling_points: string[] | null;
  unit_types: string[] | null;
  amenities: string[] | null;
  ctas: string[] | null;
  offer: string | null;
  price: string | null;
  payment_plan: string | null;
  district: string | null;
  engagement: Record<string, number> | null;
  published_at: string | null;
  post_url: string | null;
  is_video: boolean;
  has_transcript: boolean;
  project_name: string | null;
  developer_record_id: string | null;              // publisher org's `developers` record (null for marketers)
  project_record_id: string | null;                // all_projects record when confidently attributed
  thumb_url: string | null;                         // best poster / first image
  media: Array<{ kind: string; url: string }> | null; // every stored image/video
}

export interface LibraryResult {
  total: number;
  shelves: Record<string, number>;   // purpose facet counts
  rows: LibraryRow[];
}

export interface LibraryFilters {
  shelf?: string | null;
  org?: string | null;
  format?: string | null;
  platform?: string | null;
  has_offer?: boolean | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}

export async function fetchContentLibrary(f: LibraryFilters = {}): Promise<LibraryResult> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'content_library', ...f }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `content_library failed (${res.status})`);
  }
  const j = (await res.json()) as { library: LibraryResult };
  return j.library;
}

// ── Monitoring surfaces (Agents / Pipeline / Storage / Companies) ──────────
async function callAction<T>(action: string, field: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `${action} failed (${res.status})`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  return j[field] as T;
}

export interface AgentActivity {
  collection: {
    paused: boolean; enabled_accounts: number; total_accounts: number;
    runs_today: number; received_today: number; inserted_today: number;
    last_activity: string | null; daily: Array<{ day: string; inserted: number }>;
  };
  understanding: { processed_24h: number; queued: number; all_time: number };
  discovery: { last_run: string | null; runs: number; confirmed: number };
  runs: Array<{ provider: string | null; platform: string | null; handle: string | null; received: number | null; inserted: number | null; started_at: string; status: string }>;
}
export interface PipelineHealth {
  collected: number; media_stored: number; media_failed: number; ocr_done: number;
  transcribed: number; enriched: number; facts: number; attributed: number;
  by_status: Record<string, number>;
}
export interface StorageUsage {
  media_bytes: number; media_rows: number; raw_asset_bytes: number;
  by_kind: Record<string, { count: number; bytes: number }>;
  by_company: Array<{ org: string | null; files: number; bytes: number }>;
}
export interface CompanyAccount {
  platform: string | null; handle: string | null; followers: number | null;
  enabled: boolean; last_pull: string | null; posts: number | null;
}
export interface CompanyRow {
  id: string; name: string | null; org_type: string | null; facts: number;
  accounts: number; posts: number; followers: number; last_pull: string | null;
  account_list: CompanyAccount[];
}
export interface CompanyRoster { companies: CompanyRow[]; }

export const fetchAgentActivity = () => callAction<AgentActivity>('agent_activity', 'activity');
export const fetchPipelineHealth = () => callAction<PipelineHealth>('pipeline_health', 'pipeline');
export const fetchStorageUsage = () => callAction<StorageUsage>('storage_usage', 'storage');
export const fetchCompanyRoster = () => callAction<CompanyRoster>('company_roster', 'roster');

// ── Confirm links (attribution review) ─────────────────────────────────────
export interface QueueProject {
  developer: string | null;
  city: string | null;
  status: string | null;
  unit_types: string[] | null;
  price: { min?: number | null; max?: number | null } | null;
  page_url: string | null;
}
export interface QueueItem {
  post_id: string;
  project_id: string;
  confidence: number | null;
  org_name: string | null;
  platform: string | null;
  format: string | null;
  post_url: string | null;
  published_at: string | null;
  summary: string | null;
  caption: string | null;
  project_name: string | null;
  names_read: string | null;
  thumb_url: string | null;
  project: QueueProject | null;
}
export interface AttributionQueue { remaining: number; items: QueueItem[]; }

export const fetchAttributionQueue = (limit = 30) =>
  callAction<AttributionQueue>('attribution_queue', 'queue', { limit });

export async function reviewAttribution(post_id: string, project_id: string, accept: boolean): Promise<void> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'attribution_review', post_id, project_id, accept }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `attribution_review failed (${res.status})`);
  }
}

// ── Visual library (Competitor Visual Intelligence — mkt_cv_*) ─────────────
// Contract: docs/marketing-script-visual-contracts.md §7 (`api/marketing.ts`
// cv_* actions) + §8. Storage is public by design (§0) — `public_url` /
// `stored_url` are used directly, no signed URLs. Competitor material is
// reference-only; the UI always shows the «مرجع منافس» badge.

/** Raw JSON from the dispatch endpoint. The cv_* actions are being written
 *  concurrently; `pickField` tolerates both `{ <field>: … }` and a bare payload. */
async function callRaw(action: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `${action} failed (${res.status})`);
  }
  return (await res.json()) as Record<string, unknown>;
}
function pickField<T>(j: Record<string, unknown>, field: string): T {
  return (field in j ? j[field] : j) as T;
}

export type CvVideoStatus = 'queued' | 'processing' | 'frames_done' | 'analyzing' | 'analyzed' | 'failed' | 'partial';
export type CvTransition = 'cut' | 'fade' | 'dissolve' | 'graphic' | 'start' | 'end';
export type CvSearchMode = 'shot' | 'frame';

/** mkt_cv_health() — `{videos:{by_status}, shots:{by_analysis_status}, jobs:{"kind:status": n}, …}` */
export interface CvHealth {
  enabled: boolean;
  paused?: boolean;
  videos: Record<string, number>;
  shots: Record<string, number>;
  frames: number;
  keyframes_described: number;
  jobs: Record<string, number>;
  oldest_running_s: number;
  cost_today_usd: number;
  cost_month_usd: number;
  budget_usd: number;
  budget_ok: boolean;
}

/** Loose shape of `mkt_cv_shots.analysis` (shot_analyzer role output). Every key
 *  is optional — the analyzer prompt is owned by W-CV and may evolve; render
 *  defensively and never assume a key exists. */
export interface CvShotAnalysis {
  summary_ar?: string | null;
  summary_en?: string | null;
  purpose?: string | null;
  angle?: string | null;
  camera_movement?: string | null;
  motion?: string | null;
  pace?: string | null;
  transitions?: string | string[] | null;
  production_method?: string | null;
  production_difficulty?: string | null;
  production_resources?: string | string[] | null;
  production?: { method?: string | null; difficulty?: string | null; resources?: string | string[] | null } | null;
  reproducibility?: string | null;
  suitable_platforms?: string[] | null;
  mood?: string | null;
  notes?: string | null;
  [k: string]: unknown;
}

export interface CvTranscriptSegment {
  start_ms?: number; end_ms?: number;
  start?: number; end?: number;          // seconds (fal / whisper shape)
  text?: string | null;
  [k: string]: unknown;
}

/** One mkt_cv_shots row minus the vectors (as returned inside mkt_cv_shot). */
export interface CvShotRow {
  id: string;
  video_id: string;
  shot_no: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  transition_in: CvTransition | null;
  transition_out: CvTransition | null;
  is_static: boolean;
  is_micro: boolean;
  internal_change: boolean;
  edit_pace_local: number | null;
  representative_frame_id: string | null;
  keyframe_ids: string[] | null;
  transcript_text: string | null;
  transcript_segments: CvTranscriptSegment[] | null;
  ocr_text: string | null;
  analysis: CvShotAnalysis | null;
  tags: string[] | null;
  summary: string | null;
  analysis_status: 'pending' | 'done' | 'failed';
  analysis_error: string | null;
  analysis_cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface CvShotFrameRef {
  id: string;
  ts_ms: number;
  public_url: string | null;
  is_keyframe: boolean;
  is_boundary: boolean;
  labels: string[] | null;
  ocr_text: string | null;
  has_analysis: boolean;
  dup_group_id: string | null;
}

export interface CvVideoHeader {
  id: string;
  content_media_id: string | null;
  content_post_id: string | null;
  organization_id: string | null;
  org_name: string | null;
  owner: 'competitor' | 'wassel';
  source_url: string | null;
  duration_ms: number | null;
  status: CvVideoStatus;
  structure: Record<string, unknown> | null;
}

export interface CvPostRef {
  platform: string | null;
  post_url: string | null;
  published_at: string | null;
  caption: string | null;
}

export interface CvNeighbourShot {
  id?: string;                     // not emitted by mkt_cv_shot v1 (contract gap) — present if the API adds it
  shot_no: number;
  summary: string | null;
  start_ms: number;
}

/** mkt_cv_shot(p_shot_id) → { shot, video, post, frames, neighbours } */
export interface CvShot {
  shot: CvShotRow;
  video: CvVideoHeader;
  post: CvPostRef | null;
  frames: CvShotFrameRef[];
  neighbours: CvNeighbourShot[];
}

/** One shot inside cv_video's per-video listing. */
export interface CvVideoShot {
  id: string;
  shot_no: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  transition_in: CvTransition | null;
  transition_out: CvTransition | null;
  is_static: boolean;
  is_micro: boolean;
  representative_frame_id: string | null;
  representative_frame_url: string | null;
  summary: string | null;
  tags: string[] | null;
  analysis_status: 'pending' | 'done' | 'failed';
}

/** cv_video {content_media_id|video_id} → the mkt_cv_videos row + its shots in order. */
export interface CvVideo extends CvVideoHeader {
  fps: number | null;
  width: number | null;
  height: number | null;
  shot_count: number;
  frame_count: number;
  keyframe_count: number;
  detector_version: string | null;
  embedding_version: string | null;
  analysis_version: string | null;
  cost_usd: number;
  error: string | null;
  processed_at: string | null;
  analyzed_at: string | null;
  post: CvPostRef | null;
  shots: CvVideoShot[];
}

/** cv_frame {frame_id} → the mkt_cv_frames row; `describing:true` while the
 *  on-demand describe job is running and `analysis` is still null. */
export interface CvFrame {
  id: string;
  video_id: string;
  shot_id: string | null;
  frame_no: number | null;
  ts_ms: number;
  is_boundary: boolean;
  is_keyframe: boolean;
  dup_group_id: string | null;
  public_url: string | null;
  width: number | null;
  height: number | null;
  quality: { blur?: number; dark?: number; obstruction?: number } | null;
  ocr: { text?: string | null; lang?: string | null; inherited_from?: string | null } | null;
  labels: string[] | null;
  analysis: Record<string, unknown> | null;
  described_at: string | null;
  describing?: boolean;
}

export interface CvSearchWhy { visual?: number | null; text?: number | null; lexical?: number | null }

export interface CvSearchResult {
  shot_id: string;
  video_id: string;
  frame_id: string | null;
  content_media_id?: string | null;
  content_post_id?: string | null;
  organization_id?: string | null;
  org_name: string | null;
  owner?: 'competitor' | 'wassel';
  platform: string | null;
  published_at: string | null;
  post_url: string | null;
  stored_url: string | null;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  representative_frame_url: string | null;
  summary: string | null;
  tags: string[] | null;
  score: number;
  why: CvSearchWhy | null;
}

export interface CvSearchFilters {
  organization_id?: string | null;
  platform?: string | null;
  owner?: 'competitor' | 'wassel' | null;
  min_duration_ms?: number | null;
  max_duration_ms?: number | null;
  tags?: string[] | null;          // controlled-vocabulary tags, ALL must match (`@>`)
  exclude_micro?: boolean | null;
  per_video?: boolean | null;      // lift the ≤1 shot/video diversity cap
}

export interface CvSearchParams {
  q: string;
  filters?: CvSearchFilters;
  mode?: CvSearchMode;
  limit?: number;
}

export interface CvSearchResponse {
  results: CvSearchResult[];
  total?: number;
  unavailable?: boolean;           // the visual system is off (cv.enabled=false)
}

/** cv_backfill_status — how much of the stored video corpus is indexed. */
export interface CvBackfillStatus {
  enabled: boolean;
  stored_videos: number;
  indexed_videos: number;
  not_indexed: number;
  videos_by_status: Record<string, number>;
  jobs: Record<string, number>;
}

/** Frame-mode search rows come straight from mkt_cv_search_frames (representatives only). */
interface CvFrameSearchRow {
  frame_id: string;
  shot_id: string | null;
  video_id: string;
  ts_ms: number;
  public_url: string | null;
  labels: string[] | null;
  ocr_text: string | null;
  score: number | string | null;
  // The API may enrich these; absent in the raw RPC row.
  org_name?: string | null;
  organization_id?: string | null;
  platform?: string | null;
  published_at?: string | null;
  post_url?: string | null;
  stored_url?: string | null;
}

/** Normalise a frame hit into the card shape so the grid renders both modes. */
function frameRowToResult(r: CvFrameSearchRow): CvSearchResult {
  const score = typeof r.score === 'string' ? Number(r.score) : (r.score ?? 0);
  return {
    shot_id: r.shot_id ?? '',
    video_id: r.video_id,
    frame_id: r.frame_id,
    organization_id: r.organization_id ?? null,
    org_name: r.org_name ?? null,
    platform: r.platform ?? null,
    published_at: r.published_at ?? null,
    post_url: r.post_url ?? null,
    stored_url: r.stored_url ?? null,
    start_ms: r.ts_ms,
    end_ms: r.ts_ms,
    duration_ms: 0,
    representative_frame_url: r.public_url,
    summary: r.ocr_text,
    tags: r.labels,
    score: Number.isFinite(score) ? score : 0,
    why: null,
  };
}

export const cvHealth = async (): Promise<CvHealth> => pickField<CvHealth>(await callRaw('cv_health'), 'health');

/** cv_video responds `{ video, shots }` (shots carry `representative_frame_url`); merged here. */
export async function cvVideo(ref: { video_id?: string; content_media_id?: string }): Promise<CvVideo> {
  const j = await callRaw('cv_video', ref);
  const video = (j.video ?? {}) as Omit<CvVideo, 'shots' | 'post'> & { shots?: CvVideoShot[]; post?: CvPostRef | null };
  const shots = (Array.isArray(j.shots) ? j.shots : video.shots ?? []) as CvVideoShot[];
  const post = (j.post ?? video.post ?? null) as CvPostRef | null;
  return { ...video, shots, post };
}

export const cvShot = async (shot_id: string): Promise<CvShot> =>
  pickField<CvShot>(await callRaw('cv_shot', { shot_id }), 'shot');

export const cvFrame = async (frame_id: string): Promise<CvFrame> => {
  const j = await callRaw('cv_frame', { frame_id });
  const f = pickField<CvFrame>(j, 'frame');
  // `describing` may ride at the top level or on the frame itself.
  return j.describing === true ? { ...f, describing: true } : f;
};

export async function cvSearch(p: CvSearchParams): Promise<CvSearchResponse> {
  const mode = p.mode ?? 'shot';
  const j = await callRaw('cv_search', {
    q: p.q, filters: p.filters ?? {}, mode, limit: p.limit ?? 40,
  });
  const raw = (Array.isArray(j.results) ? j.results : Array.isArray(j.rows) ? j.rows : []) as unknown[];
  const results = mode === 'frame'
    ? (raw as CvFrameSearchRow[]).map(frameRowToResult)
    : (raw as CvSearchResult[]).map((r) => ({ ...r, score: typeof r.score === 'string' ? Number(r.score) : r.score }));
  return {
    results,
    total: typeof j.candidates === 'number' ? j.candidates : typeof j.total === 'number' ? j.total : undefined,
    unavailable: j.unavailable === true,
  };
}

export async function cvEnqueue(content_media_id: string, priority?: number): Promise<{ video_id: string | null }> {
  const j = await callRaw('cv_enqueue', { content_media_id, ...(typeof priority === 'number' ? { priority } : {}) });
  const vid = typeof j.video_id === 'number' || typeof j.video_id === 'string' ? String(j.video_id) : null;
  return { video_id: vid };
}

export const cvBackfillStatus = async (): Promise<CvBackfillStatus> =>
  pickField<CvBackfillStatus>(await callRaw('cv_backfill_status'), 'backfill');

/** cv_wassel_status — how much of OUR OWN asset library is visually indexed. */
export interface CvWasselStatus {
  eligible: number;
  videos: number;
  images: number;
  indexed: number;
  processing: number;
  failed: number;
  not_started: number;
}

export const cvWasselStatus = async (): Promise<CvWasselStatus> =>
  pickField<CvWasselStatus>(await callRaw('cv_wassel_status'), 'wassel');

/** Enqueue the next N un-indexed OWN assets into the visual pipeline (admin). */
export async function cvWasselBackfill(limit: number): Promise<{ queued: number }> {
  const j = await callRaw('cv_wassel_backfill', { limit });
  return { queued: typeof j.queued === 'number' ? j.queued : 0 };
}
// ── Post Creative Director: design reads + backfill + Wassel internal ──────
// Wrappers for the creative-director actions on /api/marketing
// (docs/creative-director-contracts.md §4). Row types come from the canonical
// contracts; the payload shapes mirror the endpoint's jsonOk bodies.

export const fetchDesignRead = (subject_kind: string, subject_id: string) =>
  callAction<VisualDesignReadRow[]>('design_read_get', 'reads', { subject_kind, subject_id });

export interface DesignReadsStatus {
  slide_done: number;
  post_done: number;
  failed: number;
  last_read_at: string | null;
  design_reads_config: Record<string, unknown> | null;
}
export const fetchDesignReadsStatus = () =>
  callAction<DesignReadsStatus>('design_reads_status', 'status');

export interface CreativeBackfillRun {
  id: string;
  kind: string;
  tier: number | null;
  status: 'running' | 'completed' | 'failed' | 'paused';
  started_at: string;
  finished_at: string | null;
  processed: number;
  failed: number;
  cost_usd: number | null;
  worker_id: string | null;
  note: string | null;
}
export interface CreativeBackfillStatus {
  config: Record<string, unknown>;
  runs: CreativeBackfillRun[];
}
export const fetchCreativeBackfillStatus = () =>
  callAction<CreativeBackfillStatus>('creative_backfill_status', 'backfill');

/** Admin-only. The op travels as `op` — `action` is the endpoint's dispatch key. */
export const controlCreativeBackfill = (
  kind: 'design_reads' | 'asset_meta' | 'asset_enrich',
  op: 'start' | 'pause' | 'resume',
  tier?: number,
) =>
  callAction<{ config: Record<string, unknown> }>('creative_backfill_control', 'backfill', {
    kind, op, ...(tier !== undefined ? { tier } : {}),
  });

export interface WasselInternalStatus {
  registered: boolean;
  org: { id: string; name_ar: string | null; name_en: string | null; website: string | null } | null;
  accounts: Array<{
    id: string; platform: string | null; handle: string | null; profile_url: string | null;
    is_active: boolean; collection_enabled: boolean; scrape_status: string | null;
    followers: number | null; last_synced_at: string | null;
  }>;
  posts: number;
  media_stored: number;
}
export const fetchWasselInternalStatus = () =>
  callAction<WasselInternalStatus>('wassel_internal_status', 'wassel');

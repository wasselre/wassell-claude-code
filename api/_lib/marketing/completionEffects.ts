/**
 * Completion side effects — the runner for the manifest a completion leaves
 * behind (plan-driven assignment, 2026-09-22, §5e of the reviewed plan).
 *
 * `workflow_advance_role_path` commits the transition and, on the FINAL
 * approval of a creative, writes a `side_effects` manifest onto the completion
 * event: one element per thing that must now happen OUTSIDE the transaction —
 *
 *   • `promote_asset` — the material submitted for approval becomes the
 *     approved ('final') link the Publishing tab reads;
 *   • `meta_ad` — the ad is handed to the Fly worker with the approved caption
 *     SNAPSHOTTED on the element (text + the hash the database computed), and
 *     the Meta target the approver chose.
 *
 * The runner executes every element still `pending`, and flips one to `done`
 * ONLY after the effect is confirmed (the promote RPC returned; the enqueue
 * RPC admitted, replayed, or found the job already satisfied). Anything else
 * stays `pending` with its error, and the planning sweep re-runs it
 * (`mos_completion_pending_effects`) — a crashed API response after the
 * commit therefore loses nothing.
 *
 * Every write is idempotent by construction: the promote RPC is a no-op on a
 * promoted asset, and the Meta job id is derived from the event id, so a
 * second run of the same element cannot enqueue a second job.
 *
 * Hard rules: never mark `done` on "the call returned"; never write the ad row
 * from here (the enqueue RPC owns it); never throw past a single element — a
 * failed element is recorded, the others still run.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueMetaAdJob, type AutoAdTarget, type EnqueueMetaAdOutcome } from './metaAutoAd.js';

export interface ManifestElement {
  kind: string;
  ref: string | null;
  status: 'pending' | 'done' | 'failed' | 'superseded' | string;
  attempts?: number;
  phase?: string;
  job_id?: string | null;
  target?: { kind: string; target?: AutoAdTarget; reason?: string } | null;
  approved_caption?: {
    text: string; hash: string | null; source: string; approved_at: string; approved_by: string | null;
  } | null;
  last_error?: string | null;
  detail?: unknown;
}

export interface CompletionEventRow {
  event_id: string;
  subject_table: string;
  subject_id: string;
  /** public.users id of the actor (the approver). */
  actor_user_id: string | null;
  /** auth.users id of the actor when the caller knows it (request time);
   *  resolved from `users.auth_uid` otherwise (recovery from the sweep). */
  actor_auth_uid?: string | null;
  side_effects: ManifestElement[];
}

export type EffectResult =
  | { kind: 'promote_asset'; ref: string | null; outcome: 'done' | 'pending' | 'failed'; asset_id?: string | null; error?: string }
  | { kind: 'meta_ad'; ref: string | null; outcome: 'done' | 'pending' | 'failed' | 'superseded'; enqueue?: EnqueueMetaAdOutcome; error?: string; target?: AutoAdTarget | null }
  | { kind: string; ref: string | null; outcome: 'failed'; error: string };

/** After this many attempts an element stops retrying and reads `failed`. */
const MAX_ATTEMPTS: Record<string, number> = { promote_asset: 5, meta_ad: 12 };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

async function markEffect(
  svc: SupabaseClient, eventId: string, kind: string, ref: string | null,
  outcome: 'done' | 'pending' | 'failed' | 'superseded', error: string | null, detail: unknown,
): Promise<void> {
  const res = await svc.rpc('mos_completion_effect_done', {
    p_event_id: eventId, p_kind: kind, p_ref: ref, p_outcome: outcome,
    p_error: error, p_detail: detail ?? null,
  });
  // The effect itself already happened; a lost mark means the sweep re-runs an
  // idempotent step. Loud, never fatal.
  if (res.error) {
    console.error('[completionEffects] mos_completion_effect_done failed', eventId, kind, ref,
      res.error.code, res.error.message);
  }
}

async function authUidOf(svc: SupabaseClient, appUserId: string | null): Promise<string | null> {
  if (!appUserId) return null;
  const res = await svc.from('users').select('auth_uid').eq('id', appUserId).maybeSingle();
  if (res.error) {
    console.error('[completionEffects] users.auth_uid read failed', appUserId, res.error.code, res.error.message);
    return null;
  }
  return str((res.data as { auth_uid?: unknown } | null)?.auth_uid);
}

async function contentTitleOf(svc: SupabaseClient, contentId: string): Promise<string> {
  const res = await svc.from('mos_content').select('title').eq('id', contentId).maybeSingle();
  if (res.error) {
    console.error('[completionEffects] mos_content title read failed', contentId, res.error.code, res.error.message);
    return '';
  }
  return str((res.data as { title?: unknown } | null)?.title) ?? '';
}

/** The pending/failed disposition for an element that did not complete. */
function retryOrFail(el: ManifestElement, kind: string): 'pending' | 'failed' {
  const attempts = (Number(el.attempts) || 0) + 1;
  return attempts >= (MAX_ATTEMPTS[kind] ?? 5) ? 'failed' : 'pending';
}

/**
 * Run every `pending` element of one completion event. Returns one result per
 * element it touched (done/pending/failed/superseded). Safe to call again.
 */
export async function runCompletionEffects(
  svc: SupabaseClient,
  ev: CompletionEventRow,
  opts: { wake?: () => void; contentTitle?: string | null } = {},
): Promise<EffectResult[]> {
  const out: EffectResult[] = [];
  const pending = (ev.side_effects ?? []).filter((e) => e && e.status === 'pending');
  for (const el of pending) {
    const kind = el.kind;
    const ref = el.ref ?? null;
    try {
      if (kind === 'promote_asset') {
        if (!ref) throw new Error('promote_asset element has no ref');
        const r = await svc.rpc('mos_promote_approval_asset', { p_content_id: ref });
        if (r.error) {
          const disposition = retryOrFail(el, kind);
          console.error('[completionEffects] promote failed', ev.event_id, ref, r.error.code, r.error.message, disposition);
          await markEffect(svc, ev.event_id, kind, ref, disposition, r.error.message, null);
          out.push({ kind, ref, outcome: disposition, error: r.error.message });
          continue;
        }
        const assetId = str(r.data);
        await markEffect(svc, ev.event_id, kind, ref, 'done', null, { asset_id: assetId });
        out.push({ kind, ref, outcome: 'done', asset_id: assetId });
        continue;
      }

      if (kind === 'meta_ad') {
        const target = el.target?.kind === 'target' ? (el.target.target ?? null) : null;
        const caption = el.approved_caption ?? null;
        if (!ref || !target || !caption || !str(caption.text)) {
          const msg = 'meta_ad element is missing its target or approved caption';
          console.error('[completionEffects]', msg, ev.event_id);
          await markEffect(svc, ev.event_id, kind, ref, 'failed', msg, null);
          out.push({ kind, ref, outcome: 'failed', error: msg, target });
          continue;
        }
        let jobId = str(el.job_id);
        if (!jobId) {
          const j = await svc.rpc('mos_meta_job_id', { p_event_id: ev.event_id });
          if (j.error) throw new Error(`mos_meta_job_id: ${j.error.message}`);
          jobId = str(j.data);
          if (!jobId) throw new Error('mos_meta_job_id returned nothing');
        }
        const authUid = str(ev.actor_auth_uid) ?? await authUidOf(svc, ev.actor_user_id);
        const title = str(opts.contentTitle) ?? await contentTitleOf(svc, ref);
        const enq = await enqueueMetaAdJob(svc, {
          jobId,
          eventId: ev.event_id,
          contentId: ref,
          contentTitle: title,
          target,
          approvedByAuthUid: authUid,
          approvedByUserId: ev.actor_user_id,
          approvedCaption: caption,
        });
        if (enq.reason === 'enqueued') opts.wake?.();
        if (enq.reason === 'enqueued' || enq.reason === 'replay' || enq.reason === 'already_done' || enq.reason === 'satisfied_by') {
          await markEffect(svc, ev.event_id, kind, ref, 'done', null, enq);
          out.push({ kind, ref, outcome: 'done', enqueue: enq, target });
        } else if (enq.reason === 'superseded') {
          await markEffect(svc, ev.event_id, kind, ref, 'superseded', enq.detail, enq);
          out.push({ kind, ref, outcome: 'superseded', enqueue: enq, target });
        } else {
          // retry_later: the row is mid-transition (a predecessor job still
          // queued). The sweep tries again in a couple of minutes.
          const disposition = retryOrFail(el, kind);
          await markEffect(svc, ev.event_id, kind, ref, disposition, enq.detail ?? enq.reason, enq);
          out.push({ kind, ref, outcome: disposition, enqueue: enq, target });
        }
        continue;
      }

      const msg = `unknown side-effect kind ${kind}`;
      console.error('[completionEffects]', msg, ev.event_id);
      await markEffect(svc, ev.event_id, kind, ref, 'failed', msg, null);
      out.push({ kind, ref, outcome: 'failed', error: msg });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const disposition = retryOrFail(el, kind);
      console.error('[completionEffects] element threw', ev.event_id, kind, ref, msg, disposition);
      await markEffect(svc, ev.event_id, kind, ref, disposition, msg, null);
      out.push(kind === 'meta_ad'
        ? { kind: 'meta_ad', ref, outcome: disposition, error: msg }
        : kind === 'promote_asset'
          ? { kind: 'promote_asset', ref, outcome: disposition, error: msg }
          : { kind, ref, outcome: 'failed', error: msg });
    }
  }
  return out;
}

/**
 * Recovery: every event with an element still pending after `minAge` gets its
 * runner call again. Called from the planning sweep (service role, no
 * auth.uid()) — the RPC refuses any other caller.
 */
export async function recoverPendingEffects(
  svc: SupabaseClient,
  opts: { wake?: () => void; minAge?: string; limit?: number } = {},
): Promise<{ events: number; results: Array<{ event_id: string; results: EffectResult[] }> } | { error: string }> {
  const res = await svc.rpc('mos_completion_pending_effects', {
    p_min_age: opts.minAge ?? '2 minutes',
    p_limit: opts.limit ?? 50,
  });
  if (res.error) {
    console.error('[completionEffects] mos_completion_pending_effects failed', res.error.code, res.error.message);
    return { error: res.error.message };
  }
  const rows = (res.data ?? []) as Array<{
    event_id: string; operation: string; subject_table: string; subject_id: string;
    actor_user_id: string | null; side_effects: ManifestElement[]; created_at: string;
  }>;
  const results: Array<{ event_id: string; results: EffectResult[] }> = [];
  for (const row of rows) {
    const r = await runCompletionEffects(svc, {
      event_id: row.event_id,
      subject_table: row.subject_table,
      subject_id: row.subject_id,
      actor_user_id: row.actor_user_id,
      side_effects: Array.isArray(row.side_effects) ? row.side_effects : [],
    }, { wake: opts.wake });
    results.push({ event_id: row.event_id, results: r });
  }
  return { events: rows.length, results };
}

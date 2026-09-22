/**
 * Handing ONE publication to bundle.social — the real organic publish path.
 *
 * Lifted VERBATIM out of the `publication_publish` case in api/marketing-os.ts
 * on 2026-09-14 so two callers can share it without a second implementation:
 *
 *   • the endpoint, when a person presses publish (capability-gated there);
 *   • `api/cron/release-sweep.ts`, when a release's moment arrives and the
 *     destination can publish by itself.
 *
 * The capability gate deliberately stayed at the CALL SITES. A person needs the
 * `publish` capability; the sweep is the system acting on an already-approved
 * plan and is gated by CRON_SECRET instead. Putting the gate in here would have
 * forced the sweep to fake a user.
 *
 * Nothing about the logic changed in the move — including the compensating
 * delete when the database write fails after the post is already live, which is
 * the one path that can otherwise leave an untracked live post.
 *
 * ── 2026-09-15: the material rule (Group D of the monthly operating model) ──
 *
 * Two paths live here now, chosen by the workflow version the content is
 * PINNED to — see `releaseMaterial.ts` for the whole rule and why the boundary
 * is a pin rather than a date:
 *
 *   • LEGACY (pre-cutover pin, and everything that was here before): files
 *     come off the publication row (`asset_ids`, else `asset_id`) where the
 *     Publish tab's picker put them, and the caption is the row's own caption.
 *     Byte-for-byte today's behaviour — the 24 existing content records and
 *     the 10 draft publications all land here.
 *
 *   • MANAGED (post-cutover pin): nothing is picked. The file is the design
 *     slot the DESTINATION names (feed → `final_square`, story →
 *     `final_vertical`), the caption is the approved writing (a story gets
 *     none), and both are checked against what the final approval bound before
 *     a byte leaves. A refusal opens ONE publication task through
 *     `mos_release_open_task` and returns 422; it is never silent.
 *
 * Both paths now write back what actually went out — the file ids and the
 * caption as sent — onto the publication row in the same UPDATE that records
 * the handoff, so the row is the record for reporting.
 */
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import {
  type BundleConfig, BundleApiError, isBundlePlatform, platformAcceptsKind,
  buildPlatformData, uploadFromUrl, createPost, deletePost,
} from './bundleSocial.js';
import { preflightPublishSet } from '../../../src/lib/marketingOS/platformRules.js';
import { makeServiceClient } from '../serviceClient.js';
import { enqueueWasselReadsOnPublish } from './creative/onPublished.js';
import {
  RELEASE_REFUSAL, openReleaseRefusalTask, resolveReleaseMaterial,
} from './releaseMaterial.js';

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const jsonOk = (b: Record<string, unknown>): Response => json({ ok: true, ...b }, 200);
const jsonError = (status: number, error: string): Response => json({ error }, status);
function dbFail(error: PostgrestError | null): Response | null {
  if (!error) return null;
  console.error('[publishRelease] db error', error.code, error.message);
  return jsonError(500, error.message);
}

/**
 * Publish one `mos_publications` row. Returns the same Response shapes the
 * endpoint has always returned, so the caller can pass it straight through.
 */
export async function publishPublication(
  sb: SupabaseClient, cfg: BundleConfig, pubId: string,
): Promise<Response> {
    const pubRes = await sb.from('mos_publication_v').select('*').eq('id', pubId).maybeSingle();
  const pf = dbFail(pubRes.error);
  if (pf) return pf;
  const pub = pubRes.data as Record<string, unknown> | null;
  if (!pub) return jsonError(404, 'publication not found');

  const platform = String(pub.platform ?? '');
  if (!isBundlePlatform(platform)) {
    return jsonError(400, `${platform} cannot be auto-posted — publish it manually.`);
  }
  if (pub.account_connected !== true) {
    return jsonError(400, `${platform} is not connected — connect it in Settings → Platforms first.`);
  }

  // ── idempotency guard ─────────────────────────────────────────
  // A publication already handed to bundle must NOT create a second live
  // post (double-click, retry-after-timeout, two users). Re-publishing is
  // allowed ONLY when the previous attempt is dead (ERROR, or DELETED on
  // bundle's side) — that is the retry path.
  const priorPostId = typeof pub.bundle_post_id === 'string' ? pub.bundle_post_id : null;
  const priorBundle = typeof pub.bundle_status === 'string' ? pub.bundle_status.toUpperCase() : null;
  const retrying = priorPostId !== null && (priorBundle === 'ERROR' || priorBundle === 'DELETED');
  if (priorPostId && !retrying) {
    return jsonError(409,
      'هذا النشر أُرسل للمنصة بالفعل — حدّث الحالة بدلًا من النشر مرة أخرى. / '
      + 'Already handed to the platform — refresh its status instead of publishing again.');
  }

  const contentId = typeof pub.content_id === 'string' ? pub.content_id : '';
  if (!contentId) return jsonError(400, 'This publication is not attached to any content.');

  // ── the material rule: what this release posts, and where it came from ──
  const material = await resolveReleaseMaterial(sb, pubId, contentId);
  if (material.mode === 'error') {
    // NEVER downgraded to the legacy path: a read that failed must not
    // silently un-gate publishing. Loud, and the sweep turns it into work.
    console.error('[publishRelease] material resolution failed', pubId, material.message);
    return jsonError(500, `Could not resolve what this release should post: ${material.message}`);
  }
  if (material.mode === 'refuse') {
    await openReleaseRefusalTask(sb, pubId, material.reason, material.ar);
    return jsonError(422, `${material.ar} / ${material.en}`);
  }
  const managed = material.mode === 'managed';
  const slotIds = material.mode === 'managed' ? material.assetIds : null;
  const approvedCaption = material.mode === 'managed' ? material.caption : null;
  const captionRequired = material.mode === 'managed' ? material.captionRequired : false;

  // The ORDERED file set. MANAGED: the one design slot the destination names.
  // LEGACY: asset_ids (carousel) or the single asset_id off the row.
  const setIds = Array.isArray(pub.asset_ids)
    ? (pub.asset_ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
    : [];
  const effectiveIds = slotIds
    ?? (setIds.length > 0 ? setIds : [str(pub.asset_id) ?? ''].filter(Boolean));
  if (effectiveIds.length === 0) {
    return jsonError(400, 'This publication has no approved file to post.');
  }
  // MANAGED: the approved writing — '' for a story, which carries no text.
  // LEGACY: whatever the row holds, exactly as before.
  const caption = approvedCaption ?? (typeof pub.caption === 'string' ? pub.caption : '');
  // The caption goes out exactly as approved. (Until 2026-09-22 the content's
  // hashtags were appended here; hashtags were removed altogether.)
  const finalCaption = caption;

  // Resolve every approved asset, PRESERVING the carousel order (the
  // .in() result order is arbitrary — re-order by effectiveIds).
  type AssetRow = { id: string; url: string | null; file_id: string | null;
    mime_type: string | null; kind: string; size_bytes: number | null;
    duration_seconds: number | null; aspect_ratio: string | null };
  const assetRes = await sb.from('mos_assets')
    .select('id, url, file_id, mime_type, kind, size_bytes, duration_seconds, aspect_ratio')
    .in('id', effectiveIds);
  const af = dbFail(assetRes.error);
  if (af) return af;
  const byId = new Map(((assetRes.data ?? []) as AssetRow[]).map((a) => [a.id, a]));
  const assets = effectiveIds.map((aid) => byId.get(aid)).filter((a): a is AssetRow => Boolean(a));
  if (assets.length !== effectiveIds.length) {
    if (managed) {
      // §3.4.5 exactly: the slot still names a file, and the file is gone.
      // Nothing is picked on this path, so "re-pick the files" is the wrong
      // instruction — the fix is a re-upload into the same slot.
      const ar = 'التصميم المرتبط بهذه الوجهة لم يعد موجودًا — أعد رفعه من تبويب المواد ثم أعد المحاولة.';
      await openReleaseRefusalTask(sb, pubId, RELEASE_REFUSAL.MATERIAL_UNRESOLVED, ar);
      return jsonError(422, `${ar} / The design this destination points at no longer exists`
        + ' — re-upload it on the Materials tab, then retry.');
    }
    return jsonError(404, 'An approved file on this publication no longer exists — re-pick the files.');
  }

  for (const a of assets) {
    const k = (a.kind ?? 'photo');
    if (!platformAcceptsKind(platform, k)) {
      return jsonError(400, `${platform} cannot take a ${k} file.`);
    }
  }

  // ── pre-flight — the platform's own rules, checked BEFORE upload ──
  // The SPA runs the same preflightPublishSet for its checklist; this is
  // the authoritative gate (a stale client or a direct API call still
  // cannot push a doomed post). Blockers only — warnings (unverifiable
  // metadata) pass through: bundle validates everything at post time.
  //
  // `captionRequired` is the ONE new rule (settled D3/D4): a feed post whose
  // approved writing carries no caption is blocked, because the old rulebook
  // checked caption LENGTH and hashtag COUNT only — an empty caption sailed
  // through and published a picture with no words. It is keyed on the APPROVED
  // WRITING being empty, not on `mos_publications.caption` being empty, so the
  // 10 pre-cutover drafts (legacy path, captionRequired=false) are untouched.
  // A story passes with no caption by design.
  const flight = preflightPublishSet(platform, assets, finalCaption, { captionRequired });
  const blockers = flight.issues.filter((i) => i.level === 'block');
  if (blockers.length > 0) {
    const detail = blockers.map((b) => `${b.ar} / ${b.en}`).join('  •  ');
    if (managed) {
      // Same single exception mechanism as every other managed refusal —
      // `preflight_blocked` is a reason code the RPC already knows.
      await openReleaseRefusalTask(sb, pubId, RELEASE_REFUSAL.PREFLIGHT_BLOCKED,
        blockers.map((b) => b.ar).join('  •  '));
    }
    return jsonError(422, detail);
  }

  // Resolve each file to a URL bundle can fetch (public legacy URL
  // verbatim, or a 1h signed URL — bundle fetches server-side right after
  // handoff, but its fetch can queue; 300s left no slack).
  const svc = makeServiceClient('api:marketing-os');
  const resolveUrl = async (a: AssetRow): Promise<string> => {
    if (a.url) return a.url;
    if (!a.file_id) throw new Error(`file bytes missing for asset ${a.id}`);
    if (!svc) throw new Error('file signing is unavailable');
    const fr = await svc.from('files')
      .select('storage_bucket, storage_path').eq('id', a.file_id).maybeSingle();
    if (fr.error) throw new Error(fr.error.message);
    const file = fr.data as { storage_bucket: string; storage_path: string } | null;
    if (!file) throw new Error(`file row missing for asset ${a.id}`);
    const signed = await svc.storage.from(file.storage_bucket)
      .createSignedUrl(file.storage_path, 3600);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error(signed.error?.message ?? 'sign failed');
    }
    return signed.data.signedUrl;
  };
  let fileUrls: string[];
  try {
    fileUrls = await Promise.all(assets.map(resolveUrl));
  } catch (e) {
    console.error('[marketing-os] resolving approved files failed', e);
    return jsonError(500, `Could not resolve the approved files: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A human-readable title on bundle's side — ref + title, or a fallback.
  const cRes = await sb.from('mos_content_v')
    .select('ref, title').eq('id', pub.content_id as string).maybeSingle();
  const cRow = cRes.data as { ref: string | null; title: string | null } | null;
  const title = [cRow?.ref, cRow?.title].filter(Boolean).join(' ').trim() || 'Wassel';

  // Schedule at the slot when it is safely in the future; otherwise post
  // ~now (bundle needs a valid future-ish postDate — a minute's lead).
  const now = Date.now();
  const schedMs = typeof pub.scheduled_at === 'string' ? Date.parse(pub.scheduled_at) : NaN;
  const postDate = new Date(
    Number.isFinite(schedMs) && schedMs > now + 60_000 ? schedMs : now + 60_000,
  ).toISOString();

  // Retry path: clear the dead attempt on bundle's side first so the
  // dashboard doesn't accumulate ERROR corpses. Best-effort — a failed
  // delete of an already-dead post must not block the retry (logged).
  if (retrying && priorPostId && priorBundle === 'ERROR') {
    try {
      await deletePost(cfg, priorPostId);
    } catch (e) {
      console.error('[marketing-os] cleanup of errored bundle post failed (continuing)', priorPostId, e);
    }
  }

  let post;
  try {
    // Upload every file (bundle fetches each by URL), keeping order.
    const ups = await Promise.all(fileUrls.map((u) => uploadFromUrl(cfg, u)));
    const uploads = ups.map((up, i) => ({
      id: up.id,
      kind: (assets[i]?.kind ?? 'photo') as 'photo' | 'video' | 'design' | 'audio' | 'document',
    }));
    const built = buildPlatformData(platform, { text: finalCaption, uploads });
    if (!built) return jsonError(400, `${platform} is not supported for auto-posting.`);
    post = await createPost(cfg, {
      title,
      status: 'SCHEDULED',
      socialAccountTypes: [built.socialAccountType],
      postDate,
      data: built.data,
    });
  } catch (e) {
    // Fail loudly — the platform's own message reaches the user, never swallowed.
    const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
    console.error('[marketing-os] bundle.social publish failed', e);
    return jsonError(502, `bundle.social: ${msg}`);
  }

  const patch: Record<string, unknown> = {
    status: 'scheduled',
    scheduled_at: postDate,
    external_id: post.id,
    bundle_post_id: post.id,
    bundle_status: post.status,
    bundle_error: null,
    bundle_synced_at: new Date().toISOString(),
    // ── what actually went out (material rule step 7) ───────────────────
    // Resolution happens at publish time, so until now nothing recorded WHICH
    // files and WHICH text the platform received — the row only ever held what
    // someone picked beforehand. Written in the SAME update as the handoff, so
    // the compensating delete below covers it: either the row records the post
    // or the post is rolled back. On the legacy path these are the values that
    // were already there, so the write is a no-op by construction.
    asset_ids: effectiveIds,
    asset_id: effectiveIds[0] ?? null,
  };
  // `file_id` is the pre-assets fallback the Publish tab still uses to find a
  // row's file. Filled when the posted asset has one, NEVER cleared: a legacy
  // link-only asset carries no file_id, and nulling it would break that
  // fallback on rows that depend on it.
  if (assets[0]?.file_id) patch.file_id = assets[0].file_id;
  // The caption is written back under the database's own rule.
  // `mos_tg_publication_caption_guard` raises `insufficient_privilege` when a
  // BROWSER session changes `caption` on a row whose stored status is already
  // `published` — "a published post is never rewritten". Reachable here: a
  // release marked published by hand carries no `bundle_post_id`, so the
  // idempotency guard above lets it through, and the exception would land
  // AFTER the live post exists — triggering the compensating delete and
  // failing a publish that actually worked. Honour the rule instead.
  if (String(pub.status ?? '') !== 'published') patch.caption = finalCaption;
  const upd = await sb.from('mos_publications').update(patch).eq('id', pubId).select('id').maybeSingle();
  if (upd.error || !upd.data) {
    // The live post now exists but our row doesn't know its id — that is
    // an ORPHAN live post (and a future duplicate when the user retries).
    // Compensate: delete the just-created bundle post, then fail honestly.
    try {
      await deletePost(cfg, post.id);
      console.error('[marketing-os] publish DB write failed — bundle post rolled back', pubId, post.id, upd.error);
      return jsonError(500, 'Saving the publish result failed — the post was rolled back. Try again.');
    } catch (delErr) {
      // Rollback itself failed: the post IS live but untracked. Say so
      // loudly instead of pretending — the id is in the message + logs.
      console.error('[marketing-os] publish DB write failed AND rollback failed — orphan live post', pubId, post.id, delErr);
      return jsonError(500,
        `Saving failed and rollback failed — a live post may exist untracked on bundle.social (post ${post.id}). Do not re-publish; report this.`);
    }
  }

  // ── creative director: design reads on publish (best-effort) ──
  // Verifies the published assets exist as collected internal-org media
  // for the design-read sweep; failure here must never fail the publish.
  try {
    const readsSvc = makeServiceClient('api:marketing-os:creative');
    if (readsSvc) await enqueueWasselReadsOnPublish(readsSvc, pubId);
  } catch (e) {
    console.error('[marketing-os] reads-on-publish hook failed (non-fatal)', pubId, e);
  }

  const list = await sb.from('mos_publication_v').select('*').eq('content_id', pub.content_id as string)
    .order('scheduled_at', { ascending: true, nullsFirst: false });
  const lf = dbFail(list.error);
  if (lf) return lf;
  return jsonOk({ publications: list.data ?? [] });
}

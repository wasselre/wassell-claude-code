/**
 * Handing a publication to bundle.social — the real organic publish path.
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
 *
 * ── 2026-10-01: the Instagram grid only grows by whole rows ─────────────────
 *
 * Operator rule: "we only post full rows on Instagram". An Instagram release
 * that lands on the profile grid (anything that is not a story) is never handed
 * off alone any more. It goes with its row — all three of the row's feed posts
 * at once, each at its own time, in the row's order — or not at all; and a post
 * that belongs to no row never reaches the grid. The rule, and the 29–30 Sep
 * posting that broke the grid, are in `instagramGrid.ts`. Stories and the other
 * platforms keep the one-release path below, unchanged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type BundleConfig, type BundlePost, BundleApiError, isBundlePlatform, platformAcceptsKind,
  buildPlatformData, resolvePostDate, uploadFromUrl, createPost, deletePost, getPost,
} from './bundleSocial.js';
import {
  preflightPublishSet, isRenderableImage, RENDITION_BOX,
} from '../../../src/lib/marketingOS/platformRules.js';
import { makeServiceClient } from '../serviceClient.js';
import { enqueueWasselReadsOnPublish } from './creative/onPublished.js';
import {
  RELEASE_REFUSAL, openReleaseRefusalTask, resolveReleaseMaterial,
} from './releaseMaterial.js';
import {
  type GridRelease, NOT_IN_ROW, handOffRow, isAlreadyOut, judgeRow, landsOnInstagramGrid, rowTiming,
} from './instagramGrid.js';

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const jsonError = (status: number, error: string): Response => json({ error }, status);

type PubRow = Record<string, unknown>;

type AssetRow = { id: string; url: string | null; file_id: string | null;
  mime_type: string | null; kind: string; size_bytes: number | null;
  duration_seconds: number | null; aspect_ratio: string | null };

/** One release, checked and resolved — everything up to (not including) the upload. */
interface PreparedHandoff {
  pubId: string;
  pub: PubRow;
  contentId: string;
  platform: string;
  /** The destination the payload uses: the managed variant, or null (legacy). */
  placement: 'feed' | 'story' | null;
  effectiveIds: string[];
  assets: AssetRow[];
  fileUrls: string[];
  finalCaption: string;
  title: string;
  retrying: boolean;
  priorPostId: string | null;
  priorBundle: string | null;
}

/** A step that did not work, as the HTTP answer the caller will give. */
type Failure = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Failure => ({ ok: false, status, error });

/** bundle.social cannot express this file set — no platform call was made. */
class UnsupportedPayloadError extends Error {}

/**
 * Publish one `mos_publications` row. Returns the same Response shapes the
 * endpoint has always returned, so the caller can pass it straight through.
 *
 * An Instagram grid release takes its whole row with it (see the header). The
 * answer then also carries `row: { id, release_ids, to_send, handed_off }`, so
 * the sweep can skip the row's other posts for the rest of its tick.
 */
export async function publishPublication(
  sb: SupabaseClient, cfg: BundleConfig, pubId: string,
): Promise<Response> {
  const loaded = await loadPublication(sb, pubId);
  if (!loaded.ok) return jsonError(loaded.status, loaded.error);
  const prepared = await prepareHandoff(sb, loaded.pub);
  if (!prepared.ok) return jsonError(prepared.status, prepared.error);
  if (landsOnInstagramGrid(prepared.value.platform, prepared.value.placement)) {
    return publishInstagramRow(sb, cfg, prepared.value);
  }
  return handOffOne(sb, cfg, prepared.value);
}

async function loadPublication(
  sb: SupabaseClient, pubId: string,
): Promise<{ ok: true; pub: PubRow } | Failure> {
  const pubRes = await sb.from('mos_publication_v').select('*').eq('id', pubId).maybeSingle();
  if (pubRes.error) {
    console.error('[publishRelease] db error', pubRes.error.code, pubRes.error.message);
    return fail(500, pubRes.error.message);
  }
  const pub = pubRes.data as PubRow | null;
  if (!pub) return fail(404, 'publication not found');
  return { ok: true, pub };
}

/**
 * Everything before the upload: the platform, the idempotency guard, the
 * material rule, the files, the rulebook, the URLs bundle will fetch. Nothing
 * here touches the platform, so a release that cannot go costs nothing — and a
 * ROW can be checked whole before any of it is uploaded.
 */
async function prepareHandoff(
  sb: SupabaseClient, pub: PubRow,
): Promise<{ ok: true; value: PreparedHandoff } | Failure> {
  const pubId = String(pub.id ?? '');
  const platform = String(pub.platform ?? '');
  if (!isBundlePlatform(platform)) {
    return fail(400, `${platform} cannot be auto-posted — publish it manually.`);
  }
  if (pub.account_connected !== true) {
    return fail(400, `${platform} is not connected — connect it in Settings → Platforms first.`);
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
    return fail(409,
      'هذا النشر أُرسل للمنصة بالفعل — حدّث الحالة بدلًا من النشر مرة أخرى. / '
      + 'Already handed to the platform — refresh its status instead of publishing again.');
  }

  const contentId = typeof pub.content_id === 'string' ? pub.content_id : '';
  if (!contentId) return fail(400, 'This publication is not attached to any content.');

  // ── the material rule: what this release posts, and where it came from ──
  const material = await resolveReleaseMaterial(sb, pubId, contentId);
  if (material.mode === 'error') {
    // NEVER downgraded to the legacy path: a read that failed must not
    // silently un-gate publishing. Loud, and the sweep turns it into work.
    console.error('[publishRelease] material resolution failed', pubId, material.message);
    return fail(500, `Could not resolve what this release should post: ${material.message}`);
  }
  if (material.mode === 'refuse') {
    await openReleaseRefusalTask(sb, pubId, material.reason, material.ar);
    return fail(422, `${material.ar} / ${material.en}`);
  }
  const managed = material.mode === 'managed';
  const slotIds = material.mode === 'managed' ? material.assetIds : null;
  const approvedCaption = material.mode === 'managed' ? material.caption : null;
  const captionRequired = material.mode === 'managed' ? material.captionRequired : false;
  // The destination decides the SURFACE (feed post vs story), so it travels to
  // the rulebook and to the platform payload. A legacy release has none and
  // keeps the old shape (POST / REEL by file).
  const placement = material.mode === 'managed' ? material.variant : null;

  // The ORDERED file set. MANAGED: the one design slot the destination names.
  // LEGACY: asset_ids (carousel) or the single asset_id off the row.
  const setIds = Array.isArray(pub.asset_ids)
    ? (pub.asset_ids as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
    : [];
  const effectiveIds = slotIds
    ?? (setIds.length > 0 ? setIds : [str(pub.asset_id) ?? ''].filter(Boolean));
  if (effectiveIds.length === 0) {
    return fail(400, 'This publication has no approved file to post.');
  }
  // MANAGED: the approved writing — '' for a story, which carries no text.
  // LEGACY: whatever the row holds, exactly as before.
  const caption = approvedCaption ?? (typeof pub.caption === 'string' ? pub.caption : '');
  // The caption goes out exactly as approved. (Until 2026-09-22 the content's
  // hashtags were appended here; hashtags were removed altogether.)
  const finalCaption = caption;

  // Resolve every approved asset, PRESERVING the carousel order (the
  // .in() result order is arbitrary — re-order by effectiveIds).
  const assetRes = await sb.from('mos_assets')
    .select('id, url, file_id, mime_type, kind, size_bytes, duration_seconds, aspect_ratio')
    .in('id', effectiveIds);
  if (assetRes.error) {
    console.error('[publishRelease] db error', assetRes.error.code, assetRes.error.message);
    return fail(500, assetRes.error.message);
  }
  const byId = new Map(((assetRes.data ?? []) as AssetRow[]).map((a) => [a.id, a]));
  const assets = effectiveIds.map((aid) => byId.get(aid)).filter((a): a is AssetRow => Boolean(a));
  if (assets.length !== effectiveIds.length) {
    if (managed) {
      // §3.4.5 exactly: the slot still names a file, and the file is gone.
      // Nothing is picked on this path, so "re-pick the files" is the wrong
      // instruction — the fix is a re-upload into the same slot.
      const ar = 'التصميم المرتبط بهذه الوجهة لم يعد موجودًا — أعد رفعه من تبويب المواد ثم أعد المحاولة.';
      await openReleaseRefusalTask(sb, pubId, RELEASE_REFUSAL.MATERIAL_UNRESOLVED, ar);
      return fail(422, `${ar} / The design this destination points at no longer exists`
        + ' — re-upload it on the Materials tab, then retry.');
    }
    return fail(404, 'An approved file on this publication no longer exists — re-pick the files.');
  }

  for (const a of assets) {
    const k = (a.kind ?? 'photo');
    if (!platformAcceptsKind(platform, k)) {
      return fail(400, `${platform} cannot take a ${k} file.`);
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
  // A stored image goes out as a ≤1080 px copy (see resolveUrl), so the rules
  // judge that copy, not the designer's master.
  const flight = preflightPublishSet(
    platform,
    assets.map((a) => ({ ...a, rendered: isRenderableImage(a) })),
    finalCaption,
    { captionRequired, placement },
  );
  const blockers = flight.issues.filter((i) => i.level === 'block');
  if (blockers.length > 0) {
    const detail = blockers.map((b) => `${b.ar} / ${b.en}`).join('  •  ');
    if (managed) {
      // Same single exception mechanism as every other managed refusal —
      // `preflight_blocked` is a reason code the RPC already knows.
      await openReleaseRefusalTask(sb, pubId, RELEASE_REFUSAL.PREFLIGHT_BLOCKED,
        blockers.map((b) => b.ar).join('  •  '));
    }
    return fail(422, detail);
  }

  // Resolve each file to a URL bundle can fetch (public legacy URL
  // verbatim, or a 1h signed URL — bundle fetches server-side right after
  // handoff, but its fetch can queue; 300s left no slack).
  //
  // A stored image is signed as a RESIZED copy (2026-09-29): the designers'
  // masters are 3375 px and up to 18 MB, and bundle.social refuses an
  // Instagram image wider than 1920 px («Instagram Post image width must be at
  // most 1920» — measured on the 24 Sep يمام بارك 14 posts). Supabase resizes
  // on the fly inside RENDITION_BOX, keeping the aspect and the format; the
  // approved file itself is never changed, so the approval hashes still hold.
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
      .createSignedUrl(file.storage_path, 3600, isRenderableImage(a)
        ? {
          transform: {
            width: RENDITION_BOX.width, height: RENDITION_BOX.height,
            resize: 'contain', quality: 90, format: 'origin',
          },
        }
        : undefined);
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
    return fail(500, `Could not resolve the approved files: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A human-readable title on bundle's side — ref + title, or a fallback.
  const cRes = await sb.from('mos_content_v')
    .select('ref, title').eq('id', contentId).maybeSingle();
  const cRow = cRes.data as { ref: string | null; title: string | null } | null;
  const title = [cRow?.ref, cRow?.title].filter(Boolean).join(' ').trim() || 'Wassel';

  return {
    ok: true,
    value: {
      pubId, pub, contentId, platform, placement, effectiveIds, assets, fileUrls,
      finalCaption, title, retrying, priorPostId, priorBundle,
    },
  };
}

/** Upload the files and create the scheduled post on bundle.social. Throws. */
async function createBundlePost(
  cfg: BundleConfig, p: PreparedHandoff, postDate: string,
): Promise<BundlePost> {
  // Retry path: clear the dead attempt on bundle's side first so the
  // dashboard doesn't accumulate ERROR corpses. Best-effort — a failed
  // delete of an already-dead post must not block the retry (logged).
  if (p.retrying && p.priorPostId && p.priorBundle === 'ERROR') {
    try {
      await deletePost(cfg, p.priorPostId);
    } catch (e) {
      console.error('[marketing-os] cleanup of errored bundle post failed (continuing)', p.priorPostId, e);
    }
  }
  // Upload every file (bundle fetches each by URL), keeping order.
  const ups = await Promise.all(p.fileUrls.map((u) => uploadFromUrl(cfg, u)));
  const uploads = ups.map((up, i) => ({
    id: up.id,
    kind: (p.assets[i]?.kind ?? 'photo') as 'photo' | 'video' | 'design' | 'audio' | 'document',
  }));
  const built = buildPlatformData(p.platform, { text: p.finalCaption, uploads, placement: p.placement });
  if (!built) throw new UnsupportedPayloadError(`${p.platform} is not supported for auto-posting.`);
  return createPost(cfg, {
    title: p.title,
    status: 'SCHEDULED',
    socialAccountTypes: [built.socialAccountType],
    postDate,
    data: built.data,
  });
}

/** Record a handoff on the publication row. Returns an error message, or null. */
async function recordHandoff(
  sb: SupabaseClient, p: PreparedHandoff, post: BundlePost, postDate: string,
): Promise<string | null> {
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
    // the compensating delete covers it: either the row records the post or the
    // post is rolled back. On the legacy path these are the values that were
    // already there, so the write is a no-op by construction.
    asset_ids: p.effectiveIds,
    asset_id: p.effectiveIds[0] ?? null,
  };
  // `file_id` is the pre-assets fallback the Publish tab still uses to find a
  // row's file. Filled when the posted asset has one, NEVER cleared: a legacy
  // link-only asset carries no file_id, and nulling it would break that
  // fallback on rows that depend on it.
  if (p.assets[0]?.file_id) patch.file_id = p.assets[0].file_id;
  // The caption is written back under the database's own rule.
  // `mos_tg_publication_caption_guard` raises `insufficient_privilege` when a
  // BROWSER session changes `caption` on a row whose stored status is already
  // `published` — "a published post is never rewritten". Reachable here: a
  // release marked published by hand carries no `bundle_post_id`, so the
  // idempotency guard lets it through, and the exception would land AFTER the
  // live post exists — triggering the compensating delete and failing a
  // publish that actually worked. Honour the rule instead.
  if (String(p.pub.status ?? '') !== 'published') patch.caption = p.finalCaption;
  const upd = await sb.from('mos_publications').update(patch).eq('id', p.pubId).select('id').maybeSingle();
  if (upd.error) return upd.error.message;
  if (!upd.data) return 'the publication row was not updated';
  return null;
}

/** Design reads on publish (creative director) — best-effort, never fails a publish. */
async function runReadsHook(pubId: string): Promise<void> {
  // Verifies the published assets exist as collected internal-org media
  // for the design-read sweep; failure here must never fail the publish.
  try {
    const readsSvc = makeServiceClient('api:marketing-os:creative');
    if (readsSvc) await enqueueWasselReadsOnPublish(readsSvc, pubId);
  } catch (e) {
    console.error('[marketing-os] reads-on-publish hook failed (non-fatal)', pubId, e);
  }
}

/** The refreshed publications of these content items — what every caller merges. */
async function listResponse(
  sb: SupabaseClient, contentIds: string[], extra: Record<string, unknown> = {},
): Promise<Response> {
  const list = await sb.from('mos_publication_v').select('*').in('content_id', contentIds)
    .order('scheduled_at', { ascending: true, nullsFirst: false });
  if (list.error) {
    console.error('[publishRelease] db error', list.error.code, list.error.message);
    return jsonError(500, list.error.message);
  }
  return json({ ok: true, publications: list.data ?? [], ...extra }, 200);
}

/* ------------------------------------------------------------------ */
/* one release (stories, TikTok, Snapchat)                              */
/* ------------------------------------------------------------------ */

async function handOffOne(sb: SupabaseClient, cfg: BundleConfig, p: PreparedHandoff): Promise<Response> {
  // Schedule at the slot when it is safely in the future; otherwise post
  // ~now (bundle needs a valid future-ish postDate — a minute's lead).
  // The slot is `due_at` — COALESCE(scheduled_at, planned_at). Reading only
  // `scheduled_at` (until 2026-09-30) missed every release the month plan made:
  // those carry `planned_at` alone, so the sweep — which picks a release up to
  // 15 minutes ahead — would have posted each one "now", up to 14 minutes early.
  const postDate = resolvePostDate(p.pub.due_at ?? p.pub.scheduled_at, Date.now());

  let post: BundlePost;
  try {
    post = await createBundlePost(cfg, p, postDate);
  } catch (e) {
    if (e instanceof UnsupportedPayloadError) return jsonError(400, e.message);
    // Fail loudly — the platform's own message reaches the user, never swallowed.
    const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
    console.error('[marketing-os] bundle.social publish failed', e);
    return jsonError(502, `bundle.social: ${msg}`);
  }

  const failed = await recordHandoff(sb, p, post, postDate);
  if (failed !== null) {
    // The live post now exists but our row doesn't know its id — that is
    // an ORPHAN live post (and a future duplicate when the user retries).
    // Compensate: delete the just-created bundle post, then fail honestly.
    try {
      await deletePost(cfg, post.id);
      console.error('[marketing-os] publish DB write failed — bundle post rolled back', p.pubId, post.id, failed);
      return jsonError(500, 'Saving the publish result failed — the post was rolled back. Try again.');
    } catch (delErr) {
      // Rollback itself failed: the post IS live but untracked. Say so
      // loudly instead of pretending — the id is in the message + logs.
      console.error('[marketing-os] publish DB write failed AND rollback failed — orphan live post', p.pubId, post.id, delErr);
      return jsonError(500,
        `Saving failed and rollback failed — a live post may exist untracked on bundle.social (post ${post.id}). Do not re-publish; report this.`);
    }
  }

  await runReadsHook(p.pubId);
  return listResponse(sb, [p.contentId]);
}

/* ------------------------------------------------------------------ */
/* an Instagram grid release — the whole row, or nothing (2026-10-01)   */
/* ------------------------------------------------------------------ */

const ARABIC = /[؀-ۿ]/;
/** The Arabic half of an "ar / en" message (or the whole message when it has none). */
const arabicPart = (msg: string): string =>
  (msg.split(' / ').find((s) => ARABIC.test(s)) ?? msg).trim().slice(0, 160);
/** The English half of an "ar / en" message (or the whole message when it has none). */
const englishPart = (msg: string): string =>
  (msg.split(' / ').find((s) => !ARABIC.test(s)) ?? msg).trim().slice(0, 200);

interface GridRow {
  rowId: string | null;
  releases: GridRelease[];
  memberContentIds: string[];
}

/** The content's row and the Instagram grid release of every member. */
async function loadGridRow(sb: SupabaseClient, contentId: string): Promise<{ ok: true; row: GridRow } | Failure> {
  const c = await sb.from('mos_content').select('row_id').eq('id', contentId).maybeSingle();
  if (c.error) return fail(500, `Could not read the content's row: ${c.error.message}`);
  const rowId = str((c.data as { row_id?: unknown } | null)?.row_id);
  if (!rowId) return { ok: true, row: { rowId: null, releases: [], memberContentIds: [contentId] } };

  const m = await sb.from('mos_content').select('id, ref, row_order').eq('row_id', rowId);
  if (m.error) return fail(500, `Could not read the row's posts: ${m.error.message}`);
  const members = (m.data ?? []) as Array<{ id: string; ref: string | null; row_order: number | null }>;
  const memberIds = members.map((x) => x.id);

  const r = await sb.from('mos_publications')
    .select('id, content_id, status, bundle_post_id, bundle_status, scheduled_at, planned_at, placement_variant')
    .in('content_id', memberIds).eq('platform', 'instagram');
  if (r.error) return fail(500, `Could not read the row's Instagram releases: ${r.error.message}`);
  const byContent = new Map(members.map((x) => [x.id, x]));
  type RelRow = {
    id: string; content_id: string; status: string; bundle_post_id: string | null;
    bundle_status: string | null; scheduled_at: string | null; planned_at: string | null;
    placement_variant: string | null;
  };
  const releases: GridRelease[] = ((r.data ?? []) as RelRow[])
    // Rows are the month plan's, and every month-plan release is managed, so
    // its variant is the surface it actually posts to.
    .filter((x) => landsOnInstagramGrid('instagram', x.placement_variant))
    .map((x) => ({
      releaseId: x.id,
      contentId: x.content_id,
      ref: byContent.get(x.content_id)?.ref ?? null,
      rowOrder: byContent.get(x.content_id)?.row_order ?? null,
      status: x.status,
      bundlePostId: x.bundle_post_id,
      bundleStatus: x.bundle_status,
      dueAt: x.scheduled_at ?? x.planned_at ?? null,
    }));
  return { ok: true, row: { rowId, releases, memberContentIds: memberIds } };
}

/** Delete scheduled bundle posts and confirm each is gone. Returns the ids still live. */
async function takeBackPosts(cfg: BundleConfig, postIds: string[]): Promise<string[]> {
  const stillLive: string[] = [];
  for (const id of postIds) {
    try {
      await deletePost(cfg, id);
    } catch (e) {
      // Not trusted either way — the read below decides.
      console.error('[publishRelease] taking back a scheduled post: delete call failed', id, e);
    }
    try {
      const post = await getPost(cfg, id);
      // bundle answers a deleted post with 200 + status DELETED, not a 404.
      if (String(post.status).toUpperCase() !== 'DELETED') stillLive.push(id);
    } catch (e) {
      if (e instanceof BundleApiError && e.httpStatus === 404) continue;
      console.error('[publishRelease] could not confirm a taken-back post is gone', id, e);
      stillLive.push(id);
    }
  }
  return stillLive;
}

/** Put publication rows back as they were before a handoff that was taken back. */
async function restoreRows(sb: SupabaseClient, items: PreparedHandoff[]): Promise<string[]> {
  const unrestored: string[] = [];
  for (const p of items) {
    const upd = await sb.from('mos_publications').update({
      status: p.pub.status,
      scheduled_at: p.pub.scheduled_at ?? null,
      external_id: p.pub.external_id ?? null,
      bundle_post_id: p.pub.bundle_post_id ?? null,
      bundle_status: p.pub.bundle_status ?? null,
      bundle_error: p.pub.bundle_error ?? null,
      bundle_synced_at: p.pub.bundle_synced_at ?? null,
    }).eq('id', p.pubId).select('id').maybeSingle();
    if (upd.error || !upd.data) {
      console.error('[publishRelease] could not restore a publication after a taken-back row', p.pubId, upd.error);
      unrestored.push(p.pubId);
    }
  }
  return unrestored;
}

async function publishInstagramRow(
  sb: SupabaseClient, cfg: BundleConfig, first: PreparedHandoff,
): Promise<Response> {
  const loaded = await loadGridRow(sb, first.contentId);
  if (!loaded.ok) return jsonError(loaded.status, loaded.error);
  const { row } = loaded;
  const verdict = judgeRow(row.rowId, row.releases);
  const liveIds = row.releases.filter((r) => r.status !== 'cancelled').map((r) => r.releaseId);
  const rowInfo = (toSend: string[], extra: Record<string, unknown> = {}) => ({
    id: row.rowId,
    // Every grid post of the row: the sweep skips these for the rest of its tick.
    release_ids: liveIds.includes(first.pubId) ? liveIds : [...liveIds, first.pubId],
    to_send: toSend,
    ...extra,
  });

  if (verdict.kind === 'not_in_row') {
    await openReleaseRefusalTask(sb, first.pubId, RELEASE_REFUSAL.ROW_INCOMPLETE, NOT_IN_ROW.ar);
    return json({ error: `${NOT_IN_ROW.ar} / ${NOT_IN_ROW.en}`, row: rowInfo([first.pubId]) }, 422);
  }
  if (verdict.kind === 'malformed') {
    const unsent = verdict.live.filter((r) => !isAlreadyOut(r)).map((r) => r.releaseId);
    if (!unsent.includes(first.pubId)) unsent.push(first.pubId);
    for (const id of unsent) await openReleaseRefusalTask(sb, id, RELEASE_REFUSAL.ROW_INCOMPLETE, verdict.ar);
    return json({ error: `${verdict.ar} / ${verdict.en}`, row: rowInfo(unsent) }, 422);
  }
  if (verdict.kind === 'complete' || !verdict.toSend.some((r) => r.releaseId === first.pubId)) {
    // Unreachable through the idempotency guard (an out release answers 409
    // before this), kept so a cancelled release can never pull its row out.
    return json({
      error: 'This post is not one of its row\'s feed posts still to send — refresh its status.',
      row: rowInfo([]),
    }, 409);
  }

  const toSendIds = verdict.toSend.map((r) => r.releaseId);

  // ── 1. the row posts as one burst, or waits ───────────────────────────────
  const timing = rowTiming(verdict.toSend, Date.now());
  if (!timing.ok) {
    for (const id of toSendIds) await openReleaseRefusalTask(sb, id, RELEASE_REFUSAL.ROW_INCOMPLETE, timing.ar);
    return json({ error: `${timing.ar} / ${timing.en}`, row: rowInfo(toSendIds) }, 422);
  }

  // ── 2. every post still to send must be ready NOW — or none goes ─────────
  // Each one runs the full single-release check (material rule, approval,
  // rulebook, files). A refusal records its own reason on that post; the
  // ready ones are held as waiting for the row, naming what they wait for.
  const prepared = new Map<string, PreparedHandoff>([[first.pubId, first]]);
  const blocked: Array<{ ref: string | null; status: number; error: string }> = [];
  for (const r of verdict.toSend) {
    if (prepared.has(r.releaseId)) continue;
    const pubLoaded = await loadPublication(sb, r.releaseId);
    const prep = pubLoaded.ok ? await prepareHandoff(sb, pubLoaded.pub) : pubLoaded;
    if (prep.ok) prepared.set(r.releaseId, prep.value);
    else blocked.push({ ref: r.ref, status: prep.status, error: prep.error });
  }
  if (blocked.length > 0) {
    const ar = `ينتظر اكتمال الصف — ${blocked.map((b) => `${b.ref ?? '؟'}: ${arabicPart(b.error)}`).join(' • ')}`;
    const en = `The row is not complete — ${blocked.map((b) => `${b.ref ?? '?'}: ${englishPart(b.error).replace(/[.\s]+$/, '')}`).join(' • ')}.`
      + ' Instagram feed posts go out as a whole row or not at all.';
    for (const id of prepared.keys()) await openReleaseRefusalTask(sb, id, RELEASE_REFUSAL.ROW_INCOMPLETE, ar);
    // A refusal (422) costs nothing and clears itself on approval; anything
    // else (a file that cannot be signed, a read that failed) is a failure.
    const status = blocked.find((b) => b.status !== 422)?.status ?? 422;
    return json({ error: `${ar} / ${en}`, row: rowInfo(toSendIds) }, status);
  }

  // ── 3. hand the whole row to bundle.social; take it all back on a failure ─
  const items = verdict.toSend.map((r) => ({
    item: prepared.get(r.releaseId) as PreparedHandoff,
    postDate: timing.dates.get(r.releaseId) as string,
  }));
  const result = await handOffRow(items, {
    create: (p, postDate) => createBundlePost(cfg, p, postDate),
    record: (p, post, postDate) => recordHandoff(sb, p, post, postDate),
    takeBack: (ids) => takeBackPosts(cfg, ids),
    restore: (ps) => restoreRows(sb, ps),
  });
  if (!result.ok) {
    const at = verdict.toSend[result.failedAt]?.ref ?? '?';
    console.error('[publishRelease] Instagram row handoff failed', row.rowId, result.stage, at, result.message,
      'still live:', result.leftLive, 'unrestored:', result.unrestored);
    if (result.leftLive.length > 0 || result.unrestored.length > 0) {
      // The one outcome that can still put a partial row on the grid: say
      // exactly what is left, so a person removes it before it posts.
      return json({
        error: `bundle.social: ${result.message} (${at}) — and taking the row back did not finish.`
          + (result.leftLive.length > 0
            ? ` Scheduled posts still live on bundle.social: ${result.leftLive.join(', ')} — delete them there before they post.`
            : '')
          + (result.unrestored.length > 0
            ? ` Publications not restored: ${result.unrestored.join(', ')}.`
            : ''),
        row: rowInfo(toSendIds),
      }, 500);
    }
    if (result.stage === 'create') {
      return json({
        error: `bundle.social: ${result.message} (${at}) — nothing from this row was left scheduled; the whole row will be tried again.`,
        row: rowInfo(toSendIds),
      }, 502);
    }
    return json({
      error: `Saving the row's handoff failed (${at}): ${result.message} — every post of the row was taken back. Try again.`,
      row: rowInfo(toSendIds),
    }, 500);
  }

  for (const id of toSendIds) await runReadsHook(id);
  return listResponse(sb, row.memberContentIds, { row: rowInfo(toSendIds, { handed_off: toSendIds }) });
}

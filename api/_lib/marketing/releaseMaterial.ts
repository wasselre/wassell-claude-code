/**
 * THE MATERIAL RULE — what a release posts, and where it comes from.
 * ============================================================================
 * Settled 2026-09-14 (`docs/plans/monthly-operating-model.md` §3.4) and built
 * here on 2026-09-15 as Group D of the monthly operating model.
 *
 * The rule in one line: **the destination decides the file, the approved
 * writing decides the caption, and nobody picks either by hand.**
 *
 *   • A feed post takes the square design (`final_square`) and the caption.
 *   • A story takes the vertical design (`final_vertical`) and NO caption —
 *     the copy lives on the design (`platformRules.ts` line ~344 already says
 *     so for Instagram stories).
 *   • Resolution happens AT PUBLISH, because the design does not exist when
 *     the month is compiled.
 *   • What was resolved is checked against what the final approval BOUND. If
 *     the files or the caption moved since, the release becomes visible work
 *     instead of posting something nobody approved.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 * `publishRelease.ts` read `mos_publication_v`, whose caption is a bare
 * `p.caption` with no fallback, and whose files are `asset_ids` — filled ONLY
 * by the Publish tab's file picker. `mos_release_v` has the
 * `COALESCE(NULLIF(p.caption,''), c.data->>'caption')` fallback, but the
 * publish path used the view WITHOUT it. So the publish path could post a
 * hand-picked file with an empty caption and call it done.
 *
 * ── The cutover boundary (build plan D1/D6b, both settled) ─────────────────
 * The new gates apply to content pinned AFTER the cutover **only**. The 24
 * existing content records finish on their old pinned workflow version: 9 of
 * the 17 ad-bearing rows have no design slots at all, the missing verticals do
 * not exist as files, and 0 of 24 carry a caption. Pushing them through this
 * resolver would refuse every one of them.
 *
 * The boundary is named, not dated: a content record is managed by this rule
 * when the workflow version it is PINNED to declares
 * `definition.metadata.material_rule = 'by_destination'`. Anything else — an
 * older version, no version, a version from another workflow — takes the
 * legacy path verbatim. That is the same mechanism the release split shipped
 * on (`workflow_advance_role_path` reads its steps off the pinned version), and
 * it is why a single cutover is safe: in-flight work keeps walking its old
 * chain while new work walks the new one.
 *
 * This also closes D6b. `publishRelease` has TWO callers — the sweep, and the
 * endpoint when a PERSON presses publish. The sweep is structurally blind to
 * the 10 pre-cutover drafts (`mos_release_due` filters `due_at IS NOT NULL`,
 * and all ten have NULL `scheduled_at` AND NULL `planned_at`), but the endpoint
 * is not: it never consults `due_at`. Keying on the pin rather than on the
 * caller means a person pressing publish on a pre-cutover draft gets exactly
 * today's behaviour, not a refusal for slots that were never going to exist.
 *
 * ── The hash check (D2, settled) ───────────────────────────────────────────
 * `mos_content_approvals` has **0 rows live**. A check written as "no matching
 * approval → refuse" would block 100% of publishing on day one. So the rule is
 * "an approval EXISTS **and** its hash differs → refuse"; an absent approval
 * falls through and the release resolves normally. The only reader in the repo
 * before this (`worker/src/runMetaAdJob.ts`) selected `caption_hash` and threw
 * it away — an existence check dressed as a hash check.
 *
 * Both hashes are computed by the DATABASE, never re-implemented here:
 * `mos_caption_hash` is `md5(btrim(text))` and Postgres `btrim/1` strips
 * SPACES ONLY, where JS `.trim()` strips every whitespace character. A JS
 * re-implementation would silently disagree on any caption ending in a
 * newline — the exact trim-parity divergence that broke `record_twin_fill` on
 * 2026-08-05. One implementation, called over RPC.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Feed (square, caption) vs story (vertical, no caption). Mirrors `mos_publications.placement_variant`. */
export type PlacementVariant = 'feed' | 'story';

/**
 * The marker a workflow version sets to opt its content into this rule.
 * Lives at `workflow_versions.definition.metadata.material_rule`, beside the
 * `key` / `managed_by` keys already there. Absent = pre-cutover = legacy.
 */
export const MANAGED_MATERIAL_RULE = 'by_destination';

/** Destination → the design slot that serves it. The whole rule, as data. */
export const SLOT_BY_VARIANT: Readonly<Record<PlacementVariant, string>> = {
  feed: 'final_square',
  story: 'final_vertical',
};

/**
 * Reason codes for `mos_release_open_task`. The first two are NEW (D3); the
 * third already exists in the function's own Arabic CASE. Every refusal in the
 * managed path is routed through that one function — it takes a reason plus an
 * Arabic detail and de-duplicates per release, so the sweep's generic
 * `publish_failed` lands on an already-open task and changes nothing.
 * No second exception mechanism.
 */
export const RELEASE_REFUSAL = {
  /** A destination has no design in its slot, or the slot's file is gone. */
  MATERIAL_UNRESOLVED: 'material_unresolved',
  /** An approval exists and the files or caption no longer hash to what it bound. */
  APPROVAL_MISMATCH: 'approval_mismatch',
  /** The platform's own rulebook refused the resolved set (existing code). */
  PREFLIGHT_BLOCKED: 'preflight_blocked',
} as const;

export type ReleaseRefusalReason = typeof RELEASE_REFUSAL[keyof typeof RELEASE_REFUSAL];

/** Content-level copy every path needs (hashtags are folded in at publish). */
export interface ContentCopy {
  caption: string;
  hashtags: string | null;
}

export type ReleaseMaterial =
  /** Pre-cutover pin: the caller keeps today's behaviour, verbatim. */
  | { mode: 'legacy'; copy: ContentCopy }
  /** Post-cutover pin, resolved. `assetIds` is ordered; `caption` is '' for a story. */
  | {
      mode: 'managed';
      variant: PlacementVariant;
      assetIds: string[];
      caption: string;
      hashtags: string | null;
      /** True when this destination MUST carry text (feed). False for a story. */
      captionRequired: boolean;
    }
  /** Refused by the rule — the caller opens the task and returns 422. */
  | { mode: 'refuse'; reason: ReleaseRefusalReason; ar: string; en: string }
  /** A read failed. NEVER downgraded to 'legacy' — that would silently
   *  un-gate publishing the moment a permission or a network call slipped. */
  | { mode: 'error'; message: string };

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNonEmpty = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

interface StepDef { key?: unknown; auto_meta_ad?: unknown }
interface VersionDefinition { metadata?: { material_rule?: unknown; steps?: unknown } }

/** The step keys that ARE the final approval on this pinned version. */
function finalStepKeys(def: VersionDefinition | null): string[] {
  const steps = def?.metadata?.steps;
  const keys: string[] = [];
  if (Array.isArray(steps)) {
    for (const s of steps as StepDef[]) {
      if (s && s.auto_meta_ad === true && typeof s.key === 'string') keys.push(s.key);
    }
  }
  // Same fallback the Meta worker uses for legacy / hand-made chains: the two
  // step keys that are the final manager approval.
  return keys.length > 0 ? keys : ['design_review', 'final_review'];
}

/**
 * Resolve what ONE publication should post.
 *
 * `sb` is whichever client the caller holds — service-role for the sweep, the
 * user's JWT for the endpoint. Every table it touches is readable by both
 * (`workflow_versions` is `USING (true)`; `mos_content_approvals` and
 * `mos_asset_links` are `wassell_mos_can('read')`, which anyone able to press
 * publish already holds).
 */
export async function resolveReleaseMaterial(
  sb: SupabaseClient, publicationId: string, contentId: string,
): Promise<ReleaseMaterial> {
  // `mos_publication_v` does not carry placement_variant (it predates the
  // feed/story split), and widening it belongs to the view's owner — so read
  // the two columns straight off the table.
  const pubRes = await sb.from('mos_publications')
    .select('placement_variant').eq('id', publicationId).maybeSingle();
  if (pubRes.error) return { mode: 'error', message: `publication: ${pubRes.error.message}` };
  const rawVariant = asNonEmpty((pubRes.data as { placement_variant?: unknown } | null)?.placement_variant);

  const cRes = await sb.from('mos_content')
    .select('data, workflow_version_id').eq('id', contentId).maybeSingle();
  if (cRes.error) return { mode: 'error', message: `content: ${cRes.error.message}` };
  const cRow = cRes.data as { data?: Record<string, unknown> | null; workflow_version_id?: unknown } | null;
  const data = (cRow?.data ?? {}) as Record<string, unknown>;
  const copy: ContentCopy = { caption: asString(data.caption), hashtags: asNonEmpty(data.hashtags) };

  const versionId = asNonEmpty(cRow?.workflow_version_id);
  if (!versionId) return { mode: 'legacy', copy };

  const vRes = await sb.from('workflow_versions')
    .select('definition').eq('id', versionId).maybeSingle();
  if (vRes.error) return { mode: 'error', message: `workflow version: ${vRes.error.message}` };
  const def = (vRes.data as { definition?: VersionDefinition } | null)?.definition ?? null;
  if (asNonEmpty(def?.metadata?.material_rule) !== MANAGED_MATERIAL_RULE) {
    // Pinned before the cutover. D1/D6b: it finishes on its old rulebook.
    return { mode: 'legacy', copy };
  }

  /* ── from here down the content is MANAGED by the material rule ────────── */

  if (rawVariant !== 'feed' && rawVariant !== 'story') {
    // The month compiler stamps a variant on every organic release it makes
    // (feed + story, paired). A managed publication without one has no
    // destination, so there is nothing to resolve BY. Guessing is how a 9:16
    // design ended up in the Instagram feed and the buyer had to undo it by
    // hand — refuse loudly instead.
    return {
      mode: 'refuse', reason: RELEASE_REFUSAL.MATERIAL_UNRESOLVED,
      ar: 'هذا النشر بلا وجهة محددة (فيد أو ستوري) فلا يمكن تحديد التصميم المطلوب — أعد توليد جدول الشهر أو انشره يدويًا.',
      en: 'This release has no placement (feed or story), so its design slot cannot be chosen — recompile the month or publish it by hand.',
    };
  }
  const variant: PlacementVariant = rawVariant;
  const role = SLOT_BY_VARIANT[variant];

  // ── the files: ONE slot, by destination, current version only ───────────
  const linkRes = await sb.from('mos_asset_links')
    .select('asset_id, role')
    .eq('content_id', contentId).eq('role', role).is('superseded_at', null);
  if (linkRes.error) return { mode: 'error', message: `asset links: ${linkRes.error.message}` };
  const assetIds = ((linkRes.data ?? []) as Array<{ asset_id: unknown }>)
    .map((l) => asNonEmpty(l.asset_id)).filter((x): x is string => x !== null);
  if (assetIds.length === 0) {
    const ar = variant === 'feed'
      ? 'ينقص التصميم المربّع (١:١ للفيد) — ارفعه من تبويب المواد ثم أعد المحاولة.'
      : 'ينقص التصميم الطولي (٩:١٦ للستوري) — ارفعه من تبويب المواد ثم أعد المحاولة.';
    const en = variant === 'feed'
      ? 'The square 1:1 (feed) design is missing — upload it on the Materials tab, then retry.'
      : 'The vertical 9:16 (story) design is missing — upload it on the Materials tab, then retry.';
    return { mode: 'refuse', reason: RELEASE_REFUSAL.MATERIAL_UNRESOLVED, ar, en };
  }

  // ── the caption: the approved writing, never a picker. Stories get none ──
  const caption = variant === 'feed' ? copy.caption : '';
  const hashtags = variant === 'feed' ? copy.hashtags : null;

  // ── the hash check: post what was APPROVED, or nothing ──────────────────
  const approvalRes = await sb.from('mos_content_approvals')
    .select('step_key, approved_at, design_hash, caption_hash')
    .eq('content_id', contentId).in('step_key', finalStepKeys(def))
    .order('approved_at', { ascending: false }).limit(1).maybeSingle();
  if (approvalRes.error) {
    return { mode: 'error', message: `approval: ${approvalRes.error.message}` };
  }
  const approval = approvalRes.data as
    { step_key: string; approved_at: string | null; design_hash: string | null; caption_hash: string | null } | null;

  if (approval) {
    const liveDesign = await sb.rpc('mos_content_design_hash', { p_content_id: contentId });
    if (liveDesign.error) return { mode: 'error', message: `design hash: ${liveDesign.error.message}` };
    const liveCaption = await sb.rpc('mos_caption_hash', { p_text: copy.caption });
    if (liveCaption.error) return { mode: 'error', message: `caption hash: ${liveCaption.error.message}` };

    const designNow = asNonEmpty(liveDesign.data);
    const captionNow = asNonEmpty(liveCaption.data);
    const designWas = asNonEmpty(approval.design_hash);
    const captionWas = asNonEmpty(approval.caption_hash);

    const designMoved = designNow !== designWas;
    // The caption hash is content-level and the approval bound the whole
    // package, so a caption edited after approval un-approves BOTH halves of
    // the feed/story pair — not just the half that carries text. A pair that
    // goes out half-approved is worse than one that waits.
    const captionMoved = captionNow !== captionWas;
    if (designMoved || captionMoved) {
      const whatAr = [designMoved ? 'التصميم' : null, captionMoved ? 'الكابشن' : null]
        .filter(Boolean).join(' و');
      const whatEn = [designMoved ? 'the design' : null, captionMoved ? 'the caption' : null]
        .filter(Boolean).join(' and ');
      return {
        mode: 'refuse', reason: RELEASE_REFUSAL.APPROVAL_MISMATCH,
        ar: `تغيّر ${whatAr} بعد الاعتماد — لن يُنشر شيء غير معتمد. أعد الاعتماد ثم أعد المحاولة.`,
        en: `${whatEn} changed after it was approved — nothing unapproved is posted. Re-approve, then retry.`,
      };
    }
  }
  // No approval row at all: fall through and resolve. `mos_content_approvals`
  // is empty in production, so refusing here would block every publish on day
  // one (build plan §3, settled as D3).

  return {
    mode: 'managed', variant, assetIds, caption, hashtags,
    captionRequired: variant === 'feed',
  };
}

/**
 * Open the ONE publication task a refusal produces.
 *
 * `mos_release_open_task` already de-duplicates per release and already takes
 * a free-text Arabic detail that overrides its own CASE, so a new reason code
 * needs no migration: the code lands in `mos_manual_tasks.action` and the
 * detail is the sentence the person reads. Failure to open the task is logged
 * loudly and never swallowed — but it must not mask the refusal itself, which
 * is the thing the caller has to report.
 */
export async function openReleaseRefusalTask(
  sb: SupabaseClient, publicationId: string, reason: ReleaseRefusalReason, detailAr: string,
): Promise<void> {
  const opened = await sb.rpc('mos_release_open_task', {
    p_publication_id: publicationId,
    p_reason: reason,
    p_detail: detailAr.slice(0, 400),
  });
  if (opened.error) {
    console.error('[releaseMaterial] could not open the refusal task',
      publicationId, reason, opened.error.code, opened.error.message);
  }
}

// ============================================================================
// Per-platform publishing requirements — the pre-flight rulebook for organic
// posting through bundle.social (Instagram / TikTok / Snapchat).
// ----------------------------------------------------------------------------
// PURE module: no supabase, no import.meta.env, no react. It is imported by
// BOTH the SPA (the pre-flight checklist on the Publish tab) and
// api/marketing-os.ts (the authoritative server-side gate) — the same blessed
// src↔api cross-import pattern as src/lib/geo/localizedName.ts. Keep it
// dependency-free or the server build breaks.
//
// Numbers come from bundle.social's "Platform Limits" doc (scraped 2026-08-19,
// mirrored at C:/Users/rayan/Claude/bundlsocial — "Platform Limits" page).
// bundle enforces ALL of these at post time and rejects with an English 400;
// this module pre-checks the subset we can know from mos_assets metadata
// (kind, mime_type, size_bytes, duration_seconds) so a doomed publish is
// stopped BEFORE upload with a bilingual, actionable message.
//
// Honesty rule: metadata we don't have (e.g. a legacy link-only asset with no
// size) produces a WARNING ("we could not verify X — the platform will check
// it"), never a silent pass claim and never a false block.
// ============================================================================

/** The slice of an asset the rules need. Subset of MosAsset / mos_assets row. */
export interface PublishAssetMeta {
  kind: string; // photo | video | design | audio | document
  mime_type?: string | null;
  size_bytes?: number | null;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
}

export interface RuleIssue {
  /** block = the platform WILL reject this; warn = could not verify / risky. */
  level: 'block' | 'warn';
  ar: string;
  en: string;
}

export interface PreflightResult {
  /** True when there are no blockers (warnings may still be present). */
  ok: boolean;
  /** Blockers first, then warnings. */
  issues: RuleIssue[];
  /** The platform's caption ceiling (for live counters). */
  captionMax: number;
}

/** Caption ceilings per platform (bundle "Text & Character Limits" table).
 *  Instagram is 2,000 (not the folkloric 2,200); Snapchat is a brutal 160. */
export const CAPTION_MAX: Record<string, number> = {
  instagram: 2000,
  tiktok: 2200,
  snapchat: 160,
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** bundle's /upload/from-url fetch ceiling — applies before any platform rule. */
const FROM_URL_MAX_BYTES = 1 * GB;

/** A video-ish asset the pipeline posts as video (matches buildPlatformData). */
export function isVideoKind(kind: string): boolean {
  return kind === 'video' || kind === 'audio';
}

const fmtDur = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
};
const fmtMB = (b: number): string => `${Math.round(b / MB)}MB`;

/**
 * Single-file pre-flight — delegates to the set engine. Kept as the stable
 * entry point for callers that model one file per publication.
 */
export function preflightPublish(
  platform: string,
  asset: PublishAssetMeta | null,
  caption: string | null | undefined,
): PreflightResult {
  return preflightPublishSet(platform, asset ? [asset] : [], caption);
}

/**
 * Run every knowable rule for posting a SET of files + `caption` to `platform`.
 * The set is the carousel order. Platforms outside the bundle trio return ok
 * with no issues (manual path).
 *
 * Shape rules (mirror buildPlatformData — keep in sync):
 *   instagram  1 video → REEL; anything else → POST (carousel 1–10, mixed
 *              images+videos allowed).
 *   tiktok     exactly 1 video → VIDEO; 1–10 images → Photo Mode (JPG/JPEG/
 *              WebP ONLY — PNG is rejected — ≤20MB each); mixing blocked.
 *   snapchat   exactly 1 file (image or MP4 video).
 */
export function preflightPublishSet(
  platform: string,
  assets: PublishAssetMeta[],
  caption: string | null | undefined,
): PreflightResult {
  const captionMax = CAPTION_MAX[platform] ?? 0;
  if (!['instagram', 'tiktok', 'snapchat'].includes(platform)) {
    return { ok: true, issues: [], captionMax };
  }

  const blocks: RuleIssue[] = [];
  const warns: RuleIssue[] = [];
  const block = (ar: string, en: string) => blocks.push({ level: 'block', ar, en });
  const warn = (ar: string, en: string) => warns.push({ level: 'warn', ar, en });

  /* ── caption ─────────────────────────────────────────────────────── */
  const text = caption ?? '';
  if (captionMax > 0 && text.length > captionMax) {
    block(
      `الكابشن أطول من حد المنصة (${text.length} من ${captionMax} حرفًا) — قصّره.`,
      `Caption exceeds the platform limit (${text.length} of ${captionMax} chars) — shorten it.`,
    );
  }
  if (platform === 'instagram') {
    const hashtags = (text.match(/#[^\s#]+/g) ?? []).length;
    if (hashtags > 30) {
      block(
        `انستقرام يقبل ٣٠ وسمًا كحد أقصى — الكابشن فيه ${hashtags}.`,
        `Instagram allows at most 30 hashtags — this caption has ${hashtags}.`,
      );
    }
  }

  /* ── set shape ───────────────────────────────────────────────────── */
  if (assets.length === 0) {
    block('لا ملف معتمد مرتبط بهذا النشر.', 'No approved file is attached to this publication.');
    return { ok: false, issues: [...blocks, ...warns], captionMax };
  }
  const videos = assets.filter((a) => isVideoKind(a.kind));
  const images = assets.filter((a) => !isVideoKind(a.kind));
  const n = assets.length;

  if (platform === 'instagram' && n > 10) {
    block(`كاروسيل انستقرام يقبل ١٠ ملفات كحد أقصى — المحدد ${n}.`,
      `Instagram carousels max out at 10 files — ${n} selected.`);
  }
  if (platform === 'tiktok') {
    if (videos.length > 0 && images.length > 0) {
      block('تيك توك لا يخلط الصور والفيديو في منشور واحد — فيديو واحد أو صور فقط.',
        'TikTok can’t mix images and video in one post — one video OR images only.');
    } else if (videos.length > 1) {
      block('تيك توك يقبل فيديو واحدًا فقط في المنشور.', 'TikTok accepts exactly one video per post.');
    } else if (images.length > 10) {
      block(`وضع الصور في تيك توك يقبل ١٠ صور كحد أقصى — المحدد ${images.length}.`,
        `TikTok Photo Mode maxes out at 10 images — ${images.length} selected.`);
    }
  }
  if (platform === 'snapchat' && n > 1) {
    block(`ستوري سناب يقبل ملفًا واحدًا فقط — المحدد ${n}.`,
      `Snapchat Stories take exactly one file — ${n} selected.`);
  }

  // Is this IG set a Reel (single video) or a feed post/carousel?
  const igIsReel = platform === 'instagram' && n === 1 && videos.length === 1;

  /* ── per-file rules ──────────────────────────────────────────────── */
  let anySizeUnknown = false;
  assets.forEach((asset, idx) => {
    const video = isVideoKind(asset.kind);
    const size = typeof asset.size_bytes === 'number' && asset.size_bytes > 0 ? asset.size_bytes : null;
    const dur = typeof asset.duration_seconds === 'number' && asset.duration_seconds > 0
      ? asset.duration_seconds : null;
    const mime = (asset.mime_type ?? '').toLowerCase();
    // «الملف ٣:» prefix only when there is more than one file to point at.
    const at = n > 1 ? `الملف ${idx + 1}: ` : '';
    const atEn = n > 1 ? `File ${idx + 1}: ` : '';
    if (size === null) anySizeUnknown = true;

    // Universal: bundle fetches by URL — 1 GB ceiling regardless of platform.
    if (size !== null && size > FROM_URL_MAX_BYTES) {
      block(`${at}الملف ${fmtMB(size)} — سقف الرفع 1GB.`,
        `${atEn}the file is ${fmtMB(size)} — the upload ceiling is 1GB.`);
    }

    if (platform === 'instagram') {
      if (video) {
        // Reel or carousel video item: 3s–15min, ≤45Mbps bitrate.
        if (dur !== null) {
          if (dur < 3) block(`${at}الفيديو أقصر من ٣ ثوانٍ — حد انستقرام الأدنى.`, `${atEn}video is under 3s — Instagram’s minimum.`);
          if (dur > 900) {
            block(`${at}الفيديو ${fmtDur(dur)} — حد انستقرام ١٥ دقيقة.`,
              `${atEn}video is ${fmtDur(dur)} — Instagram’s ceiling is 15 minutes.`);
          }
          if (size !== null && (size * 8) / dur > 45_000_000) {
            block(`${at}جودة الفيديو (البترريت) أعلى من حد انستقرام 45Mbps — اضغطه أولًا.`,
              `${atEn}video bitrate exceeds Instagram’s 45Mbps cap — compress it first.`);
          }
        } else {
          warn(`${at}لم نتحقق من مدة الفيديو (غير مسجلة) — انستقرام يشترط ٣ث–١٥د وسيرفض خارجها.`,
            `${atEn}video duration is not recorded — Instagram requires 3s–15min and will reject outside it.`);
        }
      } else {
        // Feed POST image: ≤8MB. Aspect is handled for us (autoFitImage letterboxes).
        if (size !== null && size > 8 * MB) {
          block(`${at}الصورة ${fmtMB(size)} — حد انستقرام 8MB. اضغطها أولًا.`,
            `${atEn}image is ${fmtMB(size)} — Instagram’s cap is 8MB. Compress it first.`);
        }
        if (mime && !/^image\/(jpe?g|png|webp)/.test(mime)) {
          block(`${at}صيغة الصورة (${mime}) غير مقبولة — JPG أو PNG أو WebP.`,
            `${atEn}image format (${mime}) is not accepted — use JPG, PNG or WebP.`);
        }
      }
    }

    if (platform === 'tiktok') {
      if (video) {
        if (size !== null && size > 1 * GB) {
          block(`${at}الفيديو ${fmtMB(size)} — حد تيك توك 1GB.`, `${atEn}video is ${fmtMB(size)} — TikTok’s cap is 1GB.`);
        }
        if (dur !== null && dur > 600) {
          block(`${at}الفيديو ${fmtDur(dur)} — حد تيك توك ١٠ دقائق.`,
            `${atEn}video is ${fmtDur(dur)} — TikTok’s ceiling is 10 minutes.`);
        }
        if (dur === null) {
          warn(`${at}لم نتحقق من مدة الفيديو (غير مسجلة) — حد تيك توك ١٠ دقائق.`,
            `${atEn}video duration is not recorded — TikTok’s ceiling is 10 minutes.`);
        }
      } else {
        // Photo Mode: JPG/JPEG/WebP ONLY (PNG rejected), ≤20MB each.
        if (mime && !/^image\/(jpe?g|webp)/.test(mime)) {
          block(`${at}وضع الصور في تيك توك يقبل JPG وWebP فقط — هذا الملف ${mime || 'غير معروف'}. PNG مرفوض؛ حوّلها أولًا.`,
            `${atEn}TikTok Photo Mode accepts JPG/WebP only — this file is ${mime || 'unknown'}. PNG is rejected; convert it first.`);
        }
        if (!mime) {
          warn(`${at}صيغة الصورة غير مسجلة — تيك توك يقبل JPG وWebP فقط وسيرفض غيرها.`,
            `${atEn}image format is not recorded — TikTok accepts JPG/WebP only and will reject others.`);
        }
        if (size !== null && size > 20 * MB) {
          block(`${at}الصورة ${fmtMB(size)} — حد تيك توك 20MB للصورة.`,
            `${atEn}image is ${fmtMB(size)} — TikTok’s per-image cap is 20MB.`);
        }
      }
    }

    if (platform === 'snapchat') {
      // STORY: ≤100MB, video must be MP4 and 5–60s. The strictest of the three.
      if (size !== null && size > 100 * MB) {
        block(`${at}الملف ${fmtMB(size)} — حد سناب شات 100MB.`, `${atEn}file is ${fmtMB(size)} — Snapchat’s cap is 100MB.`);
      }
      if (video) {
        if (mime && mime !== 'video/mp4') {
          block(`${at}سناب شات يقبل فيديو MP4 فقط — هذا الملف ${mime}.`,
            `${atEn}Snapchat accepts MP4 video only — this file is ${mime}.`);
        }
        if (dur !== null) {
          if (dur < 5) block(`${at}الفيديو أقصر من ٥ ثوانٍ — حد ستوري سناب الأدنى.`, `${atEn}video is under 5s — the Snapchat Story minimum.`);
          if (dur > 60) {
            block(`${at}الفيديو ${fmtDur(dur)} — ستوري سناب يقبل ٦٠ ثانية كحد أقصى. قصّه أو انشره يدويًا.`,
              `${atEn}video is ${fmtDur(dur)} — Snapchat Stories max out at 60s. Trim it or post manually.`);
          }
        } else {
          warn(`${at}لم نتحقق من مدة الفيديو (غير مسجلة) — ستوري سناب يقبل ٥–٦٠ ثانية فقط.`,
            `${atEn}video duration is not recorded — Snapchat Stories accept 5–60s only.`);
        }
      }
    }
  });

  // A carousel that mixes in videos posts as a feed POST, not a Reel — worth
  // saying out loud since single-video behaves differently.
  if (platform === 'instagram' && !igIsReel && videos.length > 0 && n > 1) {
    warn('كاروسيل يحتوي فيديو يُنشر كمنشور عادي (ليس ريلز).',
      'A carousel containing video posts as a feed post (not a Reel).');
  }

  // Metadata we could not verify at all (legacy link-only assets): be honest.
  if (anySizeUnknown) {
    warn('حجم أحد الملفات غير مسجل — ستتحقق المنصة منه عند النشر.',
      'A file’s size is not recorded — the platform will check it at post time.');
  }

  return { ok: blocks.length === 0, issues: [...blocks, ...warns], captionMax };
}

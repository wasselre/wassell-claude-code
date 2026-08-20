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
 * Run every knowable rule for posting `asset` + `caption` to `platform`.
 * Platforms outside the bundle trio return ok with no issues (manual path).
 */
export function preflightPublish(
  platform: string,
  asset: PublishAssetMeta | null,
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

  /* ── file ────────────────────────────────────────────────────────── */
  if (!asset) {
    block('لا ملف معتمد مرتبط بهذا النشر.', 'No approved file is attached to this publication.');
    return { ok: false, issues: [...blocks, ...warns], captionMax };
  }

  const video = isVideoKind(asset.kind);
  const size = typeof asset.size_bytes === 'number' && asset.size_bytes > 0 ? asset.size_bytes : null;
  const dur = typeof asset.duration_seconds === 'number' && asset.duration_seconds > 0
    ? asset.duration_seconds : null;
  const mime = (asset.mime_type ?? '').toLowerCase();

  // Universal: bundle fetches the file by URL — 1 GB ceiling regardless of platform.
  if (size !== null && size > FROM_URL_MAX_BYTES) {
    block(
      `الملف ${fmtMB(size)} — سقف الرفع 1GB.`,
      `The file is ${fmtMB(size)} — the upload ceiling is 1GB.`,
    );
  }

  if (platform === 'instagram') {
    if (video) {
      // REEL: 3s–15min, ≤45Mbps bitrate, ≤1920px wide.
      if (dur !== null) {
        if (dur < 3) block('الفيديو أقصر من ٣ ثوانٍ — حد الريلز الأدنى.', 'Video is under 3s — the Reels minimum.');
        if (dur > 900) {
          block(
            `الفيديو ${fmtDur(dur)} — حد الريلز ١٥ دقيقة.`,
            `Video is ${fmtDur(dur)} — the Reels ceiling is 15 minutes.`,
          );
        }
        if (size !== null && (size * 8) / dur > 45_000_000) {
          block(
            'جودة الفيديو (البترريت) أعلى من حد انستقرام 45Mbps — اضغطه أولًا.',
            'Video bitrate exceeds Instagram’s 45Mbps cap — compress it first.',
          );
        }
      } else {
        warn(
          'لم نتحقق من مدة الفيديو (غير مسجلة) — انستقرام يشترط ٣ث–١٥د وسيرفض خارجها.',
          'Video duration is not recorded — Instagram requires 3s–15min and will reject outside it.',
        );
      }
    } else {
      // Feed POST image: ≤8MB. Aspect is handled for us (autoFitImage letterboxes).
      if (size !== null && size > 8 * MB) {
        block(
          `الصورة ${fmtMB(size)} — حد انستقرام 8MB. اضغطها أولًا.`,
          `Image is ${fmtMB(size)} — Instagram’s cap is 8MB. Compress it first.`,
        );
      }
      if (mime && !/^image\/(jpe?g|png|webp)/.test(mime)) {
        block(
          `صيغة الصورة (${mime}) غير مقبولة — JPG أو PNG أو WebP.`,
          `Image format (${mime}) is not accepted — use JPG, PNG or WebP.`,
        );
      }
    }
  }

  if (platform === 'tiktok') {
    if (!video) {
      // Photo Mode exists on TikTok but our pipeline is single-file video-only.
      block('تيك توك (في نظامنا) يقبل الفيديو فقط — اختر ملف فيديو.', 'TikTok (in our pipeline) accepts video only — pick a video file.');
    } else {
      if (size !== null && size > 1 * GB) {
        block(`الفيديو ${fmtMB(size)} — حد تيك توك 1GB.`, `Video is ${fmtMB(size)} — TikTok’s cap is 1GB.`);
      }
      if (dur !== null && dur > 600) {
        block(
          `الفيديو ${fmtDur(dur)} — حد تيك توك ١٠ دقائق.`,
          `Video is ${fmtDur(dur)} — TikTok’s ceiling is 10 minutes.`,
        );
      }
      if (dur === null) {
        warn(
          'لم نتحقق من مدة الفيديو (غير مسجلة) — حد تيك توك ١٠ دقائق.',
          'Video duration is not recorded — TikTok’s ceiling is 10 minutes.',
        );
      }
    }
  }

  if (platform === 'snapchat') {
    // STORY: exactly 1 image or MP4 video, ≤100MB, video 5–60s. The strictest
    // of the three — long real-estate videos and long captions both die here.
    if (size !== null && size > 100 * MB) {
      block(`الملف ${fmtMB(size)} — حد سناب شات 100MB.`, `File is ${fmtMB(size)} — Snapchat’s cap is 100MB.`);
    }
    if (video) {
      if (mime && mime !== 'video/mp4') {
        block(
          `سناب شات يقبل فيديو MP4 فقط — هذا الملف ${mime}.`,
          `Snapchat accepts MP4 video only — this file is ${mime}.`,
        );
      }
      if (dur !== null) {
        if (dur < 5) block('الفيديو أقصر من ٥ ثوانٍ — حد ستوري سناب الأدنى.', 'Video is under 5s — the Snapchat Story minimum.');
        if (dur > 60) {
          block(
            `الفيديو ${fmtDur(dur)} — ستوري سناب يقبل ٦٠ ثانية كحد أقصى. قصّه أو انشره يدويًا.`,
            `Video is ${fmtDur(dur)} — Snapchat Stories max out at 60s. Trim it or post manually.`,
          );
        }
      } else {
        warn(
          'لم نتحقق من مدة الفيديو (غير مسجلة) — ستوري سناب يقبل ٥–٦٠ ثانية فقط.',
          'Video duration is not recorded — Snapchat Stories accept 5–60s only.',
        );
      }
    }
  }

  // Metadata we could not verify at all (legacy link-only assets): be honest.
  if (size === null) {
    warn(
      'حجم الملف غير مسجل — ستتحقق المنصة منه عند النشر.',
      'File size is not recorded — the platform will check it at post time.',
    );
  }

  return { ok: blocks.length === 0, issues: [...blocks, ...warns], captionMax };
}

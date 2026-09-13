/**
 * `<Thumb>` — the ONE way the Marketing workspace shows a picture of a thing.
 *
 * Until now exactly one surface rendered content thumbnails (`CreativePicker`,
 * because an operator refused to attach an ad creative by picking a code out of
 * a dropdown). Every other list — the content table, the campaign's content,
 * my-work, the calendar, the publishing board, search — showed a row of text
 * for something that is, literally, a picture. This is that one good precedent
 * generalised.
 *
 * Two shapes of asset exist and `useAssetUrls` is the one place that knows the
 * difference (legacy public `thumb_url`, or a canonical `file_id` that must be
 * signed). `<Thumb>` wraps it, so no surface signs anything itself.
 *
 * SIGNING IN ONE BATCH: a list of N canonical thumbs mounted as N independent
 * `useAssetUrls` hooks would fire N signing round-trips. Wrap the list in
 * `<ThumbSigner rows={rows}>` and every `<Thumb>` beneath it reads from that
 * one batch instead — the hook inside each thumb goes inert (it is still
 * called, unconditionally, with an empty list). Without a provider a lone
 * thumb still resolves itself, so a one-off never needs ceremony.
 *
 * A thumb NEVER renders an empty box: no design yet → a typed placeholder
 * (the content type's own icon) or the project cover when the server supplies
 * one, so «لا تصميم بعد» reads as a state rather than as a broken image.
 */
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { MosAsset } from '@/lib/marketingOS/client';
import { useAssetUrls, type AssetUrlResolver } from '../lib/assetUrls';
import { IconLibrary, kindIcon } from './icons';

/** What a thumb needs to resolve a URL — the shape `useAssetUrls` consumes. */
export type ThumbAsset = Pick<MosAsset, 'file_id' | 'url' | 'thumb_url' | 'kind'> & {
  mime_type?: string | null;
};

export type ThumbSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_PX: Record<ThumbSize, number> = { xs: 28, sm: 38, md: 56, lg: 96 };

/* ── one shared signing batch ───────────────────────────────────────── */

const SignerCtx = createContext<AssetUrlResolver | null>(null);

/**
 * Sign every canonical preview in `rows` ONCE for the whole list.
 *
 * `rows` may be content rows, assets, or anything carrying `thumb_url` /
 * `preview_file_id` / `file_id`; they are normalised before signing. Legacy
 * public rows cost nothing (the hook no-ops when nothing needs signing).
 */
export function ThumbSigner({
  rows, children,
}: {
  rows: ReadonlyArray<ThumbRowLike | ThumbAsset | null | undefined>;
  children: ReactNode;
}): JSX.Element {
  const assets = useMemo(
    () => rows.map((r) => (r ? toThumbAsset(r) : null)),
    [rows],
  );
  const resolver = useAssetUrls(assets);
  return <SignerCtx.Provider value={resolver}>{children}</SignerCtx.Provider>;
}

/** The signing error for the enclosing `<ThumbSigner>`, for a retry affordance. */
export function useThumbSigner(): AssetUrlResolver | null {
  return useContext(SignerCtx);
}

/* ── the thumb ──────────────────────────────────────────────────────── */

export interface ThumbProps {
  /** A library asset (whatever shape) — takes precedence over the loose fields. */
  asset?: ThumbAsset | null;
  /** A canonical `files` id to sign. */
  fileId?: string | null;
  /** A legacy public thumbnail URL. */
  thumbUrl?: string | null;
  /** The asset kind, so a non-image gets a typed placeholder rather than a gap. */
  kind?: string | null;
  size?: ThumbSize;
  /** Square by default; pass a ratio for a card-shaped tile ('4 / 3', '1 / 1'). */
  ratio?: string;
  /**
   * What to draw when nothing resolves: an icon key (a content type key, so the
   * row shows a video / post / carousel / story glyph), or a node.
   */
  fallback?: string | ReactNode;
  /** A cover to use instead of the icon when there is no design yet. */
  coverUrl?: string | null;
  alt: string;
  className?: string;
  style?: CSSProperties;
}

export default function Thumb({
  asset, fileId, thumbUrl, kind, size = 'sm', ratio,
  fallback, coverUrl, alt, className, style,
}: ThumbProps): JSX.Element {
  const resolved: ThumbAsset = useMemo(() => (asset ?? {
    file_id: fileId ?? null,
    url: null,
    thumb_url: thumbUrl ?? null,
    // When there is no preview at all the kind is unused; default it to a
    // non-image so `resolveAssetThumb` never invents a URL for a missing file.
    kind: (kind ?? 'document') as MosAsset['kind'],
    mime_type: null,
  }), [asset, fileId, thumbUrl, kind]);

  const shared = useThumbSigner();
  // Hooks run unconditionally; with a provider present this one is handed an
  // empty list, so it signs nothing and schedules no refresh timer.
  const own = useAssetUrls(shared ? EMPTY : [resolved]);
  const src = (shared ?? own).thumbFor(resolved) ?? coverUrl ?? null;

  const px = SIZE_PX[size];
  const box: CSSProperties = {
    width: ratio ? '100%' : px,
    height: ratio ? undefined : px,
    aspectRatio: ratio,
    flex: ratio ? undefined : `0 0 ${px}px`,
    borderRadius: px >= 56 ? 8 : 6,
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    background: 'var(--sand-2, color-mix(in srgb, var(--mute) 10%, transparent))',
    border: '1px solid var(--line-soft, var(--line))',
    color: 'var(--mute)',
    ...style,
  };

  if (src) {
    return (
      <span className={className} style={box}>
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </span>
    );
  }

  return (
    <span className={className} style={box} role="img" aria-label={alt}>
      <Placeholder kind={resolved.kind} fallback={fallback} big={px >= 56} />
    </span>
  );
}

const EMPTY: ReadonlyArray<ThumbAsset> = [];

/** The typed stand-in: the content type's glyph, a media glyph, or the library. */
function Placeholder({
  kind, fallback, big,
}: {
  kind: string | null | undefined;
  fallback: string | ReactNode | undefined;
  big: boolean;
}): JSX.Element {
  const dim = big ? 22 : 15;
  if (fallback && typeof fallback !== 'string') return <>{fallback}</>;
  const key = typeof fallback === 'string' ? fallback : null;
  // The icon set sizes itself from CSS (`.kind svg`, `.navi svg`); inside a
  // thumb there is no such rule, so the size and stroke are set explicitly.
  if (key) {
    const Icon = kindIcon(key);
    return <Icon strokeWidth={1.7} style={{ width: dim, height: dim }} />;
  }
  if (kind === 'video') return <MediaGlyph dim={dim} shape="video" />;
  if (kind === 'document') return <MediaGlyph dim={dim} shape="doc" />;
  return <IconLibrary strokeWidth={1.7} style={{ width: dim, height: dim }} />;
}

function MediaGlyph({ dim, shape }: { dim: number; shape: 'video' | 'doc' }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: dim, height: dim }}
      aria-hidden="true"
    >
      {shape === 'video' ? (
        <>
          <rect x="2.5" y="5.5" width="14" height="13" rx="2.5" />
          <path d="M16.5 10.5l5-3v9l-5-3z" />
        </>
      ) : (
        <>
          <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
          <path d="M14 3v5h5" />
        </>
      )}
    </svg>
  );
}

/* ── content rows ───────────────────────────────────────────────────── */

/**
 * The preview columns a content row carries. `content_list` fills them today;
 * `attachContentPreviews` is being applied to the other endpoints in parallel,
 * so EVERY field here is optional and a row without them renders the typed
 * placeholder rather than throwing.
 */
export interface ThumbRowLike {
  /** Legacy public thumbnail. */
  thumb_url?: string | null;
  /** Canonical `files` id of the preview asset. */
  preview_file_id?: string | null;
  /** `mos_assets.kind` of the preview asset. */
  preview_kind?: string | null;
  /** Set once the server supplies the project's cover for design-less items. */
  project_cover_url?: string | null;
  /** Present on assets rather than content rows. */
  file_id?: string | null;
  url?: string | null;
  kind?: string | null;
  content_type_key?: string | null;
  title?: string | null;
  ref?: string | null;
}

/** Normalise anything list-shaped into what `useAssetUrls` resolves. */
export function toThumbAsset(row: ThumbRowLike | ThumbAsset): ThumbAsset {
  const r = row as ThumbRowLike & ThumbAsset;
  return {
    file_id: r.preview_file_id ?? r.file_id ?? null,
    url: r.url ?? null,
    thumb_url: r.thumb_url ?? null,
    kind: ((r.preview_kind ?? r.kind) ?? 'document') as MosAsset['kind'],
    mime_type: null,
  };
}

/**
 * A content row's thumbnail. The row shape is the same one `CreativePicker`
 * already consumes, so a surface only has to pass the row it already has.
 */
export function ContentThumb({
  row, size = 'sm', ratio, className, style,
}: {
  row: ThumbRowLike;
  size?: ThumbSize;
  ratio?: string;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <Thumb
      asset={toThumbAsset(row)}
      coverUrl={row.project_cover_url ?? null}
      fallback={row.content_type_key ?? undefined}
      size={size}
      ratio={ratio}
      className={className}
      style={style}
      alt={row.title ?? row.ref ?? ''}
    />
  );
}

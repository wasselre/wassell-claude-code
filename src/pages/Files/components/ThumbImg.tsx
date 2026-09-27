import { useEffect, useState } from 'react';

interface Props {
  /** Small transformed thumbnail URL (from signThumbUrls). */
  src: string;
  /** Full-size original. Used when the thumbnail fails to load — Supabase's
   *  image transformer refuses sources over its size limit (a 33 MB JPEG
   *  returns 400), so those tiles fall back to downloading the original. */
  fallbackSrc?: string | null;
  alt?: string;
  className?: string;
}

/** Lazy grid thumbnail with a one-step fallback to the original image. */
export default function ThumbImg({ src, fallbackSrc, alt = '', className }: Props) {
  const [current, setCurrent] = useState(src);
  useEffect(() => { setCurrent(src); }, [src]);
  return (
    <img
      src={current}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => {
        if (fallbackSrc && current !== fallbackSrc) {
          console.warn('[ThumbImg] thumbnail failed, falling back to original', src);
          setCurrent(fallbackSrc);
        }
      }}
    />
  );
}

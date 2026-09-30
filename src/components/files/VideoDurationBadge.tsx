import { formatVideoDuration } from '@/lib/files/transcripts';

/** The video's length, pinned to the bottom corner of its thumbnail. Always
 *  LTR digits (m:ss) — a clock reads the same in both languages. */
export default function VideoDurationBadge({ seconds }: { seconds: number | null | undefined }) {
  const label = formatVideoDuration(seconds);
  if (!label) return null;
  return (
    <span
      dir="ltr"
      className="absolute bottom-1.5 end-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
    >
      {label}
    </span>
  );
}

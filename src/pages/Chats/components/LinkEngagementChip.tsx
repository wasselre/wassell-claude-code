import { Eye, EyeOff, Image as ImageIcon, PlayCircle, FileText, LayoutGrid, MapPin, Flame } from 'lucide-react';
import type { TrackedLinkEngagement } from '@/types';

/**
 * What the customer did with THIS message's tracked links (one message = one
 * token). Shown under an outbound project / unit message so the rep sees, in
 * the conversation, whether the links were opened and how far the customer got.
 * Numbers come from v_tracked_link_engagement; nothing here is estimated.
 */
export default function LinkEngagementChip({
  engagement,
  isAr,
}: {
  engagement: TrackedLinkEngagement | null;
  isAr: boolean;
}) {
  // A token we haven't loaded yet (message just arrived) — say nothing rather
  // than a "not opened" that might be false.
  if (!engagement) return null;

  if (engagement.sessions === 0) {
    return (
      <div className="mt-1.5 flex items-center gap-1 border-t border-charcoal/10 pt-1.5 text-[11px] text-charcoal/50">
        <EyeOff size={11} />
        {isAr ? 'لم يفتح الروابط بعد' : 'Links not opened yet'}
      </div>
    );
  }

  const parts: Array<{ key: string; icon: JSX.Element; text: string }> = [];
  parts.push({
    key: 'open',
    icon: <Eye size={11} />,
    text: isAr
      ? `فتحها ${engagement.sessions} ${engagement.sessions === 1 ? 'مرة' : 'مرات'}${engagement.open_days > 1 ? ` · ${engagement.open_days} أيام` : ''}`
      : `Opened ${engagement.sessions}×${engagement.open_days > 1 ? ` · ${engagement.open_days} days` : ''}`,
  });
  if (engagement.photos_opened > 0) {
    parts.push({ key: 'photos', icon: <ImageIcon size={11} />, text: isAr ? `${engagement.photos_opened} صور` : `${engagement.photos_opened} photos` });
  }
  if (engagement.videos_played > 0) {
    const pct = Math.round(Number(engagement.max_video_pct) || 0);
    parts.push({
      key: 'videos',
      icon: <PlayCircle size={11} />,
      text: isAr
        ? `${engagement.videos_played} فيديو${pct > 0 ? ` · ${pct}%` : ''}`
        : `${engagement.videos_played} video${engagement.videos_played === 1 ? '' : 's'}${pct > 0 ? ` · ${pct}%` : ''}`,
    });
  }
  if (Number(engagement.brochure_seconds) > 0 || engagement.brochure_pages > 0) {
    parts.push({
      key: 'brochure',
      icon: <FileText size={11} />,
      text: `${isAr ? 'البروشور' : 'Brochure'} ${duration(Number(engagement.brochure_seconds), isAr)}`,
    });
  }
  if (engagement.units_opened > 0 || Number(engagement.units_seconds) > 0) {
    parts.push({
      key: 'units',
      icon: <LayoutGrid size={11} />,
      text: engagement.units_opened > 0
        ? (isAr ? `${engagement.units_opened} وحدات` : `${engagement.units_opened} units`)
        : `${isAr ? 'الوحدات' : 'Units'} ${duration(Number(engagement.units_seconds), isAr)}`,
    });
  }
  if (engagement.opened_map) {
    parts.push({ key: 'map', icon: <MapPin size={11} />, text: isAr ? 'فتح الموقع' : 'Opened map' });
  }

  const score = Math.round(Number(engagement.score) || 0);
  const tone = score >= 60 ? 'text-emerald-700 bg-emerald-50' : score >= 30 ? 'text-amber-700 bg-amber-50' : 'text-charcoal/60 bg-charcoal/5';

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-charcoal/10 pt-1.5 text-[11px] text-charcoal/70">
      {parts.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1">
          {p.icon}
          {p.text}
        </span>
      ))}
      <span
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${tone}`}
        title={isAr ? 'درجة الاهتمام من 100 لهذه الرسالة' : 'Interest score out of 100 for this message'}
      >
        <Flame size={11} />
        {score}
      </span>
    </div>
  );
}

function duration(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return isAr ? `${s} ث` : `${s}s`;
  const m = Math.round(s / 60);
  return isAr ? `${m} د` : `${m}m`;
}

import { Eye, EyeOff, Image as ImageIcon, PlayCircle, FileText, LayoutGrid, MapPin, Flame, SlidersHorizontal } from 'lucide-react';
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
        {isAr ? 'لم يفتح روابط المشروع بعد' : 'Has not opened the project links yet'}
      </div>
    );
  }

  // Every part names WHAT it counts («الصور: …», «البروشور: …») — a bare
  // «فتحها مرة» read as "opened the images?" or "opened the website?" (operator,
  // 2026-09-29).
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const parts: Array<{ key: string; icon: JSX.Element; label: string; value: string }> = [];

  const visits = engagement.sessions;
  const days = engagement.open_days > 1 ? L(` (في ${engagement.open_days} أيام)`, ` (over ${engagement.open_days} days)`) : '';
  parts.push({
    key: 'open',
    icon: <Eye size={11} />,
    label: L('دخل صفحة المشروع', 'Opened the project page'),
    value: (visits === 1 ? L('مرة واحدة', 'once') : visits === 2 ? L('مرتين', 'twice') : L(`${visits} مرات`, `${visits} times`)) + days,
  });

  const photoSec = Number(engagement.photos_seconds) || 0;
  if (engagement.photos_opened > 0 || photoSec > 0) {
    parts.push({
      key: 'photos',
      icon: <ImageIcon size={11} />,
      label: L('الصور', 'Photos'),
      value: [
        engagement.photos_opened > 0 ? L(`كبّر ${engagement.photos_opened}`, `enlarged ${engagement.photos_opened}`) : L('تصفّح بدون تكبير', 'browsed, none enlarged'),
        photoSec > 0 ? duration(photoSec, isAr) : null,
      ].filter(Boolean).join(' · '),
    });
  }

  const videoSec = Number(engagement.videos_seconds) || 0;
  if (engagement.videos_played > 0 || videoSec > 0) {
    const pct = Math.round(Number(engagement.max_video_pct) || 0);
    parts.push({
      key: 'videos',
      icon: <PlayCircle size={11} />,
      label: L('الفيديو', 'Videos'),
      value: [
        engagement.videos_played > 0 ? L(`شغّل ${engagement.videos_played}`, `played ${engagement.videos_played}`) : L('لم يشغّل', 'none played'),
        pct > 0 ? L(`شاهد ${pct}%`, `watched ${pct}%`) : null,
        videoSec > 0 ? duration(videoSec, isAr) : null,
      ].filter(Boolean).join(' · '),
    });
  }

  const brochureSec = Number(engagement.brochure_seconds) || 0;
  if (brochureSec > 0 || engagement.brochure_pages > 0) {
    parts.push({
      key: 'brochure',
      icon: <FileText size={11} />,
      label: L('البروشور', 'Brochure'),
      value: [
        brochureSec > 0 ? duration(brochureSec, isAr) : null,
        engagement.brochure_pages > 1 ? L(`${engagement.brochure_pages} صفحات`, `${engagement.brochure_pages} pages`) : null,
      ].filter(Boolean).join(' · ') || L('فتحه', 'opened'),
    });
  }

  const unitsSec = Number(engagement.units_seconds) || 0;
  if (engagement.units_opened > 0 || unitsSec > 0) {
    parts.push({
      key: 'units',
      icon: <LayoutGrid size={11} />,
      label: L('الوحدات', 'Units'),
      value: [
        engagement.units_opened > 0 ? L(`فتح ${engagement.units_opened}`, `opened ${engagement.units_opened}`) : L('تصفّح القائمة', 'browsed the list'),
        unitsSec > 0 ? duration(unitsSec, isAr) : null,
      ].filter(Boolean).join(' · '),
    });
  }

  const filter = describeFilter(engagement.last_units_filter, isAr);
  if (filter) {
    parts.push({ key: 'filter', icon: <SlidersHorizontal size={11} />, label: L('يبحث عن', 'Looking for'), value: filter });
  }
  if (engagement.opened_map) {
    parts.push({ key: 'map', icon: <MapPin size={11} />, label: L('الموقع', 'Location'), value: L('فتحه في الخريطة', 'opened in Maps') });
  }

  const score = Math.round(Number(engagement.score) || 0);
  const tone = score >= 60 ? 'text-emerald-700 bg-emerald-50' : score >= 30 ? 'text-amber-700 bg-amber-50' : 'text-charcoal/60 bg-charcoal/5';

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-charcoal/10 pt-1.5 text-[11px] text-charcoal/70">
      {parts.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1">
          {p.icon}
          <span className="font-semibold text-charcoal/80">{p.label}:</span>
          {p.value}
        </span>
      ))}
      <span
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${tone}`}
        title={L('درجة الاهتمام من 100 لهذه الرسالة', 'Interest score out of 100 for this message')}
      >
        <Flame size={11} />
        {L(`الاهتمام ${score}/100`, `Interest ${score}/100`)}
      </span>
    </div>
  );
}

/** «type=شقة;bed=3;max=1500000;floor=أول» → «شقة · 3 غرف · حتى 1,500,000 · دور أول». */
function describeFilter(raw: string | null | undefined, isAr: boolean): string | null {
  if (!raw) return null;
  const parts: string[] = [];
  for (const pair of raw.split(';')) {
    const [k, ...rest] = pair.split('=');
    const v = rest.join('=').trim();
    if (!v) continue;
    if (k === 'type') parts.push(v);
    else if (k === 'bed') parts.push(isAr ? `${v} غرف` : `${v} bd`);
    else if (k === 'max') {
      const n = Number(v);
      if (Number.isFinite(n)) parts.push(isAr ? `حتى ${n.toLocaleString('en-US')}` : `≤ ${n.toLocaleString('en-US')}`);
    } else if (k === 'floor') parts.push(isAr ? `دور ${v}` : `floor ${v}`);
  }
  if (!parts.length) return null;
  return parts.join(' · ');
}

function duration(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return isAr ? `${s} ث` : `${s}s`;
  const m = Math.round(s / 60);
  return isAr ? `${m} د` : `${m}m`;
}

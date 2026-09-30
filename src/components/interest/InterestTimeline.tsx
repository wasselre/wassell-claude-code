import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Clock, Eye, FileText, Image as ImageIcon, LayoutGrid, Loader2, MapPin, PlayCircle, Send, SlidersHorizontal,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { foldTimeline, type TimelineStep } from '@/lib/trackedLinks/timeline';
import type { InterestTimelineEvent } from '@/types';

/**
 * The history behind one customer × project interest score: what we sent and
 * every action the customer took on our pages, oldest first, each with the
 * points it added. The points come from SQL (`tracked_interest_timeline`), so
 * the steps always add up to the score shown on the row.
 */
export default function InterestTimeline({
  chatWid,
  projectId,
  score,
  isAr,
}: {
  chatWid: string;
  projectId: string;
  /** The row's score — shown as the total the steps add up to. */
  score: number;
  isAr: boolean;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const loadInterestTimeline = useAppStore((s) => s.loadInterestTimeline);
  const [events, setEvents] = useState<InterestTimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEvents(null);
    setError(null);
    loadInterestTimeline(chatWid, projectId)
      .then((r) => { if (alive) setEvents(r); })
      .catch((e: unknown) => {
        console.error('[InterestTimeline] load failed:', e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [chatWid, projectId, loadInterestTimeline]);

  const days = useMemo(() => groupByDay(foldTimeline(events ?? []), isAr), [events, isAr]);

  if (error) {
    return (
      <div className="flex items-start gap-2 px-4 py-3 text-xs text-red-700">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        {L(`تعذّر تحميل السجل — ${error}`, `Couldn't load the history — ${error}`)}
      </div>
    );
  }
  if (!events) {
    return <div className="flex justify-center py-4 text-charcoal/40"><Loader2 size={16} className="animate-spin" /></div>;
  }

  return (
    <div className="bg-cream/40 px-4 py-3">
      {days.map((d) => (
        <div key={d.key} className="mb-2 last:mb-0">
          <div className="mb-1 text-[11px] font-semibold text-charcoal/50">{d.label}</div>
          <ol className="space-y-1">
            {d.steps.map((s, i) => (
              <li key={`${d.key}-${i}`} className="flex items-center gap-2 text-xs text-charcoal/80">
                <span className="w-10 shrink-0 text-[11px] text-charcoal/45" dir="ltr">{clock(s.at)}</span>
                <span className="shrink-0 text-charcoal/50">{iconOf(s)}</span>
                <span className="min-w-0 flex-1">{describe(s, isAr)}</span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${s.points > 0 ? 'bg-emerald-50 text-emerald-700' : 'text-charcoal/35'}`}
                  title={s.points > 0 ? L(`المجموع بعدها ${s.running}`, `Total after this: ${s.running}`) : L('لا تضيف نقاطاً (بلغ حدّها أو لا تُحتسب)', 'Adds no points (capped, or not scored)')}
                  dir="ltr"
                >
                  {s.points > 0 ? `+${s.points}` : '—'}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
      <div className="mt-2 flex items-center justify-between border-t border-sand/40 pt-2 text-xs font-bold text-charcoal">
        <span>{L('مجموع نقاط المشروع', 'Project total')}</span>
        <span dir="ltr">{Math.round(score)} / 100</span>
      </div>
    </div>
  );
}

function iconOf(s: TimelineStep): JSX.Element {
  switch (s.kind) {
    case 'sent': return <Send size={12} />;
    case 'view': return <Eye size={12} />;
    case 'time': return <Clock size={12} />;
    case 'photo_open': return <ImageIcon size={12} />;
    case 'video_play':
    case 'video_progress': return <PlayCircle size={12} />;
    case 'brochure_page': return <FileText size={12} />;
    case 'unit_open': return <LayoutGrid size={12} />;
    case 'units_filter': return <SlidersHorizontal size={12} />;
    case 'map_open': return <MapPin size={12} />;
  }
}

const SECTION: Record<string, { ar: string; en: string }> = {
  photos: { ar: 'الصور', en: 'Photos' },
  videos: { ar: 'الفيديوهات', en: 'Videos' },
  brochure: { ar: 'البروشور', en: 'Brochure' },
  units: { ar: 'الوحدات المتاحة', en: 'Available units' },
  unit: { ar: 'صفحة الوحدة', en: 'Unit page' },
  location: { ar: 'الموقع', en: 'Location' },
};
const VIA: Record<string, { ar: string; en: string }> = {
  agent: { ar: 'المساعد الآلي', en: 'the AI agent' },
  bot: { ar: 'الرد الآلي', en: 'the bot' },
  rep: { ar: 'مندوب', en: 'a rep' },
  bulk: { ar: 'إرسال جماعي', en: 'bulk send' },
  broker: { ar: 'وسيط', en: 'a broker' },
  other: { ar: 'النظام', en: 'the system' },
};

function describe(s: TimelineStep, isAr: boolean): string {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const sec = s.section ? (SECTION[s.section]?.[isAr ? 'ar' : 'en'] ?? s.section) : '';
  switch (s.kind) {
    case 'sent': {
      const what = s.focus === 'unit'
        ? L(`رابط الوحدة${s.unitLabel ? ` ${s.unitLabel}` : ''}`, `a link to unit${s.unitLabel ? ` ${s.unitLabel}` : ''}`)
        : s.focus === 'units' ? L('رابط قائمة الوحدات', 'a units-list link') : L('رسالة المشروع', 'the project message');
      const via = VIA[s.sentVia]?.[isAr ? 'ar' : 'en'] ?? s.sentVia;
      return L(`أرسلنا ${what} (${via})`, `We sent ${what} (${via})`);
    }
    // One line per stay on a tab: the open plus how long he stayed.
    case 'view': return s.value > 0
      ? L(`فتح ${sec} وبقي ${dur(s.value, true)}`, `Opened ${sec}, stayed ${dur(s.value, false)}`)
      : L(`فتح ${sec}`, `Opened ${sec}`);
    case 'time': return L(`بقي في ${sec} ${dur(s.value, true)}`, `Stayed on ${sec} ${dur(s.value, false)}`);
    case 'photo_open': return s.count === 1 ? L('كبّر صورة', 'Enlarged a photo') : L(`كبّر ${s.count} صور`, `Enlarged ${s.count} photos`);
    case 'video_play': return L('شغّل فيديو', 'Played a video');
    case 'video_progress': return L(`شاهد ${Math.round(s.value)}% من الفيديو`, `Watched ${Math.round(s.value)}% of the video`);
    case 'brochure_page': return s.value > 0 ? L(`وصل للصفحة ${s.value} من البروشور`, `Reached brochure page ${s.value}`) : L('تصفّح البروشور', 'Paged through the brochure');
    case 'unit_open': return L(`فتح الوحدة${s.unitLabel ? ` ${s.unitLabel}` : ''}`, `Opened unit${s.unitLabel ? ` ${s.unitLabel}` : ''}`);
    case 'units_filter': return L(`بحث في الوحدات: ${filterText(s.item, true)}`, `Filtered units: ${filterText(s.item, false)}`);
    case 'map_open': return L('فتح الموقع في الخريطة', 'Opened the location in Maps');
  }
}

function filterText(raw: string | null, isAr: boolean): string {
  const parts: string[] = [];
  for (const pair of (raw ?? '').split(';')) {
    const [k, ...rest] = pair.split('=');
    const v = rest.join('=').trim();
    if (!v) continue;
    if (k === 'type') parts.push(v);
    else if (k === 'bed') parts.push(isAr ? `${v} غرف` : `${v} bd`);
    else if (k === 'max') { const n = Number(v); if (Number.isFinite(n)) parts.push(isAr ? `حتى ${n.toLocaleString('en-US')}` : `≤ ${n.toLocaleString('en-US')}`); }
    else if (k === 'floor') parts.push(isAr ? `دور ${v}` : `floor ${v}`);
  }
  return parts.join(' · ');
}

function dur(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return isAr ? `${s} ث` : `${s}s`;
  const m = Math.floor(s / 60); const r = s % 60;
  return isAr ? `${m} د${r ? ` ${r} ث` : ''}` : `${m}m${r ? ` ${r}s` : ''}`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }).format(d);
}

function groupByDay(steps: TimelineStep[], isAr: boolean): Array<{ key: string; label: string; steps: TimelineStep[] }> {
  const out: Array<{ key: string; label: string; steps: TimelineStep[] }> = [];
  const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' });
  const fmtLabel = new Intl.DateTimeFormat(isAr ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Riyadh' });
  for (const s of steps) {
    const d = new Date(s.at);
    const key = fmtKey.format(d);
    let g = out[out.length - 1];
    if (!g || g.key !== key) { g = { key, label: fmtLabel.format(d), steps: [] }; out.push(g); }
    g.steps.push(s);
  }
  return out;
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flame, Loader2, AlertCircle, Eye, Image as ImageIcon, PlayCircle, FileText, LayoutGrid, MapPin, Link2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { TrackedInterestRow } from '@/types';

/**
 * Interest from tracked links, per customer × project (v_project_interest).
 *   • mode 'project' — the customers we sent this project to, most interested first.
 *   • mode 'client'  — the projects this customer was sent, most interested first.
 * Every message's links roll up into one row; the score (0–100) is computed in
 * SQL (tracked_interest_score) from what they actually opened. A row click opens
 * the conversation.
 */
export default function TrackedInterestList({
  mode,
  id,
  isAr,
  compact = false,
}: {
  mode: 'project' | 'client';
  id: string;
  isAr: boolean;
  /** Client record: a short block that hides itself when there is nothing yet. */
  compact?: boolean;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const navigate = useNavigate();
  const loadTrackedInterest = useAppStore((s) => s.loadTrackedInterest);
  const [rows, setRows] = useState<TrackedInterestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    loadTrackedInterest(mode === 'project' ? { projectId: id } : { clientId: id })
      .then((r) => { if (alive) setRows(r); })
      .catch((e: unknown) => {
        console.error('[TrackedInterestList] load failed:', e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [mode, id, loadTrackedInterest]);

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        {L(`تعذّر تحميل الاهتمام — ${error}`, `Couldn't load interest — ${error}`)}
      </div>
    );
  }
  if (!rows) {
    return compact ? null : (
      <div className="flex justify-center py-8 text-charcoal/40"><Loader2 size={20} className="animate-spin" /></div>
    );
  }
  if (rows.length === 0) {
    return compact ? null : (
      <div className="rounded-2xl border border-sand/30 bg-white px-4 py-8 text-center text-sm text-charcoal/50">
        <Link2 size={24} className="mx-auto mb-2 opacity-40" />
        {mode === 'project'
          ? L('لم يُرسل هذا المشروع بروابط التتبع لأي عميل بعد.', 'This project has not been sent with tracked links yet.')
          : L('لم يُرسل لهذا العميل أي مشروع بروابط التتبع بعد.', 'No project has been sent to this client with tracked links yet.')}
      </div>
    );
  }

  const opened = rows.filter((r) => r.sessions > 0).length;

  return (
    <div className="rounded-2xl border border-sand/30 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-sand/20 px-4 py-2.5">
        <Flame size={16} className="text-copper" />
        <span className="text-sm font-bold text-charcoal">
          {mode === 'project' ? L('اهتمام العملاء', 'Customer interest') : L('اهتمامه بالمشاريع', 'Project interest')}
        </span>
        <span className="text-xs text-charcoal/55">
          {L(`فتح ${opened} من ${rows.length}`, `${opened} of ${rows.length} opened`)}
        </span>
      </div>
      <ul className="divide-y divide-sand/20">
        {rows.map((r) => (
          <li key={`${r.chat_wid}:${r.project_id}`}>
            <button
              type="button"
              disabled={!r.conversation_record_id}
              onClick={() => r.conversation_record_id && navigate(`/model/chats/${r.conversation_record_id}`)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-cream/60 disabled:cursor-default"
            >
              <ScorePill score={r.score} opened={r.sessions > 0} isAr={isAr} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-charcoal">
                  {r.name ?? (mode === 'project' ? phoneOf(r.chat_wid) : L('مشروع', 'Project'))}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-charcoal/60">
                  <span>{sentMix(r, isAr)}</span>
                  {r.sessions > 0 ? (
                    <>
                      <Stat icon={<Eye size={11} />} text={L(`دخل الصفحة ${r.sessions === 1 ? 'مرة' : `${r.sessions} مرات`}`, `opened the page ${r.sessions}×`)} />
                      {r.photos_opened > 0 && <Stat icon={<ImageIcon size={11} />} text={L(`كبّر ${r.photos_opened} صور`, `enlarged ${r.photos_opened} photos`)} />}
                      {r.videos_played > 0 && <Stat icon={<PlayCircle size={11} />} text={L(`شغّل ${r.videos_played} فيديو · ${Math.round(Number(r.max_video_pct) || 0)}%`, `played ${r.videos_played} video · ${Math.round(Number(r.max_video_pct) || 0)}%`)} />}
                      {Number(r.brochure_seconds) > 0 && <Stat icon={<FileText size={11} />} text={`${L('البروشور', 'Brochure')} ${dur(Number(r.brochure_seconds), isAr)}`} />}
                      {(r.units_opened > 0 || Number(r.units_seconds) > 0) && (
                        <Stat icon={<LayoutGrid size={11} />} text={r.units_opened > 0 ? L(`فتح ${r.units_opened} وحدات`, `opened ${r.units_opened} units`) : `${L('الوحدات', 'Units')} ${dur(Number(r.units_seconds), isAr)}`} />
                      )}
                      {r.opened_map && <Stat icon={<MapPin size={11} />} text={L('فتح الموقع', 'Opened map')} />}
                    </>
                  ) : (
                    <span className="text-charcoal/45">{L('لم يفتح روابط المشروع', 'Has not opened the links')}</span>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-[11px] text-charcoal/45">
                {when(r.last_activity_at ?? r.last_sent_at, isAr)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** «أرسلنا: 2 رسالة مشروع · 1 قائمة وحدات · 1 رابط وحدة» — what the one score is summed from. */
function sentMix(r: TrackedInterestRow, isAr: boolean): string {
  const parts = [
    r.project_messages > 0 ? (isAr ? `${r.project_messages} رسالة مشروع` : `${r.project_messages} project msg`) : null,
    r.units_links > 0 ? (isAr ? `${r.units_links} قائمة وحدات` : `${r.units_links} units list`) : null,
    r.unit_links > 0 ? (isAr ? `${r.unit_links} رابط وحدة` : `${r.unit_links} unit link`) : null,
  ].filter(Boolean);
  return `${isAr ? 'أرسلنا' : 'Sent'}: ${parts.length ? parts.join(' · ') : (isAr ? `${r.messages} رسالة` : `${r.messages} msg`)}`;
}

function ScorePill({ score, opened, isAr }: { score: number; opened: boolean; isAr: boolean }) {
  const s = Math.round(score);
  const tone = !opened ? 'bg-charcoal/5 text-charcoal/40' : s >= 60 ? 'bg-emerald-50 text-emerald-700' : s >= 30 ? 'bg-amber-50 text-amber-700' : 'bg-sand/30 text-charcoal/70';
  return (
    <span
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${tone}`}
      title={isAr ? 'درجة الاهتمام من 100' : 'Interest score out of 100'}
    >
      {s}
    </span>
  );
}

function Stat({ icon, text }: { icon: JSX.Element; text: string }) {
  return <span className="inline-flex items-center gap-1">{icon}{text}</span>;
}

function phoneOf(wid: string): string {
  const digits = wid.split('@')[0] ?? wid;
  return /^\d+$/.test(digits) ? `+${digits}` : wid;
}

function dur(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return isAr ? `${s} ث` : `${s}s`;
  const m = Math.round(s / 60);
  return isAr ? `${m} د` : `${m}m`;
}

function when(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' }).format(d);
}

import { useEffect, useMemo, useState } from 'react';
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  PhoneOff,
  Play,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Bot,
  User,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { CallLog, CallStatus, CallSentiment } from '@/types';
import { listCallsForPhone, subscribeToCallsForPhone } from '@/lib/hatif/client';

interface CallHistoryPanelProps {
  phones: string[];                    // one or more phone values from the record
}

/**
 * Shows every Hatif-logged call for any phone number on the record.
 * Mounts a Supabase Realtime subscription so newly-arriving webhooks stream
 * in live. Accepts multiple phones because a client record may have main +
 * alternate phones (we look each up, dedupe by call id).
 */
export default function CallHistoryPanel({ phones }: CallHistoryPanelProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const [calls, setCalls] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);

  // Dedupe phone list so two fields with the same number don't double-fetch.
  const uniquePhones = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of phones) {
      const trimmed = (p ?? '').trim();
      if (trimmed && !seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
    }
    return out;
  }, [phones]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const all = await Promise.all(uniquePhones.map(listCallsForPhone));
      if (cancelled) return;
      const byId = new Map<string, CallLog>();
      for (const list of all) for (const c of list) byId.set(c.id, c);
      const merged = Array.from(byId.values()).sort(
        (a, b) => b.creation_time.localeCompare(a.creation_time),
      );
      setCalls(merged);
      setLoading(false);
    }

    void load();

    const unsubs = uniquePhones.map((p) =>
      subscribeToCallsForPhone(p, () => { void load(); }),
    );
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [uniquePhones]);

  if (uniquePhones.length === 0) return null;

  return (
    <section className="card">
      <header className="flex items-center gap-2 mb-4">
        <Phone size={18} className="text-copper" />
        <h3 className="text-lg font-semibold text-charcoal">
          {isAr ? 'سجل المكالمات' : 'Call History'}
        </h3>
        {!loading && (
          <span className="text-sm text-charcoal/60">
            ({calls.length})
          </span>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-charcoal/60">
          {isAr ? 'جارٍ التحميل…' : 'Loading…'}
        </p>
      ) : calls.length === 0 ? (
        <p className="text-sm text-charcoal/60">
          {isAr ? 'لا توجد مكالمات مسجلة لهذا العميل.' : 'No calls logged for this client yet.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {calls.map((c) => <CallRow key={c.id} call={c} isAr={isAr} />)}
        </ul>
      )}
    </section>
  );
}

function CallRow({ call, isAr }: { call: CallLog; isAr: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const DirectionIcon = directionIcon(call);
  const statusLabel = statusLabelOf(call.status, isAr);
  const sentimentTone = sentimentClass(call.sentiment);

  const hasDetail = !!(call.summary || call.transcription?.text || call.recording_url);

  return (
    <li className="border border-sand/40 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        disabled={!hasDetail}
        className={`w-full flex items-center gap-3 px-4 py-3 text-start ${hasDetail ? 'hover:bg-cream/50' : 'cursor-default'}`}
      >
        <DirectionIcon size={18} className="text-copper flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-charcoal">
              {isAr ? directionLabelAr(call) : directionLabelEn(call)}
            </span>
            <span className="text-xs text-charcoal/60" dir="ltr">
              {formatDateTime(call.creation_time, isAr)}
            </span>
            {call.duration_seconds != null && (
              <span className="text-xs text-charcoal/60" dir="ltr">
                · {formatDuration(call.duration_seconds)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <span className={`badge ${statusBadgeClass(call.status)}`}>{statusLabel}</span>
            {call.sentiment && call.sentiment !== 'unknown' && (
              <span className={`badge ${sentimentTone}`}>
                {sentimentLabelOf(call.sentiment, isAr)}
              </span>
            )}
            {call.agent_name && (
              <span className="text-xs text-charcoal/60 inline-flex items-center gap-1">
                {call.ai_agent_id ? <Bot size={12} /> : <User size={12} />}
                {call.agent_name}
              </span>
            )}
          </div>
        </div>
        {hasDetail && (
          expanded
            ? <ChevronDown size={16} className="text-charcoal/60 flex-shrink-0" />
            : <ChevronRight size={16} className={`text-charcoal/60 flex-shrink-0 ${isAr ? 'rotate-180' : ''}`} />
        )}
      </button>

      {expanded && hasDetail && (
        <div className="border-t border-sand/40 p-4 bg-cream/30 space-y-3">
          {call.summary && (
            <div>
              <h4 className="text-xs font-semibold text-charcoal/70 mb-1 inline-flex items-center gap-1">
                <Sparkles size={12} className="text-gold" />
                {isAr ? 'ملخص الذكاء الاصطناعي' : 'AI Summary'}
              </h4>
              <p className="text-sm text-charcoal whitespace-pre-wrap">{call.summary}</p>
            </div>
          )}

          {call.recording_url && (
            <div>
              <h4 className="text-xs font-semibold text-charcoal/70 mb-1 inline-flex items-center gap-1">
                <Play size={12} />
                {isAr ? 'التسجيل' : 'Recording'}
              </h4>
              <audio controls src={call.recording_url} className="w-full" />
            </div>
          )}

          {call.transcription?.text && (
            <div>
              <h4 className="text-xs font-semibold text-charcoal/70 mb-1">
                {isAr ? 'النص الكامل' : 'Transcript'}
              </h4>
              <p className="text-sm text-charcoal/90 whitespace-pre-wrap leading-relaxed max-h-60 overflow-auto">
                {call.transcription.text}
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

function directionIcon(c: CallLog): typeof Phone {
  if (c.status === 'missed' || c.status === 'no_answer') return PhoneMissed;
  if (c.status === 'rejected_by_callee' || c.status === 'rejected_by_caller' || c.status === 'cancelled' || c.status === 'failed') return PhoneOff;
  return c.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
}

function directionLabelEn(c: CallLog): string {
  return c.direction === 'inbound' ? 'Incoming call' : 'Outgoing call';
}
function directionLabelAr(c: CallLog): string {
  return c.direction === 'inbound' ? 'مكالمة واردة' : 'مكالمة صادرة';
}

function statusLabelOf(s: CallStatus, isAr: boolean): string {
  const ar: Record<CallStatus, string> = {
    active: 'نشطة',
    completed: 'مكتملة',
    missed: 'فائتة',
    rejected_by_caller: 'ملغاة',
    rejected_by_callee: 'مرفوضة',
    no_answer: 'بدون رد',
    cancelled: 'ملغاة',
    failed: 'فشلت',
    ringing: 'يرن',
  };
  const en: Record<CallStatus, string> = {
    active: 'Active',
    completed: 'Completed',
    missed: 'Missed',
    rejected_by_caller: 'Rejected',
    rejected_by_callee: 'Rejected',
    no_answer: 'No answer',
    cancelled: 'Cancelled',
    failed: 'Failed',
    ringing: 'Ringing',
  };
  return (isAr ? ar : en)[s];
}

function statusBadgeClass(s: CallStatus): string {
  switch (s) {
    case 'completed': return 'bg-green-100 text-green-700';
    case 'missed':
    case 'no_answer': return 'bg-red-100 text-red-700';
    case 'rejected_by_caller':
    case 'rejected_by_callee':
    case 'cancelled':
    case 'failed': return 'bg-charcoal/10 text-charcoal/70';
    case 'ringing':
    case 'active': return 'bg-gold/30 text-chocolate';
  }
}

function sentimentLabelOf(s: CallSentiment, isAr: boolean): string {
  const ar: Record<CallSentiment, string> = {
    positive: 'إيجابية',
    neutral: 'محايدة',
    negative: 'سلبية',
    mixed: 'متباينة',
    unknown: 'غير معروفة',
  };
  const en: Record<CallSentiment, string> = {
    positive: 'Positive',
    neutral: 'Neutral',
    negative: 'Negative',
    mixed: 'Mixed',
    unknown: 'Unknown',
  };
  return (isAr ? ar : en)[s];
}

function sentimentClass(s: CallSentiment | null): string {
  switch (s) {
    case 'positive': return 'bg-green-100 text-green-700';
    case 'negative': return 'bg-red-100 text-red-700';
    case 'mixed': return 'bg-gold/30 text-chocolate';
    case 'neutral':
    case 'unknown':
    case null:
    default: return 'bg-sand/30 text-charcoal/70';
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDateTime(iso: string, isAr: boolean): string {
  return new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

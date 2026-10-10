import { useEffect, useState } from 'react';
import { Phone, Bot, MessageSquare } from 'lucide-react';
import { inDaysAtTen, type NextChannel, type NextPlan } from '@/lib/nextStep/client';

/**
 * How and when the next contact happens — the agent's choice (2026-10-10):
 * a call, a WhatsApp the AI writes, or a WhatsApp the agent writes; in 1 / 3 / 5
 * days (10:00 Riyadh) or on a chosen date.
 */
export default function NextStepEditor({
  initial, isAr, onChange,
}: {
  initial: NextPlan | null;
  isAr: boolean;
  onChange: (plan: NextPlan) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [channel, setChannel] = useState<NextChannel>(initial?.channel ?? 'ai_whatsapp');
  const [at, setAt] = useState<string>(initial?.at ?? inDaysAtTen(1));
  const emit = (c: NextChannel, a: string) => { setChannel(c); setAt(a); onChange({ channel: c, at: a }); };
  // No plan yet: what the picker shows (WhatsApp by the AI, in 1 day) is the
  // choice — report it so Save saves exactly what is highlighted.
  useEffect(() => {
    if (!initial) onChange({ channel, at });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const channels: Array<{ id: NextChannel; ar: string; en: string; icon: JSX.Element }> = [
    { id: 'call', ar: 'مكالمة', en: 'A call', icon: <Phone size={14} /> },
    { id: 'ai_whatsapp', ar: 'واتساب يكتبه المساعد', en: 'WhatsApp by the AI', icon: <Bot size={14} /> },
    { id: 'agent_whatsapp', ar: 'واتساب أكتبه أنا', en: 'WhatsApp I write', icon: <MessageSquare size={14} /> },
  ];
  const presets = [1, 3, 5];
  const localDay = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-xs font-bold text-charcoal/60">{L('كيف؟', 'How?')}</div>
        <div className="flex flex-wrap gap-1.5">
          {channels.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => emit(c.id, at)}
              aria-pressed={channel === c.id}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-bold transition ${
                channel === c.id ? 'border-copper bg-copper text-white' : 'border-sand/60 bg-white text-charcoal/70 hover:bg-cream'
              }`}
            >
              {c.icon}{isAr ? c.ar : c.en}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-xs font-bold text-charcoal/60">{L('متى؟', 'When?')}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((d) => {
            const iso = inDaysAtTen(d);
            const active = localDay(iso) === localDay(at);
            return (
              <button
                key={d}
                type="button"
                onClick={() => emit(channel, iso)}
                aria-pressed={active}
                className={`rounded-lg border px-3 py-1.5 text-sm font-bold transition ${
                  active ? 'border-copper bg-copper text-white' : 'border-sand/60 bg-white text-charcoal/70 hover:bg-cream'
                }`}
              >
                {d === 1 ? L('بعد يوم', 'In 1 day') : L(`بعد ${d} أيام`, `In ${d} days`)}
              </button>
            );
          })}
          <input
            type="date"
            value={localDay(at)}
            min={localDay(new Date().toISOString())}
            onChange={(e) => {
              // A chosen day at 10:00 Riyadh (07:00 UTC).
              const ms = Date.parse(`${e.target.value}T07:00:00Z`);
              if (!Number.isNaN(ms)) emit(channel, new Date(ms).toISOString());
            }}
            className="form-input w-auto py-1.5 text-sm"
            aria-label={L('تاريخ آخر', 'Another date')}
          />
        </div>
      </div>
    </div>
  );
}

/** «WhatsApp by the AI · Sun 12 Oct» — one line for a plan. */
export function describePlan(plan: NextPlan | null, isAr: boolean): string {
  if (!plan) return isAr ? 'لا تواصل قادم' : 'No next contact';
  const how = plan.channel === 'call'
    ? (isAr ? 'مكالمة' : 'A call')
    : plan.channel === 'agent_whatsapp'
      ? (isAr ? 'واتساب تكتبه أنت' : 'WhatsApp you write')
      : (isAr ? 'واتساب يكتبه المساعد' : 'WhatsApp by the AI');
  const when = new Date(plan.at).toLocaleDateString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh',
  });
  return `${how} · ${when}`;
}

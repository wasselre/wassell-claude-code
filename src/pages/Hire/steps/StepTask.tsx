import { MessageCircle, Clock, BellRing, Sparkles, ClipboardList } from 'lucide-react';
import { Screen } from '../hireUi';
import { TASK } from '../hireScenario';

/** Step 6 — the call is logged, and Wassel auto-creates the next follow-up task. */
export default function StepTask() {
  return (
    <Screen title="مهامي — قائمة المتابعة" icon={<ClipboardList size={16} />}>
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-copper/20 bg-copper/5 px-4 py-3 text-sm text-charcoal/80 sm:text-base">
        <Sparkles size={16} className="shrink-0 text-copper" />
        <span>{TASK.note}</span>
      </div>

      <div className="hire-pop card overflow-hidden p-0" style={{ borderInlineStartWidth: 5, borderInlineStartColor: '#25D366' }}>
        <div className="flex flex-wrap items-stretch justify-between gap-4 p-4 sm:p-5">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl bg-[#25D366] px-5 py-3 text-sm font-bold text-white sm:text-base"
          >
            <MessageCircle size={18} /> واتساب
          </button>

          <div className="min-w-0 flex-1 text-start">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-bold text-chocolate sm:text-lg">{TASK.client}</span>
              <span dir="ltr" className="text-sm text-terracotta">{TASK.phone}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981] px-2.5 py-0.5 text-xs font-bold text-white">
                <BellRing size={12} /> {TASK.statusLabel}
              </span>
            </div>
            <div className="mt-1.5 text-base font-bold text-copper">{TASK.type} · {TASK.objective}</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-charcoal/60 sm:text-sm">
              <span className="inline-flex items-center gap-1"><Clock size={12} /> {TASK.scheduled}</span>
              <span className="rounded-full bg-sand/50 px-2.5 py-0.5 font-semibold text-charcoal">القناة: {TASK.channel}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[#25D366]/15 px-2.5 py-0.5 font-semibold text-[#128C7E]">
                <ClipboardList size={12} /> مهمة تلقائية
              </span>
            </div>
          </div>
        </div>
      </div>
    </Screen>
  );
}

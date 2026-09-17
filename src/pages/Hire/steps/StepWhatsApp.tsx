import { useState } from 'react';
import { MessageCircle, ShieldCheck, Send, Check, CheckCheck, Sparkles } from 'lucide-react';
import { Screen, ProjectImage } from '../hireUi';
import { CLIENT, CHAT, PROJECT_MESSAGE, PROJECT, type ChatMessage } from '../hireScenario';

/** Step 4 — sending the prepared project message over WhatsApp, from inside Wassel. */
export default function StepWhatsApp() {
  const [sent, setSent] = useState(false);
  const visible: ChatMessage[] = sent ? CHAT : CHAT.filter((m) => !m.project && m.id !== 'm4');

  return (
    <Screen
      title="المحادثات — واتساب"
      icon={<MessageCircle size={16} />}
      right={<span className="text-sm font-bold text-charcoal">{CLIENT.name}</span>}
      bodyClassName="p-0"
    >
      {/* thread */}
      <div className="space-y-3 px-4 py-5 sm:px-6" style={{ background: '#EDE0CC' }}>
        <div className="flex justify-center">
          <span className="rounded-full bg-white/70 px-3 py-0.5 text-xs font-medium text-charcoal/55">اليوم</span>
        </div>
        {visible.map((m) => (m.project ? <ProjectBubble key={m.id} /> : <Bubble key={m.id} m={m} />))}
      </div>

      {/* composer / send action */}
      <div className="border-t border-sand/30 bg-white p-3 sm:p-4">
        {sent ? (
          <div className="hire-fade flex items-center justify-center gap-2 rounded-xl bg-green-50 px-3 py-3 text-sm font-bold text-green-700 sm:text-base">
            <ShieldCheck size={18} /> تم إرسال رسالة المشروع والصور إلى العميل
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSent(true)}
            className="flex w-full items-center gap-3 rounded-xl border-2 border-copper/40 bg-copper/5 px-4 py-3 text-start transition-colors hover:bg-copper/10"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-copper text-white">
              <Send size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-charcoal sm:text-base">إرسال رسالة المشروع الجاهزة</span>
              <span className="block truncate text-xs text-charcoal/55 sm:text-sm">نص مُدقّق الأرقام + صور مشروع {PROJECT.name}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-copper">
              <ShieldCheck size={12} /> يُدقّق الأرقام
            </span>
          </button>
        )}
      </div>
    </Screen>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const out = m.flow === 'out';
  return (
    <div className={`flex w-full ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[80%] flex-col ${out ? 'items-end' : 'items-start'}`}>
        <div className={`rounded-2xl px-4 py-2.5 shadow-sm ${out ? 'rounded-br-md bg-[#D9FDD3] text-charcoal' : 'rounded-bl-md bg-white text-charcoal'}`}>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed sm:text-base">{m.text}</p>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-charcoal/50">
          <span dir="ltr">{m.time}</span>
          {out && <CheckCheck size={13} className="text-[#25D366]" />}
        </div>
      </div>
    </div>
  );
}

function ProjectBubble() {
  return (
    <div className="hire-fade flex w-full justify-end">
      <div className="flex max-w-[88%] flex-col items-end sm:max-w-[78%]">
        <div className="overflow-hidden rounded-2xl rounded-br-md bg-[#D9FDD3] shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-black/5 bg-white/50 px-3 py-1.5 text-xs font-semibold text-green-700">
            <Sparkles size={13} className="text-copper" /> رسالة مشروع مُدقّقة الأرقام
          </div>
          <div className="grid grid-cols-2 gap-0.5 bg-white/40 p-0.5">
            {PROJECT.galleryVariants.map((v, i) => (
              <div key={i} className="h-24 sm:h-28"><ProjectImage variant={v} className="h-full w-full" /></div>
            ))}
          </div>
          <p className="whitespace-pre-wrap break-words px-4 py-2.5 text-sm leading-relaxed text-charcoal sm:text-base">{PROJECT_MESSAGE}</p>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-charcoal/50">
          <span dir="ltr">10:25 ص</span>
          <Check size={13} className="text-[#25D366]" />
        </div>
      </div>
    </div>
  );
}

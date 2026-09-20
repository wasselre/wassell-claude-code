import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { CalendarCheck, CheckCircle2, Loader2, Send } from 'lucide-react';
import { ProgressRail } from './hireUi';
import { postExperience } from '@/lib/careers/experience';

/**
 * Stage 5 — the decision (القرار). Two entries off the offer page:
 *   /book     → the candidate is interested; records `offer_accepted` and tells
 *               them we'll be in touch to schedule the office visit.
 *   /decline  → asks "why not?" (optional), records `offer_rejected` + reason.
 * Best-effort writes: in preview / no-token the message still shows.
 */
export default function HireDecisionPage() {
  const { token } = useParams();
  const declined = useLocation().pathname.endsWith('/decline');

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir; const prevLang = html.lang;
    html.dir = 'rtl'; html.lang = 'ar';
    window.scrollTo({ top: 0 });
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);

  return (
    <div className="min-h-screen font-amiri" style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 55%, #E4D2B4 100%)', color: '#4A4E54' }}>
      <ProgressRail active={4} />
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4 py-8">
        {declined ? <Decline token={token} /> : <Interested token={token} />}
      </div>
    </div>
  );
}

function Interested({ token }: { token?: string }) {
  useEffect(() => { void postExperience(token ?? '', 'interested'); }, [token]);
  return (
    <div className="w-full rounded-3xl border bg-white/90 p-8 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#10B98118' }}>
        <CalendarCheck size={38} style={{ color: '#10B981' }} />
      </span>
      <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>شكرًا لاهتمامك!</h1>
      <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
        سجّلنا رغبتك في المقابلة. سنتواصل معك قريبًا لتحديد موعد زيارتك لمكتبنا في الرياض — حي النزهة.
      </p>
      <p className="mt-4 text-sm text-charcoal/50">يمكنك إغلاق هذه الصفحة الآن.</p>
    </div>
  );
}

function Decline({ token }: { token?: string }) {
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'ask' | 'sending' | 'done'>('ask');

  const submit = async () => {
    setPhase('sending');
    await postExperience(token ?? '', 'declined', reason.trim() || undefined);
    setPhase('done');
  };

  if (phase === 'done') {
    return (
      <div className="w-full rounded-3xl border bg-white/90 p-8 text-center shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#B8734F18' }}>
          <CheckCircle2 size={38} className="text-copper" />
        </span>
        <h1 className="mt-4 text-2xl font-bold" style={{ color: '#4A2C2A' }}>شكرًا لوقتك</h1>
        <p className="mx-auto mt-3 max-w-sm text-base leading-loose" style={{ color: '#4A4E54' }}>
          شكرًا لاطّلاعك على العرض ومشاركتنا رأيك. نقدّر وقتك ونتمنى لك التوفيق.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full rounded-3xl border bg-white/90 p-7 shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      <h1 className="text-center text-2xl font-bold" style={{ color: '#4A2C2A' }}>العرض غير مناسب لي</h1>
      <p className="mx-auto mt-2 max-w-sm text-center text-base leading-relaxed" style={{ color: '#4A4E54' }}>
        نودّ أن نتحسّن — ما سبب عدم اهتمامك؟ <span className="text-charcoal/45">(اختياري)</span>
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        placeholder="مثال: الراتب الأساسي أقل من المطلوب، المكان بعيد، لست متفرّغًا حاليًا…"
        className="form-input mt-4 w-full resize-none text-base"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={phase === 'sending'}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-copper px-6 text-base font-bold text-white shadow-lg disabled:opacity-50"
        style={{ minHeight: 52 }}
      >
        {phase === 'sending' ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />} إرسال
      </button>
    </div>
  );
}

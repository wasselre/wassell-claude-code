import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, ArrowLeft, CheckCircle2, Loader2, AlertTriangle, MapPin,
  CalendarDays, Wallet, TrendingUp, Trophy, Clock, Pencil, ShieldCheck,
} from 'lucide-react';
import {
  type Answers, type QuestionId, QUESTIONS, SITUATION_OPTIONS, EXPERIENCE_OPTIONS,
  YES_NO_OPTIONS, visibleQuestions, validateStep, loadAnswers, saveAnswers,
  clearAnswers, getSubmissionId, hasExperience,
} from '@/lib/careers/form';
import { captureAttribution } from '@/lib/careers/attribution';
import { submitApplication } from '@/lib/careers/client';
import CvUploadField from './components/CvUploadField';
import AudioRecorder from './components/AudioRecorder';

type Phase = 'intro' | 'form' | 'review' | 'success';

const situationLabel = (v: string) => SITUATION_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const experienceLabel = (v: string) => EXPERIENCE_OPTIONS.find((o) => o.value === v)?.label ?? '—';
const yesNoLabel = (v: string) => YES_NO_OPTIONS.find((o) => o.value === v)?.label ?? '—';

export default function SalesConsultantApplicationPage() {
  const [phase, setPhase] = useState<Phase>('intro');
  const [answers, setAnswers] = useState<Answers>(() => loadAnswers());
  const [step, setStep] = useState(0);
  const [navDir, setNavDir] = useState<1 | -1>(1);
  const [stepError, setStepError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submissionId = useMemo(() => getSubmissionId(), []);
  const attribution = useMemo(() => captureAttribution(), []);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Fully Arabic + RTL, regardless of any app-wide language setting.
  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir;
    const prevLang = html.lang;
    html.dir = 'rtl';
    html.lang = 'ar';
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);

  const visible = useMemo(() => visibleQuestions(answers), [answers]);
  const total = visible.length;
  const current = visible[Math.min(step, total - 1)];

  const patch = (p: Partial<Answers>) => {
    setAnswers((prev) => {
      const next = { ...prev, ...p };
      saveAnswers(next);
      return next;
    });
    setStepError(null);
  };

  const scrollTop = () => { scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const goNext = () => {
    if (!current) return;
    const err = validateStep(current.id, answers);
    if (err) { setStepError(err); return; }
    if (step >= total - 1) { setPhase('review'); scrollTop(); return; }
    setNavDir(1);
    setStep((s) => s + 1);
    setStepError(null);
    scrollTop();
  };

  const goBack = () => {
    if (step === 0) { setPhase('intro'); return; }
    setNavDir(-1);
    setStep((s) => s - 1);
    setStepError(null);
    scrollTop();
  };

  const startApplication = () => { setPhase('form'); setStep(0); scrollTop(); };

  const editFromReview = (id: QuestionId) => {
    const idx = visible.findIndex((q) => q.id === id);
    if (idx >= 0) { setStep(idx); setPhase('form'); setStepError(null); scrollTop(); }
  };

  const submit = async () => {
    if (submitting || !consent) return;
    // Final full validation across every visible step (defense in depth).
    for (const q of visible) {
      const err = validateStep(q.id, answers);
      if (err) { editFromReview(q.id); setStepError(err); return; }
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitApplication({
        submissionId,
        fullName: answers.full_name.trim(),
        phone: answers.phone.trim(),
        currentSituation: answers.current_situation,
        experienceLevel: answers.experience_level,
        experienceResults: hasExperience(answers) ? answers.experience_results.trim() : '',
        canCommit: answers.can_commit,
        expectedSalary: answers.expected_salary.trim(),
        expectedCommission: answers.expected_commission.trim(),
        additionalNotes: answers.additional_notes.trim(),
        cvPath: answers.cv_path,
        cvName: answers.cv_name,
        audioPath: answers.audio_path,
        audioDurationSec: answers.audio_duration_sec,
        sourceUrl: attribution.sourceUrl,
        utm: attribution.utm,
        clickIds: attribution.clickIds,
      });
      clearAnswers();
      setPhase('success');
      scrollTop();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'تعذّر إرسال الطلب، يرجى المحاولة مرة أخرى.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={scrollRef}
      className="min-h-screen font-amiri"
      style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 55%, #E4D2B4 100%)', color: '#4A4E54' }}
    >
      <style>{`
        @keyframes wassel-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.8)} }
        @keyframes wassel-fwd { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        @keyframes wassel-back { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }
        .wassel-anim-1 { animation: wassel-fwd .34s cubic-bezier(.22,.61,.36,1) both; }
        .wassel-anim--1 { animation: wassel-back .34s cubic-bezier(.22,.61,.36,1) both; }
      `}</style>

      <div className="mx-auto w-full max-w-xl px-4 py-6 sm:py-10">
        <header className="flex justify-center mb-6">
          <img src="/assets/wassel-logo.png" alt="وصل العقارية" className="h-20 sm:h-24" />
        </header>

        {phase === 'intro' && <IntroScreen onStart={startApplication} hasDraft={!!(answers.full_name || answers.phone)} />}

        {phase === 'form' && current && (
          <FormShell
            step={step}
            total={total}
            stepError={stepError}
            navDir={navDir}
            onNext={goNext}
            onBack={goBack}
            isLast={step >= total - 1}
            optional={!!current.optional}
          >
            <QuestionBody
              q={current}
              answers={answers}
              patch={patch}
              submissionId={submissionId}
            />
          </FormShell>
        )}

        {phase === 'review' && (
          <ReviewScreen
            answers={answers}
            visible={visible}
            consent={consent}
            setConsent={setConsent}
            onEdit={editFromReview}
            onBack={() => { setPhase('form'); setStep(total - 1); scrollTop(); }}
            onSubmit={submit}
            submitting={submitting}
            submitError={submitError}
          />
        )}

        {phase === 'success' && <SuccessScreen />}

        <footer className="mt-10 text-center text-xs" style={{ color: '#A79B86' }}>
          وصل العقارية · الرياض
        </footer>
      </div>
    </div>
  );
}

// ── Intro ────────────────────────────────────────────────────────────────────
function IntroScreen({ onStart, hasDraft }: { onStart: () => void; hasDraft: boolean }) {
  const facts: { icon: typeof MapPin; text: string }[] = [
    { icon: MapPin, text: 'العمل حضوري في الرياض – حي النزهة' },
    { icon: CalendarDays, text: 'الدوام 6 أيام أسبوعيًا' },
    { icon: Wallet, text: 'راتب ثابت' },
    { icon: TrendingUp, text: 'عمولات على المبيعات' },
    { icon: Trophy, text: 'مكافآت عند تحقيق الأهداف' },
  ];
  return (
    <div className="wassel-anim-1 rounded-3xl bg-white/80 backdrop-blur border shadow-xl p-7 sm:p-9 text-center" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      <p className="text-sm mb-1" style={{ color: '#B8734F' }}>المسمى الوظيفي</p>
      <h1 className="text-3xl sm:text-4xl font-bold mb-6" style={{ color: '#4A2C2A' }}>مستشار مبيعات عقارية</h1>

      <ul className="space-y-3 text-right mb-6">
        {facts.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-3 rounded-xl px-4 py-3" style={{ background: '#F5EDE0' }}>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: '#B8734F14' }}>
              <Icon size={18} style={{ color: '#B8734F' }} />
            </span>
            <span className="font-bold text-sm" style={{ color: '#4A4E54' }}>{text}</span>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-center gap-2 text-sm mb-7" style={{ color: '#8A8A8A' }}>
        <Clock size={16} />
        <span>الوقت المتوقع لإكمال الطلب: من 3 إلى 5 دقائق</span>
      </div>

      <button
        type="button"
        onClick={onStart}
        className="w-full py-4 rounded-2xl font-bold text-white text-lg shadow-lg transition-transform hover:scale-[1.02]"
        style={{ background: '#B8734F' }}
      >
        {hasDraft ? 'متابعة التقديم' : 'ابدأ التقديم'}
      </button>
    </div>
  );
}

// ── Form shell (progress + card + nav) ───────────────────────────────────────
function FormShell({
  step, total, stepError, navDir, onNext, onBack, isLast, optional, children,
}: {
  step: number; total: number; stepError: string | null; navDir: 1 | -1;
  onNext: () => void; onBack: () => void; isLast: boolean; optional: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 text-sm font-bold" style={{ color: '#8E4E3A' }}>
          <span>{`${step + 1} من ${total}`}</span>
          {optional && <span className="text-xs font-normal" style={{ color: '#A79B86' }}>اختياري</span>}
        </div>
        <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: '#EAD9C2' }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${((step + 1) / total) * 100}%`, background: 'linear-gradient(90deg,#C09B5F,#B8734F)' }} />
        </div>
      </div>

      <div key={step} className={navDir === 1 ? 'wassel-anim-1' : 'wassel-anim--1'}>
        <div className="rounded-3xl bg-white/85 backdrop-blur border shadow-xl p-6 sm:p-8 min-h-[280px] flex flex-col" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
          <div className="flex-1">{children}</div>
          {stepError && (
            <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: '#8E4E3A' }}>
              <AlertTriangle size={16} />
              <span>{stepError}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 font-bold text-sm bg-white border shadow-sm transition-colors hover:bg-cream"
          style={{ borderColor: 'rgba(212,184,150,0.5)', color: '#4A4E54' }}
        >
          <ArrowRight size={18} /> السابق
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex-1 flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 font-bold text-white shadow-lg transition-transform hover:scale-[1.01]"
          style={{ background: '#B8734F' }}
        >
          {isLast ? 'مراجعة الطلب' : 'التالي'} <ArrowLeft size={18} />
        </button>
      </div>
    </div>
  );
}

// ── Per-question body ────────────────────────────────────────────────────────
function QuestionBody({
  q, answers, patch, submissionId,
}: {
  q: (typeof QUESTIONS)[number];
  answers: Answers;
  patch: (p: Partial<Answers>) => void;
  submissionId: string;
}) {
  const title = (
    <h2 className="text-xl sm:text-2xl font-bold leading-relaxed mb-1" style={{ color: '#4A2C2A' }}>{q.title}</h2>
  );
  const hint = q.hint ? <p className="text-sm mb-5" style={{ color: '#A79B86' }}>{q.hint}</p> : <div className="mb-5" />;

  const inputBase = 'w-full rounded-xl border px-4 py-3.5 text-lg bg-white outline-none focus:ring-2 transition';
  const inputStyle = { borderColor: 'rgba(212,184,150,0.7)' } as React.CSSProperties;

  switch (q.id) {
    case 'full_name':
      return (
        <div>{title}{hint}
          <input
            className={inputBase} style={inputStyle}
            value={answers.full_name}
            onChange={(e) => patch({ full_name: e.target.value })}
            placeholder="الاسم الكامل" autoFocus
          />
        </div>
      );
    case 'phone':
      return (
        <div>{title}{hint}
          <input
            className={inputBase} style={{ ...inputStyle, textAlign: 'right' }}
            value={answers.phone}
            onChange={(e) => patch({ phone: e.target.value })}
            placeholder="05XXXXXXXX" inputMode="tel" dir="ltr" autoFocus
          />
        </div>
      );
    case 'current_situation':
      return (
        <div>{title}{hint}
          <ChoiceList options={SITUATION_OPTIONS} value={answers.current_situation} onSelect={(v) => patch({ current_situation: v })} />
        </div>
      );
    case 'experience_level':
      return (
        <div>{title}{hint}
          <ChoiceList options={EXPERIENCE_OPTIONS} value={answers.experience_level} onSelect={(v) => patch({ experience_level: v })} />
        </div>
      );
    case 'experience_results':
      return (
        <div>{title}{hint}
          <textarea
            className={`${inputBase} min-h-[140px] resize-y`} style={inputStyle}
            value={answers.experience_results}
            onChange={(e) => patch({ experience_results: e.target.value })}
            placeholder="اذكر أبرز النتائج والإنجازات…" autoFocus
          />
        </div>
      );
    case 'can_commit':
      return (
        <div>{title}{hint}
          <ChoiceList options={YES_NO_OPTIONS} value={answers.can_commit} onSelect={(v) => patch({ can_commit: v })} />
        </div>
      );
    case 'salary_commission':
      return (
        <div>{title}{hint}
          <div className="space-y-4">
            <label className="block">
              <span className="block text-sm font-bold mb-2" style={{ color: '#4A4E54' }}>الراتب الأساسي المتوقع</span>
              <div className="relative">
                <input
                  className={inputBase} style={{ ...inputStyle, paddingLeft: '3.5rem' }}
                  value={answers.expected_salary}
                  onChange={(e) => patch({ expected_salary: e.target.value.replace(/[^\d.,٠-٩]/g, '') })}
                  placeholder="مثال: 6000" inputMode="numeric"
                />
                <span className="absolute inset-y-0 left-3 flex items-center text-sm" style={{ color: '#A79B86' }}>ر.س</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-sm font-bold mb-2" style={{ color: '#4A4E54' }}>نسبة العمولة المتوقعة</span>
              <div className="relative">
                <input
                  className={inputBase} style={{ ...inputStyle, paddingLeft: '3rem' }}
                  value={answers.expected_commission}
                  onChange={(e) => patch({ expected_commission: e.target.value })}
                  placeholder="مثال: 2%" inputMode="decimal"
                />
                <span className="absolute inset-y-0 left-3 flex items-center text-sm" style={{ color: '#A79B86' }}>٪</span>
              </div>
            </label>
          </div>
        </div>
      );
    case 'cv':
      return (
        <div>{title}{hint}
          <CvUploadField
            submissionId={submissionId}
            value={answers.cv_path ? { path: answers.cv_path, name: answers.cv_name, size: answers.cv_size, mime: answers.cv_mime } : null}
            onChange={(v) => patch(v
              ? { cv_path: v.path, cv_name: v.name, cv_size: v.size, cv_mime: v.mime }
              : { cv_path: '', cv_name: '', cv_size: 0, cv_mime: '' })}
          />
        </div>
      );
    case 'audio':
      return (
        <div>{title}{hint}
          <AudioRecorder
            submissionId={submissionId}
            value={answers.audio_path ? { path: answers.audio_path, durationSec: answers.audio_duration_sec, size: answers.audio_size } : null}
            onChange={(v) => patch(v
              ? { audio_path: v.path, audio_duration_sec: v.durationSec, audio_size: v.size }
              : { audio_path: '', audio_duration_sec: 0, audio_size: 0 })}
          />
        </div>
      );
    case 'additional_notes':
      return (
        <div>{title}{hint}
          <textarea
            className={`${inputBase} min-h-[140px] resize-y`} style={inputStyle}
            value={answers.additional_notes}
            onChange={(e) => patch({ additional_notes: e.target.value })}
            placeholder="أي معلومات إضافية ترغب بمشاركتها…" autoFocus
          />
        </div>
      );
    default:
      return null;
  }
}

function ChoiceList({ options, value, onSelect }: { options: { value: string; label: string }[]; value: string; onSelect: (v: string) => void }) {
  return (
    <div className="space-y-3">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onSelect(o.value)}
            className="w-full flex items-center gap-3 rounded-2xl border-2 px-5 py-4 text-right font-bold transition-all"
            style={{
              borderColor: active ? '#B8734F' : 'rgba(212,184,150,0.6)',
              background: active ? '#B8734F10' : '#fff',
              color: active ? '#4A2C2A' : '#4A4E54',
            }}
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2"
              style={{ borderColor: active ? '#B8734F' : '#D4B896', background: active ? '#B8734F' : 'transparent' }}
            >
              {active && <CheckCircle2 size={16} className="text-white" />}
            </span>
            <span className="flex-1">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────
function ReviewScreen({
  answers, visible, consent, setConsent, onEdit, onBack, onSubmit, submitting, submitError,
}: {
  answers: Answers;
  visible: { id: QuestionId; title: string }[];
  consent: boolean; setConsent: (v: boolean) => void;
  onEdit: (id: QuestionId) => void;
  onBack: () => void; onSubmit: () => void; submitting: boolean; submitError: string | null;
}) {
  const rows: { id: QuestionId; label: string; value: string }[] = visible.map((q) => {
    let value = '—';
    switch (q.id) {
      case 'full_name': value = answers.full_name || '—'; break;
      case 'phone': value = answers.phone || '—'; break;
      case 'current_situation': value = situationLabel(answers.current_situation); break;
      case 'experience_level': value = experienceLabel(answers.experience_level); break;
      case 'experience_results': value = answers.experience_results || '—'; break;
      case 'can_commit': value = yesNoLabel(answers.can_commit); break;
      case 'salary_commission': value = `الراتب: ${answers.expected_salary || '—'} ر.س · العمولة: ${answers.expected_commission || '—'}`; break;
      case 'cv': value = answers.cv_name ? `تم إرفاق: ${answers.cv_name}` : 'لم يتم الإرفاق'; break;
      case 'audio': value = answers.audio_path ? 'تم إرفاق تسجيل صوتي' : 'لم يتم الإرفاق'; break;
      case 'additional_notes': value = answers.additional_notes || '—'; break;
    }
    return { id: q.id, label: q.title, value };
  });

  return (
    <div className="wassel-anim-1">
      <h1 className="text-2xl sm:text-3xl font-bold text-center mb-6" style={{ color: '#4A2C2A' }}>مراجعة طلبك</h1>

      <div className="rounded-3xl bg-white/85 backdrop-blur border shadow-xl divide-y" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        {rows.map((r) => (
          <div key={r.id} className="p-4 sm:p-5 flex items-start gap-3" style={{ borderColor: 'rgba(212,184,150,0.4)' }}>
            <div className="flex-1 min-w-0 text-right">
              <p className="text-xs mb-1" style={{ color: '#A79B86' }}>{r.label}</p>
              <p className="font-bold break-words whitespace-pre-wrap" style={{ color: '#4A2C2A' }}>{r.value}</p>
            </div>
            <button type="button" onClick={() => onEdit(r.id)} className="flex items-center gap-1 text-xs font-bold shrink-0 rounded-lg px-2.5 py-1.5" style={{ color: '#8E4E3A', background: '#F5EDE0' }}>
              <Pencil size={13} /> تعديل
            </button>
          </div>
        ))}
      </div>

      <label className="mt-5 flex items-start gap-3 rounded-2xl border p-4 cursor-pointer bg-white/70" style={{ borderColor: 'rgba(212,184,150,0.6)' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#B8734F]" />
        <span className="text-sm leading-relaxed text-right" style={{ color: '#4A4E54' }}>
          أوافق على أن يتم استخدام المعلومات والملفات التي قدّمتها لغرض مراجعة طلب التوظيف والتواصل معي بشأنه.
        </span>
      </label>

      {submitError && (
        <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: '#8E4E3A' }}>
          <AlertTriangle size={16} /> <span>{submitError}</span>
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button" onClick={onBack} disabled={submitting}
          className="flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 font-bold text-sm bg-white border shadow-sm disabled:opacity-40"
          style={{ borderColor: 'rgba(212,184,150,0.5)', color: '#4A4E54' }}
        >
          <ArrowRight size={18} /> رجوع
        </button>
        <button
          type="button" onClick={onSubmit} disabled={submitting || !consent}
          className="flex-1 flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 font-bold text-white shadow-lg transition-transform enabled:hover:scale-[1.01] disabled:opacity-40"
          style={{ background: '#B8734F' }}
        >
          {submitting ? <><Loader2 size={18} className="animate-spin" /> جارٍ الإرسال…</> : <><ShieldCheck size={18} /> إرسال الطلب</>}
        </button>
      </div>
    </div>
  );
}

// ── Success ──────────────────────────────────────────────────────────────────
function SuccessScreen() {
  return (
    <div className="wassel-anim-1 rounded-3xl bg-white/85 backdrop-blur border shadow-xl p-9 text-center" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
      <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full" style={{ background: '#10B98118' }}>
        <CheckCircle2 size={44} style={{ color: '#10B981' }} />
      </div>
      <h1 className="text-2xl sm:text-3xl font-bold mb-4" style={{ color: '#4A2C2A' }}>تم استلام طلبك بنجاح</h1>
      <p className="text-base leading-loose" style={{ color: '#4A4E54' }}>
        شكرًا لتقديمك على وظيفة مستشار مبيعات عقارية لدى وصل. سيقوم فريقنا بمراجعة طلبك والتواصل مع المرشحين المناسبين.
      </p>
    </div>
  );
}

import type { ReactNode } from 'react';
import {
  Wallet, BedDouble, Home, MapPin, Globe2, MessageCircle, FileText,
  Sparkles, Phone, CalendarClock, ArrowDown, Building2,
} from 'lucide-react';
import { Reveal } from './hireUi';
import { CAROUSEL_PROJECTS, OVERVIEW_RECS, OVERVIEW_SEND_PROJECT } from './hireProjects';
import { CLIENT } from './hireScenario';

/**
 * Recruitment intro — phone-first, three visually distinct sections that explain
 * the opportunity (100+ projects → more customers → more sales & commission),
 * how the system makes it manageable, and how follow-up is auto-organized.
 * Approved Arabic copy is kept exactly; visuals carry the rest. Real Wassel
 * project photos (Riyadh + Dubai) power the carousel and the overview.
 */
export default function OpeningSummary() {
  return (
    <div className="space-y-8 sm:space-y-12">
      <style>{`
        .hire-carousel { scrollbar-width: none; -ms-overflow-style: none; }
        .hire-carousel::-webkit-scrollbar { display: none; }
      `}</style>

      <SectionScale />
      <SectionHow />
      <SectionFollowup />

      {/* transition into the existing workflow */}
      <Reveal>
        <a
          href="#hire-workflow"
          className="mx-auto flex max-w-2xl items-center justify-center gap-2 rounded-2xl bg-copper px-5 py-4 text-center text-base font-bold text-white shadow-lg sm:text-lg"
          style={{ minHeight: 56 }}
        >
          شاهد كيف يحدث ذلك أثناء مكالمة واحدة
          <ArrowDown size={20} className="animate-bounce" />
        </a>
      </Reveal>
    </div>
  );
}

// ── Section 1 — the scale of the opportunity ──────────────────────────────────
function SectionScale() {
  return (
    <Reveal>
      <section className="overflow-hidden rounded-3xl border bg-white/85 shadow-xl backdrop-blur" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        <div className="p-6 sm:p-9">
          {/* prominent 100+ */}
          <div className="flex items-end justify-center gap-3">
            <span className="text-6xl font-extrabold leading-none sm:text-8xl" style={{ color: '#B8734F' }}>+100</span>
            <span className="pb-1.5 text-lg font-bold text-chocolate sm:text-2xl">مشروع</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-xs font-semibold sm:text-sm">
            <span className="rounded-full bg-copper/10 px-2.5 py-1 text-copper">الرياض</span>
            <span className="rounded-full bg-copper/10 px-2.5 py-1 text-copper">دبي</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-sand/30 px-2.5 py-1 text-charcoal/70">
              <Globe2 size={12} /> أسواق جديدة قادمة
            </span>
          </div>

          <h2 className="mt-6 text-center text-2xl font-bold leading-snug sm:text-4xl" style={{ color: '#4A2C2A' }}>
            أكثر من 100 مشروع يمكنك بيعها
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
            العمل على مشروع واحد يحصر فرصك مع العميل ويحد من مبيعاتك. في وصل، لديك أكثر من 100 مشروع في الرياض ودبي،
            وأسواق جديدة مع توسّعنا. خيارات أوسع لعملائك تعني فرصًا أكثر للبيع والعمولة.
          </p>
        </div>

        {/* swipeable real-project carousel (RTL; one card + peek of next) */}
        <div className="hire-carousel flex snap-x snap-mandatory gap-3 overflow-x-auto px-6 pb-6 sm:px-9" dir="rtl">
          {CAROUSEL_PROJECTS.map((p) => (
            <figure key={p.name} className="relative shrink-0 basis-[82%] snap-start overflow-hidden rounded-2xl border border-sand/40 bg-white shadow-md sm:basis-[300px]">
              <img src={p.url} alt={p.name} loading="lazy" className="h-52 w-full object-cover sm:h-56" />
              <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-3">
                <span className="text-base font-bold text-white sm:text-lg">{p.name}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-xs font-bold text-chocolate">
                  <MapPin size={11} /> {p.city}
                </span>
              </figcaption>
            </figure>
          ))}
          {/* expansion end-card */}
          <div className="flex shrink-0 basis-[70%] snap-start flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-copper/30 bg-copper/5 p-5 text-center sm:basis-[220px]">
            <Globe2 size={30} className="text-copper" />
            <span className="text-base font-bold text-chocolate">أسواق جديدة</span>
            <span className="text-sm text-charcoal/60">تتوسّع خياراتك مع توسّع وصل</span>
          </div>
        </div>
      </section>
    </Reveal>
  );
}

// ── Section 2 — how the system makes it possible ──────────────────────────────
function SectionHow() {
  const chips = [
    { icon: <Wallet size={13} />, text: 'حتى 2.1م ر.س' },
    { icon: <BedDouble size={13} />, text: '4–5 غرف' },
    { icon: <Home size={13} />, text: 'فيلا' },
    { icon: <MapPin size={13} />, text: 'شمال الرياض' },
  ];
  return (
    <Reveal>
      <section className="rounded-3xl border bg-cream/60 p-6 shadow-xl backdrop-blur sm:p-9" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        <h2 className="text-center text-2xl font-bold sm:text-4xl" style={{ color: '#4A2C2A' }}>كيف تعمل على كل هذه المشاريع؟</h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
          تسجّل احتياجات العميل، فيرشّح نظام وصل المشاريع المناسبة ويجهّز معلومات المشروع وملف الوحدة للإرسال عبر واتساب.
          لا تحتاج إلى حفظ تفاصيل المشاريع أو البحث عنها.
        </p>

        <div className="mx-auto mt-7 max-w-md space-y-3">
          {/* 1. preferences */}
          <Panel label="احتياجات العميل" icon={<Sparkles size={14} />}>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <span key={c.text} className="inline-flex items-center gap-1 rounded-full border border-sand/50 bg-white px-2.5 py-1 text-xs font-semibold text-charcoal/80 sm:text-sm">
                  <span className="text-copper">{c.icon}</span> {c.text}
                </span>
              ))}
            </div>
          </Panel>

          <Flow>يرشّح وصل المشاريع المناسبة</Flow>

          {/* 2. two recommendations */}
          <div className="grid grid-cols-1 gap-2.5">
            {OVERVIEW_RECS.map((r) => (
              <div key={r.name} className="flex items-center gap-3 rounded-2xl border border-sand/40 bg-white p-2.5 shadow-sm">
                <img src={r.url} alt={r.name} loading="lazy" className="h-16 w-20 shrink-0 rounded-xl object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-base font-bold text-charcoal">{r.name}</span>
                    <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-bold text-green-700">{r.band}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-xs text-charcoal/55">
                    <MapPin size={11} className="text-copper" /> {r.district}، {r.city}
                  </div>
                  <div className="mt-0.5 text-sm font-semibold text-copper">{r.price}</div>
                </div>
              </div>
            ))}
          </div>

          <Flow>يجهّز رسالة واتساب وملف الوحدة</Flow>

          {/* 3. prepared WhatsApp message */}
          <div className="flex justify-end">
            <div className="max-w-[92%] overflow-hidden rounded-2xl rounded-br-md bg-[#D9FDD3] shadow-sm">
              <div className="flex items-center gap-1.5 border-b border-black/5 bg-white/50 px-3 py-1.5 text-[11px] font-semibold text-green-700">
                <MessageCircle size={12} className="text-[#128C7E]" /> رسالة جاهزة للإرسال
              </div>
              <img src={OVERVIEW_SEND_PROJECT.url} alt={OVERVIEW_SEND_PROJECT.name} loading="lazy" className="h-28 w-full object-cover" />
              <div className="px-3 py-2">
                <p className="text-sm leading-relaxed text-charcoal">مشروع {OVERVIEW_SEND_PROJECT.name} — فلل شمال الرياض، تبدأ من 1,900,000 ر.س 🌿</p>
                <span className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-charcoal/80">
                  <FileText size={13} className="text-copper" /> ملف الوحدة — U-1207.pdf
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-charcoal/50 sm:text-sm">نظرة عامة — التفاصيل خطوة بخطوة في الأسفل.</p>
      </section>
    </Reveal>
  );
}

// ── Section 3 — follow-up is already organized ────────────────────────────────
function SectionFollowup() {
  return (
    <Reveal>
      <section className="rounded-3xl border bg-white/85 p-6 shadow-xl backdrop-blur sm:p-9" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
        <h2 className="text-center text-2xl font-bold sm:text-4xl" style={{ color: '#4A2C2A' }}>ركّز على العميل، والنظام ينظّم المتابعة</h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
          وصل يجدول متابعاتك تلقائيًا ويلخّص لك حالة العميل قبل كل تواصل. دورك هو فهم العميل، وبناء ثقته، ومساعدته على اتخاذ القرار.
        </p>

        <div className="mx-auto mt-7 max-w-md space-y-3">
          {/* follow-up task */}
          <div className="overflow-hidden rounded-2xl border border-sand/40 bg-white p-4 shadow-sm" style={{ borderInlineStartWidth: 5, borderInlineStartColor: '#25D366' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-base font-bold text-chocolate">{CLIENT.name}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981]/15 px-2.5 py-1 text-[11px] font-bold text-[#0f7a52]">
                <CalendarClock size={12} /> مجدولة تلقائيًا
              </span>
            </div>
            <div className="mt-1.5 text-sm font-bold text-copper">اتصال لحجز موعد · سكن</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-charcoal/60">الموعد: غدًا · 11:00 صباحًا</span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl bg-copper px-4 text-sm font-bold text-white"
                style={{ minHeight: 44 }}
              >
                <Phone size={15} /> اتصال
              </button>
            </div>
          </div>

          {/* connector */}
          <div className="flex items-center justify-center">
            <span className="rounded-full bg-copper/10 px-3 py-1 text-xs font-semibold text-copper">مع ملخّص جاهز قبل الاتصال</span>
          </div>

          {/* client summary */}
          <div className="rounded-2xl border border-sand/40 bg-cream/40 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles size={15} className="text-copper" />
              <span className="text-sm font-bold text-chocolate">ملخّص العميل</span>
            </div>
            <ul className="list-disc space-y-1 ps-5 text-sm leading-relaxed text-charcoal/85 marker:text-copper">
              <li>مهتم بفلل شمال الرياض، ميزانية حتى 2.1 مليون ر.س.</li>
              <li>أُرسلت له تفاصيل مشروع صفا 20 عبر واتساب، وطلب موعد زيارة.</li>
              <li>الخطوة التالية: تأكيد موعد الزيارة نهاية الأسبوع.</li>
            </ul>
          </div>
        </div>
      </section>
    </Reveal>
  );
}

// ── small helpers ─────────────────────────────────────────────────────────────
function Panel({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-sand/40 bg-white p-3.5 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-copper">
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function Flow({ children }: { children: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-0.5">
      <ArrowDown size={18} className="text-copper/60" />
      <span className="inline-flex items-center gap-1.5 rounded-full bg-copper/10 px-3 py-1 text-xs font-semibold text-copper sm:text-sm">
        <Building2 size={12} /> {children}
      </span>
    </div>
  );
}

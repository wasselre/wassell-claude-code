import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Wallet, Percent, Users, TrendingUp, Clock, MapPin, CalendarDays,
  Laptop, CalendarCheck, XCircle, Lock, Building2,
} from 'lucide-react';
import { ProgressRail } from './hireUi';

// ── Income model (exact spec formula) ─────────────────────────────────────────
const SALARY = 3000;
const PER_SALE = 1800; // 15% of the 12,000 average company commission
interface MonthPoint { m: number; sales: number; commission: number; total: number }
const SERIES: MonthPoint[] = Array.from({ length: 12 }, (_, i) => {
  const m = i + 1;
  const sales = m === 1 ? 0 : Math.pow(1.2, m - 2);
  const commission = sales * PER_SALE;
  return { m, sales, commission, total: SALARY + commission };
});
const sar = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Stage 4 — the offer (العرض). Compensation, an interactive first-year income
 * graph, the year-one target, working arrangements, and the interested/decline
 * actions. Phone-first, Arabic/RTL. Figures are illustrative averages, not caps
 * or guarantees. Unresolved business terms (payout timing, remote eligibility,
 * health insurance) are deliberately NOT presented here.
 */
export default function HireOfferPage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const base = `/careers/experience/${token ?? 'preview'}`;

  useEffect(() => {
    const html = document.documentElement;
    const prevDir = html.dir; const prevLang = html.lang;
    html.dir = 'rtl'; html.lang = 'ar';
    window.scrollTo({ top: 0 });
    return () => { html.dir = prevDir; html.lang = prevLang; };
  }, []);

  return (
    <div className="min-h-screen font-amiri" style={{ background: 'radial-gradient(ellipse at top, #FAF7F2 0%, #F1E6D4 60%, #E4D2B4 100%)', color: '#4A4E54' }}>
      <ProgressRail active={3} />
      <div className="mx-auto w-full max-w-xl px-4 py-6">
        <header className="mb-6 flex flex-col items-center text-center">
          <img src="/assets/wassel-logo.png" alt="وصل العقارية" className="h-12 sm:h-14" />
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-copper/30 bg-white/70 px-3 py-1 text-xs font-bold text-copper">
            <Lock size={12} /> تجربة خاصة بالمرشّحين
          </span>
        </header>

        {/* 1 · opening + compensation */}
        <h1 className="text-center text-3xl font-bold sm:text-4xl" style={{ color: '#4A2C2A' }}>تفاصيل العمل والدخل</h1>
        <p className="mx-auto mt-3 max-w-md text-center text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
          راتب ثابت، وعمولة مرتبطة بمبيعاتك.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <CompCard icon={<Wallet size={20} />} value="3,000 ريال" label="راتب شهري ثابت" />
          <CompCard icon={<Percent size={20} />} value="15%" label="حصتك من عمولة وصل على كل صفقة" />
          <CompCard icon={<Users size={20} />} value="300 عميل محتمل على الأقل" label="شهريًا" small />
        </div>

        <div className="mt-3 rounded-2xl border border-copper/25 bg-copper/5 p-4 text-center text-sm leading-relaxed sm:text-base" style={{ color: '#4A4E54' }}>
          تحصل على <b>15% من عمولة وصل</b> على الصفقة، وليست 15% من سعر العقار.
        </div>

        <div className="mt-3 rounded-2xl border border-sand/40 bg-white p-4 shadow-sm">
          <ExampleRow label="متوسط عمولة وصل للصفقة" value="12,000 ريال" />
          <ExampleRow label="حصتك بنسبة 15%" value="1,800 ريال" strong />
          <p className="mt-2 text-xs text-charcoal/55">رقم 12,000 ريال متوسط تقريبي للتوضيح، ويختلف من صفقة لأخرى.</p>
        </div>

        {/* 2 · interactive income graph */}
        <h2 className="mt-9 text-center text-xl font-bold sm:text-2xl" style={{ color: '#4A2C2A' }}>
          كيف يمكن أن يتطور دخلك خلال عامك الأول؟
        </h2>
        <IncomeChart />
        <p className="mt-3 text-center text-xs leading-relaxed text-charcoal/60 sm:text-sm">
          نموذج توضيحي يفترض أول عملية بيع في الشهر الثاني، ثم نمو متوسط المبيعات 20% شهريًا. النتائج الفعلية تختلف حسب الأداء والصفقات.
        </p>
        <p className="mt-1.5 text-center text-[11px] leading-relaxed text-charcoal/45">
          الكسور تمثّل متوسط معدل المبيعات في النموذج، لا أجزاء من صفقات مكتملة.
        </p>

        {/* 3 · year-one target */}
        <div className="mt-8 rounded-3xl border-2 border-copper/30 bg-white p-5 shadow-md">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-copper/10 text-copper"><TrendingUp size={18} /></span>
            <h3 className="text-lg font-bold text-chocolate sm:text-xl">هدف نهاية العام الأول</h3>
          </div>
          <div className="mt-3 rounded-2xl bg-cream/50 p-3 text-center text-base font-bold text-chocolate sm:text-lg">
            300 عميل محتمل × 2% تحويل = 6 مبيعات شهريًا
          </div>
          <div className="mt-3 text-center">
            <div className="text-base font-semibold text-charcoal sm:text-lg">3,000 ريال راتب + 10,800 ريال عمولات</div>
            <div className="mt-1 text-2xl font-extrabold" style={{ color: '#B8734F' }}>13,800 ريال</div>
            <div className="text-sm text-charcoal/60">إجمالي شهري عند تحقيق 6 مبيعات بمتوسط العمولة المذكور</div>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-charcoal/70">
            نستهدف وصولك تدريجيًا إلى هذا المتوسط بحلول نهاية عامك الأول. لا نتوقع منك تحقيقه في الشهر الأول.
          </p>
          <p className="mt-3 rounded-xl bg-cream/40 p-3 text-xs leading-relaxed text-charcoal/55">
            النموذج أعلاه يتجاوز 6 مبيعات شهريًا لأول مرة في الشهر ١٢ (نحو 6.19 مبيعة ≈ 14,145 ريال). أما 6 مبيعات بالضبط فتعطي 13,800 ريال. الرقمان توضيحيان ولا يمثّلان حدًا للدخل أو نتيجة مضمونة.
          </p>
        </div>

        {/* 4 · working arrangements */}
        <h2 className="mt-9 text-center text-xl font-bold sm:text-2xl" style={{ color: '#4A2C2A' }}>ترتيبات العمل</h2>
        <div className="mt-4 space-y-2.5">
          <ArrangeRow icon={<CalendarDays size={18} />} label="أيام العمل" value="6 أيام أسبوعيًا" />
          <ArrangeRow icon={<Clock size={18} />} label="ساعات العمل" value="من 12 ظهرًا إلى 8 مساءً" />
          <ArrangeRow icon={<MapPin size={18} />} label="مقر العمل" value="الرياض، حي النزهة" />
          <ArrangeRow icon={<Laptop size={18} />} label="العمل عن بُعد" value="تبدأ من المكتب، مع إمكانية الانتقال للعمل عن بُعد بعد إثبات الأداء واعتماد الانتقال" />
        </div>

        {/* 5 · closing + decision */}
        <div className="mt-9 rounded-3xl border bg-chocolate p-6 text-center shadow-xl sm:p-8" style={{ borderColor: 'rgba(212,184,150,0.4)' }}>
          <p className="mx-auto max-w-lg text-base leading-loose text-cream sm:text-lg">
            لديك عملاء محتملون كل شهر، وأكثر من 100 مشروع تستطيع بيعها، ونظام يدعمك أثناء التواصل والمتابعة.
            نمو دخلك يرتبط بقدرتك على تحويل هذه الفرص إلى مبيعات.
          </p>
        </div>

        <div className="mt-5 space-y-3">
          <button
            type="button"
            onClick={() => navigate(`${base}/book`)}
            className="inline-flex w-full items-center justify-center gap-2.5 rounded-2xl px-6 text-lg font-bold text-white shadow-lg transition-transform hover:scale-[1.01]"
            style={{ background: '#B8734F', minHeight: 56 }}
          >
            <CalendarCheck size={20} /> مهتم — احجز مقابلة
          </button>
          <p className="text-center text-xs text-charcoal/55">حجز المقابلة تعبير عن اهتمامك، وليس قبولًا لعقد عمل.</p>
          <button
            type="button"
            onClick={() => navigate(`${base}/decline`)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border bg-white px-6 text-base font-bold shadow-sm"
            style={{ borderColor: 'rgba(212,184,150,0.6)', color: '#4A4E54', minHeight: 52 }}
          >
            <XCircle size={18} /> العرض غير مناسب لي
          </button>
        </div>

        <footer className="mt-10 text-center text-xs" style={{ color: '#A79B86' }}>وصل العقارية · الرياض</footer>
      </div>
    </div>
  );
}

// ── cards / rows ──────────────────────────────────────────────────────────────
function CompCard({ icon, value, label, small }: { icon: ReactNode; value: string; label: string; small?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-sand/40 bg-white p-4 text-center shadow-sm">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-copper/10 text-copper">{icon}</span>
      <div className={`font-extrabold text-chocolate ${small ? 'text-lg' : 'text-2xl'}`}>{value}</div>
      <div className="mt-1 text-sm text-charcoal/60">{label}</div>
    </div>
  );
}

function ExampleRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-sand/30 py-2 last:border-0">
      <span className="text-sm text-charcoal/60 sm:text-base">{label}</span>
      <span className={`text-base sm:text-lg ${strong ? 'font-extrabold text-copper' : 'font-bold text-charcoal'}`}>{value}</span>
    </div>
  );
}

function ArrangeRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-sand/40 bg-white p-3.5 shadow-sm">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copper/10 text-copper">{icon}</span>
      <div className="min-w-0">
        <div className="text-sm font-bold text-chocolate">{label}</div>
        <div className="mt-0.5 text-sm leading-relaxed text-charcoal/75 sm:text-base">{value}</div>
      </div>
    </div>
  );
}

// ── interactive income chart (SVG; touch + keyboard, no hover reliance) ────────
function IncomeChart() {
  const [month, setMonth] = useState(12);
  const sel = SERIES[month - 1]!;

  // geometry
  const W = 340, H = 240, L = 46, R = 12, T = 14, Bm = 30;
  const x0 = L, x1 = W - R, y0 = H - Bm, y1 = T;
  const yMax = 15000;
  const xOf = (m: number) => x0 + ((m - 1) / 11) * (x1 - x0);
  const yOf = (v: number) => y0 - (Math.min(v, yMax) / yMax) * (y0 - y1);
  const totalPts = SERIES.map((p) => `${xOf(p.m).toFixed(1)},${yOf(p.total).toFixed(1)}`).join(' ');
  const grid = [0, 5000, 10000, 15000];

  const ticks = useMemo(() => SERIES.map((p) => ({ m: p.m, x: xOf(p.m) })), []); // eslint-disable-line

  return (
    <div className="mt-4 rounded-3xl border border-sand/40 bg-white p-3 shadow-sm sm:p-4">
      {/* legend */}
      <div className="mb-1 flex items-center justify-center gap-4 text-xs sm:text-sm">
        <span className="inline-flex items-center gap-1.5 text-charcoal/70"><span className="inline-block h-2.5 w-4 rounded-full" style={{ background: '#B8734F' }} /> إجمالي الدخل التقديري</span>
        <span className="inline-flex items-center gap-1.5 text-charcoal/70"><span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: '#9CA3AF' }} /> الراتب الثابت</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="رسم بياني لتطور الدخل خلال العام الأول">
        {/* gridlines + y labels */}
        {grid.map((g) => (
          <g key={g}>
            <line x1={x0} y1={yOf(g)} x2={x1} y2={yOf(g)} stroke="#EDE1CF" strokeWidth="1" />
            <text x={x0 - 6} y={yOf(g) + 3} textAnchor="end" fontSize="9" fill="#9C907C" fontFamily="Amiri, serif">{g.toLocaleString('en-US')}</text>
          </g>
        ))}
        {/* salary line */}
        <line x1={x0} y1={yOf(SALARY)} x2={x1} y2={yOf(SALARY)} stroke="#9CA3AF" strokeWidth="2" strokeDasharray="5 4" />
        {/* total income line */}
        <polyline points={totalPts} fill="none" stroke="#B8734F" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* selected guide */}
        <line x1={xOf(month)} y1={y1} x2={xOf(month)} y2={y0} stroke="#B8734F" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
        {/* dots */}
        {SERIES.map((p) => (
          <circle key={p.m} cx={xOf(p.m)} cy={yOf(p.total)} r={p.m === month ? 5 : 3} fill={p.m === month ? '#8E4E3A' : '#B8734F'} stroke="#fff" strokeWidth="1.5" />
        ))}
        {/* x labels */}
        {ticks.map((t) => (
          <text key={t.m} x={t.x} y={H - 10} textAnchor="middle" fontSize="9" fill={t.m === month ? '#8E4E3A' : '#9C907C'} fontWeight={t.m === month ? 700 : 400} fontFamily="Amiri, serif">{t.m}</text>
        ))}
        {/* generous tap targets per month */}
        {SERIES.map((p) => (
          <rect
            key={p.m}
            x={xOf(p.m) - (x1 - x0) / 22}
            y={y1}
            width={(x1 - x0) / 11}
            height={y0 - y1}
            fill="transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => setMonth(p.m)}
          >
            <title>{`الشهر ${p.m}`}</title>
          </rect>
        ))}
      </svg>

      {/* month selector — keyboard-accessible */}
      <div className="mt-1 flex items-center gap-3 px-1" style={{ minHeight: 44 }}>
        <span className="text-xs font-semibold text-charcoal/60">الشهر ١</span>
        <input
          type="range" min={1} max={12} value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          aria-label="اختر شهر العمل"
          className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-sand/50 accent-[#B8734F]"
        />
        <span className="text-xs font-semibold text-charcoal/60">١٢</span>
      </div>

      {/* breakdown */}
      <div className="mt-3 rounded-2xl bg-cream/40 p-3.5">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-copper">
          <Building2 size={14} /> الشهر {sel.m} من العمل
        </div>
        <BreakRow label="متوسط المبيعات في النموذج" value={sel.sales.toFixed(2)} />
        <BreakRow label="الراتب الثابت" value={`${sar(SALARY)} ريال`} />
        <BreakRow label="العمولات التقديرية" value={`${sar(sel.commission)} ريال`} />
        <BreakRow label="إجمالي الدخل التقديري" value={`${sar(sel.total)} ريال`} strong />
      </div>
    </div>
  );
}

function BreakRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-sand/30 py-1.5 last:border-0">
      <span className="text-sm text-charcoal/60">{label}</span>
      <span className={`${strong ? 'text-lg font-extrabold text-copper' : 'text-base font-bold text-charcoal'}`}>{value}</span>
    </div>
  );
}

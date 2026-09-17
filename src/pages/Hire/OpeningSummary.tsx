import type { ReactNode } from 'react';
import {
  ChevronLeft, Building2, Users, TrendingUp, MapPin, Globe2, Sparkles,
  CheckCircle2, HelpCircle,
} from 'lucide-react';
import { Reveal } from './hireUi';

/**
 * The opening value summary — shown BEFORE the workflow steps.
 *
 * The central idea the candidate must grasp first: at Wassel a salesperson isn't
 * limited to one project / city / country — they can sell across 100+ current
 * projects, and the system makes that possible without memorizing everything.
 * This section is intentionally the visual anchor of the page (stronger than the
 * individual workflow steps, which are the evidence below it).
 */

const NEEDS = [
  'ما المشاريع المناسبة لهذا العميل؟',
  'ما المعلومات التي يجب عرضها؟',
  'ما الوحدات المتاحة؟',
  'ما الملفات التي يمكن إرسالها؟',
  'ماذا حدث في التواصل السابق؟',
  'متى يجب متابعة العميل؟',
  'ما الخطوة التالية؟',
];

export default function OpeningSummary() {
  return (
    <div className="space-y-10 sm:space-y-14">
      {/* ── 1. The framing: one project → 100+ ─────────────────────────── */}
      <Reveal>
        <div className="rounded-3xl border bg-white/85 p-7 shadow-xl backdrop-blur sm:p-11" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
          <h1 className="text-center text-3xl font-extrabold leading-snug sm:text-5xl" style={{ color: '#4A2C2A' }}>
            من مشروع واحد إلى أكثر من 100 مشروع
          </h1>

          <div className="mx-auto mt-6 max-w-2xl space-y-4 text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
            <p>عادةً يعمل موظف المبيعات العقارية على مشروع واحد فقط.</p>
            <p>
              السبب ليس عدم وجود مشاريع أخرى يمكنه بيعها، بل لأن كل مشروع يحتوي على كمية كبيرة من المعلومات:
              الأسعار، المواقع، أنواع الوحدات، المساحات، المخططات، الصور، الفيديوهات، البروشورات، والمخزون المتاح.
            </p>
            <p>
              من الصعب على أي شخص أن يحفظ معلومات عدد كبير من المشاريع، ويتابع تحديثاتها، ويعرف المشروع المناسب لكل عميل.
              لذلك ينتهي به الأمر إلى بيع المشروع الذي يعرفه فقط.
            </p>
            <p className="font-semibold" style={{ color: '#4A2C2A' }}>
              وهذا يحد من عدد العملاء الذين يستطيع خدمتهم، وعدد فرص البيع التي يستطيع الاستفادة منها.
            </p>
          </div>

          {/* the value sequence */}
          <div className="mt-8">
            <SequenceBand />
          </div>
        </div>
      </Reveal>

      {/* ── 2. In Wassel you don't work on one project ─────────────────── */}
      <Reveal>
        <div className="rounded-3xl border bg-chocolate p-7 text-cream shadow-xl sm:p-11" style={{ borderColor: 'rgba(212,184,150,0.4)' }}>
          <h2 className="text-center text-2xl font-bold sm:text-4xl">في وصل، أنت لا تعمل على مشروع واحد</h2>
          <div className="mx-auto mt-5 max-w-2xl space-y-4 text-base leading-loose text-cream/90 sm:text-lg">
            <p>
              يوجد حاليًا في وصل أكثر من 100 مشروع يمكنك بيعها. أنت لا ترتبط بمشروع واحد، أو مدينة واحدة، أو دولة واحدة.
              تستطيع العمل على مشاريعنا الحالية، ومع توسع وصل وإضافة مشاريع وأسواق جديدة، تتوسع معك الخيارات التي تستطيع تقديمها للعملاء.
            </p>
            <p>
              قد يتواصل معك عميل يبحث في الرياض، وعميل آخر يبحث في دبي، ومستقبلًا يمكن أن يتواصل معك عميل يبحث عن عقار في سوق آخر.
              قدرتك على البيع لا تعتمد على عدد المشاريع التي تستطيع حفظها.
            </p>
          </div>

          {/* stat figures */}
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={<Building2 size={18} />} big="+100" label="مشروع متاح" />
            <Stat icon={<MapPin size={18} />} big="الرياض ودبي" label="حاليًا" />
            <Stat icon={<Globe2 size={18} />} big="أسواق جديدة" label="مع توسع وصل" />
            <Stat icon={<TrendingUp size={18} />} big="لا مشروع واحد" label="يحدد فرصك" />
          </div>
        </div>
      </Reveal>

      {/* ── 3. How can you work on all of these? ───────────────────────── */}
      <Reveal>
        <div className="rounded-3xl border bg-white/85 p-7 shadow-xl backdrop-blur sm:p-11" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
          <h2 className="text-center text-2xl font-bold sm:text-4xl" style={{ color: '#4A2C2A' }}>
            كيف تستطيع العمل على كل هذه المشاريع؟
          </h2>
          <div className="mx-auto mt-5 max-w-2xl space-y-4 text-base leading-loose sm:text-lg" style={{ color: '#4A4E54' }}>
            <p className="text-center text-xl font-bold" style={{ color: '#B8734F' }}>لا تحتاج إلى حفظ معلوماتها.</p>
            <p>
              نظام وصل يحفظ بيانات المشاريع والوحدات، ويطابق احتياجات العميل مع الخيارات المتاحة، ويعرض لك المشاريع المناسبة أثناء المكالمة.
            </p>
            <p>
              كما يحفظ النظام سجل كل عميل، وينظم المتابعات المطلوبة، ويحدد موعد التواصل القادم، ويجهز لك ملخصًا قبل كل متابعة.
            </p>
            <p>لذلك لا تحتاج إلى معرفة كل مشروع مسبقًا، أو تذكر كل ما حدث مع كل عميل.</p>
          </div>
        </div>
      </Reveal>

      {/* ── 4. What do YOU need? ───────────────────────────────────────── */}
      <Reveal>
        <div className="rounded-3xl border bg-white/85 p-7 shadow-xl backdrop-blur sm:p-11" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
          <h2 className="text-center text-2xl font-bold sm:text-4xl" style={{ color: '#4A2C2A' }}>ما الذي تحتاج إليه أنت؟</h2>

          <div className="mx-auto mt-6 max-w-3xl rounded-2xl bg-copper/10 p-6 text-center sm:p-8">
            <p className="text-xl font-bold leading-relaxed sm:text-2xl" style={{ color: '#4A2C2A' }}>
              تحتاج إلى أن تعرف كيف تتواصل مع العميل، وتفهم احتياجه، وتبني معه علاقة قائمة على الثقة.
            </p>
          </div>

          <p className="mt-6 text-center text-base font-semibold sm:text-lg" style={{ color: '#4A4E54' }}>
            ثم يساعدك وصل في كل ما تحتاج إليه أثناء هذا التواصل:
          </p>

          <div className="mx-auto mt-4 grid max-w-3xl grid-cols-1 gap-2.5 sm:grid-cols-2">
            {NEEDS.map((q) => (
              <div key={q} className="flex items-center gap-2.5 rounded-xl border border-sand/50 bg-white px-4 py-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-copper/10 text-copper">
                  <HelpCircle size={15} />
                </span>
                <span className="flex-1 text-sm font-medium sm:text-base" style={{ color: '#4A4E54' }}>{q}</span>
                <CheckCircle2 size={17} className="shrink-0 text-green-600" />
              </div>
            ))}
          </div>

          {/* bridge into the workflow */}
          <div className="mt-8 flex items-center justify-center gap-2 text-center">
            <Sparkles size={16} className="text-copper" />
            <p className="max-w-2xl text-base font-semibold leading-relaxed sm:text-lg" style={{ color: '#4A2C2A' }}>
              في الخطوات التالية، سترى كيف يدير وصل هذه التفاصيل أثناء عملك، من أول مكالمة مع العميل وحتى المتابعة التالية.
            </p>
          </div>
        </div>
      </Reveal>
    </div>
  );
}

// ── The value sequence: one project → 100+ → more clients → more sales ────────
function SequenceBand() {
  const nodes = [
    { label: 'مشروع واحد', icon: <Building2 size={18} />, tone: 'muted' },
    { label: 'أكثر من 100 مشروع', icon: <Building2 size={18} />, tone: 'sand' },
    { label: 'فرص عملاء أكثر', icon: <Users size={18} />, tone: 'gold' },
    { label: 'فرص بيع أكثر', icon: <TrendingUp size={18} />, tone: 'copper' },
  ] as const;
  const toneCls: Record<string, string> = {
    muted: 'bg-white text-charcoal/50 border-sand/50',
    sand: 'bg-sand/25 text-chocolate border-sand',
    gold: 'bg-gold/20 text-chocolate border-gold/50',
    copper: 'bg-copper text-white border-copper shadow-md',
  };
  return (
    <div className="flex flex-wrap items-stretch justify-center gap-2 sm:gap-3">
      {nodes.map((n, i) => (
        <div key={n.label} className="flex items-center gap-2 sm:gap-3">
          <div className={`flex min-w-[8.5rem] flex-col items-center gap-1.5 rounded-2xl border px-3 py-3 text-center sm:min-w-[10rem] sm:py-4 ${toneCls[n.tone]}`}>
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/5">{n.icon}</span>
            <span className="text-sm font-bold sm:text-base">{n.label}</span>
          </div>
          {i < nodes.length - 1 && <ChevronLeft size={20} className="shrink-0 text-copper/50" />}
        </div>
      ))}
    </div>
  );
}

function Stat({ icon, big, label }: { icon: ReactNode; big: string; label: string }) {
  return (
    <div className="rounded-2xl bg-white/10 p-4 text-center ring-1 ring-white/15">
      <span className="mx-auto mb-1.5 flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 text-cream">{icon}</span>
      <div className="text-lg font-extrabold text-white sm:text-2xl">{big}</div>
      <div className="mt-0.5 text-xs text-cream/70 sm:text-sm">{label}</div>
    </div>
  );
}


import type { ReactNode } from 'react';
import {
  Sparkles, Phone, MessageCircle, CalendarClock, Star, Activity, ClipboardList,
  History, PhoneCall, User,
} from 'lucide-react';
import { Screen } from '../hireUi';
import { CLIENT, CLIENT_SUMMARY } from '../hireScenario';

const TILES: { icon: typeof Phone; label: string; value: string }[] = [
  { icon: CalendarClock, label: 'الخطوة القادمة', value: 'غدًا 11:00 ص' },
  { icon: Activity, label: 'آخر نشاط', value: 'أمس' },
  { icon: ClipboardList, label: 'المتابعات', value: '3' },
  { icon: Phone, label: 'المكالمات', value: '2' },
  { icon: MessageCircle, label: 'واتساب', value: '6' },
  { icon: Star, label: 'الاهتمام', value: 'مرتفع' },
];

/** Step 7 — opening the task; Wassel reads the whole history and briefs the rep. */
export default function StepSummary() {
  return (
    <Screen title="ملف العميل — نظرة عامة" icon={<User size={16} />} bodyClassName="p-4 sm:p-6 space-y-4">
      {/* profile header */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-extrabold text-chocolate sm:text-2xl">{CLIENT.name}</h1>
          <span className="rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ backgroundColor: '#B8734F24', color: '#B8734F' }}>{CLIENT.status}</span>
          <span className="rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ backgroundColor: '#4A4E5424', color: '#4A4E54' }}>{CLIENT.stage}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-charcoal/60 sm:text-base">
          <span className="font-bold text-copper">{CLIENT.code}</span>
          <span dir="ltr">{CLIENT.phone}</span>
          <span>المدينة: {CLIENT.city}</span>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {TILES.map(({ icon: Icon, label, value }) => (
          <div key={label} className="card p-4">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-charcoal/50 sm:text-xs">
              <Icon size={14} className="text-copper" /> {label}
            </div>
            <div className="mt-1 text-base font-bold text-chocolate">{value}</div>
          </div>
        ))}
      </div>

      {/* AI summary */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={16} className="text-copper" />
          <h3 className="text-base font-bold text-chocolate">ملخّص العميل</h3>
          <span className="ms-auto text-xs text-charcoal/45">أنشأه الذكاء الاصطناعي من سجلّ العميل</span>
        </div>
        <Briefing text={CLIENT_SUMMARY} />
        <div className="mt-4 flex flex-wrap gap-2">
          <HistoryBtn icon={<History size={15} />}>المتابعات السابقة</HistoryBtn>
          <HistoryBtn icon={<PhoneCall size={15} />}>المكالمات السابقة</HistoryBtn>
          <HistoryBtn icon={<MessageCircle size={15} />}>محادثة واتساب</HistoryBtn>
        </div>
      </section>
    </Screen>
  );
}

function HistoryBtn({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-sand px-3.5 py-2 text-sm font-semibold text-charcoal sm:text-base">
      {icon} {children}
    </span>
  );
}

/** Mini-markdown briefing renderer (mirrors ClientContextCard `Briefing`). */
function Briefing({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flush = (key: string) => {
    if (bullets.length) {
      blocks.push(
        <ul key={key} className="list-disc space-y-1 ps-5 marker:text-copper">
          {bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}
        </ul>,
      );
      bullets = [];
    }
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { flush(`u${i}`); return; }
    if (line.startsWith('- ')) { bullets.push(line.slice(2)); return; }
    flush(`u${i}`);
    const heading = /^\*\*(.+)\*\*$/.exec(line);
    if (heading) {
      blocks.push(<p key={`h${i}`} className="font-bold text-chocolate">{heading[1]}</p>);
    } else {
      blocks.push(<p key={`p${i}`}>{inline(line)}</p>);
    }
  });
  flush('end');

  return <div className="space-y-2 text-sm leading-relaxed text-charcoal/90 sm:text-base">{blocks}</div>;
}

function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    return m ? <strong key={i} className="font-semibold text-chocolate">{m[1]}</strong> : <span key={i}>{p}</span>;
  });
}

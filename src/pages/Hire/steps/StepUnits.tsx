import { useState } from 'react';
import { FileText, Send, LayoutGrid, CheckCircle2 } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import { Screen, Row } from '../hireUi';
import { UNITS, SELECTED_UNIT_CODE, PROJECT, type UnitRow } from '../hireScenario';

const sar = (n: number) => `${n.toLocaleString('en-US')} ر.س`;

/** Step 5 — browse the project's units, pick one, preview its floor plan, send it. */
export default function StepUnits() {
  const [selected, setSelected] = useState<string>(SELECTED_UNIT_CODE);
  const [sent, setSent] = useState(false);
  const unit = UNITS.find((u) => u.code === selected) ?? UNITS[0]!;

  const pick = (code: string) => { setSelected(code); setSent(false); };

  return (
    <Screen title="المشروع — الوحدات المتاحة" icon={<LayoutGrid size={16} />} bodyClassName="p-4 sm:p-6">
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* units table */}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm sm:text-base">
            <thead>
              <tr className="border-b border-sand/50 text-xs text-charcoal/40 sm:text-sm">
                <th className="p-3 text-start font-medium">الكود</th>
                <th className="p-3 text-start font-medium">النوع</th>
                <th className="p-3 text-end font-medium">المساحة</th>
                <th className="p-3 text-center font-medium">الغرف</th>
                <th className="p-3 text-end font-medium">السعر</th>
                <th className="p-3 text-center font-medium">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {UNITS.map((u) => (
                <tr
                  key={u.code}
                  onClick={() => pick(u.code)}
                  className={`cursor-pointer border-b border-sand/30 last:border-0 ${
                    u.code === selected ? 'bg-copper/10' : 'hover:bg-cream/50'
                  }`}
                >
                  <td className="p-3 font-bold text-charcoal">{u.code}</td>
                  <td className="p-3 text-charcoal/80">{u.type}</td>
                  <td className="p-3 text-end text-charcoal/80">{u.area} م²</td>
                  <td className="p-3 text-center text-charcoal/80">{u.bedrooms}</td>
                  <td className="p-3 text-end font-medium text-charcoal">{sar(u.price)}</td>
                  <td className="p-3 text-center"><Badge label={u.status.label} color={u.status.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* selected unit + floor plan */}
        <UnitPanel unit={unit} sent={sent} onSend={() => setSent(true)} />
      </div>
    </Screen>
  );
}

function UnitPanel({ unit, sent, onSend }: { unit: UnitRow; sent: boolean; onSend: () => void }) {
  return (
    <div className="card space-y-4 p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xl font-bold text-charcoal">{unit.code}</div>
          <div className="text-xs text-charcoal/50">{PROJECT.name}</div>
        </div>
        <Badge label={unit.status.label} color={unit.status.color} />
      </div>

      <div>
        <Row label="النوع" value={unit.type} />
        <Row label="المساحة" value={`${unit.area} م²`} />
        <Row label="غرف النوم" value={unit.bedrooms} />
        <Row label="دورات المياه" value={unit.bathrooms} />
        <Row label="السعر" value={<span className="font-bold text-copper">{sar(unit.price)}</span>} />
      </div>

      <div>
        <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-copper">المخطط</h3>
        <FloorPlan />
      </div>

      {sent ? (
        <div className="hire-fade flex items-center justify-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-sm font-bold text-green-700 sm:text-base">
          <CheckCircle2 size={18} /> تم إرسال ملف الوحدة والمخطط عبر واتساب
        </div>
      ) : (
        <button
          type="button"
          onClick={onSend}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-copper px-4 py-3 text-sm font-bold text-white transition-transform hover:scale-[1.01] sm:text-base"
        >
          <Send size={16} /> إرسال المخطط والتفاصيل عبر واتساب
        </button>
      )}
      <div className="flex items-center justify-center gap-1.5 text-xs text-charcoal/50">
        <FileText size={13} /> ملف PDF يُنشأ تلقائيًا من بيانات الوحدة
      </div>
    </div>
  );
}

/** A self-contained, realistic villa floor-plan illustration (no external asset). */
function FloorPlan() {
  const label = (x: number, y: number, t: string) => (
    <text x={x} y={y} textAnchor="middle" fontSize="9" fill="#8E4E3A" fontFamily="Amiri, serif">{t}</text>
  );
  return (
    <div className="overflow-hidden rounded-xl border border-sand/50 bg-white p-2">
      <svg viewBox="0 0 320 220" className="h-auto w-full" role="img" aria-label="مخطط الوحدة">
        <rect x="6" y="6" width="308" height="208" fill="#FAF7F2" stroke="#B8734F" strokeWidth="2" />
        <g stroke="#C0A67E" strokeWidth="1.5" fill="none">
          <line x1="160" y1="6" x2="160" y2="130" />
          <line x1="6" y1="130" x2="314" y2="130" />
          <line x1="90" y1="130" x2="90" y2="214" />
          <line x1="210" y1="130" x2="210" y2="214" />
          <line x1="160" y1="70" x2="314" y2="70" />
        </g>
        <g fillOpacity="0.35">
          <rect x="7" y="7" width="152" height="122" fill="#EDD9C4" />
          <rect x="161" y="7" width="152" height="62" fill="#E5D5BD" />
          <rect x="161" y="71" width="152" height="58" fill="#F5EDE0" />
          <rect x="7" y="131" width="82" height="82" fill="#F5EDE0" />
          <rect x="211" y="131" width="102" height="82" fill="#EDD9C4" />
        </g>
        {label(83, 70, 'المجلس')}
        {label(237, 42, 'الصالة')}
        {label(237, 103, 'المطبخ')}
        {label(48, 175, 'حمام')}
        {label(150, 175, 'غرفة نوم')}
        {label(262, 175, 'غرفة النوم الرئيسية')}
        <rect x="140" y="208" width="40" height="6" fill="#B8734F" />
        <text x="160" y="205" textAnchor="middle" fontSize="8" fill="#4A4E54" fontFamily="Amiri, serif">المدخل</text>
      </svg>
    </div>
  );
}

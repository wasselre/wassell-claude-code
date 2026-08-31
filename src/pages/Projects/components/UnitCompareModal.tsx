import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import { bestUnitBy, type UnitView } from '@/lib/projects/unitView';

interface UnitCompareModalProps {
  open: boolean;
  onClose: () => void;
  units: UnitView[];
  projectName?: string | null;
  isAr: boolean;
}

const SAR = (n: number | null, isAr: boolean) => (n === null ? null : `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`);

export default function UnitCompareModal({ open, onClose, units, isAr }: UnitCompareModalProps) {
  const dash = '—';
  const cheapestId = bestUnitBy(units, (u) => u.totalPrice, 'min');
  const largestId = bestUnitBy(units, (u) => u.area, 'max');
  const bestPerM2Id = bestUnitBy(units, (u) => u.pricePerM2, 'min');

  const rows: { label: string; render: (u: UnitView) => React.ReactNode; bestId?: string | null }[] = [
    { label: isAr ? 'رمز المطور' : 'Dev. code', render: (u) => u.developerCode ?? dash },
    { label: isAr ? 'النوع' : 'Type', render: (u) => (u.type ? (isAr ? u.type.label_ar : u.type.label_en) : dash) },
    { label: isAr ? 'الحالة' : 'Status', render: (u) => (u.status ? <Badge label={isAr ? u.status.label_ar : u.status.label_en} color={u.status.color ?? undefined} /> : dash) },
    { label: isAr ? 'السعر' : 'Price', render: (u) => SAR(u.totalPrice, isAr) ?? dash, bestId: cheapestId },
    { label: isAr ? 'المساحة' : 'Area', render: (u) => (u.area !== null ? `${u.area} m²` : dash), bestId: largestId },
    { label: isAr ? 'سعر المتر' : 'Price/m²', render: (u) => SAR(u.pricePerM2, isAr) ?? dash, bestId: bestPerM2Id },
    { label: isAr ? 'غرف النوم' : 'Bedrooms', render: (u) => u.bedrooms ?? dash },
    { label: isAr ? 'دورات المياه' : 'Bathrooms', render: (u) => u.bathrooms ?? dash },
    { label: isAr ? 'الطابق' : 'Floor', render: (u) => (u.floor ? (isAr ? u.floor.label_ar : u.floor.label_en) : dash) },
  ];

  return (
    <Modal open={open} onClose={onClose} title={isAr ? `مقارنة ${units.length} وحدات` : `Compare ${units.length} units`} maxWidth="max-w-3xl">
      {units.length < 2 ? (
        <p className="text-charcoal/60 text-sm">{isAr ? 'اختر وحدتين على الأقل للمقارنة.' : 'Select at least two units to compare.'}</p>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-start p-2 text-charcoal/40 font-medium"></th>
                  {units.map((u) => (
                    <th key={u.id} className="p-2 text-charcoal font-bold text-center whitespace-nowrap">{u.code ?? `#${u.id.slice(0, 6)}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-t border-sand/40">
                    <td className="p-2 text-charcoal/50 whitespace-nowrap">{row.label}</td>
                    {units.map((u) => (
                      <td key={u.id} className={`p-2 text-center ${row.bestId === u.id ? 'bg-copper/10 font-bold text-copper rounded' : 'text-charcoal'}`}>
                        {row.render(u)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-charcoal/40">
            {isAr ? 'القيم المميزة = الأفضل حسابياً (الأرخص، الأكبر، أفضل سعر متر).' : 'Highlighted = deterministically best (cheapest, largest, best price/m²).'}
          </p>
        </div>
      )}
    </Modal>
  );
}

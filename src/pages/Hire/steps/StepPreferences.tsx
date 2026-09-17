import { Phone, User } from 'lucide-react';
import { Screen, FromCallChip } from '../hireUi';
import { CLIENT, PREFERENCES } from '../hireScenario';

/** Step 1 — an active call, with the customer's preferences filled in live. */
export default function StepPreferences() {
  return (
    <Screen
      title="ملف العميل — التفضيلات"
      icon={<User size={16} />}
      right={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-600 px-2.5 py-1 text-xs font-bold text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> مكالمة جارية
        </span>
      }
    >
      {/* who's on the call */}
      <div className="mb-5 flex items-center gap-3">
        <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-green-600 text-white">
          <Phone size={18} />
          <span className="absolute -inset-1 animate-ping rounded-full border-2 border-green-400 opacity-50" />
        </span>
        <div>
          <div className="text-base font-bold text-charcoal">{CLIENT.name}</div>
          <div className="text-sm text-charcoal/55" dir="ltr">{CLIENT.phone} · 00:42</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
        {PREFERENCES.map((p) => (
          <div key={p.label} className={p.full ? 'sm:col-span-2' : undefined}>
            <label className="mb-1.5 flex items-center justify-between gap-2 text-sm font-semibold text-charcoal/60">
              <span>{p.label}</span>
              {p.fromCall && <FromCallChip />}
            </label>
            <div className="form-input min-h-[3rem] bg-white text-base">{p.value}</div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

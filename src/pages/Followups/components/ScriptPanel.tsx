import { useAppStore } from '@/stores/appStore';
import type { FollowUpTypeConfig } from '@/lib/salesProcess';

interface ScriptPanelProps {
  typeConfig: FollowUpTypeConfig | undefined;
}

/** Short call/message guidance for this follow-up type, from the config. */
export default function ScriptPanel({ typeConfig }: ScriptPanelProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const lines = (isAr ? typeConfig?.script?.ar : typeConfig?.script?.en) ?? [];
  if (lines.length === 0) return null;
  return (
    <section className="card">
      <h2 className="mb-2 text-sm font-bold text-[#4A2C2A]">{isAr ? 'إرشادات المكالمة' : 'Call Guidance'}</h2>
      <ul className="list-disc space-y-1 ps-5 text-sm text-[#4A4E54]">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

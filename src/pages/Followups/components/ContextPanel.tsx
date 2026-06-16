import { useAppStore } from '@/stores/appStore';
import { resolveContext, type ContextInput, type FollowUpTypeConfig } from '@/lib/salesProcess';

interface ContextPanelProps {
  typeConfig: FollowUpTypeConfig | undefined;
  ctx: ContextInput;
}

/** Renders the type-specific context blocks the rep needs before acting. */
export default function ContextPanel({ typeConfig, ctx }: ContextPanelProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  if (!typeConfig || typeConfig.context_blocks.length === 0) return null;

  // Only render context rows that actually have a value — no walls of dashes.
  const blocks = typeConfig.context_blocks
    .map((id) => resolveContext(id, ctx))
    .filter((b) => b.value != null && b.value !== '');

  return (
    <section className="card">
      <h2 className="mb-2 text-sm font-bold text-[#4A2C2A]">{isAr ? 'سياق العميل' : 'Context'}</h2>
      {blocks.length === 0 ? (
        <p className="text-sm text-[#8E4E3A]">{isAr ? 'لا توجد معلومات سياقية متاحة' : 'No context available'}</p>
      ) : (
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-sm">
          {blocks.map((b) => (
            <div key={b.id} className="contents">
              <dt className="text-[#8E4E3A]">{isAr ? b.label_ar : b.label_en}</dt>
              <dd className="font-medium text-[#4A4E54]">{b.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

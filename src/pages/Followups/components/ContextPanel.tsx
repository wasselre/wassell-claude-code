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

  const blocks = typeConfig.context_blocks.map((id) => resolveContext(id, ctx));

  return (
    <section className="card">
      <h2 className="mb-2 text-sm font-bold text-[#4A2C2A]">{isAr ? 'سياق العميل' : 'Context'}</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {blocks.map((b) => (
          <div key={b.id} className="contents">
            <dt className="text-[#8E4E3A]">{isAr ? b.label_ar : b.label_en}</dt>
            <dd className="font-medium text-[#4A4E54]">{b.value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

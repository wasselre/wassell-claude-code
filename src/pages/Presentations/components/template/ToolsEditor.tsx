import { Server, User } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { TEMPLATE_TOOL_REGISTRY } from '@/data/templateToolRegistry';
import type { PresentationToolName } from '@/types';

/**
 * Editor for `template.tools` — a checkbox list of every tool the cloud
 * worker exposes. The checklist is driven by `TEMPLATE_TOOL_REGISTRY`,
 * which is the authoritative frontend mirror of `cloud-worker/src/tools/`.
 *
 * Server-side tools (web_search / web_fetch / code_execution) get a small
 * "server" badge so the author understands they're Anthropic-hosted and
 * have predictable cost/latency characteristics.
 */
interface ToolsEditorProps {
  selected: PresentationToolName[];
  onChange: (selected: PresentationToolName[]) => void;
  readonly?: boolean;
}

export default function ToolsEditor({
  selected,
  onChange,
  readonly,
}: ToolsEditorProps): JSX.Element {
  const isAr = useAppStore((s) => s.language === 'ar');
  const selectedSet = new Set(selected);

  const toggle = (name: PresentationToolName): void => {
    const next = new Set(selectedSet);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    // Preserve registry order so saved value is deterministic.
    onChange(TEMPLATE_TOOL_REGISTRY.map((t) => t.name).filter((n) => next.has(n)));
  };

  return (
    <div className="space-y-2">
      {TEMPLATE_TOOL_REGISTRY.map((tool) => {
        const checked = selectedSet.has(tool.name);
        return (
          <label
            key={tool.name}
            className={`flex items-start gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
              checked
                ? 'border-copper bg-copper/5'
                : 'border-sand/40 bg-white hover:border-copper/40'
            } ${readonly ? 'cursor-default opacity-70' : ''}`}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => !readonly && toggle(tool.name)}
              disabled={readonly}
              className="mt-1 w-4 h-4 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-sm text-charcoal">
                  {isAr ? tool.label_ar : tool.label_en}
                </span>
                <span className="font-mono text-[10px] text-charcoal/40">
                  {tool.name}
                </span>
                {tool.serverSide ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-charcoal/10 text-charcoal/60">
                    <Server size={9} />
                    {isAr ? 'مستضاف' : 'server-side'}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-copper/15 text-copper">
                    <User size={9} />
                    {isAr ? 'مخصص' : 'custom'}
                  </span>
                )}
              </div>
              <p className="text-xs text-charcoal/55 mt-1">
                {isAr ? tool.description_ar : tool.description_en}
              </p>
            </div>
          </label>
        );
      })}
    </div>
  );
}

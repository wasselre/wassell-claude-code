import type { ReactNode } from 'react';
import { Film, Sparkles, Megaphone, Building2, Clapperboard } from 'lucide-react';
import type { ReelScript } from '@/lib/copywriter/reelScript';

/**
 * Renders a FINAL reel script (emitted by the copywriter agent via
 * emit_reel_script) as a structured card: hook + angle header, a scene-by-scene
 * table, CTA + alternative hooks, and a "Create Reel" button that converts the
 * script into a prefilled Reels (reel_scripts) record. Rendered inside the
 * assistant message in CopywriterThread, beneath the message text.
 */
export default function ReelScriptCard({
  rs,
  isAr,
  onAccept,
  disabled,
}: {
  rs: ReelScript;
  isAr: boolean;
  onAccept: (rs: ReelScript) => void;
  disabled?: boolean;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);

  return (
    <div className="mt-2 w-full max-w-[80%] self-start rounded-2xl border border-copper/30 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-copper/10 border-b border-copper/20">
        <Clapperboard size={16} className="text-copper shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-charcoal truncate">
            {rs.title || L('نص ريل', 'Reel Script')}
          </div>
          {rs.project_name && (
            <div className="flex items-center gap-1 text-xs text-charcoal/60">
              <Building2 size={11} />
              <span className="truncate">{rs.project_name}</span>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Hook + angle */}
        {rs.hook && (
          <Field icon={<Film size={13} className="text-copper" />} label={L('الخطّاف', 'Hook')}>
            {rs.hook}
          </Field>
        )}
        {rs.angle && (
          <Field icon={<Sparkles size={13} className="text-copper" />} label={L('الزاوية / المحفّز', 'Angle / Trigger')}>
            {rs.angle}
          </Field>
        )}

        {/* Scenes table */}
        {rs.scenes.length > 0 && (
          <div className="border border-sand/50 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-cream/50 border-b border-sand/40">
                  <tr>
                    <Th>{L('المشهد', 'Scene')}</Th>
                    <Th>{L('التعليق الصوتي', 'Voiceover')}</Th>
                    <Th>{L('التوجيه البصري', 'Visual')}</Th>
                    <Th>{L('نص على الشاشة', 'On-Screen Text')}</Th>
                    <Th>{L('ملاحظات', 'Notes')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rs.scenes.map((s, i) => (
                    <tr key={i} className="border-b border-sand/25 last:border-0 align-top">
                      <Td className="font-medium whitespace-nowrap">{s.scene || `#${i + 1}`}</Td>
                      <Td>{s.voiceover}</Td>
                      <Td className="text-charcoal/70">{s.visual}</Td>
                      <Td className="text-charcoal/70">{s.on_screen_text}</Td>
                      <Td className="text-charcoal/50">{s.notes}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CTA */}
        {rs.cta && (
          <Field icon={<Megaphone size={13} className="text-copper" />} label={L('الدعوة', 'CTA')}>
            {rs.cta}
          </Field>
        )}

        {/* Alternative hooks */}
        {rs.alt_hooks && rs.alt_hooks.length > 0 && (
          <div>
            <div className="text-[11px] font-bold text-charcoal/60 uppercase tracking-wider mb-1">
              {L('خطّافات بديلة', 'Alternative Hooks')}
            </div>
            <ul className="space-y-1">
              {rs.alt_hooks.map((h, i) => (
                <li key={i} className="text-sm text-charcoal/80 flex gap-1.5">
                  <span className="text-copper">•</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Action */}
      <div className="px-4 py-2.5 border-t border-sand/40 bg-cream/20 flex justify-end">
        <button
          type="button"
          onClick={() => onAccept(rs)}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white text-sm font-medium hover:bg-terracotta disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={disabled ? L('نموذج الريلز غير متوفر', 'Reels model unavailable') : undefined}
        >
          <Clapperboard size={15} />
          {L('إنشاء ريل', 'Create Reel')}
        </button>
      </div>
    </div>
  );
}

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-charcoal/60 uppercase tracking-wider mb-0.5">
        {icon}
        {label}
      </div>
      <div className="text-sm text-charcoal whitespace-pre-wrap">{children}</div>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="text-start px-2.5 py-1.5 text-[10px] font-bold text-charcoal/60 uppercase tracking-wider whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-2.5 py-1.5 text-charcoal/90 whitespace-pre-wrap ${className}`}>{children}</td>;
}

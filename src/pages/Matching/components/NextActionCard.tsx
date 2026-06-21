import { Compass, Flame, Snowflake, ThermometerSun, Trophy, XCircle, AlertTriangle, Megaphone, Clock } from 'lucide-react';
import type { NextActionPayload, LeadTemperature } from '@/lib/matching/cards';

/**
 * Renders a sales-consultant Next-Best-Action recommendation (emit_next_action).
 * lead_temperature / stage / status / next action are deterministic (from
 * get_customer_context); the coaching is the agent's. One chat, one card type.
 */
export default function NextActionCard({ payload, isAr }: { payload: NextActionPayload; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  return (
    <div className="mt-2 w-full max-w-[88%] self-start rounded-2xl border border-copper/30 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-copper/10 border-b border-copper/20">
        <Compass size={16} className="text-copper shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-charcoal truncate">
            {L('الخطوة التالية', 'Next best action')}{payload.client_name ? ` — ${payload.client_name}` : ''}
          </div>
        </div>
        <TempBadge temp={payload.lead_temperature} isAr={isAr} />
      </div>

      <div className="p-3 space-y-2.5">
        {(payload.stage || payload.status) && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {payload.stage && <span className="px-2 py-0.5 rounded-full bg-cream border border-sand/40 text-charcoal/70">{L('المرحلة: ', 'Stage: ')}{payload.stage}</span>}
            {payload.status && <span className="px-2 py-0.5 rounded-full bg-cream border border-sand/40 text-charcoal/70">{L('الحالة: ', 'Status: ')}{payload.status}</span>}
          </div>
        )}

        {payload.risk && (
          <div className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span><b>{L('الخطر: ', 'Risk: ')}</b>{payload.risk}</span>
          </div>
        )}

        <div className="rounded-lg border border-copper/30 bg-copper/5 p-2.5">
          <div className="text-[11px] font-bold text-copper uppercase tracking-wider mb-0.5">{L('الإجراء المقترح', 'Recommended action')}</div>
          <div className="text-sm text-charcoal font-medium">{payload.recommended_action}</div>
          {payload.why && <div className="text-xs text-charcoal/60 mt-1">{payload.why}</div>}
        </div>

        {payload.talking_points.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-charcoal/60 uppercase tracking-wider mb-1">
              <Megaphone size={12} className="text-copper" /> {L('نقاط للمكالمة', 'Talking points')}
            </div>
            <ul className="space-y-0.5">
              {payload.talking_points.map((t, i) => (
                <li key={i} className="text-sm text-charcoal/80 flex gap-1.5"><span className="text-copper">•</span><span>{t}</span></li>
              ))}
            </ul>
          </div>
        )}

        {(payload.follow_up_timing || payload.next_action_due_at) && (
          <div className="flex items-center gap-1.5 text-xs text-charcoal/70">
            <Clock size={12} className="text-copper" />
            <span>{L('المتابعة: ', 'Follow up: ')}{payload.follow_up_timing}{payload.next_action_due_at ? ` (${payload.next_action_due_at})` : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TempBadge({ temp, isAr }: { temp: LeadTemperature; isAr: boolean }) {
  const map: Record<LeadTemperature, { cls: string; Icon: typeof Flame; ar: string; en: string }> = {
    hot: { cls: 'bg-red-100 text-red-700 border-red-200', Icon: Flame, ar: 'حار', en: 'Hot' },
    warm: { cls: 'bg-amber-100 text-amber-700 border-amber-200', Icon: ThermometerSun, ar: 'دافئ', en: 'Warm' },
    cold: { cls: 'bg-sky-100 text-sky-700 border-sky-200', Icon: Snowflake, ar: 'بارد', en: 'Cold' },
    won: { cls: 'bg-green-100 text-green-700 border-green-200', Icon: Trophy, ar: 'مغلق ناجح', en: 'Won' },
    lost: { cls: 'bg-gray-100 text-gray-600 border-gray-200', Icon: XCircle, ar: 'خاسر', en: 'Lost' },
  };
  const e = map[temp];
  const { Icon } = e;
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${e.cls}`}>
      <Icon size={11} /> {isAr ? e.ar : e.en}
    </span>
  );
}

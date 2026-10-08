import { Bot, User, Flame, AlertTriangle } from 'lucide-react';
import type { SalesClient } from '../lib/salesClients';
import {
  INTEREST_META, actionText, reasonText, situationText, visitText, type ClientPulse,
} from '../lib/clientPulse';
import { formatRelative } from '@/pages/Clients/lib/lifecycleDisplay';
import ClientQuickActions from '@/pages/Clients/components/ClientQuickActions';

/**
 * The client list as dense rows (operator, 2026-10-08): one row per client
 * with interest, top project, stage, what is happening, the last action — the
 * AI's work shows here like anyone else's — last contact and visit. The data
 * comes from /api/client-pulse; a client the pulse has not loaded for yet
 * shows dashes, never a guess.
 */
export default function ClientPulseTable({ rows, pulse, isAr, now, returnTo, onOpen, onWhatsApp }: {
  rows: SalesClient[];
  pulse: Map<string, ClientPulse>;
  isAr: boolean;
  now: number;
  returnTo: string;
  onOpen: (clientId: string) => void;
  onWhatsApp: (clientId: string, phone: string | null) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const th = 'px-3 py-2 text-start text-[11px] font-bold uppercase tracking-wide text-charcoal/50';
  const td = 'px-3 py-2 align-top text-xs text-charcoal';
  const dash = <span className="text-charcoal/30">—</span>;

  return (
    <div className="overflow-x-auto rounded-2xl border border-sand/50 bg-white">
      <table className="w-full min-w-[1100px] border-collapse">
        <thead className="border-b border-sand/50 bg-cream/60">
          <tr>
            <th className={th}>{L('العميل', 'Client')}</th>
            <th className={th}>{L('الاهتمام', 'Interest')}</th>
            <th className={th}>{L('المشروع الأبرز', 'Top project')}</th>
            <th className={th}>{L('المرحلة', 'Stage')}</th>
            <th className={th}>{L('ما يحدث الآن', 'What is happening')}</th>
            <th className={th}>{L('آخر إجراء', 'Last action')}</th>
            <th className={th}>{L('آخر تواصل', 'Last contact')}</th>
            <th className={th}>{L('الزيارة', 'Visit')}</th>
            <th className={th}><span className="sr-only">{L('إجراءات', 'Actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((sc) => {
            const v = sc.view;
            const p = pulse.get(v.id);
            const meta = p ? INTEREST_META[p.interest] : null;
            const sit = p ? situationText(p, isAr, now) : null;
            const act = p ? actionText(p, isAr) : null;
            const visit = p ? visitText(p, isAr) : null;
            const reason = p ? reasonText(p.interest_reason, isAr) : null;
            return (
              <tr
                key={v.id}
                onClick={() => onOpen(v.id)}
                className="cursor-pointer border-b border-sand/30 transition last:border-b-0 hover:bg-cream/40"
              >
                <td className={td}>
                  <div className="font-bold text-chocolate">{v.name ?? L('عميل بدون اسم', 'Unnamed client')}</div>
                  <div className="text-[11px] text-charcoal/50">
                    <span dir="ltr">{v.phone ?? '—'}</span>
                    {v.ownerName && <span> · {v.ownerName}</span>}
                  </div>
                </td>
                <td className={td}>
                  {meta ? (
                    <span title={reason ?? undefined} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${meta.cls}`}>
                      {p!.interest === 'hot' && <Flame size={11} />}
                      {isAr ? meta.ar : meta.en}
                    </span>
                  ) : dash}
                  {reason && <div className="mt-0.5 text-[10px] text-charcoal/50">{reason}</div>}
                </td>
                <td className={td}>{p?.top_project_name ? <span className="font-semibold">{p.top_project_name}</span> : dash}</td>
                <td className={td}>
                  {v.stage ? <div className="font-semibold">{v.stage}</div> : dash}
                  {v.status && <div className="text-[11px] text-charcoal/55">{v.status}</div>}
                </td>
                <td className={td}>
                  {sit ? (
                    <span className={`inline-flex items-start gap-1 ${sit.urgent ? 'font-semibold text-terracotta' : ''}`}>
                      {sit.urgent && <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                      {sit.text}
                    </span>
                  ) : dash}
                </td>
                <td className={td}>
                  {act && p?.last_action ? (
                    <div className="flex items-start gap-1">
                      {p.last_action.by === 'ai'
                        ? <Bot size={12} className="mt-0.5 shrink-0 text-copper" aria-label={L('المساعد', 'AI')} />
                        : <User size={12} className="mt-0.5 shrink-0 text-charcoal/50" aria-label={L('شخص', 'Person')} />}
                      <div>
                        <div>{act}</div>
                        <div className="text-[10px] text-charcoal/45">{formatRelative(p.last_action.at, isAr, now)}</div>
                      </div>
                    </div>
                  ) : dash}
                </td>
                <td className={td}>{p?.last_contact_at ? formatRelative(p.last_contact_at, isAr, now) : dash}</td>
                <td className={td}>{visit ?? dash}</td>
                <td className={td} onClick={(e) => e.stopPropagation()}>
                  <ClientQuickActions
                    clientId={v.id}
                    phone={v.phone}
                    nextFollowupId={v.nextFollowupId}
                    isAr={isAr}
                    variant="row"
                    returnTo={returnTo}
                    onWhatsApp={() => onWhatsApp(v.id, v.phone)}
                    hideOpenClient
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

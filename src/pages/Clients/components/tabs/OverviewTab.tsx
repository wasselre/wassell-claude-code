import { useNavigate } from 'react-router-dom';
import { ListChecks, MessageCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { normalizePhoneDigits } from '@/lib/haberchat/normalize';
import type { AppRecord } from '@/types';
import ClientAcquisitionPanel from '@/pages/Records/components/ClientAcquisitionPanel';
import { buildClientTimeline, type ClientView, type ClientViewCtx, isOverdue } from '../../lib/clientView';
import { formatRelative, formatBudget, lifecycleHealthDisplay, lifecycleHealthExplanation, nextActionTypeLabel } from '../../lib/lifecycleDisplay';
import { Dash } from '../clientChips';

interface OverviewTabProps {
  view: ClientView;
  ctx: ClientViewCtx;
  isAr: boolean;
  returnTo: string;
  onOpenTimeline: () => void;
  onOpenWhatsApp: () => void;
  now?: number;
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-chocolate">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-charcoal/50">{label}</span>
      <span className="text-end font-semibold text-charcoal/85">{children}</span>
    </div>
  );
}

/** Latest WhatsApp conversation summary from already-loaded chats records. */
function latestChat(ctx: ClientViewCtx, clientId: string, phone: string | null): { preview: string | null; at: string | null } | null {
  const chatsModel = ctx.models.find((m) => m.name === 'chats');
  if (!chatsModel) return null;
  const recs = ctx.records[chatsModel.id] ?? [];
  let hit: AppRecord | null = recs.find((r) => r.data.client_link === clientId) ?? null;
  if (!hit && phone) {
    const target = normalizePhoneDigits(phone);
    if (target.length >= 6) {
      hit = recs.find((r) => {
        const p = normalizePhoneDigits(r.data.phone as string | null | undefined);
        return p.length >= 6 && (p === target || p.endsWith(target) || target.endsWith(p));
      }) ?? null;
    }
  }
  if (!hit) return null;
  const preview = typeof hit.data.last_message_preview === 'string' ? hit.data.last_message_preview : null;
  const at = typeof hit.data.last_message_at === 'string' ? hit.data.last_message_at : null;
  return { preview, at };
}

export default function OverviewTab({ view, ctx, isAr, returnTo, onOpenTimeline, onOpenWhatsApp, now = Date.now() }: OverviewTabProps) {
  const navigate = useNavigate();
  const overdue = isOverdue(view, now);
  const health = lifecycleHealthDisplay(view.lifecycleHealth);
  const recent = buildClientTimeline(ctx, view.id).slice(0, 5);
  const chat = latestChat(ctx, view.id, view.phone);
  const clientsModelId = ctx.models.find((m) => m.name === 'clients')?.id ?? null;
  const Chevron = isAr ? ChevronLeft : ChevronRight;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Identity */}
      <Card title={isAr ? 'هوية العميل' : 'Client identity'}>
        <Row label={isAr ? 'معرف العميل' : 'Client ID'}>{view.clientId ?? <Dash />}</Row>
        <Row label={isAr ? 'الاسم' : 'Name'}>{view.name ?? <Dash />}</Row>
        <Row label={isAr ? 'الجوال' : 'Phone'}><span dir="ltr">{view.phone ?? '—'}</span></Row>
        <Row label={isAr ? 'مستشار المبيعات' : 'Sales Consultant'}>{view.ownerName ?? <Dash />}</Row>
        <Row label={isAr ? 'المرحلة' : 'Stage'}>{view.stageLabel ?? <Dash />}</Row>
        <Row label={isAr ? 'الحالة' : 'Status'}>{view.statusLabel ?? <Dash />}</Row>
      </Card>

      {/* Lifecycle summary */}
      <Card title={isAr ? 'ملخص دورة الحياة' : 'Lifecycle summary'}>
        <div className="mb-2 inline-flex items-center gap-2">
          <span className="rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ backgroundColor: `${health.color}24`, color: health.color }}>
            {isAr ? health.label_ar : health.label_en}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-charcoal/70">{lifecycleHealthExplanation(view.lifecycleHealth, isAr)}</p>
      </Card>

      {/* Marketing acquisition — where this client came from, resolved live
        * through the Ad. Self-hides when the client has no recorded acquisition. */}
      {clientsModelId && (
        <div className="lg:col-span-2">
          <ClientAcquisitionPanel modelId={clientsModelId} recordId={view.id} variant="cockpit" />
        </div>
      )}

      {/* Next action */}
      <Card
        title={isAr ? 'الإجراء التالي' : 'Next action'}
        action={
          view.nextFollowupId ? (
            <button
              type="button"
              onClick={() => navigate(`/model/followups/${view.nextFollowupId}?returnTo=${encodeURIComponent(returnTo)}`)}
              className="inline-flex items-center gap-1 text-xs font-bold text-copper hover:underline"
            >
              <ListChecks size={13} /> {isAr ? 'افتح المتابعة' : 'Open follow-up'}
            </button>
          ) : undefined
        }
      >
        <Row label={isAr ? 'النوع' : 'Type'}>{nextActionTypeLabel(view.nextActionType, isAr) ?? <Dash />}</Row>
        <Row label={isAr ? 'الاستحقاق' : 'Due'}>
          <span className={overdue ? 'font-bold text-[#B5462F]' : ''}>{formatRelative(view.nextActionDueAt, isAr, now) ?? <Dash />}</span>
        </Row>
        {!view.nextFollowupId && (
          <p className="mt-2 text-xs text-charcoal/50">{isAr ? 'لا توجد متابعة مفتوحة.' : 'No open follow-up.'}</p>
        )}
      </Card>

      {/* Latest activity + communication */}
      <Card title={isAr ? 'آخر نشاط وتواصل' : 'Latest activity & communication'}>
        <Row label={isAr ? 'آخر نشاط' : 'Last activity'}>{formatRelative(view.lastActivityAt, isAr, now) ?? <Dash />}</Row>
        {chat ? (
          <button type="button" onClick={onOpenWhatsApp} className="mt-2 w-full rounded-lg bg-[#25D366]/8 p-2.5 text-start transition hover:bg-[#25D366]/15">
            <div className="flex items-center gap-1.5 text-xs font-bold text-[#128C7E]">
              <MessageCircle size={13} /> {isAr ? 'آخر رسالة واتساب' : 'Latest WhatsApp'}
              <span className="font-normal text-charcoal/50">{formatRelative(chat.at, isAr, now) ?? ''}</span>
            </div>
            {chat.preview && <p className="mt-1 line-clamp-2 text-xs text-charcoal/70">{chat.preview}</p>}
          </button>
        ) : (
          <p className="mt-2 text-xs text-charcoal/50">{isAr ? 'لا توجد محادثة واتساب محمّلة.' : 'No WhatsApp conversation loaded.'}</p>
        )}
      </Card>

      {/* Preference summary */}
      <Card title={isAr ? 'ملخص التفضيلات' : 'Preference summary'}>
        <Row label={isAr ? 'نوع الوحدة' : 'Unit type'}>{view.preferredUnitType.length ? view.preferredUnitType.join('، ') : <Dash />}</Row>
        <Row label={isAr ? 'الميزانية' : 'Budget'}>{formatBudget(view.budget, isAr) ?? <Dash />}</Row>
        <Row label={isAr ? 'المدينة' : 'City'}>{view.preferredCity ?? <Dash />}</Row>
        <Row label={isAr ? 'الاتجاه' : 'Direction'}>{view.preferredDirection.length ? view.preferredDirection.join('، ') : <Dash />}</Row>
        <Row label={isAr ? 'الحي' : 'District'}>{view.preferredDistrict ?? <Dash />}</Row>
        <Row label={isAr ? 'مشاريع مفضلة' : 'Preferred projects'}>{view.preferredProjects.length || <Dash />}</Row>
        <Row label={isAr ? 'إعلانات مفضلة' : 'Preferred listings'}>{view.preferredMarketListings.length || <Dash />}</Row>
      </Card>

      {/* Recent related records */}
      <Card
        title={isAr ? 'أحدث السجلات المرتبطة' : 'Recent related records'}
        action={
          recent.length ? (
            <button type="button" onClick={onOpenTimeline} className="text-xs font-bold text-copper hover:underline">
              {isAr ? 'الجدول الزمني' : 'Timeline'}
            </button>
          ) : undefined
        }
      >
        {recent.length === 0 ? (
          <p className="text-xs text-charcoal/50">{isAr ? 'لا توجد سجلات مرتبطة محمّلة.' : 'No related records loaded.'}</p>
        ) : (
          <ul className="divide-y divide-sand/30">
            {recent.map((item) => (
              <li key={`${item.modelName}-${item.id}`}>
                <button type="button" onClick={() => navigate(item.href)} className="flex w-full items-center justify-between gap-2 py-2 text-start transition hover:opacity-80">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-charcoal/85">{item.typeLabel}{item.status ? ` · ${item.status}` : ''}</span>
                    {item.summary && <span className="block truncate text-xs text-charcoal/50">{item.summary}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-charcoal/50">
                    {formatRelative(item.date, isAr, now) ?? ''}
                    <Chevron size={14} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Sourcing Opportunities — READ-ONLY view inside the Market Registry
 * (governing decision #3). Shows only existing, truthful records:
 *   • Known real-estate offices (`real_estate_offices`) — the supply directory.
 *   • Open demand requests (`unanswered_requests`) — unmet customer demand.
 *
 * NO schema changes, NO workflow activation, NO fake states or actions. The
 * real sourcing pipeline (connecting a geographic demand gap → offices → offers
 * → a Portfolio project) is activated later with D38; this view just surfaces
 * what already exists and documents the intended connection.
 */
import { useMemo } from 'react';
import { Building, Phone, Mail, MapPin, Inbox } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, fieldByCandidates, optionFor, asString } from '@/lib/projects/projectView';

export default function SourcingView({ isAr }: { isAr: boolean }) {
  const { models, records } = useAppStore();

  const officesModel = modelByName(models, 'real_estate_offices');
  const requestsModel = modelByName(models, 'unanswered_requests');
  const brokerField = fieldByCandidates(officesModel, ['broker_type']);
  const statusField = fieldByCandidates(requestsModel, ['request_status']);

  const offices = useMemo(() => {
    if (!officesModel) return [];
    return (records[officesModel.id] ?? []).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const bt = optionFor(brokerField, d.broker_type);
      return {
        id: r.id,
        name: asString(d.office_name) ?? (isAr ? 'مكتب بدون اسم' : 'Unnamed office'),
        brokerType: bt ? (isAr ? bt.label_ar : bt.label_en) : (asString(d.broker_type) ?? ''),
        phone: asString(d.mobile_number),
        email: asString(d.email),
        where: [asString(d.street), asString(d.location)].filter(Boolean).join(isAr ? '، ' : ', '),
      };
    });
  }, [officesModel, records, brokerField, isAr]);

  const requests = useMemo(() => {
    if (!requestsModel) return [];
    return (records[requestsModel.id] ?? []).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const st = optionFor(statusField, d.request_status);
      return {
        id: r.id,
        client: asString(d.client_name) ?? (isAr ? 'عميل' : 'Client'),
        phone: asString(d.client_mobile_number),
        status: st ? { label: isAr ? st.label_ar : st.label_en, color: st.color ?? '#9CA3AF' } : null,
        notes: asString(d.request_notes) ?? '',
      };
    });
  }, [requestsModel, records, statusField, isAr]);

  return (
    <div className="space-y-6">
      <p className="text-xs text-charcoal/50 max-w-3xl">
        {isAr
          ? 'عرض للقراءة فقط: طلبات الطلب غير المجابة (طلب العملاء) والمكاتب العقارية المعروفة (مصدر المعروض). ربط هذه في مسار مصادر واحد يتم لاحقاً — لا تُنشأ حالات أو إجراءات وهمية هنا.'
          : 'Read-only: open demand requests (customer demand) and known real-estate offices (supply directory). Wiring these into one sourcing pipeline happens later — no fake states or actions are created here.'}
      </p>

      {/* Open demand requests */}
      <section>
        <h3 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-2">
          {isAr ? 'طلبات مفتوحة' : 'Open requests'} <span className="text-charcoal/25">({requests.length})</span>
        </h3>
        {requests.length === 0 ? (
          <div className="card p-8 text-center text-charcoal/40 text-sm">
            <Inbox size={22} className="mx-auto mb-2 opacity-40" />
            {isAr ? 'لا توجد طلبات مفتوحة.' : 'No open requests.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {requests.map((rq) => (
              <div key={rq.id} className="card p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-charcoal text-sm truncate">{rq.client}</div>
                  {rq.status && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0" style={{ backgroundColor: rq.status.color + '1A', color: rq.status.color }}>
                      {rq.status.label}
                    </span>
                  )}
                </div>
                {rq.phone && <div className="text-xs text-charcoal/50 mt-0.5 inline-flex items-center gap-1"><Phone size={11} /> {rq.phone}</div>}
                {rq.notes && <div className="text-[11px] text-charcoal/45 mt-1 line-clamp-2">{rq.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Known offices */}
      <section>
        <h3 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-2">
          {isAr ? 'مكاتب عقارية معروفة' : 'Known real-estate offices'} <span className="text-charcoal/25">({offices.length})</span>
        </h3>
        {offices.length === 0 ? (
          <div className="card p-8 text-center text-charcoal/40 text-sm">
            <Building size={22} className="mx-auto mb-2 opacity-40" />
            {isAr ? 'لا توجد مكاتب مسجَّلة.' : 'No offices recorded.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {offices.slice(0, 60).map((o) => (
              <div key={o.id} className="card p-3">
                <div className="font-bold text-charcoal text-sm truncate">{o.name}</div>
                {o.brokerType && <div className="text-[11px] text-charcoal/40 mt-0.5">{o.brokerType}</div>}
                <div className="mt-1 space-y-0.5 text-xs text-charcoal/55">
                  {o.phone && <div className="inline-flex items-center gap-1"><Phone size={11} /> {o.phone}</div>}
                  {o.email && <div className="inline-flex items-center gap-1"><Mail size={11} /> {o.email}</div>}
                  {o.where && <div className="inline-flex items-center gap-1"><MapPin size={11} /> {o.where}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        {offices.length > 60 && (
          <p className="text-[11px] text-charcoal/40 mt-2">
            {isAr ? `عرض 60 من ${offices.length.toLocaleString('ar-SA')} مكتباً.` : `Showing 60 of ${offices.length.toLocaleString('en-US')} offices.`}
          </p>
        )}
      </section>
    </div>
  );
}

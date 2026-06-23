import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import CallHistoryPanel from '@/pages/Records/components/CallHistoryPanel';
import WhatsAppHistoryPanel from '@/pages/Records/components/WhatsAppHistoryPanel';
import type { AppModel, AppRecord } from '@/types';

// ── Model ids ────────────────────────────────────────────────────────
export const SV = {
  reviews: 'sales_valuation_reviews',
  tasks: 'sales_correction_tasks',
  daily: 'sales_rep_daily_valuations',
  categories: 'sales_mistake_categories',
  settings: 'sales_valuation_settings',
} as const;

/** Resolve the Sales Valuation models + the records + helpers in one hook. */
export function useSv() {
  const { models, records, language, users, currentUserId } = useAppStore();
  const isAr = language === 'ar';
  const byName = (n: string) => models.find((m) => m.name === n) ?? null;
  const m = {
    reviews: byName(SV.reviews), tasks: byName(SV.tasks), daily: byName(SV.daily),
    categories: byName(SV.categories), settings: byName(SV.settings),
    clients: byName('clients'), followups: byName('followups'),
  };
  const rows = (model: AppModel | null) => (model ? records[model.id] ?? [] : []);
  const resolveUser = (id: unknown): string => {
    if (typeof id !== 'string' || !id) return '—';
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '—') : '—';
  };
  return { isAr, models, records, users, currentUserId, m, rows, resolveUser };
}

/** Map a dropdown/multiselect VALUE to its Arabic label via the model's own
 *  field options — guarantees no raw slug ever reaches the screen. */
export function optOf(model: AppModel | null, fieldName: string, value: unknown, isAr: boolean): { label: string; color?: string } {
  const f = model?.schema.sections.flatMap((s) => s.fields).find((x) => x.name === fieldName);
  const o = (f?.options ?? []).find((x) => x.value === value);
  if (!o) return { label: typeof value === 'string' && value ? value : '—' };
  return { label: (isAr ? o.label_ar : o.label_en) || '—', color: o.color };
}

export function fmtDateTime(v: unknown, isAr: boolean): string {
  if (typeof v !== 'string' || !v) return '—';
  const dt = new Date(v);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function clientNameOf(rec: AppRecord | undefined | null, clientRows: AppRecord[]): string {
  if (!rec) return '—';
  const snap = rec.data.client_name_snapshot;
  if (typeof snap === 'string' && snap) return snap;
  const cid = rec.data.client;
  const c = typeof cid === 'string' ? clientRows.find((x) => x.id === cid) : null;
  return (c?.data.client_name as string) || '—';
}

// ── presentational primitives ────────────────────────────────────────

export function Pill({ label, color, prefix }: { label: string; color?: string; prefix?: string }) {
  const c = color || '#6B7280';
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap"
      style={{ backgroundColor: `${c}1A`, color: c }}>
      {prefix && <span className="opacity-70 font-medium">{prefix}:</span>}{label}
    </span>
  );
}

export function KpiCard({ label, value, tone = '#B8734F', onClick, active }: {
  label: string; value: ReactNode; tone?: string; onClick?: () => void; active?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`card p-4 text-start transition-all ${onClick ? 'hover:shadow-md cursor-pointer' : 'cursor-default'} ${active ? 'ring-2' : ''}`}
      style={active ? { boxShadow: `0 0 0 2px ${tone}` } : undefined}>
      <p className="text-2xl font-extrabold" style={{ color: tone }}>{value}</p>
      <p className="text-xs font-medium text-charcoal/60 mt-1">{label}</p>
    </button>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-charcoal/50">{label}</p>
      <div className="text-sm font-semibold text-charcoal mt-0.5">{value}</div>
    </div>
  );
}

export function SectionCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-charcoal">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Modal({ title, onClose, isAr, children, wide }: { title: string; onClose: () => void; isAr: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} dir={isAr ? 'rtl' : 'ltr'}>
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-2xl'} max-h-[85vh] overflow-y-auto rounded-2xl bg-cream shadow-xl`}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-sand/40 bg-cream px-5 py-3">
          <h3 className="text-base font-bold text-charcoal">{title}</h3>
          <button type="button" onClick={onClose} className="text-charcoal/50 hover:text-charcoal"><X size={20} /></button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ── shared evidence modals (client profile / call / whatsapp) ─────────

export type Evidence = { kind: 'client' | 'call' | 'whatsapp'; clientId: string; phone: string };

export function useEvidence() {
  const [ev, setEv] = useState<Evidence | null>(null);
  return {
    openClient: (clientId: string) => setEv({ kind: 'client', clientId, phone: '' }),
    openCall: (clientId: string, phone: string) => setEv({ kind: 'call', clientId, phone }),
    openWhatsApp: (clientId: string) => setEv({ kind: 'whatsapp', clientId, phone: '' }),
    ev, close: () => setEv(null),
  };
}

export function EvidenceModals({ ev, onClose }: { ev: Evidence | null; onClose: () => void }) {
  const { m, isAr } = useSv();
  if (!ev) return null;
  if (ev.kind === 'client') {
    if (!m.clients || !ev.clientId) { onClose(); return null; }
    return (
      <RecordFormModal modelId={m.clients.id} recordId={ev.clientId}
        openInPageHref={`/model/clients/${ev.clientId}`} onClose={onClose} onSaved={onClose} />
    );
  }
  if (ev.kind === 'call') {
    return (
      <Modal title={isAr ? 'الاستماع للمكالمة' : 'Call Recording'} onClose={onClose} isAr={isAr}>
        {ev.phone
          ? <CallHistoryPanel phones={[ev.phone]} chrome="naked" />
          : <p className="text-sm text-charcoal/60">{isAr ? 'لا يوجد تسجيل مكالمة مرتبط بهذه المتابعة' : 'No call recording linked'}</p>}
      </Modal>
    );
  }
  return (
    <Modal title={isAr ? 'محادثة واتساب' : 'WhatsApp Chat'} onClose={onClose} isAr={isAr}>
      {ev.clientId
        ? <WhatsAppHistoryPanel clientId={ev.clientId} chrome="naked" />
        : <p className="text-sm text-charcoal/60">{isAr ? 'لا توجد محادثة واتساب مرتبطة بهذا العميل' : 'No WhatsApp conversation linked'}</p>}
    </Modal>
  );
}

/** Small toolbar header shared by every Sales Valuation operational page. */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-extrabold text-chocolate">{title}</h1>
        {subtitle && <p className="text-sm text-charcoal/60 mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

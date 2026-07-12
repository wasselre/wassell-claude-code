import { useMemo, useState } from 'react';
import { useParams, useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, SlidersHorizontal, ListChecks, Clock, MessageCircle, Phone, Link2, FileText } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanViewRecord, useCanEditRecord } from '@/hooks/usePermission';
import { phoneFieldSlugs } from '@/lib/haberchat/normalize';
import RecordFormPage from '@/pages/Records/RecordFormPage';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import WhatsAppHistoryPanel from '@/pages/Records/components/WhatsAppHistoryPanel';
import CallHistoryPanel from '@/pages/Records/components/CallHistoryPanel';
import RelatedRecordsPanel from '@/pages/Records/components/RelatedRecordsPanel';
import {
  resolveClientView,
  isGenericMode,
  allFields,
  nonEmptyString,
  type ClientViewCtx,
} from './lib/clientView';
import { useClientWhatsApp } from './lib/useClientWhatsApp';
import DetailHeader from './components/DetailHeader';
import DetailKpiRow from './components/DetailKpiRow';
import OverviewTab from './components/tabs/OverviewTab';
import PreferencesTab from './components/tabs/PreferencesTab';
import ClientOptionsTab from './components/tabs/ClientOptionsTab';
import TimelineTab from './components/tabs/TimelineTab';
import SalesNotesTab from './components/tabs/SalesNotesTab';

type TabKey = 'overview' | 'preferences' | 'options' | 'timeline' | 'whatsapp' | 'calls' | 'related' | 'notes';

const TABS: { key: TabKey; label_ar: string; label_en: string; icon: typeof LayoutGrid }[] = [
  { key: 'overview', label_ar: 'نظرة عامة', label_en: 'Overview', icon: LayoutGrid },
  { key: 'preferences', label_ar: 'التفضيلات', label_en: 'Preferences', icon: SlidersHorizontal },
  { key: 'options', label_ar: 'الخيارات', label_en: 'Options', icon: ListChecks },
  { key: 'timeline', label_ar: 'الجدول الزمني', label_en: 'Timeline', icon: Clock },
  { key: 'whatsapp', label_ar: 'واتساب', label_en: 'WhatsApp', icon: MessageCircle },
  { key: 'calls', label_ar: 'المكالمات', label_en: 'Calls', icon: Phone },
  { key: 'related', label_ar: 'السجلات المرتبطة', label_en: 'Related', icon: Link2 },
  { key: 'notes', label_ar: 'ملاحظات المبيعات', label_en: 'Sales Notes', icon: FileText },
];

/** Find the slug on `targetModel` that links back to clients (for create prefill). */
function clientLookupSlug(modelId: string | undefined, models: ClientViewCtx['models'], clientsModelId: string): string | null {
  const m = models.find((x) => x.id === modelId);
  if (!m) return null;
  return allFields(m).find((f) => f.type === 'lookup' && f.lookup_model_id === clientsModelId)?.name ?? null;
}

/** Custom Client 360 cockpit — replaces the generic record form for clients. */
export default function ClientDetailPage() {
  const { recordId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const language = useAppStore((s) => s.language);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = language === 'ar';

  const generic = isGenericMode(searchParams);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const client = useMemo(
    () => (clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === recordId) ?? null : null),
    [clientsModel, records, recordId],
  );

  const canView = useCanViewRecord(clientsModel ?? undefined, client ?? undefined);
  const canEdit = useCanEditRecord(clientsModel ?? undefined, client ?? undefined);

  const ctx: ClientViewCtx = useMemo(() => ({ models, records, users, language }), [models, records, users, language]);
  const view = useMemo(() => (client ? resolveClientView(client, ctx) : null), [client, ctx]);

  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [showFollowupModal, setShowFollowupModal] = useState(false);
  const [showApptModal, setShowApptModal] = useState(false);
  const { openWhatsApp, whatsAppModals } = useClientWhatsApp();

  // Advanced view (`?generic=1`) — the raw record form, incl. the permission-gated
  // delete button. A slim bar on top routes back to the workspace view.
  if (generic) {
    const backToWorkspace = () => {
      const sp = new URLSearchParams(location.search);
      sp.delete('generic');
      navigate({ pathname: location.pathname, search: sp.toString() });
    };
    return (
      <div>
        <div className="mx-auto max-w-[1500px] px-4 pt-4 sm:px-6">
          <button
            type="button"
            onClick={backToWorkspace}
            className="inline-flex items-center gap-1.5 rounded-lg bg-copper/10 px-3 py-1.5 text-sm font-bold text-copper transition hover:bg-copper/20"
          >
            <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} />
            {isAr ? 'العودة إلى ملف العميل' : 'Back to client workspace'}
          </button>
        </div>
        <RecordFormPage />
      </div>
    );
  }
  if (!clientsModel) return <div className="p-6 text-terracotta">{isAr ? 'نموذج العملاء غير موجود' : 'Clients model not found'}</div>;
  if (!client || !view) return <div className="p-6 text-terracotta">{isAr ? 'العميل غير موجود' : 'Client not found'}</div>;
  if (!canView) return <div className="p-6 text-terracotta">{isAr ? 'لا تملك صلاحية عرض هذا العميل' : 'You do not have permission to view this client'}</div>;

  const returnTo = `/model/clients/${client.id}`;
  const listReturnTo = new URLSearchParams(location.search).get('returnTo') ?? '/model/clients';

  // Phones for the Call History panel (every phone-type field on the client).
  const phones = phoneFieldSlugs(clientsModel)
    .map((slug) => nonEmptyString(client.data[slug]))
    .filter((p): p is string => !!p);

  const followupsModelId = models.find((m) => m.name === 'followups')?.id;
  const appointmentsModelId = models.find((m) => m.name === 'appointments')?.id;
  const fuClientSlug = clientLookupSlug(followupsModelId, models, clientsModel.id);
  const apptClientSlug = clientLookupSlug(appointmentsModelId, models, clientsModel.id);

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 sm:p-6">
      {whatsAppModals}

      <DetailHeader
        view={view}
        isAr={isAr}
        returnTo={listReturnTo}
        onWhatsApp={() => openWhatsApp(client.id, view.phone)}
        onCreateFollowup={() => setShowFollowupModal(true)}
        onCreateAppointment={() => setShowApptModal(true)}
        onAdvancedView={() => {
          const sp = new URLSearchParams(location.search);
          sp.set('generic', '1');
          navigate({ pathname: location.pathname, search: sp.toString() });
        }}
      />

      <DetailKpiRow view={view} isAr={isAr} />

      {/* Tab nav */}
      <div className="flex gap-1 overflow-x-auto border-b border-sand/40">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-bold transition ${
                activeTab === t.key ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'
              }`}
            >
              <Icon size={15} />
              {isAr ? t.label_ar : t.label_en}
            </button>
          );
        })}
      </div>

      <div>
        {activeTab === 'overview' && (
          <OverviewTab
            view={view}
            ctx={ctx}
            isAr={isAr}
            returnTo={returnTo}
            onOpenTimeline={() => setActiveTab('timeline')}
            onOpenWhatsApp={() => setActiveTab('whatsapp')}
          />
        )}
        {activeTab === 'preferences' && <PreferencesTab client={client} clientsModel={clientsModel} isAr={isAr} canEdit={canEdit} />}
        {activeTab === 'options' && (
          <ClientOptionsTab
            client={client}
            isAr={isAr}
            canEdit={canEdit}
            onFindMore={() => navigate(`/model/clients/${client.id}/projects`)}
          />
        )}
        {activeTab === 'timeline' && <TimelineTab view={view} ctx={ctx} isAr={isAr} />}
        {activeTab === 'whatsapp' && <WhatsAppHistoryPanel clientId={client.id} chrome="card" />}
        {activeTab === 'calls' && <CallHistoryPanel phones={phones} chrome="card" />}
        {activeTab === 'related' && <RelatedRecordsPanel recordId={client.id} targetModelName="clients" />}
        {activeTab === 'notes' && (
          <SalesNotesTab view={view} client={client} clientsModel={clientsModel} ctx={ctx} isAr={isAr} canEdit={canEdit} />
        )}
      </div>

      {/* Create follow-up */}
      {showFollowupModal && followupsModelId && (
        <RecordFormModal
          modelId={followupsModelId}
          recordId={null}
          prefill={{
            ...(fuClientSlug ? { [fuClientSlug]: client.id } : {}),
            phone_number: phones[0] ?? '',
            sales_rep: view.ownerId ?? currentUserId ?? null,
          }}
          onClose={() => setShowFollowupModal(false)}
          onSaved={() => {
            setShowFollowupModal(false);
            addToast(isAr ? 'تم إنشاء المتابعة' : 'Follow-up created', 'success');
          }}
        />
      )}

      {/* Create appointment */}
      {showApptModal && appointmentsModelId && (
        <RecordFormModal
          modelId={appointmentsModelId}
          recordId={null}
          prefill={{
            ...(apptClientSlug ? { [apptClientSlug]: client.id } : {}),
            phone_number: phones[0] ?? '',
            sales_rep: view.ownerId ?? currentUserId ?? null,
          }}
          onClose={() => setShowApptModal(false)}
          onSaved={() => {
            setShowApptModal(false);
            addToast(isAr ? 'تم إنشاء الموعد' : 'Appointment created', 'success');
          }}
        />
      )}
    </div>
  );
}

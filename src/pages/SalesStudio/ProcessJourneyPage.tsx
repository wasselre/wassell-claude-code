import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Map as MapIcon, UserPlus, Users } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import type { AppRecord, SalesProcessVersion, SalesWorkflowOverlay } from '@/types';
import {
  buildJourney, buildWorkflowCard, overlayMapFromConfig, clientsForProcess,
} from '@/lib/salesStudio';
import type { WorkflowCard } from '@/lib/salesStudio';
import { DEFAULT_SALES_PROCESS } from '@/lib/salesProcess';
import { useProcessRollup, useStudioBase } from './lib/useStudioData';
import { PROCESS_STATUS_LABELS, statusColor, formatMetric, pick } from './lib/labels';
import WorkflowCardView from './components/WorkflowCardView';
import WorkflowSimpleEditor from './components/WorkflowSimpleEditor';
import VersionManager from './components/VersionManager';
import AssignClientModal from './components/AssignClientModal';

interface EditorState { card: WorkflowCard; overlay: SalesWorkflowOverlay; draftVersionId: string; editingActive: boolean }

export default function ProcessJourneyPage() {
  const { processId } = useParams<{ processId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const {
    language, workflows, salesProcesses, salesProcessVersions,
    ensureDraftVersion, saveSalesProcessVersion, assignClientToProcess, addToast,
  } = useAppStore();
  const isAr = language === 'ar';

  const process = salesProcesses.find((p) => p.id === processId);
  const versions = useMemo(
    () => salesProcessVersions.filter((v) => v.sales_process_id === processId),
    [salesProcessVersions, processId],
  );
  const activeVersion = versions.find((v) => v.status === 'active');
  const draftVersion = versions.find((v) => v.status === 'draft');

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedVersionId && versions.some((v) => v.id === selectedVersionId)) return;
    const preferDraft = searchParams.get('draft') === '1' && draftVersion;
    setSelectedVersionId((preferDraft ? draftVersion?.id : activeVersion?.id) ?? versions[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions.length, activeVersion?.id, draftVersion?.id]);

  const selectedVersion = versions.find((v) => v.id === selectedVersionId) ?? activeVersion ?? versions[0];
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);

  const base = useStudioBase();
  const rollup = useProcessRollup(process ?? ({ id: '', is_default: false } as never));

  const journey = useMemo(
    () => buildJourney(workflows, { config: DEFAULT_SALES_PROCESS, overlayByWorkflow: overlayMapFromConfig(selectedVersion?.config_json) }),
    [workflows, selectedVersion],
  );

  // Clients assigned to this process whose active assignment is on an OLD version
  // and who have no open follow-up — eligible for safe migration to the active version.
  const migrateEligible = useMemo(() => {
    if (!process || !activeVersion) return [] as AppRecord[];
    const openByClient = new Set<string>();
    for (const f of base.followups) {
      const st = (f.data.followup_status as string) || 'open';
      if (st !== 'open' && st !== 'in_progress') continue;
      const cid = Array.isArray(f.data.client_id) ? f.data.client_id[0] : f.data.client_id;
      if (typeof cid === 'string') openByClient.add(cid);
    }
    return clientsForProcess(process.id, process.is_default, base.clients, base.byClient).filter((c) => {
      const a = base.byClient.get(c.id);
      return a && a.sales_process_version_id !== activeVersion.id && !openByClient.has(c.id);
    });
  }, [process, activeVersion, base]);

  if (!process) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <button onClick={() => navigate('/sales/studio')} className="mb-4 inline-flex items-center gap-1 text-sm text-copper"><ArrowLeft size={15} /> {isAr ? 'استوديو المبيعات' : 'Sales Studio'}</button>
        <p className="rounded-xl bg-terracotta/10 p-4 text-sm text-terracotta">{isAr ? 'المسار غير موجود.' : 'Process not found.'}</p>
      </div>
    );
  }

  const openEditor = (card: WorkflowCard) => {
    if (!card.workflow_id || !process) return;
    if (!isAdmin) { addToast(isAr ? 'التحرير للمسؤولين فقط' : 'Editing is admin-only', 'error'); return; }
    const editingActive = !selectedVersion || selectedVersion.status !== 'draft';
    const draft = editingActive ? ensureDraftVersion(process.id) : selectedVersion!;
    setSelectedVersionId(draft.id);
    // Build the card from the DRAFT overlay so current values reflect the draft.
    const wf = workflows.find((w) => w.id === card.workflow_id);
    const draftCard = buildWorkflowCard(
      card.activity_type, card.stage_key, wf, draft.config_json.workflows, DEFAULT_SALES_PROCESS,
    );
    setEditor({
      card: draftCard,
      overlay: draft.config_json.workflows[card.workflow_id] ?? {},
      draftVersionId: draft.id,
      editingActive,
    });
  };

  const saveOverlay = (next: SalesWorkflowOverlay) => {
    if (!editor) return;
    const draft = salesProcessVersions.find((v) => v.id === editor.draftVersionId);
    if (!draft || !editor.card.workflow_id) return;
    const updated: SalesProcessVersion = {
      ...draft,
      config_json: {
        ...draft.config_json,
        workflows: { ...draft.config_json.workflows, [editor.card.workflow_id]: next },
      },
      updated_at: new Date().toISOString(),
    };
    saveSalesProcessVersion(updated);
    addToast(isAr ? 'تم حفظ التعديل في المسودة' : 'Saved to draft', 'success');
    setEditor(null);
  };

  const migrate = () => {
    if (!process || !activeVersion) return;
    let n = 0;
    for (const c of migrateEligible) {
      const a = base.byClient.get(c.id);
      assignClientToProcess({
        clientId: c.id,
        processId: process.id,
        versionId: activeVersion.id,
        experimentId: a?.sales_experiment_id ?? null,
        group: a?.experiment_group ?? null,
        reason: isAr ? `ترحيل إلى v${activeVersion.version_number}` : `Migrated to v${activeVersion.version_number}`,
      });
      n++;
    }
    addToast(isAr ? `تم نقل ${n} عميلًا` : `Migrated ${n} clients`, 'success');
  };

  const f = rollup.funnel;

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      {/* header */}
      <button onClick={() => navigate('/sales/studio')} className="mb-3 inline-flex items-center gap-1 text-sm text-copper hover:underline"><ArrowLeft size={15} /> {isAr ? 'كل المسارات' : 'All processes'}</button>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-copper-50 text-copper"><MapIcon size={22} /></span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-chocolate">{isAr ? process.name_ar : process.name_en}</h1>
              <span className="badge" style={{ backgroundColor: `${statusColor(process.status)}1A`, color: statusColor(process.status) }}>{pick(PROCESS_STATUS_LABELS[process.status], isAr)}</span>
            </div>
            {(process.description_ar || process.description_en) && (
              <p className="mt-0.5 max-w-2xl text-sm text-charcoal/60">{isAr ? process.description_ar : process.description_en}</p>
            )}
          </div>
        </div>
        {isAdmin && (
          <button type="button" onClick={() => setAssignOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-copper px-4 py-2.5 text-sm font-bold text-white hover:bg-terracotta">
            <UserPlus size={16} /> {isAr ? 'إسناد عميل' : 'Assign client'}
          </button>
        )}
      </header>

      {/* funnel strip */}
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-cream px-5 py-3 text-sm">
        <Stat label={isAr ? 'العملاء' : 'Clients'} value={String(f.lead_count.value ?? 0)} />
        <Stat label={isAr ? 'حجز موعد' : 'Booking'} value={formatMetric(f.appointment_booking_rate, isAr)} />
        <Stat label={isAr ? 'زيارة' : 'Visit'} value={formatMetric(f.visit_rate, isAr)} />
        <Stat label={isAr ? 'عرض' : 'Offer'} value={formatMetric(f.offer_request_rate, isAr)} />
        <Stat label={isAr ? 'حجز' : 'Reservation'} value={formatMetric(f.reservation_rate, isAr)} />
        <Stat label={isAr ? 'إغلاق ناجح' : 'Closed won'} value={formatMetric(f.closed_won_rate, isAr)} good />
        <Stat label={isAr ? 'تسريبات' : 'Leaks'} value={String(f.no_next_action_count.value ?? 0)} bad />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* journey map */}
        <div className="space-y-4">
          {selectedVersion && selectedVersion.status === 'draft' && (
            <div className="rounded-xl bg-copper/10 px-4 py-2.5 text-xs font-semibold text-copper">
              {isAr ? 'تعرض الآن المسودة — التعديلات تُحفظ فيها دون التأثير على الإصدار النشط.' : 'Viewing the draft — edits save here without affecting the active version.'}
            </div>
          )}
          {journey.map((stage) => (
            <section key={stage.key} className="card rounded-2xl p-4" style={{ borderInlineStart: `4px solid ${stage.color ?? '#B8734F'}` }}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-bold text-chocolate">{isAr ? stage.label_ar : stage.label_en}</h2>
                <span className="text-xs text-charcoal/45">{stage.cards.length} {isAr ? 'سير عمل' : 'workflows'}</span>
              </div>
              {stage.cards.length === 0 ? (
                <p className="rounded-lg bg-cream/60 px-3 py-2 text-xs text-charcoal/45">{isAr ? 'لا توجد أنشطة في هذه المرحلة (خروج/نهائية).' : 'No activities at this stage (terminal/side-exit).'}</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {stage.cards.map((card, i) => (
                    <WorkflowCardView key={`${card.workflow_id ?? card.activity_type}-${i}`} card={card} onEditSimple={openEditor} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>

        {/* sidebar */}
        <aside className="space-y-4">
          <VersionManager
            process={process}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
            migrateEligibleCount={migrateEligible.length}
            onMigrate={migrate}
          />
          <AssignedClientsCard processId={process.id} isDefault={process.is_default} onAssign={() => setAssignOpen(true)} />
        </aside>
      </div>

      {editor && (
        <WorkflowSimpleEditor
          card={editor.card}
          overlay={editor.overlay}
          editingActive={editor.editingActive}
          onClose={() => setEditor(null)}
          onSave={saveOverlay}
        />
      )}
      <AssignClientModal open={assignOpen} onClose={() => setAssignOpen(false)} presetProcessId={process.id} />
    </div>
  );
}

function Stat({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  const color = good ? '#10B981' : bad ? '#8E4E3A' : '#4A2C2A';
  return (
    <span className="inline-flex flex-col">
      <span className="text-[11px] text-charcoal/55">{label}</span>
      <b className="text-base font-bold leading-tight" style={{ color }} dir="ltr">{value}</b>
    </span>
  );
}

/** Compact assigned-clients summary with current stage + next action. */
function AssignedClientsCard({ processId, isDefault, onAssign }: { processId: string; isDefault: boolean; onAssign: () => void }) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const base = useStudioBase();
  const navigate = useNavigate();
  const cohort = useMemo(
    () => clientsForProcess(processId, isDefault, base.clients, base.byClient),
    [processId, isDefault, base],
  );
  const assignedExplicit = cohort.filter((c) => base.byClient.get(c.id)?.sales_process_id === processId);

  return (
    <section className="card rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-chocolate"><Users size={16} className="text-copper" /> {isAr ? 'العملاء المعيّنون' : 'Assigned clients'}</h3>
        <span className="text-sm font-bold text-chocolate" dir="ltr">{assignedExplicit.length}</span>
      </div>
      {isDefault && (
        <p className="mb-2 rounded-lg bg-cream/60 px-2.5 py-1.5 text-[11px] text-charcoal/55">{isAr ? 'هذا هو المسار الافتراضي — العملاء غير المعيّنين يتبعونه تلقائيًا.' : 'Default process — unassigned clients follow it automatically.'}</p>
      )}
      <ul className="space-y-1.5">
        {assignedExplicit.slice(0, 8).map((c) => {
          const a = base.byClient.get(c.id);
          return (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/model/clients/${c.id}`)} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-cream">
                <span className="truncate text-charcoal">{String(c.data.client_name ?? (isAr ? 'بدون اسم' : 'Unnamed'))}</span>
                <span className="shrink-0 text-charcoal/45">{a?.experiment_group ?? (c.data.client_stage as string) ?? ''}</span>
              </button>
            </li>
          );
        })}
        {assignedExplicit.length === 0 && <li className="px-2 text-xs text-charcoal/40">{isAr ? 'لا يوجد عملاء معيّنون يدويًا.' : 'No manually assigned clients.'}</li>}
      </ul>
      <button type="button" onClick={onAssign} className="mt-2 w-full rounded-lg border border-sand px-3 py-1.5 text-xs font-semibold text-charcoal hover:bg-cream">
        {isAr ? 'إسناد عميل' : 'Assign a client'}
      </button>
    </section>
  );
}

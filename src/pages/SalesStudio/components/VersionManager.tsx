import { useMemo, useState } from 'react';
import { GitBranch, Plus, Rocket, Trash2, RotateCcw, Users, Check } from 'lucide-react';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useAppStore } from '@/stores/appStore';
import type { SalesProcess, SalesProcessVersion } from '@/types';
import { VERSION_STATUS_LABELS, statusColor, pick } from '../lib/labels';

/** Version lifecycle panel: list + create-draft / publish / discard / rollback / migrate. */
export default function VersionManager({
  process,
  selectedVersionId,
  onSelectVersion,
  migrateEligibleCount,
  onMigrate,
}: {
  process: SalesProcess;
  selectedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  migrateEligibleCount: number;
  onMigrate: () => void;
}) {
  const { language, salesProcessVersions, ensureDraftVersion, publishSalesProcessVersion, discardDraftVersion, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [confirm, setConfirm] = useState<null | { kind: 'publish' | 'discard' | 'rollback' | 'migrate'; versionId?: string }>(null);
  const [busy, setBusy] = useState(false);

  const versions = useMemo(
    () => salesProcessVersions
      .filter((v) => v.sales_process_id === process.id)
      .sort((a, b) => b.version_number - a.version_number),
    [salesProcessVersions, process.id],
  );
  const draft = versions.find((v) => v.status === 'draft');
  const active = versions.find((v) => v.status === 'active');

  const createDraft = () => {
    const d = ensureDraftVersion(process.id);
    onSelectVersion(d.id);
    addToast(isAr ? 'تم إنشاء مسودة' : 'Draft created', 'success');
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    if (confirm.kind === 'publish' && draft) {
      await publishSalesProcessVersion(draft.id);
      onSelectVersion(draft.id);
      addToast(isAr ? 'تم نشر الإصدار' : 'Version published', 'success');
    } else if (confirm.kind === 'discard' && draft) {
      discardDraftVersion(draft.id);
      if (active) onSelectVersion(active.id);
      addToast(isAr ? 'تم تجاهل المسودة' : 'Draft discarded', 'info');
    } else if (confirm.kind === 'rollback' && confirm.versionId) {
      await publishSalesProcessVersion(confirm.versionId);
      onSelectVersion(confirm.versionId);
      addToast(isAr ? 'تمت الاستعادة' : 'Rolled back', 'success');
    } else if (confirm.kind === 'migrate') {
      onMigrate();
    }
    setBusy(false);
    setConfirm(null);
  };

  const confirmCopy = (): { title: string; message: string } => {
    if (confirm?.kind === 'publish') return {
      title: isAr ? 'نشر المسودة؟' : 'Publish draft?',
      message: isAr ? 'سيصبح هذا الإصدار النشط، ويُؤرشف الإصدار النشط الحالي. لن يتم نقل العملاء الحاليين تلقائيًا.' : 'This becomes the active version and the current active version is archived. Existing clients are NOT auto-migrated.',
    };
    if (confirm?.kind === 'discard') return {
      title: isAr ? 'تجاهل المسودة؟' : 'Discard draft?',
      message: isAr ? 'ستفقد كل التعديلات غير المنشورة في هذه المسودة.' : 'All unpublished edits in this draft will be lost.',
    };
    if (confirm?.kind === 'rollback') return {
      title: isAr ? 'الاستعادة لهذا الإصدار؟' : 'Roll back to this version?',
      message: isAr ? 'سيُعاد تفعيل هذا الإصدار ويُؤرشف الإصدار النشط الحالي.' : 'This version is re-activated and the current active version is archived.',
    };
    return {
      title: isAr ? 'نقل العملاء؟' : 'Migrate clients?',
      message: isAr ? `سيتم نقل ${migrateEligibleCount} عميلًا بدون متابعة مفتوحة إلى الإصدار النشط الحالي. العملاء ذوو المتابعات المفتوحة يبقون على إصدارهم.` : `${migrateEligibleCount} clients with no open follow-up will be moved to the current active version. Clients with open follow-ups stay on their version.`,
    };
  };

  return (
    <section className="card rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-chocolate"><GitBranch size={16} className="text-copper" /> {isAr ? 'الإصدارات' : 'Versions'}</h3>
        {!draft && (
          <button type="button" onClick={createDraft} className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-[11px] font-bold text-white hover:bg-terracotta">
            <Plus size={12} /> {isAr ? 'مسودة من النشط' : 'Draft from active'}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {versions.map((v) => (
          <VersionRow
            key={v.id}
            version={v}
            isAr={isAr}
            selected={v.id === selectedVersionId}
            onSelect={() => onSelectVersion(v.id)}
            isActive={v.status === 'active'}
            onRollback={v.status === 'archived' ? () => setConfirm({ kind: 'rollback', versionId: v.id }) : undefined}
          />
        ))}
        {versions.length === 0 && <p className="text-xs text-charcoal/45">{isAr ? 'لا توجد إصدارات' : 'No versions'}</p>}
      </div>

      {/* draft actions */}
      {draft && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-sand/40 pt-3">
          <button type="button" onClick={() => setConfirm({ kind: 'publish' })} className="inline-flex items-center gap-1 rounded-lg bg-[#10B981] px-3 py-1.5 text-xs font-bold text-white hover:opacity-90">
            <Rocket size={13} /> {isAr ? 'نشر المسودة' : 'Publish draft'}
          </button>
          <button type="button" onClick={() => setConfirm({ kind: 'discard' })} className="inline-flex items-center gap-1 rounded-lg border border-sand px-3 py-1.5 text-xs font-semibold text-charcoal hover:bg-cream">
            <Trash2 size={13} /> {isAr ? 'تجاهل' : 'Discard'}
          </button>
        </div>
      )}

      {/* migration */}
      {active && (
        <div className="mt-3 border-t border-sand/40 pt-3">
          <button
            type="button"
            onClick={() => setConfirm({ kind: 'migrate' })}
            disabled={migrateEligibleCount === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sand px-3 py-1.5 text-xs font-semibold text-charcoal hover:bg-cream disabled:opacity-40"
          >
            <Users size={13} /> {isAr ? `نقل العملاء بلا متابعة (${migrateEligibleCount})` : `Migrate clients w/o follow-up (${migrateEligibleCount})`}
          </button>
          <p className="mt-1.5 text-[11px] text-charcoal/45">{isAr ? 'العملاء الحاليون لا يُنقلون تلقائيًا عند النشر.' : 'Existing clients are never silently migrated on publish.'}</p>
        </div>
      )}

      <ConfirmModal
        open={!!confirm}
        title={confirmCopy().title}
        message={confirmCopy().message}
        confirmLabel={isAr ? 'تأكيد' : 'Confirm'}
        cancelLabel={isAr ? 'إلغاء' : 'Cancel'}
        danger={confirm?.kind === 'discard'}
        busy={busy}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}

function VersionRow({ version, isAr, selected, onSelect, isActive, onRollback }: {
  version: SalesProcessVersion; isAr: boolean; selected: boolean; onSelect: () => void; isActive: boolean; onRollback?: () => void;
}) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border p-2 ${selected ? 'border-copper bg-copper/5' : 'border-sand/40'}`}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-start">
        {selected && <Check size={13} className="shrink-0 text-copper" />}
        <span className="text-sm font-bold text-chocolate" dir="ltr">v{version.version_number}</span>
        <span className="badge" style={{ backgroundColor: `${statusColor(version.status)}1A`, color: statusColor(version.status) }}>
          {pick(VERSION_STATUS_LABELS[version.status], isAr)}
        </span>
        {isActive && <span className="text-[11px] text-charcoal/45">{isAr ? 'مُستخدم في التنفيذ' : 'live'}</span>}
      </button>
      {onRollback && (
        <button type="button" onClick={onRollback} title={isAr ? 'استعادة' : 'Roll back'} className="rounded p-1 text-charcoal/45 hover:bg-cream hover:text-copper">
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

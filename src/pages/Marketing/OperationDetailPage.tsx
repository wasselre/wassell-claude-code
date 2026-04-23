import { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import StatusBadge from './components/StatusBadge';
import ResearchQuestionsPanel from './components/ResearchQuestionsPanel';
import type { MarketingOperation, ResearchFact, ResearchOutput } from '@/types';
import { exportPostsPdf, exportReelsPdf } from '@/lib/marketingPdf';

export default function OperationDetailPage() {
  const { operationId } = useParams<{ operationId: string }>();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const operations = useAppStore((s) => s.marketingOperations);
  const reels = useAppStore((s) => s.reels);
  const posts = useAppStore((s) => s.posts);
  const approveMarketingOperation = useAppStore((s) => s.approveMarketingOperation);
  const updateOperationResearch = useAppStore((s) => s.updateOperationResearch);
  const addToast = useAppStore((s) => s.addToast);

  const [approving, setApproving] = useState(false);
  const [selectedReels, setSelectedReels] = useState<Set<string>>(new Set());
  const [selectedPosts, setSelectedPosts] = useState<Set<string>>(new Set());
  const [reelsExporting, setReelsExporting] = useState(false);
  const [postsExporting, setPostsExporting] = useState(false);

  const operation = operations.find((o) => o.id === operationId);

  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);
  const project = useMemo(() => {
    if (!operation || !allProjectsModel) return null;
    const list = records[allProjectsModel.id] ?? [];
    return list.find((r) => r.id === operation.project_record_id) ?? null;
  }, [operation, allProjectsModel, records]);

  const opReels = useMemo(
    () => reels.filter((r) => r.operation_id === operationId).sort((a, b) => a.reel_number - b.reel_number),
    [reels, operationId],
  );
  const opPosts = useMemo(
    () => posts.filter((p) => p.operation_id === operationId).sort((a, b) => a.post_number - b.post_number),
    [posts, operationId],
  );

  if (!operation) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-center">
        <p className="text-charcoal/60">
          {isAr ? 'لم يتم العثور على العملية' : 'Operation not found'}
        </p>
        <Button variant="secondary" className="mt-3" onClick={() => navigate('/marketing')}>
          {isAr ? 'العودة للقائمة' : 'Back to list'}
        </Button>
      </div>
    );
  }

  const projectName =
    (project?.data.project_name as string | undefined) ??
    (project?.data.name as string | undefined) ??
    '—';

  const BackIcon = isAr ? ArrowRight : ArrowLeft;
  const locale = isAr ? 'ar-SA' : 'en-US';
  const date = new Date(operation.created_at).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const canApprove = operation.status === 'ready_for_review';

  const handleApprove = async () => {
    setApproving(true);
    try {
      await approveMarketingOperation(operation.id);
      addToast(isAr ? 'تمت الموافقة على العملية' : 'Operation approved', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    } finally {
      setApproving(false);
    }
  };

  const toggleInSet = (prev: Set<string>, id: string): Set<string> => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const handleExportReels = async (onlySelected: boolean) => {
    const subset = onlySelected
      ? opReels.filter((r) => selectedReels.has(r.id))
      : opReels;
    if (subset.length === 0) {
      addToast(isAr ? 'لا توجد عناصر للتصدير' : 'Nothing selected to export', 'error');
      return;
    }
    setReelsExporting(true);
    try {
      await exportReelsPdf(projectName, subset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    } finally {
      setReelsExporting(false);
    }
  };

  const handleExportPosts = async (onlySelected: boolean) => {
    const subset = onlySelected
      ? opPosts.filter((p) => selectedPosts.has(p.id))
      : opPosts;
    if (subset.length === 0) {
      addToast(isAr ? 'لا توجد عناصر للتصدير' : 'Nothing selected to export', 'error');
      return;
    }
    setPostsExporting(true);
    try {
      await exportPostsPdf(projectName, subset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    } finally {
      setPostsExporting(false);
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-6">
      <button
        onClick={() => navigate('/marketing')}
        className="inline-flex items-center gap-1.5 text-sm text-charcoal/60 hover:text-copper"
      >
        <BackIcon size={14} />
        {isAr ? 'العودة' : 'Back'}
      </button>

      <div className="bg-white rounded-xl border border-sand/50 p-5">
        <div className="flex flex-wrap items-start gap-4 justify-between">
          <div>
            <h1 className="text-xl font-bold text-charcoal mb-1">{projectName}</h1>
            <div className="flex items-center gap-3 text-xs text-charcoal/60">
              <span>{isAr ? 'أُنشئت' : 'Created'}: {date}</span>
            </div>
          </div>
          <StatusBadge status={operation.status} />
        </div>
        {operation.research_error && (
          <p className="mt-3 text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2">
            {operation.research_error}
          </p>
        )}
        {canApprove && (
          <div className="mt-4 flex justify-end">
            <Button onClick={handleApprove} disabled={approving}>
              <CheckCircle2 size={16} />
              {approving
                ? (isAr ? 'جاري الموافقة…' : 'Approving…')
                : (isAr ? 'الموافقة على كل المحتوى' : 'Approve all content')}
            </Button>
          </div>
        )}
      </div>

      <section>
        {operation.status === 'research_pending' || operation.status === 'research_in_progress' ? (
          <>
            <SectionHeader title={isAr ? 'البحث' : 'Research'} />
            <div className="bg-white rounded-xl border border-sand/50 p-5 flex items-center gap-3 text-sm text-charcoal/70">
              <Loader2 size={16} className="animate-spin text-copper" />
              {isAr ? 'جاري البحث عن المشروع — قد يستغرق دقيقة أو دقيقتين.' : 'Researching the project — may take a minute or two.'}
            </div>
          </>
        ) : operation.status === 'research_waiting_answers' ? (
          <>
            <SectionHeader title={isAr ? 'البحث' : 'Research'} />
            <ResearchQuestionsPanel operationId={operation.id} />
          </>
        ) : operation.research_output ? (
          <ResearchSection
            operation={operation}
            isAr={isAr}
            onSave={async (output) => {
              await updateOperationResearch(operation.id, output);
              addToast(isAr ? 'تم حفظ التعديلات' : 'Changes saved', 'success');
            }}
          />
        ) : (
          <>
            <SectionHeader title={isAr ? 'البحث' : 'Research'} />
            <div className="bg-white rounded-xl border border-sand/50 p-5 text-sm text-charcoal/60">
              {isAr ? 'لا توجد بيانات بحث' : 'No research data'}
            </div>
          </>
        )}
      </section>

      {operation.reels_settings && (
        <section>
          <SectionHeader
            title={isAr ? 'الريلز' : 'Reels'}
            count={`${opReels.length} ${isAr ? 'ريل' : 'reels'}`}
            right={
              <ExportControls
                isAr={isAr}
                selectedCount={selectedReels.size}
                totalCount={opReels.length}
                busy={reelsExporting}
                onExportAll={() => handleExportReels(false)}
                onExportSelected={() => handleExportReels(true)}
              />
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {opReels.map((reel) => (
              <SelectableCard
                key={reel.id}
                selected={selectedReels.has(reel.id)}
                onToggle={() => setSelectedReels((prev) => toggleInSet(prev, reel.id))}
              >
                <Link
                  to={`/marketing/${operation.id}/reels/${reel.id}`}
                  className="block flex-1"
                >
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-bold text-charcoal">
                      {isAr ? `ريل #${reel.reel_number}` : `Reel #${reel.reel_number}`}
                    </span>
                    <StatusBadge status={reel.status} />
                  </div>
                  <div className="text-xs text-charcoal/60 mb-2">
                    {reel.type ?? '—'} · {reel.duration ?? '?'}s · {reel.platform ?? '—'}
                  </div>
                  {reel.scenes && reel.scenes[0] && (
                    <div className="text-sm text-charcoal/80 line-clamp-2">{reel.scenes[0].text}</div>
                  )}
                </Link>
              </SelectableCard>
            ))}
          </div>
        </section>
      )}

      {operation.posts_settings && (
        <section>
          <SectionHeader
            title={isAr ? 'المنشورات' : 'Posts'}
            count={`${opPosts.length} ${isAr ? 'منشور' : 'posts'}`}
            right={
              <ExportControls
                isAr={isAr}
                selectedCount={selectedPosts.size}
                totalCount={opPosts.length}
                busy={postsExporting}
                onExportAll={() => handleExportPosts(false)}
                onExportSelected={() => handleExportPosts(true)}
              />
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {opPosts.map((post) => (
              <SelectableCard
                key={post.id}
                selected={selectedPosts.has(post.id)}
                onToggle={() => setSelectedPosts((prev) => toggleInSet(prev, post.id))}
              >
                <Link
                  to={`/marketing/${operation.id}/posts/${post.id}`}
                  className="block flex-1"
                >
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-bold text-charcoal">
                      {isAr ? `منشور #${post.post_number}` : `Post #${post.post_number}`}
                    </span>
                    <StatusBadge status={post.status} />
                  </div>
                  <div className="text-xs text-charcoal/60 mb-2">
                    {post.type ?? '—'} · {post.components ?? '—'} · {post.usage ?? '—'}
                  </div>
                  {post.title && <div className="text-sm font-semibold text-charcoal">{post.title}</div>}
                  {post.design_text_1 && (
                    <div className="text-sm text-charcoal/80 line-clamp-2">{post.design_text_1}</div>
                  )}
                </Link>
              </SelectableCard>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  count,
  right,
}: {
  title: string;
  count?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
      <div className="flex items-end gap-3">
        <h2 className="text-lg font-bold text-charcoal">{title}</h2>
        {count && <span className="text-xs text-charcoal/50">{count}</span>}
      </div>
      {right}
    </div>
  );
}

function ExportControls({
  isAr,
  selectedCount,
  totalCount,
  busy,
  onExportAll,
  onExportSelected,
}: {
  isAr: boolean;
  selectedCount: number;
  totalCount: number;
  busy: boolean;
  onExportAll: () => void;
  onExportSelected: () => void;
}) {
  if (totalCount === 0) return null;
  return (
    <div className="flex gap-2 items-center text-xs">
      <button
        type="button"
        onClick={onExportSelected}
        disabled={busy || selectedCount === 0}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/60 bg-white text-charcoal hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download size={13} />
        {isAr ? `المحدد (${selectedCount})` : `Selected (${selectedCount})`}
      </button>
      <button
        type="button"
        onClick={onExportAll}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        {isAr ? 'تصدير الكل PDF' : 'Export all PDF'}
      </button>
    </div>
  );
}

function SelectableCard({
  selected,
  onToggle,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-white rounded-xl border p-4 hover:border-copper/40 transition-colors flex gap-3 items-start ${
        selected ? 'border-copper' : 'border-sand/50'
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 w-4 h-4 accent-copper cursor-pointer"
        aria-label="select"
      />
      {children}
    </div>
  );
}

function ResearchSection({
  operation,
  isAr,
  onSave,
}: {
  operation: MarketingOperation;
  isAr: boolean;
  onSave: (output: ResearchOutput) => Promise<void>;
}) {
  const output = operation.research_output!;
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ResearchFact[]>(output.facts ?? []);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(output.facts ?? []);
    setEditing(true);
    setCollapsed(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(output.facts ?? []);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...output, facts: draft });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const updateFact = (index: number, patch: Partial<ResearchFact>) => {
    setDraft((d) => d.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const addFact = () => {
    setDraft((d) => [
      ...d,
      { dataType: '', value: '', source: isAr ? 'تعديل يدوي' : 'Manual edit' },
    ]);
  };

  const deleteFact = (index: number) => {
    setDraft((d) => d.filter((_, i) => i !== index));
  };

  const facts = editing ? draft : (output.facts ?? []);

  return (
    <>
      <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-end gap-2 text-lg font-bold text-charcoal hover:text-copper transition-colors"
        >
          {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          {isAr ? 'البحث' : 'Research'}
          <span className="text-xs font-normal text-charcoal/50">
            {facts.length} {isAr ? 'حقل' : 'facts'}
          </span>
        </button>
        <div className="flex gap-2">
          {!editing ? (
            <button
              type="button"
              onClick={startEdit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/60 bg-white text-charcoal hover:bg-cream text-xs"
            >
              <Pencil size={13} />
              {isAr ? 'تعديل' : 'Edit'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/60 bg-white text-charcoal hover:bg-cream text-xs disabled:opacity-50"
              >
                <X size={13} />
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta text-xs disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                {isAr ? 'حفظ' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>
      {!collapsed && (
        <ResearchFactsTable
          facts={facts}
          isAr={isAr}
          editing={editing}
          onUpdate={updateFact}
          onDelete={deleteFact}
          onAdd={addFact}
        />
      )}
    </>
  );
}

function ResearchFactsTable({
  facts,
  isAr,
  editing,
  onUpdate,
  onDelete,
  onAdd,
}: {
  facts: ResearchFact[];
  isAr: boolean;
  editing: boolean;
  onUpdate: (index: number, patch: Partial<ResearchFact>) => void;
  onDelete: (index: number) => void;
  onAdd: () => void;
}) {
  if (facts.length === 0 && !editing) {
    return (
      <div className="bg-white rounded-xl border border-sand/50 p-5 text-sm text-charcoal/60">
        {isAr ? 'لا توجد حقائق مستخرجة' : 'No facts extracted'}
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl border border-sand/50 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-cream/50 border-b border-sand/50">
          <tr>
            <th className="text-start px-4 py-2 text-xs font-bold text-charcoal/60 uppercase tracking-wider">
              {isAr ? 'الحقل' : 'Field'}
            </th>
            <th className="text-start px-4 py-2 text-xs font-bold text-charcoal/60 uppercase tracking-wider">
              {isAr ? 'القيمة' : 'Value'}
            </th>
            <th className="text-start px-4 py-2 text-xs font-bold text-charcoal/60 uppercase tracking-wider">
              {isAr ? 'المصدر' : 'Source'}
            </th>
            {editing && <th className="w-8" aria-label="delete" />}
          </tr>
        </thead>
        <tbody>
          {facts.map((f, i) => (
            <tr key={i} className="border-b border-sand/30">
              {editing ? (
                <>
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      value={f.dataType}
                      onChange={(e) => onUpdate(i, { dataType: e.target.value })}
                      className="w-full bg-cream/30 border border-sand/40 rounded px-2 py-1 text-sm font-semibold text-charcoal focus:outline-none focus:border-copper"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <textarea
                      value={f.value}
                      onChange={(e) => onUpdate(i, { value: e.target.value })}
                      rows={1}
                      className="w-full bg-cream/30 border border-sand/40 rounded px-2 py-1 text-sm text-charcoal focus:outline-none focus:border-copper resize-y"
                    />
                  </td>
                  <td className="px-4 py-2 space-y-1">
                    <input
                      type="text"
                      value={f.source}
                      onChange={(e) => onUpdate(i, { source: e.target.value })}
                      placeholder={isAr ? 'المصدر' : 'Source'}
                      className="w-full bg-cream/30 border border-sand/40 rounded px-2 py-1 text-xs text-charcoal focus:outline-none focus:border-copper"
                    />
                    <input
                      type="url"
                      value={f.sourceUrl ?? ''}
                      onChange={(e) => onUpdate(i, { sourceUrl: e.target.value || undefined })}
                      placeholder="https://…"
                      className="w-full bg-cream/30 border border-sand/40 rounded px-2 py-1 text-xs text-charcoal focus:outline-none focus:border-copper"
                      dir="ltr"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => onDelete(i)}
                      className="p-1 rounded text-red-600/70 hover:text-red-700 hover:bg-red-50"
                      aria-label="delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className="px-4 py-2 font-semibold text-charcoal">{f.dataType}</td>
                  <td className="px-4 py-2 text-charcoal/80 whitespace-pre-wrap">{f.value}</td>
                  <td className="px-4 py-2 text-xs">
                    {f.sourceUrl ? (
                      <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-copper hover:underline">
                        {f.source || f.sourceUrl}
                      </a>
                    ) : (
                      <span className="text-charcoal/60">{f.source || '—'}</span>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <div className="px-4 py-3 border-t border-sand/40 bg-cream/20">
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1.5 text-xs text-copper hover:text-terracotta font-semibold"
          >
            <Plus size={13} />
            {isAr ? 'إضافة صف' : 'Add row'}
          </button>
        </div>
      )}
    </div>
  );
}

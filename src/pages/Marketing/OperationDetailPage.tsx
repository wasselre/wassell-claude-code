import { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import StatusBadge from './components/StatusBadge';
import ResearchQuestionsPanel from './components/ResearchQuestionsPanel';

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
  const addToast = useAppStore((s) => s.addToast);

  const [approving, setApproving] = useState(false);

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
        <SectionHeader title={isAr ? 'البحث' : 'Research'} />
        {operation.status === 'research_pending' || operation.status === 'research_in_progress' ? (
          <div className="bg-white rounded-xl border border-sand/50 p-5 flex items-center gap-3 text-sm text-charcoal/70">
            <Loader2 size={16} className="animate-spin text-copper" />
            {isAr ? 'جاري البحث عن المشروع — قد يستغرق دقيقة أو دقيقتين.' : 'Researching the project — may take a minute or two.'}
          </div>
        ) : operation.status === 'research_waiting_answers' ? (
          <ResearchQuestionsPanel operationId={operation.id} />
        ) : operation.research_output ? (
          <ResearchOutputTable output={operation.research_output} isAr={isAr} />
        ) : (
          <div className="bg-white rounded-xl border border-sand/50 p-5 text-sm text-charcoal/60">
            {isAr ? 'لا توجد بيانات بحث' : 'No research data'}
          </div>
        )}
      </section>

      {operation.reels_settings && (
        <section>
          <SectionHeader
            title={isAr ? 'الريلز' : 'Reels'}
            count={`${opReels.length} ${isAr ? 'ريل' : 'reels'}`}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {opReels.map((reel) => (
              <Link
                key={reel.id}
                to={`/marketing/${operation.id}/reels/${reel.id}`}
                className="block bg-white rounded-xl border border-sand/50 p-4 hover:border-copper/40 transition-colors"
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
            ))}
          </div>
        </section>
      )}

      {operation.posts_settings && (
        <section>
          <SectionHeader
            title={isAr ? 'المنشورات' : 'Posts'}
            count={`${opPosts.length} ${isAr ? 'منشور' : 'posts'}`}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {opPosts.map((post) => (
              <Link
                key={post.id}
                to={`/marketing/${operation.id}/posts/${post.id}`}
                className="block bg-white rounded-xl border border-sand/50 p-4 hover:border-copper/40 transition-colors"
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
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count?: string }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <h2 className="text-lg font-bold text-charcoal">{title}</h2>
      {count && <span className="text-xs text-charcoal/50">{count}</span>}
    </div>
  );
}

function ResearchOutputTable({
  output,
  isAr,
}: {
  output: { facts?: Array<{ dataType: string; value: string; source?: string; sourceUrl?: string }> };
  isAr: boolean;
}) {
  const facts = output.facts ?? [];
  if (facts.length === 0) {
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
          </tr>
        </thead>
        <tbody>
          {facts.map((f, i) => (
            <tr key={i} className="border-b border-sand/30">
              <td className="px-4 py-2 font-semibold text-charcoal">{f.dataType}</td>
              <td className="px-4 py-2 text-charcoal/80">{f.value}</td>
              <td className="px-4 py-2 text-xs">
                {f.sourceUrl ? (
                  <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-copper hover:underline">
                    {f.source ?? f.sourceUrl}
                  </a>
                ) : (
                  <span className="text-charcoal/60">{f.source ?? '—'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

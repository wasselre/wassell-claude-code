import { useMemo, useState } from 'react';
import { Search, Check, Undo2, Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { normalizeForSearch } from '@/lib/recordSearch';
import { POST_ANGLES } from '@/lib/postsContent/templates';
import { needsAr, needsEn } from '@/lib/postsContent/facts';
import type { PostLanguage } from '@/lib/postsContent/planning';
import PostCard from './PostCard';
import type { PostState, ReviewStatus } from '../lib/persistence';

interface Props {
  isAr: boolean;
  states: PostState[];
  language: PostLanguage;
  running: boolean;
  onApprove: (key: string) => void;
  onUnapprove: (key: string) => void;
  onReject: (key: string) => void;
  onRestore: (key: string) => void;
  onRegenerate: (key: string) => void;
  onEditBody: (key: string, lang: 'ar' | 'en', value: string) => void;
  /** Applies to the CURRENTLY VISIBLE (filtered) posts only. */
  onBulk: (keys: string[], next: ReviewStatus) => void;
}

type StatusFilter = 'all' | ReviewStatus | 'failed';

/**
 * Stage 2 — review the batch.
 *
 * Bulk actions deliberately operate on the FILTERED set and say so, so
 * "approve all" while a project filter is active can't silently approve posts
 * the reviewer never looked at. Bulk reject is intentionally absent: rejecting
 * carries a reason per post, and a blanket reject with one reason is worse than
 * useless for the regeneration feedback loop.
 */
export default function ReviewStage({
  isAr, states, language, running,
  onApprove, onUnapprove, onReject, onRestore, onRegenerate, onEditBody, onBulk,
}: Props) {
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [angleFilter, setAngleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of states) if (!m.has(s.ourProjectId)) m.set(s.ourProjectId, s.projectName);
    return [...m.entries()];
  }, [states]);

  const usedAngles = useMemo(() => {
    const set = new Set(states.map((s) => s.angle));
    return POST_ANGLES.filter((a) => set.has(a.id));
  }, [states]);

  const counts = useMemo(() => ({
    draft: states.filter((s) => s.cardStatus === 'ready' && s.review === 'draft').length,
    approved: states.filter((s) => s.review === 'approved').length,
    rejected: states.filter((s) => s.review === 'rejected').length,
    failed: states.filter((s) => s.cardStatus === 'error').length,
    ready: states.filter((s) => s.cardStatus === 'ready').length,
    total: states.length,
  }), [states]);

  const visible = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    return states.filter((s) => {
      if (projectFilter !== 'all' && s.ourProjectId !== projectFilter) return false;
      if (angleFilter !== 'all' && s.angle !== angleFilter) return false;
      if (statusFilter === 'failed') {
        if (s.cardStatus !== 'error') return false;
      } else if (statusFilter !== 'all') {
        if (s.cardStatus !== 'ready' || s.review !== statusFilter) return false;
      }
      if (!q) return true;
      const hay = normalizeForSearch(
        [s.projectName, s.post?.headline_ar, s.post?.headline_en, s.post?.body_ar, s.post?.body_en]
          .filter(Boolean).join(' '),
      );
      return hay.includes(q);
    });
  }, [states, query, projectFilter, angleFilter, statusFilter]);

  const visibleReadyKeys = visible.filter((s) => s.cardStatus === 'ready').map((s) => s.key);
  const selectClass =
    'py-1.5 px-2 rounded-lg border border-sand/30 bg-cream/40 text-xs text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/25';

  return (
    <>
      {/* Summary + filters */}
      <div className="bg-white rounded-2xl border border-sand/25 shadow-sm p-4 mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {running && (
            <span className="flex items-center gap-1.5 text-copper font-bold">
              <Loader2 size={13} className="animate-spin" />
              {isAr ? `${counts.ready}/${counts.total} جاهز` : `${counts.ready}/${counts.total} ready`}
            </span>
          )}
          <span className="text-charcoal/60">
            {isAr ? 'مسودة' : 'Draft'}: <b className="text-chocolate">{counts.draft}</b>
          </span>
          <span className="text-green-700">
            {isAr ? 'معتمد' : 'Approved'}: <b>{counts.approved}</b>
          </span>
          <span className="text-red-600">
            {isAr ? 'مرفوض' : 'Rejected'}: <b>{counts.rejected}</b>
          </span>
          {counts.failed > 0 && (
            <span className="text-amber-700">
              {isAr ? 'فشل' : 'Failed'}: <b>{counts.failed}</b>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className={`absolute top-1/2 -translate-y-1/2 text-charcoal/30 ${isAr ? 'right-2.5' : 'left-2.5'}`} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isAr ? 'ابحث في النصوص…' : 'Search post text…'}
              className={`w-full py-1.5 rounded-lg border border-sand/30 bg-cream/40 text-xs focus:outline-none focus:ring-2 focus:ring-copper/25 ${isAr ? 'pr-8 pl-2' : 'pl-8 pr-2'}`}
            />
          </div>
          {projects.length > 1 && (
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} className={selectClass}>
              <option value="all">{isAr ? 'كل المشاريع' : 'All projects'}</option>
              {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          <select value={angleFilter} onChange={(e) => setAngleFilter(e.target.value)} className={selectClass}>
            <option value="all">{isAr ? 'كل الزوايا' : 'All angles'}</option>
            {usedAngles.map((a) => (
              <option key={a.id} value={a.id}>{isAr ? a.label_ar : a.label_en}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className={selectClass}>
            <option value="all">{isAr ? 'كل الحالات' : 'All statuses'}</option>
            <option value="draft">{isAr ? 'مسودة' : 'Draft'}</option>
            <option value="approved">{isAr ? 'معتمد' : 'Approved'}</option>
            <option value="rejected">{isAr ? 'مرفوض' : 'Rejected'}</option>
            <option value="failed">{isAr ? 'فشل التوليد' : 'Failed'}</option>
          </select>
          <Button
            variant="secondary"
            onClick={() => onBulk(visibleReadyKeys, 'approved')}
            disabled={visibleReadyKeys.length === 0}
          >
            <Check size={14} />
            {isAr ? `اعتماد الظاهر (${visibleReadyKeys.length})` : `Approve visible (${visibleReadyKeys.length})`}
          </Button>
          <Button
            variant="ghost"
            onClick={() => onBulk(visible.filter((s) => s.review === 'approved').map((s) => s.key), 'draft')}
            disabled={visible.every((s) => s.review !== 'approved')}
          >
            <Undo2 size={14} />
            {isAr ? 'إعادة لمسودة' : 'Back to draft'}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="p-10 text-center text-sm text-charcoal/40">
          {isAr ? 'لا توجد منشورات مطابقة للفلاتر' : 'No posts match these filters'}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {visible.map((s) => (
            <PostCard
              key={s.key}
              state={s}
              isAr={isAr}
              showAr={needsAr(language)}
              showEn={needsEn(language)}
              onApprove={() => onApprove(s.key)}
              onUnapprove={() => onUnapprove(s.key)}
              onReject={() => onReject(s.key)}
              onRestore={() => onRestore(s.key)}
              onRegenerate={() => onRegenerate(s.key)}
              onEditBody={(lang, value) => onEditBody(s.key, lang, value)}
            />
          ))}
        </div>
      )}

      {/* Angle legend — helps a reviewer see which themes the batch covered. */}
      {usedAngles.length > 0 && (
        <p className="mt-6 text-[11px] text-charcoal/35">
          {isAr ? 'الزوايا في هذه الدفعة: ' : 'Angles in this batch: '}
          {usedAngles.map((a) => (isAr ? a.label_ar : a.label_en)).join(isAr ? '، ' : ', ')}
        </p>
      )}
    </>
  );
}

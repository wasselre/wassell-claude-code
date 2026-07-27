import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Megaphone, ArrowRight, ArrowLeft, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { normalizeForSearch } from '@/lib/recordSearch';
import { resolveProjectFacts } from '@/lib/projectMessageFacts';
import type { PostTone } from '@/lib/postsContent/templates';
import {
  buildQuantityPlan, type PostLanguage, type QuantityMode,
} from '@/lib/postsContent/planning';
import {
  buildWorkItems, fetchProjectsPlan, regeneratePost, runWorkItems,
  type ProjectFactsResult, type WorkItem,
} from '@/lib/postsContent/client';
import type { GeneratedPost } from '@/lib/postsContent/facts';
import SetupStage, { type BatchSummary, type ProjectRow } from './components/SetupStage';
import ReviewStage from './components/ReviewStage';
import RejectModal, { REJECTION_REASONS } from './components/RejectModal';
import {
  applyEdit, applyReview, batchToRecord, postToRecord, recordToPostState,
  type BatchContext, type PostState, type RejectionInfo, type ReviewStatus,
} from './lib/persistence';
import type { AppRecord } from '@/types';

/**
 * Posts Content writer.
 *
 * Stage 1 — pick one or more of Our Projects, choose how many posts (a total
 * distributed across them, or an explicit count each), the language and the
 * style. Stage 2 — review every post: edit, approve, reject with a reason,
 * rewrite (with that reason fed back to the model), copy.
 *
 * Posts are persisted to `posts_content` AS THEY ARRIVE, and the run itself to
 * `posts_batches`, so a reload never loses work and a batch can be reopened and
 * approved later. Every numeric specification inside a post body is rendered
 * from the database, never written by the model — see
 * api/templates/posts-content.ts.
 */

type Stage = 'setup' | 'review';

const POSTS_MODEL = 'posts_content';
const BATCHES_MODEL = 'posts_batches';

export default function PostsContentPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const ourProjectsModel = useMemo(() => models.find((m) => m.name === 'our_projects'), [models]);
  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);
  const postsModel = useMemo(() => models.find((m) => m.name === POSTS_MODEL), [models]);
  const batchesModel = useMemo(() => models.find((m) => m.name === BATCHES_MODEL), [models]);

  const actorName = useMemo(() => {
    const u = users.find((x) => x.id === currentUserId);
    return u ? (isAr ? u.name_ar || u.name_en : u.name_en || u.name_ar) : (currentUserId ?? 'unknown');
  }, [users, currentUserId, isAr]);

  const allOurProjects = ourProjectsModel ? (records[ourProjectsModel.id] ?? []) : [];
  const scopedProjects = useApplyViewScope(ourProjectsModel, allOurProjects);

  // ── Setup state ────────────────────────────────────────────────────────
  const [stage, setStage] = useState<Stage>('setup');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<QuantityMode>('total');
  const [totalCount, setTotalCount] = useState(5);
  const [perCounts, setPerCounts] = useState<Record<string, number>>({});
  const [language, setLanguage] = useState<PostLanguage>('ar');
  const [tone, setTone] = useState<PostTone>('short');
  const [planInfo, setPlanInfo] = useState<ProjectFactsResult[] | null>(null);
  const [planInfoLoading, setPlanInfoLoading] = useState(false);

  // ── Run state ──────────────────────────────────────────────────────────
  const [states, setStates] = useState<PostState[]>([]);
  const [running, setRunning] = useState(false);
  const [batchCtx, setBatchCtx] = useState<BatchContext | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ key: string; intent: 'reject' | 'regenerate' } | null>(null);

  /** Guards a double-click on Generate from starting two runs. */
  const runLock = useRef(false);
  const editTimers = useRef<Record<string, number>>({});
  /**
   * key → posts_content record id.
   *
   * Held in a ref, NOT derived inside a setState updater. React may invoke a
   * state updater more than once for a single update (StrictMode double-invokes
   * in dev, and concurrent rendering can replay it), so minting `uuid()` or
   * calling `persist()` inside one produced TWO records per post — verified
   * live: a 7-post batch wrote 14 rows. Updaters stay pure; ids come from here
   * and writes happen in the handler.
   */
  const recordIds = useRef<Record<string, string>>({});
  const idFor = useCallback((key: string): string => {
    const existing = recordIds.current[key];
    if (existing) return existing;
    const fresh = uuid();
    recordIds.current[key] = fresh;
    return fresh;
  }, []);
  useEffect(() => () => {
    for (const t of Object.values(editTimers.current)) window.clearTimeout(t);
  }, []);

  // ── Project rows for the picker ────────────────────────────────────────
  const projectRows: ProjectRow[] = useMemo(() => {
    const allRecords = allProjectsModel ? (records[allProjectsModel.id] ?? []) : [];
    return scopedProjects.map((r) => {
      const f = resolveProjectFacts(r, models, records);
      const master = f.allProjectId ? allRecords.find((x) => x.id === f.allProjectId) : null;
      const availRaw = master?.data?.available_units;
      const availableUnits =
        typeof availRaw === 'number' ? availRaw
        : typeof availRaw === 'string' && availRaw.trim() !== '' && Number.isFinite(Number(availRaw))
          ? Number(availRaw) : null;
      const name = f.name ?? (isAr ? '(بدون اسم)' : '(unnamed)');
      const district = (isAr ? f.district?.ar : f.district?.en) ?? '';
      const city = (isAr ? f.city?.ar : f.city?.en) ?? '';
      return {
        id: r.id,
        allProjectId: f.allProjectId,
        name,
        district,
        city,
        availableUnits,
        // minPrice already reads the AVAILABLE-only rollup (QA-003).
        priceText: f.minPrice ? (isAr ? f.minPrice.ar : f.minPrice.en) : null,
        search: normalizeForSearch([
          f.name ?? '', f.district?.ar ?? '', f.district?.en ?? '', f.city?.ar ?? '', f.city?.en ?? '',
        ].join(' ')),
      };
    });
  }, [scopedProjects, models, records, allProjectsModel, isAr]);

  const plan = useMemo(
    () => buildQuantityPlan({ projectIds: selectedIds, mode, totalCount, perProjectCounts: perCounts, isAr }),
    [selectedIds, mode, totalCount, perCounts, isAr],
  );

  // Resolve facts + supported angles whenever the selection changes — cheap,
  // no tokens, and it drives the "N angles supported" / shortfall warnings.
  useEffect(() => {
    if (selectedIds.length === 0) { setPlanInfo(null); return; }
    let cancelled = false;
    // Debounced: every checkbox toggle changes `selectedIds`, and each refetch
    // re-resolves EVERY selected project. Ticking through five projects fired
    // five cumulative round-trips (ten in dev StrictMode) where one suffices.
    setPlanInfoLoading(true);
    const timer = window.setTimeout(() => {
      fetchProjectsPlan(selectedIds)
        .then((r) => { if (!cancelled) setPlanInfo(r); })
        .catch((err) => {
          if (cancelled) return;
          console.error('[PostsContent] facts preflight failed:', err);
          addToast(err instanceof Error ? err.message : String(err), 'error');
          setPlanInfo(null);
        })
        .finally(() => { if (!cancelled) setPlanInfoLoading(false); });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [selectedIds, addToast]);

  // ── Persistence helpers ────────────────────────────────────────────────
  const existingPosts = postsModel ? (records[postsModel.id] ?? []) : [];
  const existingBatches = batchesModel ? (records[batchesModel.id] ?? []) : [];

  const persist = useCallback(
    async (record: AppRecord) => {
      try {
        await saveRecord(record);
      } catch (err) {
        // Loud, never silent — a post the user believes is saved but isn't is
        // exactly the failure mode CLAUDE.md's silent-failure rules exist for.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[PostsContent] saveRecord failed:', err);
        addToast(isAr ? `تعذر الحفظ: ${msg}` : `Save failed: ${msg}`, 'error');
      }
    },
    [saveRecord, addToast, isAr],
  );

  const recordFor = useCallback(
    (key: string): { state: PostState; record: AppRecord } | null => {
      const st = states.find((s) => s.key === key);
      if (!st?.recordId) return null;
      const rec = existingPosts.find((r) => r.id === st.recordId);
      return rec ? { state: st, record: rec } : null;
    },
    [states, existingPosts],
  );

  // ── Generation ─────────────────────────────────────────────────────────
  const startRun = async () => {
    if (runLock.current) return;
    if (!postsModel || !batchesModel) {
      addToast(
        isAr ? 'نماذج المنشورات غير متوفرة — شغّل ترحيل 2026-07-26_posts_content_v2.sql'
             : 'The posts models are missing — run the 2026-07-26_posts_content_v2.sql migration',
        'error',
      );
      return;
    }
    if (plan.errors.length > 0 || plan.total === 0) return;

    const info = planInfo ?? (await fetchProjectsPlan(selectedIds).catch(() => null));
    if (!info) {
      addToast(isAr ? 'تعذر قراءة بيانات المشاريع' : 'Could not read the project data', 'error');
      return;
    }

    const workPlans = plan.perProject.map((p) => ({
      ourProjectId: p.ourProjectId,
      requested: p.requested,
      ranked: info.find((i) => i.our_project_id === p.ourProjectId)?.ranked ?? [],
    }));
    const { items, shortfalls } = buildWorkItems(workPlans);
    if (items.length === 0) {
      addToast(
        isAr ? 'لا توجد بيانات كافية في المشاريع المختارة لكتابة أي منشور.'
             : 'The selected projects have no data that can back a post.',
        'error',
      );
      return;
    }
    for (const s of shortfalls) {
      const row = projectRows.find((r) => r.id === s.ourProjectId);
      addToast(
        isAr
          ? `${row?.name ?? s.ourProjectId}: طُلب ${s.requested} منشورًا وتم توليد ${s.possible} فقط — البيانات لا تدعم أكثر.`
          : `${row?.name ?? s.ourProjectId}: ${s.requested} requested but only ${s.possible} possible — the data supports no more.`,
        'error',
      );
    }

    runLock.current = true;
    setRunning(true);
    recordIds.current = {};

    const batchRecordId = uuid();
    const batchId = uuid();
    const ctx: BatchContext = { batchRecordId, batchId, tone, language, actorName };
    setBatchCtx(ctx);

    const initial: PostState[] = items.map((i) => {
      const row = projectRows.find((r) => r.id === i.ourProjectId);
      return {
        key: i.key,
        ourProjectId: i.ourProjectId,
        allProjectId: row?.allProjectId ?? null,
        projectName: row?.name ?? i.ourProjectId,
        angle: i.angle,
        variationIndex: i.variationIndex,
        postNumber: i.postNumber,
        cardStatus: 'generating',
        post: null,
        recordId: null,
        review: 'draft',
      };
    });
    setStates(initial);
    setStage('review');

    const perProjectCounts = Object.fromEntries(plan.perProject.map((p) => [p.ourProjectId, p.requested]));
    const allProjectIds = plan.perProject
      .map((p) => projectRows.find((r) => r.id === p.ourProjectId)?.allProjectId)
      .filter((x): x is string => !!x);
    const labelNames = plan.perProject
      .map((p) => projectRows.find((r) => r.id === p.ourProjectId)?.name ?? '')
      .filter(Boolean);
    const batchLabel = `${labelNames.slice(0, 2).join('، ')}${labelNames.length > 2 ? ` +${labelNames.length - 2}` : ''} — ${items.length}`;

    await persist(batchToRecord(batchesModel.id, batchRecordId, {
      label: batchLabel,
      status: 'running',
      language, tone,
      quantityMode: mode,
      requestedCount: items.length,
      failedCount: 0,
      allProjectIds,
      ourProjectIds: plan.perProject.map((p) => p.ourProjectId),
      perProjectCounts,
      actorName,
    }));

    let failed = 0;
    await runWorkItems(items, tone, language, {
      onPosts: (posts) => {
        // Pure updater — no id minting, no writes (see the recordIds comment).
        setStates((prev) =>
          prev.map((s) => {
            const p = posts.find((x) => x.key === s.key);
            return p ? { ...s, cardStatus: 'ready', post: p, error: undefined, recordId: idFor(s.key) } : s;
          }),
        );
        // Persist exactly once per arrived post, outside the updater.
        for (const p of posts) {
          const base = initial.find((s) => s.key === p.key);
          if (!base) continue;
          void persist(postToRecord(
            postsModel.id,
            { ...base, cardStatus: 'ready', post: p, recordId: idFor(p.key) },
            ctx,
          ));
        }
      },
      onErrors: (errs) => {
        failed += errs.length;
        setStates((prev) =>
          prev.map((s) => {
            const e = errs.find((x) => x.key === s.key);
            return e ? { ...s, cardStatus: 'error', error: e.error } : s;
          }),
        );
      },
    });

    await persist(batchToRecord(batchesModel.id, batchRecordId, {
      label: batchLabel,
      status: failed === 0 ? 'completed' : failed >= items.length ? 'failed' : 'partial',
      language, tone,
      quantityMode: mode,
      requestedCount: items.length,
      failedCount: failed,
      allProjectIds,
      ourProjectIds: plan.perProject.map((p) => p.ourProjectId),
      perProjectCounts,
      actorName,
    }, existingBatches.find((b) => b.id === batchRecordId)));

    setRunning(false);
    runLock.current = false;
  };

  const regenerate = async (key: string, feedback?: RejectionInfo) => {
    const st = states.find((s) => s.key === key);
    if (!st || !batchCtx || !postsModel) return;
    setStates((prev) => prev.map((s) => (s.key === key ? { ...s, cardStatus: 'generating', error: undefined } : s)));

    const item: WorkItem = {
      key: st.key,
      ourProjectId: st.ourProjectId,
      angle: st.angle,
      variationIndex: st.variationIndex,
      postNumber: st.postNumber,
      evidence: st.post?.evidence ?? [],
    };
    const avoid = states
      .filter((s) => s.ourProjectId === st.ourProjectId && s.key !== key && s.post)
      .map((s) => s.post!.headline_ar || s.post!.headline_en)
      .filter(Boolean);
    const reasonLabel = feedback
      ? (REJECTION_REASONS.find((r) => r.value === feedback.reason)?.en ?? feedback.reason)
      : undefined;

    try {
      const r = await regeneratePost({
        ourProjectId: st.ourProjectId,
        tone: batchCtx.tone,
        language: batchCtx.language,
        item,
        avoidHeadlines: avoid,
        feedback: feedback
          ? {
              reason: reasonLabel,
              note: feedback.note,
              previous_headline: st.post?.headline_ar || st.post?.headline_en,
              previous_prose: st.post?.prose_ar || st.post?.prose_en,
            }
          : undefined,
      });
      const fresh: GeneratedPost | undefined = r.posts[0];
      if (fresh) {
        // A rewrite replaces the content and returns the post to draft — the
        // previous verdict was about text that no longer exists.
        const recordId = idFor(key);
        const next: PostState = {
          ...st, cardStatus: 'ready', post: fresh, error: undefined,
          review: 'draft', rejection: undefined, recordId,
        };
        setStates((prev) => prev.map((s) => (s.key === key ? next : s)));
        const existing = existingPosts.find((x) => x.id === recordId);
        const rec = postToRecord(postsModel.id, next, batchCtx, existing);
        void persist(applyReview(rec, 'draft', actorName));
      } else {
        const msg = r.errors[0]?.error ?? (isAr ? 'فشل التوليد' : 'generation failed');
        setStates((prev) => prev.map((s) => (s.key === key ? { ...s, cardStatus: 'error', error: msg } : s)));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStates((prev) => prev.map((s) => (s.key === key ? { ...s, cardStatus: 'error', error: msg } : s)));
    }
  };

  // ── Review actions ─────────────────────────────────────────────────────
  const setReview = useCallback(
    (key: string, next: ReviewStatus, rejection?: RejectionInfo) => {
      const found = recordFor(key);
      setStates((prev) =>
        prev.map((s) => (s.key === key
          ? { ...s, review: next, rejection: next === 'rejected' ? rejection : undefined }
          : s)),
      );
      if (found) void persist(applyReview(found.record, next, actorName, rejection));
    },
    [recordFor, persist, actorName],
  );

  const bulkReview = useCallback(
    (keys: string[], next: ReviewStatus) => {
      for (const k of keys) setReview(k, next);
    },
    [setReview],
  );

  const editBody = useCallback(
    (key: string, lang: 'ar' | 'en', value: string) => {
      // Pure updater.
      setStates((prev) =>
        prev.map((s) => {
          if (s.key !== key || !s.post) return s;
          const post: GeneratedPost = lang === 'ar' ? { ...s.post, body_ar: value } : { ...s.post, body_en: value };
          return { ...s, post };
        }),
      );
      // Debounced write-through, scheduled OUTSIDE the updater so a replayed
      // update can't queue a second timer. Survives a reload with no save button
      // and without a request per keystroke.
      window.clearTimeout(editTimers.current[key]);
      editTimers.current[key] = window.setTimeout(() => {
        const rec = existingPosts.find((r) => r.id === recordIds.current[key]);
        if (rec) void persist(applyEdit(rec, lang, value));
      }, 1_000);
    },
    [existingPosts, persist],
  );

  // ── Batch history ──────────────────────────────────────────────────────
  const batchSummaries: BatchSummary[] = useMemo(() => {
    return [...existingBatches]
      .sort((a, b) =>
        String(b.data?.generated_at ?? b.created_at ?? '')
          .localeCompare(String(a.data?.generated_at ?? a.created_at ?? '')))
      .slice(0, 12)
      .map((b) => {
        const d = b.data ?? {};
        const posts = existingPosts.filter((p) => p.data?.batch === b.id);
        const when = String(d.generated_at ?? b.created_at ?? '');
        return {
          recordId: b.id,
          label: String(d.label ?? ''),
          when: when ? new Date(when).toLocaleString(isAr ? 'ar-SA' : 'en-GB') : '',
          projects: String(d.label ?? '—'),
          requested: typeof d.requested_count === 'number' ? d.requested_count : posts.length,
          // Completed / approved are DERIVED from the post rows — the batch row
          // stores only what cannot be recovered from them (requested, failed).
          completed: posts.length,
          approved: posts.filter((p) => p.data?.status === 'approved').length,
          language: (d.language === 'en' ? 'en' : d.language === 'both' ? 'both' : 'ar') as PostLanguage,
          tone: (d.tone === 'long' ? 'long' : 'short') as PostTone,
        };
      });
  }, [existingBatches, existingPosts, isAr]);

  const openBatch = (batchRecordId: string) => {
    const batch = existingBatches.find((b) => b.id === batchRecordId);
    if (!batch) return;
    const d = batch.data ?? {};
    const posts = existingPosts.filter((p) => p.data?.batch === batchRecordId);
    if (posts.length === 0) {
      addToast(isAr ? 'لا توجد منشورات محفوظة في هذه الدفعة' : 'This batch has no saved posts', 'error');
      return;
    }
    const batchTone: PostTone = d.tone === 'long' ? 'long' : 'short';
    const batchLang: PostLanguage = d.language === 'en' ? 'en' : d.language === 'both' ? 'both' : 'ar';
    setTone(batchTone);
    setLanguage(batchLang);
    setBatchCtx({
      batchRecordId,
      batchId: String(d.batch_id ?? batchRecordId),
      tone: batchTone,
      language: batchLang,
      actorName,
    });
    const reopened = posts
      .map((p) => {
        const ourId = String(p.data?.source_project_id ?? '');
        const row = projectRows.find((r) => r.id === ourId);
        return recordToPostState(p, row?.name ?? (isAr ? '(مشروع محذوف)' : '(removed project)'));
      })
      .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.postNumber - b.postNumber);
    // Re-seed the key → record-id map so edits and rewrites on a reopened batch
    // update the SAME rows rather than minting new ones.
    recordIds.current = Object.fromEntries(
      reopened.filter((s) => s.recordId).map((s) => [s.key, s.recordId as string]),
    );
    setStates(reopened);
    setStage('review');
  };

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  // ── Render ─────────────────────────────────────────────────────────────
  if (!postsModel || !batchesModel) {
    return (
      <div className="p-8 text-center text-charcoal/60">
        <AlertTriangle className="mx-auto mb-3 text-amber-500" size={28} />
        <p className="text-sm">
          {isAr
            ? 'نماذج المنشورات غير موجودة. شغّل ترحيل supabase/migrations/2026-07-26_posts_content_v2.sql.'
            : 'The posts models are missing. Run supabase/migrations/2026-07-26_posts_content_v2.sql.'}
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center gap-3 mb-5">
        {stage === 'review' && (
          <button
            onClick={() => setStage('setup')}
            className="p-2 rounded-xl text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors"
            aria-label={isAr ? 'رجوع' : 'Back'}
          >
            <BackIcon size={18} />
          </button>
        )}
        <div className="w-10 h-10 rounded-xl bg-copper/10 text-copper flex items-center justify-center shrink-0">
          <Megaphone size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-chocolate">{isAr ? 'كاتب المحتوى' : 'Content Writer'}</h1>
          <p className="text-xs text-charcoal/50">
            {stage === 'setup'
              ? (isAr
                  ? 'اختر مشاريع من «مشاريعنا»، حدّد عدد المنشورات واللغة والأسلوب'
                  : 'Pick projects from Our Projects, then set the count, language and style')
              : (isAr ? 'راجع كل منشور: تعديل، اعتماد، رفض، أو إعادة كتابة' : 'Review each post: edit, approve, reject or rewrite')}
          </p>
        </div>
      </div>

      {stage === 'setup' ? (
        <SetupStage
          isAr={isAr}
          rows={projectRows}
          selectedIds={selectedIds}
          onToggleProject={(id) =>
            setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
          }
          mode={mode}
          setMode={setMode}
          totalCount={totalCount}
          setTotalCount={setTotalCount}
          perCounts={perCounts}
          setPerCount={(id, n) => setPerCounts((prev) => ({ ...prev, [id]: n }))}
          language={language}
          setLanguage={setLanguage}
          tone={tone}
          setTone={setTone}
          plan={plan}
          planInfo={planInfo}
          planInfoLoading={planInfoLoading}
          generating={running}
          onGenerate={() => void startRun()}
          batches={batchSummaries}
          onOpenBatch={openBatch}
        />
      ) : (
        <ReviewStage
          isAr={isAr}
          states={states}
          language={batchCtx?.language ?? language}
          running={running}
          onApprove={(k) => setReview(k, 'approved')}
          onUnapprove={(k) => setReview(k, 'draft')}
          onReject={(k) => setRejectTarget({ key: k, intent: 'reject' })}
          onRestore={(k) => setReview(k, 'draft')}
          onRegenerate={(k) => setRejectTarget({ key: k, intent: 'regenerate' })}
          onEditBody={editBody}
          onBulk={bulkReview}
        />
      )}

      {rejectTarget && (
        <RejectModal
          isAr={isAr}
          intent={rejectTarget.intent}
          onClose={() => setRejectTarget(null)}
          onConfirm={(info, alsoRegenerate) => {
            const { key, intent } = rejectTarget;
            setRejectTarget(null);
            if (intent === 'reject') {
              setReview(key, 'rejected', info);
              if (alsoRegenerate) void regenerate(key, info);
            } else {
              void regenerate(key, info);
            }
          }}
        />
      )}
    </div>
  );
}

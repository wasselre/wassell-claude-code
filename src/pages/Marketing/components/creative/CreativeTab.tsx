/**
 * CreativeTab — the Post Creative Director's home inside a content item.
 *
 * The flow, in one place: pick targets → AI proposes 2–3 concepts → human
 * picks one → AI builds the full package (base creative + one derivative per
 * target + references + assets + AI image proposals) → human edits (every edit
 * lands as a NEW version, never an overwrite) → Apply writes the package onto
 * the content item (auditable, reversible) → the design owner's HandoffView.
 *
 * Jobs run in the background (mos_creative_jobs on the Fly worker) — nothing
 * here holds a request open; the tab polls `creative_job_status` every 4 s
 * while a job is queued/running, exactly like the video-script lane.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BasePackage, CreativeDerivativeRow, CreativeJobRow, CreativePackageRow,
  DerivativeTarget, IntendedUse, PostFormat,
} from '@/lib/creative/contracts';
import {
  approveCreativeAi, applyCreativePackage, dismissCreativeAi,
  fetchCreativeFlags, fetchCreativeJobStatus, fetchCreativePackage,
  fetchCreativeTargets, listCreativePackages, regenerateCreative,
  replaceCreativeAsset, revertCreativePackage, saveCreativePackage,
  selectCreativeConcept, writePostCreative,
  type CreativeFlagsResult, type CreativePackageGetResult, type CreativeTargetsResult,
} from '@/lib/marketingOS/creativeClient';
import type { MosContentRow } from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';
import { LoadError, Skeleton } from '../kit';
import VersionsBar from './VersionsBar';
import TargetsPicker from './TargetsPicker';
import ConceptCards from './ConceptCards';
import BaseCreativeEditor from './BaseCreativeEditor';
import DerivativesPanel from './DerivativesPanel';
import ReferencesPanel from './ReferencesPanel';
import AssetsPanel from './AssetsPanel';
import AiRecommendationsPanel from './AiRecommendationsPanel';
import PalettePanel from './PalettePanel';
import WarningsPanel from './WarningsPanel';
import HandoffView from './HandoffView';
import {
  INTENDED_USE_LABELS, JOB_KIND_LABELS, JOB_STAGE_LABELS, PLACEMENT_LABELS,
  platformLabel, pick,
} from './labels';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export default function CreativeTab({
  item, canWrite, designOwnerActive, isAr,
}: {
  item: MosContentRow;
  /** can('write_content') — every mutation hides without it. */
  canWrite: boolean;
  /** The open task's role IS the role_map design owner → handoff first. */
  designOwnerActive: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const contentId = item.id;

  const [flags, setFlags] = useState<CreativeFlagsResult | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [packages, setPackages] = useState<CreativePackageRow[] | null>(null);
  const [active, setActive] = useState<CreativePackageGetResult | null>(null);
  const [job, setJob] = useState<CreativeJobRow | null>(null);
  const [targets, setTargets] = useState<CreativeTargetsResult | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);

  const [draftBase, setDraftBase] = useState<BasePackage | null>(null);
  const [draftDerivatives, setDraftDerivatives] = useState<CreativeDerivativeRow[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<'package' | 'handoff'>(designOwnerActive ? 'handoff' : 'package');

  const [busy, setBusy] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [regenNote, setRegenNote] = useState('');
  const [overwrite, setOverwrite] = useState({ headlines: false, design_brief: false, captions: false, ad_copy: false });
  const [confirmRights, setConfirmRights] = useState(false);
  const [revertNote, setRevertNote] = useState<{ restored: string[]; failed: string[] } | null>(null);

  /* ── loading ──────────────────────────────────────────────────────── */

  const loadPackage = useCallback(async (packageId: string) => {
    const res = await fetchCreativePackage(packageId);
    setActive(res);
    setDraftBase(res.package.base ? clone(res.package.base) : null);
    setDraftDerivatives(clone(res.derivatives));
    setDirty(false);
    setConfirmRights(false);
    setRevertNote(null);
  }, []);

  // The currently-viewed package id, readable inside callbacks without a dep loop.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { activeIdRef.current = active?.package.id ?? null; }, [active]);

  const reload = useCallback(async () => {
    const res = await listCreativePackages(contentId);
    setPackages(res.packages);
    // Keep viewing the same version when it still exists; otherwise the newest.
    const currentId = activeIdRef.current;
    const stillThere = currentId !== null && res.packages.some((p) => p.id === currentId);
    if (stillThere) return;
    const latest = [...res.packages].sort((a, b) => b.version - a.version)[0] ?? null;
    if (!latest) {
      setActive(null);
      setDraftBase(null);
      setDraftDerivatives(null);
      return;
    }
    try {
      await loadPackage(latest.id);
    } catch (e) {
      console.error('[creative] package fetch failed', e);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  }, [contentId, addToast, loadPackage]);

  useEffect(() => {
    let alive = true;
    setFlagsError(null);
    Promise.all([
      fetchCreativeFlags(),
      listCreativePackages(contentId),
      fetchCreativeJobStatus(contentId),
    ]).then(([f, pkgs, j]) => {
      if (!alive) return;
      setFlags(f);
      setPackages(pkgs.packages);
      setJob(j.job);
      const latest = [...pkgs.packages].sort((a, b) => b.version - a.version)[0] ?? null;
      if (latest) {
        return fetchCreativePackage(latest.id).then((full) => {
          if (!alive) return;
          setActive(full);
          setDraftBase(full.package.base ? clone(full.package.base) : null);
          setDraftDerivatives(clone(full.derivatives));
        });
      }
      return undefined;
    }).catch((e: unknown) => {
      if (alive) setFlagsError(e instanceof Error ? e.message : String(e));
    });
    return () => { alive = false; };
  }, [contentId]);

  // Targets are needed only when there is no package yet — fetched lazily.
  useEffect(() => {
    if (!flags || packages === null || packages.length > 0 || targets || targetsError) return;
    let alive = true;
    fetchCreativeTargets(contentId)
      .then((t) => { if (alive) setTargets(t); })
      .catch((e: unknown) => { if (alive) setTargetsError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [flags, packages, targets, targetsError, contentId]);

  /* ── job polling (4 s while queued/running) ───────────────────────── */

  const jobActive = job !== null && (job.status === 'queued' || job.status === 'running');
  const lastJobStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!jobActive || !job) return;
    let cancelled = false;
    const iv = setInterval(() => {
      void fetchCreativeJobStatus(contentId).then((r) => {
        if (cancelled) return;
        const next = r.job;
        if (!next) { setJob(null); return; }
        const wasRunning = lastJobStatus.current === 'queued' || lastJobStatus.current === 'running';
        setJob(next);
        if ((next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled') && wasRunning) {
          if (next.status === 'completed') {
            addToast(isAr ? 'اكتملت المهمة — حُدّثت الحزمة.' : 'Job done — the package is updated.', 'success');
            void reload();
            if (active) void loadPackage(active.package.id).catch((e: unknown) => {
              console.error('[creative] reload after job failed', e);
            });
          } else if (next.status === 'failed') {
            addToast(
              isAr ? `فشلت المهمة: ${next.error ?? ''}` : `Job failed: ${next.error ?? ''}`,
              'error',
            );
          }
        }
      }).catch(() => { /* transient — keep polling, same posture as the script lane */ });
    }, 4000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobActive, job?.id, contentId, isAr, addToast, reload, active?.package.id, loadPackage]);
  useEffect(() => { lastJobStatus.current = job?.status ?? null; }, [job?.status]);

  /* ── AI execution polling — a creative-image job patches the package ── */

  const aiInFlight = useMemo(
    () => (active?.package.base?.ai_recommendations ?? []).some(
      (r) => r.status === 'queued' || r.status === 'running',
    ),
    [active],
  );
  useEffect(() => {
    if (!aiInFlight || !active) return;
    let cancelled = false;
    const iv = setInterval(() => {
      void fetchCreativePackage(active.package.id).then((full) => {
        if (cancelled) return;
        setActive(full);
        // Keep the human's unsaved draft — only the AI execution state refreshes.
        setDraftBase((cur) => (dirty && cur ? cur : (full.package.base ? clone(full.package.base) : null)));
      }).catch(() => { /* transient — next tick retries */ });
    }, 6000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiInFlight, active?.package.id, dirty]);

  /* ── actions ──────────────────────────────────────────────────────── */

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const start = (selection: DerivativeTarget[], use: IntendedUse, recipe: string | null): void => {
    void run('start', async () => {
      const r = await writePostCreative({
        content_id: contentId, targets: selection, intended_use: use, recipe,
      });
      setJob(r.job);
    });
  };

  const selectConcept = (conceptId: string | null, custom?: { title: string; angle: string; format: PostFormat }): void => {
    if (!active) return;
    void run('concept', async () => {
      const r = await selectCreativeConcept({
        package_id: active.package.id,
        ...(conceptId ? { concept_id: conceptId } : {}),
        ...(custom ? { custom } : {}),
      });
      setJob(r.job);
    });
  };

  const saveDraft = (): void => {
    if (!active || !draftBase) return;
    void run('save', async () => {
      const r = await saveCreativePackage({
        package_id: active.package.id,
        base: draftBase,
        derivatives: (draftDerivatives ?? []).map((d) => ({
          target_kind: d.target_kind,
          platform: d.platform,
          placement_type: d.placement_type,
          target_ref: d.target_ref,
          dimensions: d.dimensions,
          adaptation: d.adaptation,
          copy: d.copy,
          limits: d.limits,
          warnings: d.warnings,
        })),
      });
      addToast(isAr ? `حُفظت كنسخة جديدة (ن${r.package.version}).` : `Saved as a new version (v${r.package.version}).`, 'success');
      await reload();
      await loadPackage(r.package.id);
    });
  };

  const regenerate = (): void => {
    if (!active || !regenNote.trim()) return;
    void run('regen', async () => {
      const r = await regenerateCreative(active.package.id, regenNote.trim());
      setRegenNote('');
      setJob(r.job);
    });
  };

  const apply = (): void => {
    if (!active) return;
    void run('apply', async () => {
      await applyCreativePackage(active.package.id, overwrite, confirmRights);
      addToast(isAr ? 'طُبِّقت الحزمة على المحتوى.' : 'Package applied to the content.', 'success');
      await reload();
      await loadPackage(active.package.id);
    });
  };

  const revert = (): void => {
    if (!active) return;
    void run('revert', async () => {
      const r = await revertCreativePackage(active.package.id);
      setRevertNote({ restored: r.restored, failed: r.restore_failed });
      await reload();
      await loadPackage(active.package.id);
    });
  };

  const replaceAsset = (index: number, fileId: string): void => {
    if (!active) return;
    setReplacing(index);
    replaceCreativeAsset(active.package.id, index, fileId)
      .then(() => loadPackage(active.package.id))
      .catch((e: unknown) => addToast(e instanceof Error ? e.message : String(e), 'error'))
      .finally(() => setReplacing(null));
  };

  const aiAction = (kind: 'approve' | 'dismiss', index: number): void => {
    if (!active) return;
    void run(`ai-${index}`, async () => {
      if (kind === 'approve') await approveCreativeAi(active.package.id, index);
      else await dismissCreativeAi(active.package.id, index);
      await loadPackage(active.package.id);
    });
  };

  const selectVersion = (packageId: string): void => {
    if (active?.package.id === packageId) return;
    if (dirty && !window.confirm(
      isAr ? 'لديك تعديلات غير محفوظة — تجاهلها والانتقال؟' : 'You have unsaved edits — discard and switch?',
    )) return;
    void loadPackage(packageId).catch((e: unknown) => addToast(e instanceof Error ? e.message : String(e), 'error'));
  };

  /* ── render ───────────────────────────────────────────────────────── */

  if (flagsError && !flags) {
    return <LoadError message={flagsError} onRetry={() => window.location.reload()} isAr={isAr} />;
  }
  if (!flags || packages === null) return <Skeleton rows={5} />;

  if (!flags.flags.post_enabled) {
    return (
      <div className="notice">
        {isAr
          ? 'مدير الإبداع للمنشورات غير مفعّل بعد — يُفعَّل من الإعدادات › أعلام الإبداع.'
          : 'The post creative director is not enabled yet — turn it on in Settings › Creative flags.'}
      </div>
    );
  }

  const pkg = active?.package ?? null;
  const base = draftBase;
  const derivatives = draftDerivatives ?? [];
  const blocking = (base?.warnings.length ?? 0) > 0;
  const needsRights = (base?.assets ?? []).some((a) => a.needs_rights_confirmation);
  const defaultUse: IntendedUse = item.purpose ?? 'organic';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── job progress ───────────────────────────────────────────── */}
      {jobActive && job && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
          <style>{'@keyframes wsCreativeBar{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}'}</style>
          <div style={{ position: 'relative', height: 6, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
            <span style={{ position: 'absolute', top: 0, bottom: 0, width: '30%', borderRadius: 99, background: 'var(--copper)', animation: 'wsCreativeBar 1.2s ease-in-out infinite' }} />
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--mute)' }}>
            {pick(JOB_KIND_LABELS, job.kind, isAr)}
            {job.stage ? <> · {pick(JOB_STAGE_LABELS, job.stage, isAr)}</> : null}
            {' — '}
            {isAr ? 'تعمل في الخلفية؛ يمكنك مغادرة الصفحة.' : 'running in the background; you can leave this page.'}
          </div>
        </div>
      )}
      {job && !jobActive && job.status === 'failed' && (
        <div className="notice bad" style={{ fontSize: 12.5 }}>
          <b>{pick(JOB_KIND_LABELS, job.kind, isAr)}: </b>{job.error ?? (isAr ? 'فشل غير معروف' : 'Unknown failure')}
        </div>
      )}

      {/* ── empty state: no package yet ────────────────────────────── */}
      {packages.length === 0 && !jobActive && (
        <>
          {!item.project_id && (
            <div className="notice bad">
              {isAr
                ? 'اربط المحتوى بمشروع أولًا (الموجز في تبويب «نظرة عامة») — مدير الإبداع يبني على حقائق المشروع.'
                : 'Link the content to a project first (the brief on the Overview tab) — the creative director builds on project facts.'}
            </div>
          )}
          {targetsError && <LoadError message={targetsError} onRetry={() => setTargetsError(null)} isAr={isAr} />}
          {item.project_id && targets && (
            canWrite ? (
              <TargetsPicker
                targets={targets}
                defaultUse={defaultUse}
                busy={busy === 'start'}
                isAr={isAr}
                onStart={start}
              />
            ) : (
              <div className="notice">
                {isAr ? 'لا حزمة إبداعية بعد — تتطلب البداية صلاحية كتابة المحتوى.' : 'No creative package yet — starting one requires write-content.'}
              </div>
            )
          )}
          {item.project_id && !targets && !targetsError && <Skeleton rows={3} />}
        </>
      )}

      {/* ── versions + view toggle ─────────────────────────────────── */}
      {packages.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <VersionsBar packages={packages} activeId={pkg?.id ?? null} isAr={isAr} onSelect={selectVersion} />
          <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`fbtn${view === 'package' ? ' on' : ''}`}
              onClick={() => setView('package')}
            >
              {isAr ? 'الحزمة' : 'Package'}
            </button>
            <button
              type="button"
              className={`fbtn${view === 'handoff' ? ' on' : ''}`}
              onClick={() => setView('handoff')}
            >
              {isAr ? 'التسليم للمصمم' : 'Designer handoff'}
            </button>
          </span>
        </div>
      )}

      {packages.length > 0 && view === 'handoff' && <HandoffView contentId={contentId} isAr={isAr} />}

      {packages.length > 0 && view === 'package' && pkg && (
        <>
          {/* intended_use + targets, prominent — authored facts, never derived */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill p-now">{pick(INTENDED_USE_LABELS, pkg.intended_use, isAr)}</span>
            {derivatives.map((d) => (
              <span key={d.id} className="tag">
                {platformLabel(d.platform, isAr)} · {pick(PLACEMENT_LABELS, d.placement_type, isAr)}
              </span>
            ))}
            {pkg.brand_kit_mode && (
              <span className="tag">
                {isAr ? 'عدة الهوية ' : 'brand kit '}
                <span className="ltr">v{pkg.brand_kit_version ?? '—'}</span>
                {' · '}{pkg.brand_kit_mode === 'constraint' ? (isAr ? 'إلزامية' : 'constraint') : (isAr ? 'استشارية' : 'advisory')}
              </span>
            )}
            {pkg.status === 'applied' && (
              <span className="pill p-go">{isAr ? 'مُطبَّقة على المحتوى' : 'Applied to the content'}</span>
            )}
          </div>

          {/* concepts stage → pick one */}
          {pkg.stage === 'concepts' && pkg.concepts && (
            canWrite ? (
              <ConceptCards
                concepts={pkg.concepts}
                busy={busy === 'concept' || jobActive}
                isAr={isAr}
                onSelect={selectConcept}
              />
            ) : (
              <div className="notice">
                {isAr ? 'الأفكار جاهزة — اختيار فكرة يتطلب صلاحية كتابة المحتوى.' : 'Concepts are ready — picking one requires write-content.'}
              </div>
            )
          )}

          {/* package stage → the full editor */}
          {pkg.stage === 'package' && base && (
            <>
              <WarningsPanel
                warnings={base.warnings}
                missing={base.missing}
                derivatives={derivatives}
                isAr={isAr}
              />

              {revertNote && (
                <div className={`notice${revertNote.failed.length > 0 ? ' bad' : ''}`} style={{ fontSize: 12.5 }}>
                  <b>{isAr ? 'التراجع: ' : 'Revert: '}</b>
                  {revertNote.restored.length > 0
                    ? (isAr ? `استُعيدت ${revertNote.restored.join('، ')}.` : `restored ${revertNote.restored.join(', ')}.`)
                    : (isAr ? 'لا شيء استُعيد.' : 'nothing restored.')}
                  {revertNote.failed.length > 0 && (
                    <> {isAr ? `تعذّر استعادة: ${revertNote.failed.join('، ')}` : `could not restore: ${revertNote.failed.join(', ')}`}</>
                  )}
                </div>
              )}

              <BaseCreativeEditor
                base={base}
                canEdit={canWrite && pkg.status !== 'applied'}
                isAr={isAr}
                onChange={(next) => { setDraftBase(next); setDirty(true); }}
              />

              <PalettePanel palette={base.palette} rationale={base.palette_rationale} kit={base.brand_kit} isAr={isAr} />

              <AssetsPanel
                assets={base.assets}
                previews={active?.previews ?? {}}
                projectId={item.project_id}
                canEdit={canWrite && pkg.status !== 'applied'}
                replacing={replacing}
                isAr={isAr}
                onReplace={replaceAsset}
              />

              <ReferencesPanel
                references={base.references}
                previews={active?.previews ?? {}}
                canEdit={canWrite && pkg.status !== 'applied'}
                isAr={isAr}
                onRemove={(i) => {
                  setDraftBase({ ...base, references: base.references.filter((_, ri) => ri !== i) });
                  setDirty(true);
                }}
              />

              <AiRecommendationsPanel
                recs={base.ai_recommendations}
                previews={active?.previews ?? {}}
                canExecute={canWrite && flags.flags.ai_image_execution && pkg.status !== 'applied'}
                busy={busy !== null}
                isAr={isAr}
                onApprove={(i) => aiAction('approve', i)}
                onDismiss={(i) => aiAction('dismiss', i)}
              />

              <DerivativesPanel
                derivatives={derivatives}
                canEdit={canWrite && pkg.status !== 'applied'}
                isAr={isAr}
                onChange={(i, next) => {
                  setDraftDerivatives(derivatives.map((d, di) => (di === i ? next : d)));
                  setDirty(true);
                }}
              />

              {/* save / apply / regenerate bar */}
              {canWrite && (
                <div className="card">
                  <div className="card-b" style={{ display: 'grid', gap: 12 }}>
                    {dirty && pkg.status !== 'applied' && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-p"
                          disabled={busy !== null}
                          onClick={saveDraft}
                        >
                          {busy === 'save'
                            ? (isAr ? 'يُحفظ…' : 'Saving…')
                            : (isAr ? 'حفظ كنسخة جديدة' : 'Save as a new version')}
                        </button>
                        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                          {isAr ? 'تعديلاتك تحفظ نسخة يدوية جديدة — الأصل يبقى.' : 'Your edits mint a new human version — the original stays.'}
                        </span>
                      </div>
                    )}

                    {pkg.status !== 'applied' && (
                      <div style={{ borderTop: dirty ? '1px solid var(--line-soft)' : 'none', paddingTop: dirty ? 12 : 0, display: 'grid', gap: 8 }}>
                        <div className="lbl">{isAr ? 'التطبيق على المحتوى' : 'Apply to the content'}</div>
                        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
                          {(
                            [
                              ['headlines', isAr ? 'استبدال العناوين' : 'Overwrite headlines'],
                              ['design_brief', isAr ? 'استبدال الاتجاه البصري' : 'Overwrite visual direction'],
                              ['captions', isAr ? 'استبدال الكابشن' : 'Overwrite captions'],
                              ['ad_copy', isAr ? 'استبدال نصوص الإعلانات' : 'Overwrite ad copy'],
                            ] as Array<[keyof typeof overwrite, string]>
                          ).map(([key, label]) => (
                            <label key={key} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={overwrite[key]}
                                onChange={(e) => setOverwrite({ ...overwrite, [key]: e.target.checked })}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        {needsRights && (
                          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer', color: 'var(--wait)', fontWeight: 700 }}>
                            <input
                              type="checkbox"
                              checked={confirmRights}
                              onChange={(e) => setConfirmRights(e.target.checked)}
                            />
                            {isAr ? 'أؤكد حقوق الاستخدام لهذه الأصول' : 'I confirm the usage rights for these assets'}
                          </label>
                        )}
                        <div>
                          <button
                            type="button"
                            className="btn btn-go"
                            disabled={busy !== null || blocking || dirty || (needsRights && !confirmRights)}
                            onClick={apply}
                          >
                            {busy === 'apply'
                              ? (isAr ? 'يُطبَّق…' : 'Applying…')
                              : (isAr ? 'تطبيق الحزمة' : 'Apply the package')}
                          </button>
                          {(blocking || dirty) && (
                            <span style={{ fontSize: 11.5, color: 'var(--mute)', marginInlineStart: 10 }}>
                              {blocking
                                ? (isAr ? 'معطّل — عالج التحذيرات المانعة أولًا.' : 'Disabled — resolve the blocking warnings first.')
                                : (isAr ? 'معطّل — احفظ تعديلاتك أولًا.' : 'Disabled — save your edits first.')}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {pkg.status === 'applied' && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy !== null}
                          onClick={revert}
                        >
                          {busy === 'revert'
                            ? (isAr ? 'يتراجع…' : 'Reverting…')
                            : (isAr ? 'التراجع عن التطبيق' : 'Revert the apply')}
                        </button>
                        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                          {isAr ? 'يستعيد القيم التي كانت قبل التطبيق.' : 'Restores the values from before the apply.'}
                        </span>
                      </div>
                    )}

                    <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 12, display: 'grid', gap: 6 }}>
                      <div className="lbl">{isAr ? 'إعادة التوليد' : 'Regenerate'}</div>
                      <textarea
                        className="inp"
                        rows={2}
                        placeholder={isAr ? 'ملاحظة المراجعة (إلزامية) — ماذا يتغيّر ولماذا…' : 'Revision note (required) — what changes and why…'}
                        value={regenNote}
                        onChange={(e) => setRegenNote(e.target.value)}
                      />
                      <div>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy !== null || jobActive || !regenNote.trim()}
                          onClick={regenerate}
                        >
                          {busy === 'regen'
                            ? (isAr ? 'يُعاد…' : 'Regenerating…')
                            : (isAr ? 'أعد التوليد بهذه الملاحظة' : 'Regenerate with this note')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

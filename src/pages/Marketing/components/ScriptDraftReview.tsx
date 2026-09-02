/**
 * Script draft review — Script Writer v2's human gate.
 *
 * A generated script is a DRAFT (mos_script_drafts). Nothing enters the scenes
 * table until someone reads it here and presses Apply; protected scenes
 * (manually edited / shoot-linked / used in production) are never removed, and
 * a replace shows exactly what goes and what stays before anything moves.
 *
 * Reads top-down the way a reviewer works: what it was written from (recipe,
 * readiness, warnings) → what it learned (plan) → the scenes with their facts
 * and claim verdicts → the hook choice → the judge's scores → the decision.
 * On the phone it is READ-ONLY stacked cards (the phone flow is for reading;
 * applying stays on the desktop).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  SCENE_PURPOSE_LABELS, applyDraft, discardDraft, previewApplyDraft, sendDraftFeedback, writeVideoScript,
  type ApplyMode, type ApplyPreview, type ClaimVerdict, type DraftScene, type MosScene,
  type ProtectedReason, type ScriptDraft, type ScriptFact, type ScriptJobRow, type ScriptRecipe,
} from '@/lib/marketingOS/client';
import { Modal, Pill, type Tone } from './kit';
import { num, toArabicDigits } from '../lib/format';

/* ── label tables ─────────────────────────────────────────────────────── */

const RECIPE_FALLBACK: Record<string, { ar: string; en: string }> = {
  walkthrough:       { ar: 'جولة', en: 'Walkthrough' },
  offer:             { ar: 'عرض', en: 'Offer' },
  rent_vs_own:       { ar: 'إيجار مقابل تملّك', en: 'Rent vs own' },
  product_explainer: { ar: 'شرح المنتج', en: 'Product explainer' },
  launch:            { ar: 'إطلاق', en: 'Launch' },
};

const READINESS: Record<ScriptDraft['facts']['readiness'], { ar: string; en: string; tone: Tone }> = {
  off_plan: { ar: 'على الخارطة', en: 'Off-plan', tone: 'wait' },
  ready:    { ar: 'جاهز', en: 'Ready', tone: 'go' },
  unknown:  { ar: 'الجاهزية غير معروفة', en: 'Readiness unknown', tone: 'idle' },
  conflict: { ar: 'تعارض في بيانات الجاهزية', en: 'Readiness conflict', tone: 'late' },
};

const ASSET_REQ: Record<DraftScene['asset_requirement'], { ar: string; en: string }> = {
  footage:   { ar: 'يحتاج تصويراً', en: 'Needs footage' },
  image:     { ar: 'صورة', en: 'Image' },
  graphic:   { ar: 'جرافيك', en: 'Graphic' },
  animation: { ar: 'أنيميشن', en: 'Animation' },
  template:  { ar: 'قالب', en: 'Template' },
  none:      { ar: 'بلا مادة', en: 'No asset' },
};

const PROTECTED_REASON: Record<ProtectedReason, { ar: string; en: string }> = {
  edited:          { ar: 'عُدّل يدوياً', en: 'edited by hand' },
  shoot_linked:    { ar: 'مرتبط بطلب تصوير', en: 'linked to a shoot' },
  production_used: { ar: 'مستخدم في الإنتاج', en: 'used in production' },
  manual:          { ar: 'مُضاف يدوياً', en: 'added manually' },
};

const JUDGE_OVERALL: Record<string, { ar: string; en: string; tone: Tone }> = {
  pass:   { ar: 'مقبول', en: 'Pass', tone: 'go' },
  revise: { ar: 'يحتاج تعديلاً', en: 'Revise', tone: 'wait' },
  reject: { ar: 'مرفوض', en: 'Reject', tone: 'late' },
};

const JUDGE_SCORES: Array<{ key: 'dialect' | 'hook' | 'progression' | 'fit' | 'completeness'; ar: string; en: string }> = [
  { key: 'dialect', ar: 'اللهجة', en: 'Dialect' },
  { key: 'hook', ar: 'الخطّاف', en: 'Hook' },
  { key: 'progression', ar: 'التدرّج', en: 'Progression' },
  { key: 'fit', ar: 'الملاءمة', en: 'Fit' },
  { key: 'completeness', ar: 'الاكتمال', en: 'Completeness' },
];

const secs = (v: number, isAr: boolean): string => (isAr ? `${num(v, true)} ث` : `${v}s`);

/* ── small pieces ─────────────────────────────────────────────────────── */

function Chip({ children, title, tone }: { children: ReactNode; title?: string; tone?: 'fact' | 'intent' | 'learn' }) {
  const bg = tone === 'fact'
    ? 'color-mix(in srgb, var(--copper) 14%, transparent)'
    : tone === 'learn' ? 'color-mix(in srgb, var(--go) 12%, transparent)' : 'var(--sand-2)';
  const color = tone === 'fact' ? 'var(--copper)' : tone === 'learn' ? 'var(--go)' : 'var(--mute)';
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 7px',
        borderRadius: 5, background: bg, color, border: '1px solid var(--line)', cursor: title ? 'help' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function Block({ label, children, isAr }: { label: string; children: ReactNode; isAr: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--mute)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.85, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: isAr ? 'right' : 'left' }}>
        {children}
      </div>
    </div>
  );
}

function VerdictLine({ v, isAr }: { v: ClaimVerdict; isAr: boolean }) {
  const color = v.verdict === 'fail' ? 'var(--late)' : v.verdict === 'review' ? 'var(--wait)' : 'var(--go)';
  const word = v.verdict === 'fail'
    ? (isAr ? 'ادعاء غير مدعوم' : 'Unsupported claim')
    : v.verdict === 'review' ? (isAr ? 'يحتاج مراجعة' : 'Needs review') : (isAr ? 'مدعوم' : 'Supported');
  return (
    <div style={{ fontSize: 11.5, color, lineHeight: 1.6 }}>
      <b>{word}</b> · «{v.mention}» {v.fact_id ? `(${v.fact_id})` : ''} — {v.reason}
    </div>
  );
}

/* ── one scene card ───────────────────────────────────────────────────── */

function SceneCard({
  s, facts, claims, judgeNotes, isAr,
}: {
  s: DraftScene;
  facts: Map<string, ScriptFact>;
  claims: ClaimVerdict[];
  judgeNotes: string[];
  isAr: boolean;
}) {
  const purpose = SCENE_PURPOSE_LABELS[s.purpose];
  const vi = s.visual_intent;
  const intentChips = vi
    ? [vi.shot_size, vi.subject, vi.setting, vi.interior_exterior, vi.motion,
      vi.graphic_kind !== 'none' ? vi.graphic_kind : null, vi.mood].filter((x): x is string => !!x)
    : [];
  const onScreen = isAr ? toArabicDigits(s.on_screen_text ?? '') : (s.on_screen_text ?? '');
  const flagged = claims.some((c) => c.verdict === 'fail') || s.warnings.length > 0;

  return (
    <div
      style={{
        border: `1px solid ${flagged ? 'color-mix(in srgb, var(--late) 40%, transparent)' : 'var(--line)'}`,
        borderRadius: 10, padding: '10px 12px', background: 'var(--paper)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 13 }}>{num(s.order, isAr)}</span>
        {purpose && <Pill tone={s.purpose === 'hook' ? 'now' : s.purpose === 'cta' ? 'live' : 'idle'}>{isAr ? purpose.ar : purpose.en}</Pill>}
        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
          {secs(s.duration_sec, isAr)} · {num(s.start_sec, isAr)}–{num(s.end_sec, isAr)}
        </span>
        {s.asset_requirement && (
          <Pill tone={s.asset_requirement === 'footage' ? 'wait' : 'idle'}>
            {(() => { const a = ASSET_REQ[s.asset_requirement]; return a ? (isAr ? a.ar : a.en) : s.asset_requirement; })()}
          </Pill>
        )}
        {s.angle && <span style={{ fontSize: 11, color: 'var(--mute)', marginInlineStart: 'auto' }}>{s.angle}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Block label={isAr ? 'التعليق الصوتي' : 'Voice-over'} isAr={isAr}>{s.voiceover || '—'}</Block>
        <Block label={isAr ? 'نص على الشاشة' : 'On-screen text'} isAr={isAr}>{onScreen || '—'}</Block>
        <Block label={isAr ? 'الصورة' : 'The shot'} isAr={isAr}>{s.visual || '—'}</Block>
      </div>

      {(intentChips.length > 0 || s.fact_refs.length > 0 || s.learned_from.length > 0) && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
          {intentChips.map((c, i) => <Chip key={`i${i}`} tone="intent">{c}</Chip>)}
          {s.fact_refs.map((f) => {
            const fact = facts.get(f);
            const title = fact
              ? `${fact.rendered_ar}\n${isAr ? 'المصدر' : 'source'}: ${fact.source_field}${fact.claimable ? '' : (isAr ? ' · غير قابل للادعاء' : ' · not claimable')}`
              : (isAr ? 'حقيقة غير معروفة' : 'unknown fact');
            return <Chip key={f} tone="fact" title={title}>{f}</Chip>;
          })}
          {s.learned_from.map((e) => (
            <Chip key={e} tone="learn" title={isAr ? 'مُستلهَم من فيديو منافس' : "learned from a competitor's video"}>{e}</Chip>
          ))}
        </div>
      )}

      {(s.warnings.length > 0 || claims.length > 0 || judgeNotes.length > 0 || s.production_note) && (
        <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
          {(s.warnings ?? []).map((w, i) => <div key={`w${i}`} style={{ fontSize: 11.5, color: 'var(--wait)' }}>⚠ {w}</div>)}
          {claims.map((c, i) => <VerdictLine key={`c${i}`} v={c} isAr={isAr} />)}
          {judgeNotes.map((n, i) => <div key={`j${i}`} style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{isAr ? 'المراجع: ' : 'Reviewer: '}{n}</div>)}
          {s.production_note && <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>{isAr ? 'ملاحظة إنتاج: ' : 'Production note: '}{s.production_note}</div>}
        </div>
      )}
    </div>
  );
}

/* ── apply confirm step ───────────────────────────────────────────────── */

function ApplyConfirm({
  draft, chosenHook, isAr, onClose, onApplied,
}: {
  draft: ScriptDraft;
  chosenHook: number | null;
  isAr: boolean;
  onClose: () => void;
  onApplied: (scenes: MosScene[], draft: ScriptDraft) => void;
}) {
  const [mode, setMode] = useState<ApplyMode>(draft.brief.existing_scenes.length > 0 ? 'append' : 'replace');
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError(null);
    previewApplyDraft(draft.id, mode)
      .then((p) => { if (alive) setPreview(p); })
      .catch((e: unknown) => { if (alive) setPreviewError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [draft.id, mode]);

  const apply = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await applyDraft(draft.id, {
        mode,
        chosen_hook: chosenHook,
        // The server refuses if this differs from its CURRENT replaceable set —
        // so we only ever confirm exactly what was shown.
        confirm_remove_ids: mode === 'replace' ? preview.replaceable.map((x) => x.id) : undefined,
      });
      onApplied(r.scenes, r.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const radio = (m: ApplyMode, label: string, hint: string) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 }}>
      <input type="radio" name="apply-mode" checked={mode === m} onChange={() => setMode(m)} style={{ marginTop: 4 }} />
      <span>
        <b>{label}</b>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--mute)' }}>{hint}</span>
      </span>
    </label>
  );

  return (
    <Modal
      title={isAr ? 'اعتماد المسودة إلى المشاهد' : 'Apply the draft to the scenes'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</button>
          <button type="button" className="btn btn-p" disabled={busy || !preview} onClick={() => void apply()}>
            {busy ? (isAr ? 'يعتمد…' : 'Applying…') : (isAr ? 'اعتمد' : 'Apply')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
        {radio('append',
          isAr ? 'إضافة بعد المشاهد الحالية' : 'Append after the existing scenes',
          isAr ? 'لا يُحذف شيء.' : 'Nothing is removed.')}
        {radio('replace',
          isAr ? 'استبدال المشاهد الحالية' : 'Replace the existing scenes',
          isAr ? 'تُحذف المشاهد القابلة للاستبدال فقط — المعدّلة يدوياً أو المرتبطة بتصوير أو المستخدمة في الإنتاج تبقى.' : 'Only replaceable scenes are removed — edited, shoot-linked or in-production ones stay.')}
      </div>

      {previewError && <div className="notice bad" role="alert">{previewError}</div>}
      {!preview && !previewError && <div style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? 'يحسب…' : 'Computing…'}</div>}

      {preview && (
        <div style={{ display: 'grid', gap: 10, fontSize: 12.5 }}>
          <div>
            {isAr ? `سيُضاف ${num(preview.will_insert, true)} مشاهد.` : `${preview.will_insert} scenes will be added.`}
          </div>
          {mode === 'replace' && (
            <>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--late)', marginBottom: 4 }}>
                  {isAr ? `سيُحذف (${num(preview.replaceable.length, true)})` : `Will be removed (${preview.replaceable.length})`}
                </div>
                {preview.replaceable.length === 0
                  ? <div style={{ color: 'var(--mute)' }}>{isAr ? 'لا شيء' : 'Nothing'}</div>
                  : preview.replaceable.map((r) => (
                    <div key={r.id} style={{ display: 'flex', gap: 8, lineHeight: 1.6 }}>
                      <span style={{ color: 'var(--mute)', flex: '0 0 22px' }}>{num(r.position, isAr)}</span>
                      <span style={{ overflowWrap: 'anywhere' }}>{r.visual || '—'}</span>
                    </div>
                  ))}
              </div>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--go)', marginBottom: 4 }}>
                  {isAr ? `يبقى (${num(preview.protected.length, true)})` : `Kept (${preview.protected.length})`}
                </div>
                {preview.protected.length === 0
                  ? <div style={{ color: 'var(--mute)' }}>{isAr ? 'لا شيء' : 'Nothing'}</div>
                  : preview.protected.map((p) => (
                    <div key={p.id} style={{ display: 'flex', gap: 8, lineHeight: 1.6 }}>
                      <span style={{ color: 'var(--mute)', flex: '0 0 22px' }}>{num(p.position, isAr)}</span>
                      <span>{isAr ? PROTECTED_REASON[p.reason]?.ar ?? p.reason : PROTECTED_REASON[p.reason]?.en ?? p.reason}</span>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {error && <div className="notice bad" role="alert" style={{ marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

/* ── feedback after apply ─────────────────────────────────────────────── */

function FeedbackCard({ draft, isAr, onDone }: { draft: ScriptDraft; isAr: boolean; onDone: () => void }) {
  const addToast = useAppStore((s) => s.addToast);
  const [rating, setRating] = useState<number>(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    if (!rating) return;
    setBusy(true);
    try {
      await sendDraftFeedback(draft.id, rating, note.trim() || undefined);
      addToast(isAr ? 'شكراً — سُجّل تقييمك' : 'Thanks — your rating was recorded', 'success');
      onDone();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-b" style={{ padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          {isAr ? 'اعتُمدت المسودة — كيف كانت؟' : 'Draft applied — how was it?'}
        </div>
        <div style={{ display: 'flex', gap: 3 }} role="radiogroup" aria-label={isAr ? 'التقييم' : 'Rating'}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              onClick={() => setRating(n)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, lineHeight: 1, color: n <= rating ? 'var(--copper)' : 'var(--line)', padding: 2 }}
            >
              ★
            </button>
          ))}
        </div>
        <input
          className="inp"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={isAr ? 'ملاحظة (اختياري) — ما الذي غيّرته بعد الاعتماد؟' : 'Note (optional) — what did you change after applying?'}
          style={{ flex: '1 1 240px', minWidth: 0 }}
        />
        <button type="button" className="btn btn-p btn-sm" disabled={busy || !rating} onClick={() => void send()}>
          {isAr ? 'إرسال' : 'Send'}
        </button>
        <button type="button" className="btn btn-d btn-sm" disabled={busy} onClick={onDone}>
          {isAr ? 'تخطٍّ' : 'Skip'}
        </button>
      </div>
    </div>
  );
}

/* ── the review ───────────────────────────────────────────────────────── */

export default function ScriptDraftReview({
  draft, contentId, recipes, isAr, canEdit, readOnly = false, onDraftChange, onApplied, onRegenerated,
}: {
  draft: ScriptDraft;
  contentId: string;
  /** For the recipe label; falls back to the seeded five when absent. */
  recipes?: ScriptRecipe[];
  isAr: boolean;
  /** write_content — the same gate as the header button. */
  canEdit: boolean;
  /** Phone: read-only stacked cards. */
  readOnly?: boolean;
  /** null = hide the review (discarded / feedback done). */
  onDraftChange: (draft: ScriptDraft | null) => void;
  onApplied: (scenes: MosScene[], draft: ScriptDraft) => void;
  onRegenerated: (job: ScriptJobRow) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [chosenHook, setChosenHook] = useState<number | null>(
    draft.chosen_hook ?? (draft.hooks.length > 0 ? 0 : null),
  );
  const [applyOpen, setApplyOpen] = useState(false);
  const [confirm, setConfirm] = useState<'regenerate' | 'discard' | null>(null);
  const [busy, setBusy] = useState(false);

  const facts = useMemo(() => new Map((draft.facts?.facts ?? []).map((f) => [f.id, f])), [draft.facts]);
  const claimsByScene = useMemo(() => {
    const m = new Map<number, ClaimVerdict[]>();
    for (const c of draft.review?.validator?.claims ?? []) {
      if (c.verdict === 'pass') continue;
      m.set(c.scene, [...(m.get(c.scene) ?? []), c]);
    }
    return m;
  }, [draft.review]);
  const judgeNotesByScene = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const n of draft.review?.judge?.notes ?? []) m.set(n.scene, [...(m.get(n.scene) ?? []), n.note]);
    return m;
  }, [draft.review]);

  if (draft.status === 'applied') {
    return <FeedbackCard draft={draft} isAr={isAr} onDone={() => onDraftChange(null)} />;
  }
  if (draft.status === 'discarded') return null;

  const recipeRow = recipes?.find((r) => r.key === draft.recipe);
  const fallbackRecipe = RECIPE_FALLBACK[draft.recipe];
  const recipeLabel = recipeRow
    ? (isAr ? recipeRow.label_ar : recipeRow.label_en)
    : (fallbackRecipe ? (isAr ? fallbackRecipe.ar : fallbackRecipe.en) : draft.recipe);
  const readiness = READINESS[draft.facts?.readiness ?? 'unknown'];
  const warnings = [...(draft.facts?.warnings ?? []), ...(draft.facts?.missing ?? []).map((m) => (isAr ? `ناقص: ${m}` : `Missing: ${m}`))];
  const checks = (draft.review?.validator?.checks ?? []).filter((c) => c.level !== 'pass');
  const judge = draft.review?.judge;
  const totalSec = draft.scenes.reduce((a, s) => a + (s.duration_sec || 0), 0);
  const roleLine = draft.roles
    ? Object.entries(draft.roles).filter(([, v]) => v?.model).map(([k, v]) => `${k}: ${v.model}`).join(' · ')
    : '';
  const actionable = canEdit && !readOnly;

  const regenerate = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await writeVideoScript(contentId, {
        recipe: draft.recipe,
        duration_sec: draft.brief?.duration_sec,
        audience: draft.brief?.audience ?? null,
        objection: draft.brief?.objection ?? null,
        regenerate: true,
      });
      onRegenerated(r.job);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
      setConfirm(null);
    }
  };

  const discard = async (): Promise<void> => {
    setBusy(true);
    try {
      await discardDraft(draft.id);
      addToast(isAr ? 'أُلغيت المسودة' : 'Draft discarded', 'success');
      onDraftChange(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 12, borderColor: 'color-mix(in srgb, var(--copper) 45%, transparent)' }}>
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h4>{isAr ? 'مسودة السكربت — بانتظار مراجعتك' : 'Script draft — awaiting your review'}</h4>
        <Pill tone="idle">{recipeLabel}</Pill>
        <Pill tone={readiness.tone}>{isAr ? readiness.ar : readiness.en}</Pill>
        {draft.facts?.sold_out && <Pill tone="late">{isAr ? 'مباع بالكامل' : 'Sold out'}</Pill>}
        {draft.status === 'needs_attention' && <Pill tone="wait">{isAr ? 'يحتاج انتباهاً' : 'Needs attention'}</Pill>}
        {draft.review?.repaired && <Pill tone="idle">{isAr ? 'أُصلح تلقائياً' : 'Auto-repaired'}</Pill>}
        <span className="r" style={{ marginInlineStart: 'auto' }}>
          {isAr
            ? `${num(draft.scenes.length, true)} مشاهد · ${secs(totalSec, true)}`
            : `${draft.scenes.length} scenes · ${secs(totalSec, false)}`}
        </span>
      </div>

      <div className="card-b" style={{ padding: '14px 16px', display: 'grid', gap: 12 }}>
        {warnings.length > 0 && (
          <div className="notice">
            {warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}
        {checks.length > 0 && (
          <div className={`notice${checks.some((c) => c.level === 'fail') ? ' bad' : ''}`}>
            {checks.map((c, i) => <div key={i}><b>{c.key}</b> — {c.detail}</div>)}
          </div>
        )}

        {/* The plan — what it learned and how it laid the scenes out. */}
        {draft.plan && ((draft.plan.patterns_learned?.length ?? 0) > 0 || (draft.plan.scene_plan?.length ?? 0) > 0) && (
          <details style={{ fontSize: 12.5 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--ink-2)' }}>
              {isAr ? 'الخطة — ما تعلّمه من المنافسين وكيف رتّب المشاهد' : 'The plan — what it learned from competitors and how it laid out the scenes'}
            </summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 8, paddingInlineStart: 8 }}>
              {(draft.plan.patterns_learned?.length ?? 0) > 0 && (
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--mute)', fontSize: 11, marginBottom: 3 }}>{isAr ? 'أنماط مُتعلَّمة' : 'Patterns learned'}</div>
                  {draft.plan.patterns_learned.map((p, i) => (
                    <div key={i} style={{ lineHeight: 1.7 }}>
                      {p.pattern}
                      {p.from?.length > 0 && <span style={{ color: 'var(--mute)' }}> · {p.from.join(', ')}</span>}
                    </div>
                  ))}
                </div>
              )}
              {(draft.plan.scene_plan?.length ?? 0) > 0 && (
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--mute)', fontSize: 11, marginBottom: 3 }}>{isAr ? 'مخطط المشاهد' : 'Scene plan'}</div>
                  {draft.plan.scene_plan.map((p, i) => (
                    <div key={i} style={{ lineHeight: 1.7 }}>
                      <span style={{ color: 'var(--mute)' }}>{num(p.order, isAr)}</span> · {p.purpose} — {p.goal}
                      {p.facts?.length > 0 && <span style={{ color: 'var(--copper)' }}> ({p.facts.join(', ')})</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        )}

        {/* Scenes, in order. */}
        <div style={{ display: 'grid', gap: 8 }}>
          {draft.scenes.map((s) => (
            <SceneCard
              key={s.order}
              s={s}
              facts={facts}
              claims={claimsByScene.get(s.order) ?? []}
              judgeNotes={judgeNotesByScene.get(s.order) ?? []}
              isAr={isAr}
            />
          ))}
        </div>

        {/* Hooks. */}
        {draft.hooks.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--mute)', marginBottom: 6 }}>
              {isAr ? 'الخطّاف — اختر الافتتاحية' : 'Hook — choose the opener'}
            </div>
            <div style={{ display: 'grid', gap: 5 }} role="radiogroup">
              {draft.hooks.map((h, i) => (
                <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.7, cursor: actionable ? 'pointer' : 'default' }}>
                  <input
                    type="radio"
                    name={`hook-${draft.id}`}
                    checked={chosenHook === i}
                    disabled={!actionable}
                    onChange={() => setChosenHook(i)}
                    style={{ marginTop: 5 }}
                  />
                  <span style={{ color: chosenHook === i ? 'var(--ink)' : 'var(--ink-2)' }}>{isAr ? toArabicDigits(h) : h}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Judge. */}
        {judge && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ fontWeight: 700, color: 'var(--mute)', fontSize: 11 }}>{isAr ? 'تقييم المراجع' : 'Reviewer'}</span>
            {(() => {
              const o = JUDGE_OVERALL[judge.overall];
              return o ? <Pill tone={o.tone}>{isAr ? o.ar : o.en}</Pill> : null;
            })()}
            {JUDGE_SCORES.map((sc) => (
              <span key={sc.key} style={{ color: 'var(--ink-2)' }}>
                {isAr ? sc.ar : sc.en} <b>{num(judge[sc.key], isAr)}</b>
              </span>
            ))}
          </div>
        )}

        {/* Small print. */}
        {(draft.cost_usd !== null || roleLine) && (
          <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
            {draft.cost_usd !== null && draft.cost_usd !== undefined && (
              <span>{isAr ? 'التكلفة' : 'Cost'} ${draft.cost_usd.toFixed(3)}</span>
            )}
            {roleLine && <span> · {roleLine}</span>}
          </div>
        )}

        {/* Decision. */}
        {actionable && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
            {confirm === null ? (
              <>
                <button type="button" className="btn btn-p" disabled={busy} onClick={() => setApplyOpen(true)}>
                  {isAr ? 'اعتمد إلى المشاهد' : 'Apply to scenes'}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setConfirm('regenerate')}>
                  {isAr ? 'أعد الكتابة' : 'Regenerate'}
                </button>
                <button type="button" className="btn btn-d" disabled={busy} onClick={() => setConfirm('discard')} style={{ marginInlineStart: 'auto' }}>
                  {isAr ? 'تجاهل المسودة' : 'Discard'}
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 12.5 }}>
                  {confirm === 'regenerate'
                    ? (isAr ? 'تُتجاهل هذه المسودة وتبدأ كتابة جديدة بالوصفة نفسها. متأكد؟' : 'This draft is discarded and a new one is written with the same recipe. Sure?')
                    : (isAr ? 'تُتجاهل المسودة ولا يتغيّر أي مشهد. متأكد؟' : 'The draft is discarded; no scene changes. Sure?')}
                </span>
                <button type="button" className={`btn btn-sm${confirm === 'discard' ? ' btn-d' : ' btn-p'}`} disabled={busy} onClick={() => void (confirm === 'regenerate' ? regenerate() : discard())}>
                  {busy ? '…' : (confirm === 'regenerate' ? (isAr ? 'نعم، أعد الكتابة' : 'Yes, regenerate') : (isAr ? 'نعم، تجاهل' : 'Yes, discard'))}
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirm(null)}>
                  {isAr ? 'رجوع' : 'Back'}
                </button>
              </>
            )}
          </div>
        )}
        {!actionable && readOnly && (
          <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr ? 'الاعتماد والتعديل من الحاسوب — الهاتف للقراءة.' : 'Apply and edit from the desktop — the phone is for reading.'}
          </div>
        )}
      </div>

      {applyOpen && (
        <ApplyConfirm
          draft={draft}
          chosenHook={chosenHook}
          isAr={isAr}
          onClose={() => setApplyOpen(false)}
          onApplied={(scenes, d) => {
            setApplyOpen(false);
            addToast(
              isAr ? `اعتُمدت المسودة — ${num(scenes.length, true)} مشاهد في الجدول الآن` : `Draft applied — ${scenes.length} scenes in the table now`,
              'success',
            );
            onApplied(scenes, d);
          }}
        />
      )}
    </div>
  );
}

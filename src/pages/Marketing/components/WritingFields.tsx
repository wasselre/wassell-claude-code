/**
 * The writing surface — design screens 07 (video) and 08 (post), composed.
 *
 * Not a flat list of textareas: the schema keys are grouped into the design's
 * instruments —
 *   idea + hook (+ core_message)        → the Idea card, hook and message side by side
 *   voiceover                           → the voice-over card with a read-speed chip,
 *                                         because a 38-second script must not become
 *                                         70 seconds silently
 *   headlines + approved_headline       → the headline picker: write several, APPROVE
 *                                         one. Approval is a recorded decision, not an
 *                                         edit that erases the alternatives — rejected
 *                                         headlines become paid-ad copy later.
 *   caption + hashtags                  → the caption card (per-platform captions live
 *                                         in the Publishing tab, and the card says so)
 *   design_brief + slides (+ format/direction/reference) → the structured design brief,
 *                                         so "what do I design" never drowns in a notes box
 * Anything else in the schema renders as a plain field. Unknown keys degrade
 * quietly rather than crashing the tab.
 *
 * Values live in `mos_content.data` — free-form JSONB, so companion keys like
 * core_message need no migration.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { updateContent } from '@/lib/marketingOS/client';
import { num } from '../lib/format';

interface FieldDef {
  ar: string;
  en: string;
  kind: 'short' | 'long' | 'list';
  hint_ar?: string;
  hint_en?: string;
}

const GENERIC_FIELDS: Record<string, FieldDef> = {
  script:       { ar: 'النص', en: 'Script', kind: 'long' },
  duration:     { ar: 'المدة', en: 'Duration', kind: 'short' },
  aspect_ratio: { ar: 'نسبة العرض', en: 'Aspect ratio', kind: 'short' },
  expiry:       { ar: 'تاريخ الانتهاء', en: 'Expiry', kind: 'short' },
};

/** Keys the composed cards consume — everything else falls to the generic grid. */
const COMPOSED = new Set([
  'idea', 'hook', 'core_message', 'voiceover',
  'headlines', 'approved_headline', 'caption', 'hashtags',
  'design_brief', 'slides', 'scenes',
]);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The dashed "next headline" row. Local state, committed on blur/Enter —
 * appending on every keystroke would fragment typing into one-char headlines.
 */
function NewHeadlineRow({
  index, isAr, onCommit,
}: {
  index: number;
  isAr: boolean;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const commit = (): void => {
    if (value.trim() !== '') {
      onCommit(value.trim());
      setValue('');
    }
  };
  return (
    <div className="opt" style={{ borderStyle: 'dashed' }}>
      <span className="rd" style={{ opacity: 0.4 }} />
      <div style={{ flex: 1 }}>
        <input
          className="inp"
          style={{ border: '1px solid transparent', background: 'transparent', padding: '2px 4px', fontSize: 14 }}
          placeholder={isAr
            ? `العنوان ${num(index, true)} — لم يُكتب بعد`
            : `Headline ${index} — not written yet`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        />
        <div className="mt">{isAr ? 'مطلوب قبل الإرسال للمراجعة' : 'expected before submitting for review'}</div>
      </div>
    </div>
  );
}

export default function WritingFields({
  contentId, schema, data, canEdit, canApprove, isAr, onSaved,
}: {
  contentId: string;
  schema: string[];
  data: Record<string, unknown>;
  canEdit: boolean;
  /** Approving a headline is a decision, gated separately from writing. */
  canApprove: boolean;
  isAr: boolean;
  onSaved: (data: Record<string, unknown>) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft({ ...data }); }, [data]);

  const has = (k: string): boolean => schema.includes(k);
  const str = (k: string): string => asString(draft[k]);
  const set = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));

  const leftovers = useMemo(
    () => schema.filter((k) => !COMPOSED.has(k) && GENERIC_FIELDS[k]),
    [schema],
  );

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(data),
    [draft, data],
  );

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload = { ...data, ...draft };
      await updateContent(contentId, { data: payload });
      onSaved(payload);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── the voice-over read-speed chip: ~2.2 words/sec of read Arabic ── */
  const voWords = str('voiceover').trim() ? str('voiceover').trim().split(/\s+/).length : 0;
  const voSeconds = voWords > 0 ? Math.round(voWords / 2.2) : 0;

  const copyVoiceover = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(str('voiceover'));
      addToast(
        isAr ? 'نُسخ النص — أرسله لمن يسجّل الصوت.' : 'Copied — send it to whoever records the voice.',
        'success',
      );
    } catch (e) {
      // Clipboard can be denied by the browser; that is a real failure the
      // user must see, not a silent no-op.
      console.error('[marketing] clipboard write failed', e);
      addToast(isAr ? 'تعذّر النسخ إلى الحافظة.' : 'Could not copy to the clipboard.', 'error');
    }
  };

  /* ── headlines: write several, approve ONE ── */
  const headlines = asList(draft.headlines ?? data.headlines);
  const approved = str('approved_headline') || asString(data.approved_headline);
  const TARGET = 4;
  const written = headlines.filter((h) => h.trim() !== '').length;

  const setHeadline = (i: number, v: string): void => {
    const next = [...headlines];
    next[i] = v;
    set('headlines', next.filter((h, idx) => h.trim() !== '' || idx === i));
  };

  const approve = (h: string): void => {
    set('approved_headline', approved === h ? '' : h);
  };

  /* ── hashtags render as tags, edit as one line ── */
  const hashtags = str('hashtags');
  const tagList = hashtags.split(/\s+/).map((t) => t.trim()).filter(Boolean);

  const nothingComposed = !has('idea') && !has('voiceover') && !has('headlines')
    && !has('caption') && !has('design_brief') && !has('slides') && leftovers.length === 0;

  if (nothingComposed) {
    return (
      <div className="write" style={{ textAlign: 'center', color: 'var(--mute)', fontSize: 13 }}>
        {isAr ? 'لا حقول كتابة لهذا النوع.' : 'This type has no writing fields.'}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── الفكرة ─────────────────────────────────────────────────── */}
      {has('idea') && (
        <div className="write">
          <div className="doc-lbl">{isAr ? 'الفكرة' : 'The idea'}</div>
          <textarea
            className="inp"
            rows={3}
            style={{ fontSize: 15.5, lineHeight: 1.9, border: canEdit ? undefined : '1px solid transparent' }}
            value={str('idea')}
            disabled={!canEdit}
            placeholder={isAr
              ? 'ابدأ بما لا يعرفه المشتري — أثبت الادعاء قبل أن تبيع.'
              : 'Start from what the buyer does not know — prove the claim before selling.'}
            onChange={(e) => set('idea', e.target.value)}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px', marginTop: 6 }}>
            <div className="fld">
              <div className="k">{isAr ? 'الافتتاحية · أول ٣ ثوانٍ' : 'The hook · first 3 seconds'}</div>
              <input
                className="inp"
                style={{ marginTop: 4, fontSize: 13 }}
                value={str('hook')}
                disabled={!canEdit}
                placeholder={isAr ? '«اثنتا عشرة دقيقة. هذا كل شيء.»' : '“Twelve minutes. That’s it.”'}
                onChange={(e) => set('hook', e.target.value)}
              />
            </div>
            <div className="fld">
              <div className="k">{isAr ? 'الرسالة الأساسية' : 'The core message'}</div>
              <input
                className="inp"
                style={{ marginTop: 4, fontSize: 13 }}
                value={str('core_message')}
                disabled={!canEdit}
                placeholder={isAr ? 'جملة واحدة يخرج بها المشاهد' : 'the one sentence the viewer leaves with'}
                onChange={(e) => set('core_message', e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── نص التعليق الصوتي ──────────────────────────────────────── */}
      {has('voiceover') && (
        <div className="write">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <div className="doc-lbl" style={{ margin: 0 }}>
              {isAr ? 'نص التعليق الصوتي' : 'The voice-over script'}
            </div>
            {voSeconds > 0 && (
              <span className="tag tag-t">
                {isAr ? `~${num(voSeconds, true)} ثانية بسرعة القراءة` : `~${voSeconds}s at reading speed`}
              </span>
            )}
            <button
              type="button"
              className="btn btn-d btn-sm"
              style={{ marginInlineStart: 'auto' }}
              disabled={voWords === 0}
              onClick={() => void copyVoiceover()}
            >
              {isAr ? 'إرسال للتسجيل الصوتي' : 'Send for recording'}
            </button>
          </div>
          <textarea
            className="inp"
            rows={7}
            style={{ fontSize: 14, lineHeight: 1.95 }}
            value={str('voiceover')}
            disabled={!canEdit}
            onChange={(e) => set('voiceover', e.target.value)}
          />
        </div>
      )}

      {/* ── العناوين — يُكتب عدة، ويُعتمد واحد ─────────────────────── */}
      {has('headlines') && (
        <div className="write">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div className="doc-lbl" style={{ margin: 0 }}>
              {isAr ? `العناوين — اكتب ${num(TARGET, true)}، ويُعتمد واحد` : `Headlines — write ${TARGET}, approve one`}
            </div>
            <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
              {isAr ? `${num(written, true)} من ${num(TARGET, true)} مكتوبة` : `${written} of ${TARGET} written`}
            </span>
          </div>

          {headlines.map((h, i) => {
            const isPicked = approved !== '' && h === approved;
            return (
              <div key={i} className={`opt${isPicked ? ' pick' : ''}`}>
                {/* No `border: 0` here — that would erase the .rd circle and
                    leave an invisible 14px button (shipped once; caught live). */}
                <button
                  type="button"
                  className="rd"
                  style={{ cursor: canApprove ? 'pointer' : 'default' }}
                  disabled={!canApprove}
                  onClick={() => approve(h)}
                  aria-label={isAr ? 'اعتماد هذا العنوان' : 'Approve this headline'}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input
                    className="inp"
                    style={{ border: '1px solid transparent', background: 'transparent', padding: '2px 4px', fontSize: 14 }}
                    value={h}
                    disabled={!canEdit}
                    onChange={(e) => setHeadline(i, e.target.value)}
                  />
                  <div className="mt">
                    {isPicked
                      ? isAr ? 'المعتمد — القرار مسجَّل ولا يمحو البدائل' : 'Approved — a recorded decision; the alternatives stay'
                      : isAr ? 'بديل · يصلح نسخة إعلان مدفوع لاحقًا' : 'Alternative · reusable as paid-ad copy later'}
                  </div>
                </div>
              </div>
            );
          })}

          {canEdit && headlines.length < TARGET && (
            <NewHeadlineRow
              index={headlines.length + 1}
              isAr={isAr}
              onCommit={(v) => set('headlines', [...headlines, v])}
            />
          )}
        </div>
      )}

      {/* ── الكابشن + موجز التصميم ─────────────────────────────────── */}
      {(has('caption') || has('design_brief') || has('slides')) && (
        <div className={has('caption') && (has('design_brief') || has('slides')) ? 'grid g2' : undefined}>
          {has('caption') && (
            <div className="write">
              <div className="doc-lbl">{isAr ? 'الكابشن · انستقرام' : 'The caption · Instagram'}</div>
              <textarea
                className="inp"
                rows={6}
                style={{ fontSize: 14.5, lineHeight: 1.9 }}
                value={str('caption')}
                disabled={!canEdit}
                onChange={(e) => set('caption', e.target.value)}
              />
              {has('hashtags') && (
                <>
                  {tagList.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
                      {tagList.slice(0, 6).map((t) => <span key={t} className="tag">{t}</span>)}
                      {tagList.length > 6 && (
                        <span className="tag tag-t">+{num(tagList.length - 6, isAr)}</span>
                      )}
                    </div>
                  )}
                  <input
                    className="inp"
                    dir="rtl"
                    style={{ marginTop: 8, fontSize: 12.5 }}
                    value={hashtags}
                    disabled={!canEdit}
                    placeholder={isAr ? '#الوسوم مفصولة بمسافة' : '#hashtags separated by spaces'}
                    onChange={(e) => set('hashtags', e.target.value)}
                  />
                </>
              )}
              <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10 }}>
                {isAr
                  ? 'كابشن كل منصة أخرى مختلف — يُضبط في تبويب النشر، لا هنا.'
                  : 'Every other platform’s caption is different — set in the Publishing tab, not here.'}
              </div>
            </div>
          )}

          {(has('design_brief') || has('slides')) && (
            <div className="write">
              <div className="doc-lbl">
                {isAr ? 'موجز التصميم — للمونتير' : 'The design brief — for the editor'}
              </div>
              <div className="fld">
                <div className="k">{isAr ? 'الصيغة' : 'Format'}</div>
                <input
                  className="inp"
                  style={{ marginTop: 4, fontSize: 13 }}
                  value={str('design_format')}
                  disabled={!canEdit}
                  placeholder={isAr ? 'كاروسيل، ٤ شرائح · ١٠٨٠ × ١٣٥٠' : 'Carousel, 4 slides · 1080 × 1350'}
                  onChange={(e) => set('design_format', e.target.value)}
                />
              </div>
              {has('slides') && (
                <div className="fld">
                  <div className="k">{isAr ? 'النص على التصميم · شريحة في كل سطر' : 'On-design copy · one slide per line'}</div>
                  <textarea
                    className="inp"
                    rows={4}
                    style={{ marginTop: 4, fontSize: 13 }}
                    value={asList(draft.slides ?? data.slides).join('\n')}
                    disabled={!canEdit}
                    onChange={(e) => set('slides', e.target.value.split('\n'))}
                  />
                </div>
              )}
              <div className="fld">
                <div className="k">{isAr ? 'الاتجاه البصري' : 'Visual direction'}</div>
                <textarea
                  className="inp"
                  rows={3}
                  style={{ marginTop: 4, fontSize: 13 }}
                  value={str('design_brief')}
                  disabled={!canEdit}
                  placeholder={isAr ? 'صور داخلية، ساعة ذهبية. بدون صور مخزون.' : 'Interior shots, golden hour. No stock photos.'}
                  onChange={(e) => set('design_brief', e.target.value)}
                />
              </div>
              <div className="fld">
                <div className="k">{isAr ? 'مرجع' : 'Reference'}</div>
                <input
                  className="inp"
                  style={{ marginTop: 4, fontSize: 13 }}
                  value={str('design_reference')}
                  disabled={!canEdit}
                  placeholder={isAr ? 'P-014 — نفس التخطيط، أدّى جيدًا' : 'P-014 — same layout, performed well'}
                  onChange={(e) => set('design_reference', e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── ما تبقى من المخطط ──────────────────────────────────────── */}
      {leftovers.length > 0 && (
        <div className="write">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
            {leftovers.map((k) => {
              const def = GENERIC_FIELDS[k];
              if (!def) return null;
              return (
                <div key={k} style={def.kind === 'long' ? { gridColumn: '1 / -1' } : undefined}>
                  <div className="lbl" style={{ marginBottom: 5 }}>{isAr ? def.ar : def.en}</div>
                  {def.kind === 'long' ? (
                    <textarea
                      className="inp"
                      rows={5}
                      value={str(k)}
                      disabled={!canEdit}
                      onChange={(e) => set(k, e.target.value)}
                    />
                  ) : (
                    <input
                      className="inp"
                      value={str(k)}
                      disabled={!canEdit}
                      onChange={(e) => set(k, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {canEdit || canApprove ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
          {dirty && (
            <span style={{ fontSize: 12, color: 'var(--wait)', fontWeight: 700 }}>
              {isAr ? 'تغييرات غير محفوظة' : 'Unsaved changes'}
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--mute)' }}>
          {isAr
            ? 'للقراءة فقط — هذه المرحلة ليست لدى دورك.'
            : 'Read-only — this stage does not sit with your role.'}
        </div>
      )}
    </div>
  );
}

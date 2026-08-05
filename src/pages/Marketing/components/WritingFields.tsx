/**
 * The writing surface — design screens 07 (video) and 08 (post), composed.
 *
 * Not a flat list of textareas: the schema keys are grouped into the design's
 * instruments —
 *   idea + hook (+ core_message)        → the Idea card, hook and message side by side
 *   voiceover                           → the voice-over card with a read-speed chip,
 *                                         because a 38-second script must not become
 *                                         70 seconds silently
 *   headlines                           → the headlines that MAKE the post: the copy
 *                                         that lands on the design. Write as many as
 *                                         the piece needs; none is "approved" and none
 *                                         is discarded — every headline is part of the
 *                                         post, so there is no picker and no forced count.
 *   caption + hashtags                  → the caption card (per-platform captions live
 *                                         in the Publishing tab, and the card says so)
 *   design_brief (+ format/reference)   → the structured design brief, so "what do I
 *                                         design" never drowns in a notes box. The
 *                                         reference is a PICK from the content library,
 *                                         not free text — "make it like this piece."
 * Anything else in the schema renders as a plain field. Unknown keys degrade
 * quietly rather than crashing the tab.
 *
 * Two render modes (screen 36's rule): when the open stage sits with MY role
 * the cards are inputs; when it doesn't, the SAME cards render as locked TEXT —
 * the mockups' filled states — with the comment composer as the only live
 * surface on the page.
 *
 * Values live in `mos_content.data` — free-form JSONB, so companion keys like
 * core_message need no migration.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { updateContent, fetchContentList, type MosContentRow } from '@/lib/marketingOS/client';
import { Modal } from './kit';
import { num } from '../lib/format';
import { useMosText } from '../lib/useMosText';

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

/**
 * Keys the composed cards consume — everything else falls to the generic grid.
 * `approved_headline` and `slides` are legacy keys: headlines are no longer
 * picked from, and "on-design copy" is now the headlines' own job. They stay
 * listed here so any historical data on those keys is quietly ignored rather
 * than leaking into the generic field grid.
 */
const COMPOSED = new Set([
  'idea', 'hook', 'core_message', 'voiceover',
  'headlines', 'approved_headline', 'caption', 'hashtags',
  'design_brief', 'slides', 'scenes',
]);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** The muted order index that replaces the old approval radio on each headline row. */
const idxBadge = {
  flex: '0 0 auto', minWidth: 16, textAlign: 'center' as const,
  fontSize: 12, fontWeight: 700, color: 'var(--mute)',
};
const delBtn = {
  flex: '0 0 auto', border: 0, background: 'transparent', color: 'var(--mute)',
  cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px',
};
const rowCentered = { alignItems: 'center' as const };
const bareInput = {
  border: '1px solid transparent', background: 'transparent', padding: '2px 4px', fontSize: 14,
};

/**
 * The dashed "add a headline" row. Local state, committed on blur/Enter —
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
    <div className="opt" style={{ borderStyle: 'dashed', ...rowCentered }}>
      <span style={{ ...idxBadge, opacity: 0.5 }}>{num(index, isAr)}</span>
      <input
        className="inp"
        style={{ ...bareInput, flex: 1 }}
        placeholder={isAr ? 'أضف عنوانًا…' : 'Add a headline…'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      />
    </div>
  );
}

/**
 * The Reference field's picker — a choice FROM the content library, not free
 * text. Stores the chosen content item's id; a legacy free-text value that
 * matches no item still renders verbatim so nothing already written is lost.
 */
function ReferencePicker({
  value, contentList, currentId, loadError, loading, isAr, onChange,
}: {
  value: string;
  contentList: MosContentRow[];
  currentId: string;
  loadError: string | null;
  loading: boolean;
  isAr: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const selected = contentList.find((c) => c.id === value) ?? null;
  const label = (c: MosContentRow): string => `${c.ref ? `${c.ref} — ` : ''}${c.title}`;
  // Selected item → its label; legacy non-id text → itself; nothing → empty.
  const display = selected ? label(selected) : value;

  const term = q.trim().toLowerCase();
  const options = contentList
    .filter((c) => c.id !== currentId)
    .filter((c) => !term || `${c.ref ?? ''} ${c.title}`.toLowerCase().includes(term));

  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <button
          type="button"
          className="inp"
          style={{
            flex: 1, textAlign: isAr ? 'right' : 'left', fontSize: 13, cursor: 'pointer',
            color: display ? 'var(--copper)' : 'var(--mute)',
          }}
          onClick={() => setOpen(true)}
        >
          {display || (isAr ? 'اختر من مكتبة المحتوى…' : 'Pick from the content library…')}
        </button>
        {value && (
          <button type="button" style={delBtn} onClick={() => onChange('')} aria-label={isAr ? 'إزالة المرجع' : 'Clear reference'}>
            ×
          </button>
        )}
      </div>

      {open && (
        <Modal
          title={isAr ? 'اختر مرجعًا من مكتبة المحتوى' : 'Pick a reference from the content library'}
          sub={isAr ? 'المنشور أو الفيديو الذي يحتذي به هذا التصميم.' : 'The piece this design should take after.'}
          onClose={() => setOpen(false)}
        >
          <input
            className="inp"
            autoFocus
            style={{ marginBottom: 10 }}
            placeholder={isAr ? 'ابحث بالرقم المرجعي أو العنوان' : 'Search by ref or title'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {loadError && (
            <div className="notice" style={{ marginBottom: 10 }}>
              {isAr ? 'تعذّر تحميل المحتوى: ' : 'Could not load content: '}{loadError}
            </div>
          )}
          <div style={{ maxHeight: 360, overflowY: 'auto', display: 'grid', gap: 6 }}>
            {loading && contentList.length === 0 && !loadError && (
              <div style={{ fontSize: 13, color: 'var(--mute)', padding: '8px 2px' }}>
                {isAr ? 'جارٍ تحميل المحتوى…' : 'Loading content…'}
              </div>
            )}
            {options.length === 0 && !loadError && !(loading && contentList.length === 0) && (
              <div style={{ fontSize: 13, color: 'var(--mute)', padding: '8px 2px' }}>
                {isAr ? 'لا محتوى مطابق.' : 'No matching content.'}
              </div>
            )}
            {options.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`opt${c.id === value ? ' pick' : ''}`}
                style={{ ...rowCentered, width: '100%', cursor: 'pointer', textAlign: isAr ? 'right' : 'left' }}
                onClick={() => { onChange(c.id); setOpen(false); }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="tx">{c.title}</div>
                  <div className="mt">
                    {c.ref ? <span className="ltr">{c.ref}</span> : null}
                    {c.ref ? ' · ' : ''}
                    {isAr ? c.content_type_label_ar : c.content_type_label_en}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

export default function WritingFields({
  contentId, schema, data, canEdit, isAr, onSaved,
}: {
  contentId: string;
  schema: string[];
  data: Record<string, unknown>;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (data: Record<string, unknown>) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [contentList, setContentList] = useState<MosContentRow[]>([]);
  const [refLoadError, setRefLoadError] = useState<string | null>(null);
  const [refLoading, setRefLoading] = useState(false);

  useEffect(() => { setDraft({ ...data }); }, [data]);

  const has = (k: string): boolean => schema.includes(k);
  const str = (k: string): string => asString(draft[k]);
  // W6-M: readonly DISPLAY of a content value in the workspace language (English
  // translates the Arabic source on demand). Never used on editable inputs —
  // the user edits the source, so `str()` (raw) drives every input below.
  const mosText = useMosText();
  const disp = (k: string): string => mosText(str(k), k);
  const set = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));

  // The reference field pulls from the content library. It lives INSIDE the
  // design-brief card, which renders whenever `design_brief` is in the schema —
  // `design_reference` / `design_format` are companion keys that need not be
  // separate schema entries. So load the library whenever that card is present
  // (or a bare `design_reference` key exists). Needed in BOTH edit (the picker)
  // and locked (resolving a stored id to its title) modes.
  const needsContentLibrary =
    schema.includes('design_brief') || schema.includes('design_reference');
  useEffect(() => {
    if (!needsContentLibrary) return;
    let alive = true;
    setRefLoading(true);
    fetchContentList({ limit: 500 })
      .then((r) => { if (alive) setContentList(r.content); })
      .catch((e) => {
        if (!alive) return;
        // Surfaced in the picker rather than as a toast — a failed reference
        // list must not look like a silent success, but it also must not block
        // writing the rest of the brief.
        console.error('[marketing] content library load failed', e);
        setRefLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (alive) setRefLoading(false); });
    return () => { alive = false; };
  }, [needsContentLibrary]);

  const referenceDisplay = (value: string): string => {
    const hit = contentList.find((c) => c.id === value);
    return hit ? `${hit.ref ? `${hit.ref} — ` : ''}${hit.title}` : value;
  };

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
  // Display paragraphs translate in EN (readonly view only); the read-speed
  // estimate + copy-for-recording keep the raw Arabic source above.
  const voParagraphs = disp('voiceover').split(/\n+/).map((p) => p.trim()).filter(Boolean);

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

  /* ── headlines: the copy that makes the post. Unlimited, none "approved". ── */
  const headlines = asList(draft.headlines ?? data.headlines);
  const written = headlines.filter((h) => h.trim() !== '').length;

  const setHeadline = (i: number, v: string): void => {
    const next = [...headlines];
    next[i] = v;
    set('headlines', next);
  };
  const removeHeadline = (i: number): void => {
    set('headlines', headlines.filter((_, idx) => idx !== i));
  };

  const headlineCountTag = (): string => {
    if (written === 0) return isAr ? 'لا عناوين بعد' : 'none yet';
    return isAr ? `${num(written, true)} عنوان` : `${written} headline${written === 1 ? '' : 's'}`;
  };

  /* ── hashtags render as tags, edit as one line ── */
  const hashtags = str('hashtags');
  const tagList = hashtags.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const captionParagraphs = disp('caption').split(/\n+/).map((p) => p.trim()).filter(Boolean);

  const nothingComposed = !has('idea') && !has('voiceover') && !has('headlines')
    && !has('caption') && !has('design_brief') && leftovers.length === 0;

  if (nothingComposed) {
    return (
      <div className="write" style={{ textAlign: 'center', color: 'var(--mute)', fontSize: 13 }}>
        {isAr ? 'لا حقول كتابة لهذا النوع.' : 'This type has no writing fields.'}
      </div>
    );
  }

  const saveBar = canEdit ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {dirty && (
        <>
          <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--wait)', fontWeight: 700 }}>
            {isAr ? 'تغييرات غير محفوظة' : 'Unsaved changes'}
          </span>
        </>
      )}
    </div>
  ) : (
    <div style={{ fontSize: 12, color: 'var(--mute)' }}>
      {isAr
        ? 'للقراءة فقط — هذه المرحلة ليست لدى دورك.'
        : 'Read-only — this stage does not sit with your role.'}
    </div>
  );

  /* ════════════════════════════════════════════════════════════════════
     LOCKED — screen 36's «الحقول مقفلة أثناء المراجعة». The same cards,
     rendered as the mockups' filled states: text, not disabled inputs.
     ════════════════════════════════════════════════════════════════════ */
  if (!canEdit) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        {has('idea') && (
          <div className="write">
            <div className="doc-lbl">{isAr ? 'الفكرة' : 'The idea'}</div>
            <p style={{ fontSize: 15.5, color: 'var(--ink)', lineHeight: 1.9 }}>
              {disp('idea') || '—'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px', marginTop: 6 }}>
              <div className="fld">
                <div className="k">{isAr ? 'الافتتاحية · أول ٣ ثوانٍ' : 'The hook · first 3 seconds'}</div>
                <div className="v">{disp('hook') || '—'}</div>
              </div>
              <div className="fld">
                <div className="k">{isAr ? 'الرسالة الأساسية' : 'The core message'}</div>
                <div className="v">{disp('core_message') || '—'}</div>
              </div>
            </div>
          </div>
        )}

        {has('voiceover') && (
          <div className="write">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div className="doc-lbl" style={{ margin: 0 }}>
                {isAr ? 'نص التعليق الصوتي' : 'The voice-over script'}
              </div>
              {voSeconds > 0 && (
                <span className="tag tag-t">
                  {isAr ? `${num(voSeconds, true)} ثانية بسرعة القراءة` : `${voSeconds}s at reading speed`}
                </span>
              )}
              {voWords > 0 && (
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  style={{ marginInlineStart: 'auto' }}
                  onClick={() => void copyVoiceover()}
                >
                  {isAr ? 'إرسال للتسجيل الصوتي' : 'Send for recording'}
                </button>
              )}
            </div>
            {voParagraphs.length === 0 ? (
              <p style={{ color: 'var(--mute)' }}>—</p>
            ) : (
              voParagraphs.map((p, i) => <p key={i} style={{ lineHeight: 1.95 }}>{p}</p>)
            )}
          </div>
        )}

        {has('headlines') && (
          <div className="write">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div className="doc-lbl" style={{ margin: 0 }}>
                {isAr ? 'العناوين' : 'Headlines'}
              </div>
              <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
                {headlineCountTag()}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--mute)', marginBottom: 12 }}>
              {isAr ? 'العناوين التي تصنع المنشور — النص الذي يظهر على التصميم.' : 'The headlines that make the post — the copy shown on the design.'}
            </div>

            {headlines.length === 0 ? (
              <p style={{ color: 'var(--mute)' }}>—</p>
            ) : (
              headlines.map((h, i) => (
                <div key={i} className="opt" style={rowCentered}>
                  <span style={idxBadge}>{num(i + 1, isAr)}</span>
                  <div className="tx" style={{ flex: 1, minWidth: 0 }}>{h || '—'}</div>
                </div>
              ))
            )}
          </div>
        )}

        {(has('caption') || has('design_brief')) && (
          <div className={has('caption') && has('design_brief') ? 'grid g2' : undefined}>
            {has('caption') && (
              <div className="write">
                <div className="doc-lbl">{isAr ? 'الكابشن · انستقرام' : 'The caption · Instagram'}</div>
                {captionParagraphs.length === 0 ? (
                  <p style={{ color: 'var(--mute)' }}>—</p>
                ) : (
                  captionParagraphs.map((p, i) => (
                    <p key={i} style={{ fontSize: 14.5, lineHeight: 1.9 }}>{p}</p>
                  ))
                )}
                {tagList.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
                    {/* Four tags then «+٣» — screen 08's collapse point. */}
                    {tagList.slice(0, 4).map((t) => <span key={t} className="tag">{t}</span>)}
                    {tagList.length > 4 && (
                      <span className="tag tag-t">+{num(tagList.length - 4, isAr)}</span>
                    )}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10 }}>
                  {isAr
                    ? 'كابشن كل منصة أخرى مختلف — يُضبط في تبويب النشر، لا هنا.'
                    : 'Every other platform’s caption is different — set in the Publishing tab, not here.'}
                </div>
              </div>
            )}

            {has('design_brief') && (
              <div className="write">
                <div className="doc-lbl">
                  {isAr ? 'موجز التصميم — للمونتير' : 'The design brief — for the editor'}
                </div>
                <div className="fld">
                  <div className="k">{isAr ? 'الصيغة' : 'Format'}</div>
                  <div className="v">{str('design_format') || '—'}</div>
                </div>
                <div className="fld">
                  <div className="k">{isAr ? 'الاتجاه البصري' : 'Visual direction'}</div>
                  <div className="v">{str('design_brief') || '—'}</div>
                </div>
                <div className="fld">
                  <div className="k">{isAr ? 'مرجع' : 'Reference'}</div>
                  <div className="v" style={str('design_reference') ? { color: 'var(--copper)' } : undefined}>
                    {str('design_reference') ? referenceDisplay(str('design_reference')) : '—'}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {leftovers.length > 0 && (
          <div className="write">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}>
              {leftovers.map((k) => {
                const def = GENERIC_FIELDS[k];
                if (!def) return null;
                return (
                  <div key={k} className="fld" style={def.kind === 'long' ? { gridColumn: '1 / -1' } : undefined}>
                    <div className="k">{isAr ? def.ar : def.en}</div>
                    <div className="v" style={{ whiteSpace: 'pre-line' }}>{str(k) || '—'}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {saveBar}
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════════
     EDITABLE — the open stage sits with my role.
     ════════════════════════════════════════════════════════════════════ */
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── الفكرة ─────────────────────────────────────────────────── */}
      {has('idea') && (
        <div className="write">
          <div className="doc-lbl">{isAr ? 'الفكرة' : 'The idea'}</div>
          <textarea
            className="inp"
            rows={3}
            style={{ fontSize: 15.5, lineHeight: 1.9 }}
            value={str('idea')}
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
                {isAr ? `${num(voSeconds, true)} ثانية بسرعة القراءة` : `${voSeconds}s at reading speed`}
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
            onChange={(e) => set('voiceover', e.target.value)}
          />
        </div>
      )}

      {/* ── العناوين — تصنع المنشور، بلا عدد مفروض وبلا اعتماد ───────── */}
      {has('headlines') && (
        <div className="write">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div className="doc-lbl" style={{ margin: 0 }}>
              {isAr ? 'العناوين' : 'Headlines'}
            </div>
            <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
              {headlineCountTag()}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginBottom: 12 }}>
            {isAr
              ? 'هذه العناوين هي نص المنشور الذي يظهر على التصميم — أضف ما يحتاجه العمل.'
              : 'These headlines are the post copy shown on the design — add as many as the piece needs.'}
          </div>

          {headlines.map((h, i) => (
            <div key={i} className="opt" style={rowCentered}>
              <span style={idxBadge}>{num(i + 1, isAr)}</span>
              <input
                className="inp"
                style={{ ...bareInput, flex: 1 }}
                value={h}
                onChange={(e) => setHeadline(i, e.target.value)}
              />
              <button
                type="button"
                style={delBtn}
                onClick={() => removeHeadline(i)}
                aria-label={isAr ? 'حذف هذا العنوان' : 'Remove this headline'}
              >
                ×
              </button>
            </div>
          ))}

          <NewHeadlineRow
            index={headlines.length + 1}
            isAr={isAr}
            onCommit={(v) => set('headlines', [...headlines, v])}
          />
        </div>
      )}

      {/* ── الكابشن + موجز التصميم ─────────────────────────────────── */}
      {(has('caption') || has('design_brief')) && (
        <div className={has('caption') && has('design_brief') ? 'grid g2' : undefined}>
          {has('caption') && (
            <div className="write">
              <div className="doc-lbl">{isAr ? 'الكابشن · انستقرام' : 'The caption · Instagram'}</div>
              <textarea
                className="inp"
                rows={6}
                style={{ fontSize: 14.5, lineHeight: 1.9 }}
                value={str('caption')}
                onChange={(e) => set('caption', e.target.value)}
              />
              {has('hashtags') && (
                <>
                  {tagList.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
                      {/* Four tags then «+٣» — screen 08's collapse point. */}
                      {tagList.slice(0, 4).map((t) => <span key={t} className="tag">{t}</span>)}
                      {tagList.length > 4 && (
                        <span className="tag tag-t">+{num(tagList.length - 4, isAr)}</span>
                      )}
                    </div>
                  )}
                  <input
                    className="inp"
                    dir="rtl"
                    style={{ marginTop: 8, fontSize: 12.5 }}
                    value={hashtags}
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

          {has('design_brief') && (
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
                  placeholder={isAr ? 'كاروسيل، ٤ شرائح · ١٠٨٠ × ١٣٥٠' : 'Carousel, 4 slides · 1080 × 1350'}
                  onChange={(e) => set('design_format', e.target.value)}
                />
              </div>
              <div className="fld">
                <div className="k">{isAr ? 'الاتجاه البصري' : 'Visual direction'}</div>
                <textarea
                  className="inp"
                  rows={3}
                  style={{ marginTop: 4, fontSize: 13 }}
                  value={str('design_brief')}
                  placeholder={isAr ? 'صور داخلية، ساعة ذهبية. بدون صور مخزون.' : 'Interior shots, golden hour. No stock photos.'}
                  onChange={(e) => set('design_brief', e.target.value)}
                />
              </div>
              <div className="fld">
                <div className="k">{isAr ? 'مرجع' : 'Reference'}</div>
                <ReferencePicker
                  value={str('design_reference')}
                  contentList={contentList}
                  currentId={contentId}
                  loadError={refLoadError}
                  loading={refLoading}
                  isAr={isAr}
                  onChange={(v) => set('design_reference', v)}
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
                      onChange={(e) => set(k, e.target.value)}
                    />
                  ) : (
                    <input
                      className="inp"
                      value={str(k)}
                      onChange={(e) => set(k, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {saveBar}
    </div>
  );
}

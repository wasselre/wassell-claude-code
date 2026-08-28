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
 *   (caption + hashtags + paid ad copy) → NOT here. Distribution copy belongs to
 *                                         the PLACEMENT it runs on, so it is authored
 *                                         in PlacementCaptions (rendered by the content
 *                                         tab next to this) — organic captions on the
 *                                         publication rows, paid copy on the ad rows.
 *   design_brief (+ references)         → the structured design brief, so "what do I
 *                                         design" never drowns in a notes box. The
 *                                         references are PICKS from the Files library
 *                                         (one or many), each shown as a thumbnail
 *                                         card and previewable in place.
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
import { updateContent } from '@/lib/marketingOS/client';
import FilePickerModal from '@/pages/Files/library/FilePickerModal';
import FilePreviewModal from '@/pages/Files/components/FilePreviewModal';
import { listFilesByIds, signViewUrls } from '@/lib/files/client';
import { kindIcon, kindLabel } from '@/lib/files/format';
import type { FileRow } from '@/types';
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
  // Per-platform caption companion keys (Instagram = the legacy `caption`).
  'caption_tiktok', 'caption_x', 'caption_snapchat',
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
 * The design-brief References strip — MULTIPLE reference files from the Files
 * library, each rendered as a real preview card: an image/video thumbnail
 * (signed URL) or a kind icon, the file name, and an in-app preview on click
 * (the Files system's own FilePreviewModal — never a navigation away). In edit
 * mode each card gets an ×, and «+ إضافة مرجع» opens the ONE shared Files
 * picker (search + library cards + upload).
 *
 * Data: `design_reference_file_ids: string[]` in mos_content.data; the parent
 * keeps the legacy single keys (`design_reference_file_id`/`_title`) in sync.
 */
function ReferenceFilesStrip({
  fileIds, fallbackTitles, canEdit, isAr, onChange,
}: {
  fileIds: string[];
  /** Display names for ids whose rows can't be fetched (deleted/no access). */
  fallbackTitles: Record<string, string>;
  canEdit: boolean;
  isAr: boolean;
  /** Second arg = the first id's display title (legacy-key sync). */
  onChange: (fileIds: string[], firstTitle: string) => void;
}) {
  const [rows, setRows] = useState<Map<string, FileRow>>(() => new Map());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<FileRow | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const idsKey = fileIds.join(',');
  useEffect(() => {
    if (fileIds.length === 0) { setRows(new Map()); setThumbs({}); return; }
    let alive = true;
    listFilesByIds(fileIds)
      .then((rs) => {
        if (!alive) return;
        setRows(new Map(rs.map((r) => [r.id, r])));
        const media = rs.filter((r) => r.kind === 'image' || r.kind === 'video').map((r) => r.id);
        return signViewUrls(media).then((m) => { if (alive) setThumbs(m); });
      })
      .catch((e) => {
        // The cards degrade to name-only; the failure must still be visible.
        console.error('[marketing] reference files load failed', e);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const titleOf = (id: string): string => {
    const r = rows.get(id);
    return r?.original_name || fallbackTitles[id] || id;
  };

  const emit = (ids: string[]): void => {
    const first = ids[0];
    onChange(ids, first ? titleOf(first) : '');
  };

  const card = {
    position: 'relative' as const, width: 124, borderRadius: 8, overflow: 'hidden',
    border: '1px solid var(--line, rgba(255,255,255,0.10))',
    background: 'var(--panel, rgba(255,255,255,0.03))',
  };
  const thumbBox = {
    width: '100%', height: 78, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(0,0,0,0.18)',
  };
  const nameLine = {
    display: 'block', width: '100%', padding: '5px 7px', fontSize: 11,
    color: 'var(--ink, inherit)', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const, textAlign: 'start' as const,
  };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {fileIds.map((id) => {
          const row = rows.get(id) ?? null;
          const url = thumbs[id];
          const Icon = row ? kindIcon[row.kind] : null;
          return (
            <div key={id} style={card}>
              <button
                type="button"
                style={{ display: 'block', width: '100%', padding: 0, border: 0, background: 'transparent', cursor: row ? 'pointer' : 'default' }}
                title={titleOf(id)}
                onClick={() => { if (row) setPreview(row); }}
              >
                <div style={thumbBox}>
                  {row && row.kind === 'image' && url ? (
                    <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : row && row.kind === 'video' && url ? (
                    <video src={url} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : Icon && row ? (
                    <span style={{ display: 'grid', justifyItems: 'center', gap: 4, color: 'var(--mute)' }}>
                      <Icon size={22} aria-hidden />
                      <span style={{ fontSize: 10 }}>{kindLabel(row.kind, isAr)}</span>
                    </span>
                  ) : (
                    <span style={{ fontSize: 10.5, color: 'var(--mute)', padding: '0 6px', textAlign: 'center' }}>
                      {isAr ? 'غير متاح' : 'Unavailable'}
                    </span>
                  )}
                </div>
                <span style={nameLine}>{titleOf(id)}</span>
              </button>
              {canEdit && (
                <button
                  type="button"
                  style={{
                    position: 'absolute', top: 3, insetInlineEnd: 3, width: 20, height: 20,
                    borderRadius: 6, border: 0, cursor: 'pointer', lineHeight: 1, fontSize: 13,
                    background: 'rgba(0,0,0,0.55)', color: '#fff',
                  }}
                  onClick={() => emit(fileIds.filter((x) => x !== id))}
                  aria-label={isAr ? 'إزالة المرجع' : 'Remove reference'}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        {canEdit && (
          <button
            type="button"
            style={{
              width: 124, minHeight: 104, borderRadius: 8, cursor: 'pointer',
              border: '1px dashed var(--line, rgba(255,255,255,0.18))',
              background: 'transparent', color: 'var(--mute)', fontSize: 12,
            }}
            onClick={() => setPickerOpen(true)}
          >
            {isAr ? '+ إضافة مرجع' : '+ Add reference'}
          </button>
        )}

        {!canEdit && fileIds.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--mute)' }}>—</span>
        )}
      </div>

      <FilePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(f) => { if (!fileIds.includes(f.id)) emit([...fileIds, f.id]); }}
        title={isAr ? 'أضف مرجعًا من مكتبة الملفات' : 'Add a reference from the Files library'}
        sub={isAr ? 'ملفات مثال يحتذي بها هذا التصميم.' : 'Example files this design should take after.'}
      />

      {/* The Files system's own full-screen viewer — image lightbox, in-app PDF,
          video player… — opened in place; read-only here. */}
      <FilePreviewModal
        file={preview}
        open={!!preview}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreview(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
      />
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

  useEffect(() => { setDraft({ ...data }); }, [data]);

  const has = (k: string): boolean => schema.includes(k);
  const str = (k: string): string => asString(draft[k]);
  // W6-M: readonly DISPLAY of a content value in the workspace language (English
  // translates the Arabic source on demand). Never used on editable inputs —
  // the user edits the source, so `str()` (raw) drives every input below.
  const mosText = useMosText();
  const disp = (k: string): string => mosText(str(k), k);
  const set = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));

  const leftovers = useMemo(
    () => schema.filter((k) => !COMPOSED.has(k) && GENERIC_FIELDS[k]),
    [schema],
  );

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(data),
    [draft, data],
  );

  /* ── design-brief reference files ──────────────────────────────────
     The array key `design_reference_file_ids`, falling back to the legacy
     single keys for content saved before multi-reference (2026-08-28). The
     legacy keys are kept in sync (first id + its title) on every change. */
  const refFileIds = useMemo(() => {
    const arr = asList(draft.design_reference_file_ids ?? data.design_reference_file_ids);
    if (arr.length > 0) return arr;
    const legacy = asString(draft.design_reference_file_id ?? data.design_reference_file_id);
    return legacy ? [legacy] : [];
  }, [draft, data]);
  const legacyRefTitles = useMemo(() => {
    const id = asString(draft.design_reference_file_id ?? data.design_reference_file_id);
    const title = asString(draft.design_reference_file_title ?? data.design_reference_file_title);
    return id && title ? { [id]: title } : {};
  }, [draft, data]);
  const setRefFiles = (ids: string[], firstTitle: string): void => {
    setDraft((d) => ({
      ...d,
      design_reference_file_ids: ids,
      design_reference_file_id: ids[0] ?? '',
      design_reference_file_title: ids.length > 0 ? firstTitle : '',
    }));
  };

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

  const nothingComposed = !has('idea') && !has('voiceover') && !has('headlines')
    && !has('design_brief') && leftovers.length === 0;

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

        {/* Captions/ad-copy are authored in PlacementCaptions (rendered by the
            content tab) — they belong to the placement, not the creative. */}
        {has('design_brief') && (
          <div className="write">
            <div className="doc-lbl">
              {isAr ? 'موجز التصميم — للمونتير' : 'The design brief — for the editor'}
            </div>
            <div className="fld">
              <div className="k">{isAr ? 'الاتجاه البصري' : 'Visual direction'}</div>
              <div className="v">{str('design_brief') || '—'}</div>
            </div>
            <div className="fld">
              <div className="k">{isAr ? 'مراجع' : 'References'}</div>
              <ReferenceFilesStrip
                fileIds={refFileIds}
                fallbackTitles={legacyRefTitles}
                canEdit={false}
                isAr={isAr}
                onChange={() => {}}
              />
            </div>
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

      {/* ── موجز التصميم ───────────────────────────────────────────── */}
      {/* Captions + paid ad-copy live in PlacementCaptions (the content tab
          renders it next to this) — a caption belongs to the placement it runs
          on, not to the creative. */}
      {has('design_brief') && (
        <div className="write">
          <div className="doc-lbl">
            {isAr ? 'موجز التصميم — للمونتير' : 'The design brief — for the editor'}
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
            <div className="k">{isAr ? 'مراجع' : 'References'}</div>
            <ReferenceFilesStrip
              fileIds={refFileIds}
              fallbackTitles={legacyRefTitles}
              canEdit
              isAr={isAr}
              onChange={setRefFiles}
            />
          </div>
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

/**
 * The writing surface — one ITEM's copy, the object of the writing task.
 *
 * E3 (2026-09-15) settled the order and the vocabulary. A post is not a
 * headline plus a caption; it is a LIST OF LINES that land on the design, plus
 * the caption that goes under it. Per item, in order:
 *
 *   1. أسطر المنشور   — `headlines`: the ordered 3–6 lines that land on the
 *                        design. A hook line, then the fact lines, then the
 *                        call to action. None is "approved" and none is
 *                        discarded — there is no picker and no forced count.
 *                        Add / remove / REORDER: order is the copy's shape, so
 *                        moving a line is a first-class verb, not a delete and
 *                        a retype.
 *   2. النص           — `caption`: AI-PREFILLED on task open and visibly a
 *                        draft until the writer confirms it. `caption_source`
 *                        renders from DATA (it used to render from transient
 *                        component state, which is null on every page load, so
 *                        «مسودة من الذكاء» vanished the moment you reloaded).
 *                        The writing cannot be sent while it is unconfirmed —
 *                        `caption_confirmed_text` holds WHAT was confirmed, so
 *                        a later edit invalidates it by itself.
 *   3. موجز التصميم    — one sentence to the designer.
 *   4. مرجع بصري      — picks from the Files library, as thumbnails.
 *   5. الهاشتاقات     — shared, appended to every platform at publish. It had
 *                        NO editor in the writing task (only PlacementsTab),
 *                        yet publish appends it; this is its home.
 *
 * Video keeps its own two instruments above the five — الفكرة (idea + hook +
 * core message) and نص التعليق الصوتي with its read-speed chip, because a
 * 38-second script must not silently become 70. Anything else in the schema
 * renders as a plain field; unknown keys degrade quietly rather than crashing.
 *
 * Two render modes (screen 36's rule): when the open stage sits with MY role
 * the cards are inputs; when it doesn't, the SAME cards render as locked TEXT —
 * the mockups' filled states — with the comment composer as the only live
 * surface on the page.
 *
 * Embedded mode (`embedded`) is what the ROW writer mounts three of: no save
 * bar of its own, every draft change reported upward, one submit for the row.
 *
 * Values live in `mos_content.data` — free-form JSONB, so companion keys like
 * core_message need no migration.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { updateContent, generateContentCaption } from '@/lib/marketingOS/client';
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
  // Caption confirmation companions — rendered by the caption card, never generic.
  'caption_confirmed_text', 'caption_confirmed_at', 'caption_source',
  // Per-platform caption companion keys (Instagram = the legacy `caption`).
  'caption_tiktok', 'caption_x', 'caption_snapchat',
  'design_brief', 'slides', 'scenes',
]);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/* ════════════════════════════════════════════════════════════════════
   The writing state of ONE item, read straight from `data`.

   Exported because the ROW is what gets sent, not the post: the row writer's
   pre-send check has to ask the same three questions of all three members, and
   asking them twice in two places is how the two answers drift apart.
   ════════════════════════════════════════════════════════════════════ */

export interface PostWritingState {
  /** At least one line that lands on the design. */
  hasLines: boolean;
  /** The lines themselves, trimmed of blanks — the first one is the hook. */
  lines: string[];
  /** The caption has text. */
  hasCaption: boolean;
  /**
   * The writer confirmed THIS EXACT caption. Compared raw and untrimmed, the
   * same way `mos_caption_hash` and the Meta worker compare it — a trim-parity
   * mismatch between JS and SQL is exactly how the 2026-08-05 twin-fill bug
   * shipped, and how the caption gate would silently pass the wrong text.
   */
  captionConfirmed: boolean;
  /** Who drafted the caption, from DATA — survives a reload. */
  captionSource: 'ai' | 'fallback' | null;
}

export function postWritingState(data: Record<string, unknown>): PostWritingState {
  const lines = asList(data.headlines).map((l) => l.trim()).filter((l) => l !== '');
  const caption = asString(data.caption);
  const src = asString(data.caption_source);
  return {
    hasLines: lines.length > 0,
    lines,
    hasCaption: caption.length > 0,
    captionConfirmed: caption.length > 0 && asString(data.caption_confirmed_text) === caption,
    captionSource: src === 'ai' ? 'ai' : src === 'fallback' ? 'fallback' : null,
  };
}

/** The muted order index that replaces the old approval radio on each line row. */
const idxBadge = {
  flex: '0 0 auto', minWidth: 16, textAlign: 'center' as const,
  fontSize: 12, fontWeight: 700, color: 'var(--mute)',
};
const delBtn = {
  flex: '0 0 auto', border: 0, background: 'transparent', color: 'var(--mute)',
  cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px',
};
const moveBtn = {
  flex: '0 0 auto', width: 20, height: 20, padding: 0, lineHeight: 1, fontSize: 11,
  borderRadius: 5, border: '1px solid var(--line)', background: 'var(--paper)',
  color: 'var(--mute)', cursor: 'pointer',
};
const rowCentered = { alignItems: 'center' as const };
const bareInput = {
  border: '1px solid transparent', background: 'transparent', padding: '2px 4px', fontSize: 14,
};

/**
 * The dashed "add a line" row. Local state, committed on blur/Enter —
 * appending on every keystroke would fragment typing into one-char lines.
 */
function NewLineRow({
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
        placeholder={isAr ? 'أضف سطرًا…' : 'Add a line…'}
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

/** The one place that says «مسودة من الذكاء» / «مسودة تلقائية» — from DATA. */
function CaptionSourceNote({ source, isAr }: { source: 'ai' | 'fallback' | null; isAr: boolean }) {
  if (!source) return null;
  return (
    <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>
      {source === 'fallback'
        ? (isAr ? 'مسودة تلقائية من أسطر المنشور — راجعها.' : 'Deterministic draft from the post lines — review it.')
        : (isAr ? 'مسودة من الذكاء الاصطناعي — راجعها.' : 'AI draft — review it.')}
    </div>
  );
}

/* ── autosave: nothing typed is lost to a refresh ─────────────────────────
   Operator rule (2026-09-17): whatever is typed is kept at once, without a
   save button. Two layers:
     1. a copy on THIS device, written on every change — survives a refresh
        or a crash before the server answers;
     2. the server, ~600 ms after typing pauses.
   The device copy remembers which server state it was typed on top of
   (`base`). It is restored only while the server still holds exactly that
   state — so an old copy can never overwrite newer work saved elsewhere. */
/**
 * JSON with object keys sorted, recursively. Postgres `jsonb` hands keys back in
 * its own order, so a plain JSON.stringify of the reloaded record never equals
 * the string the browser saved — and a device copy would never be recognised as
 * sitting on the current server state.
 */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

const DRAFT_KEY = (contentId: string): string => `wassel.mos.writing-draft.v1:${contentId}`;
const AUTOSAVE_DELAY_MS = 600;

interface DeviceDraft { base: string; draft: Record<string, unknown>; at: string }

function readDeviceDraft(contentId: string): DeviceDraft | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DRAFT_KEY(contentId));
  } catch (e) {
    // Storage blocked (private mode / policy): the server save still runs.
    console.error('[marketing] device draft read failed', contentId, e);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceDraft>;
    if (typeof parsed.base !== 'string' || !parsed.draft || typeof parsed.draft !== 'object') return null;
    return { base: parsed.base, draft: parsed.draft as Record<string, unknown>, at: String(parsed.at ?? '') };
  } catch (e) {
    console.error('[marketing] device draft unreadable — discarded', contentId, e);
    return null;
  }
}

function writeDeviceDraft(contentId: string, value: DeviceDraft | null): boolean {
  try {
    if (value) window.localStorage.setItem(DRAFT_KEY(contentId), JSON.stringify(value));
    else window.localStorage.removeItem(DRAFT_KEY(contentId));
    return true;
  } catch (e) {
    console.error('[marketing] device draft write failed', contentId, e);
    return false;
  }
}

type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

export default function WritingFields({
  contentId, schema, data, canEdit, isAr, onSaved,
  embedded = false, onDraftChange, prefillCaption,
}: {
  contentId: string;
  schema: string[];
  data: Record<string, unknown>;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (data: Record<string, unknown>) => void;
  /**
   * Mounted inside the ROW writer: no save bar of its own, no «للقراءة فقط»
   * note, and every draft change reported up so the row can save all three
   * members under one submit.
   */
  embedded?: boolean;
  onDraftChange?: (contentId: string, data: Record<string, unknown>, dirty: boolean) => void;
  /**
   * AI-prefill the caption when the box is empty and this stage is mine.
   * Defaults to `canEdit` — opening the writing task IS the prefill moment.
   * Pass `false` on surfaces that merely preview the writing (a popup over a
   * list), so browsing never spends a model call.
   */
  prefillCaption?: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  // Starts AS the server copy, so the first render never looks like an edit.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...data }));

  /** The server's copy as JSON — what the last successful save (or load) holds. */
  const savedJson = useRef<string>(stableJson(data));
  const [autosave, setAutosave] = useState<AutosaveState>('idle');

  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const serverJson = stableJson(data);
    // A parent echoing back what the autosave just stored is not new server
    // state — resetting the draft then would eat whatever was typed since.
    if (loadedFor.current === contentId && serverJson === savedJson.current) return;
    loadedFor.current = contentId;
    savedJson.current = serverJson;
    const device = canEdit ? readDeviceDraft(contentId) : null;
    if (device && device.base === serverJson && stableJson({ ...data, ...device.draft }) !== serverJson) {
      // Typed before a refresh and never reached the server: bring it back
      // (the autosave below then saves it).
      setDraft({ ...data, ...device.draft });
    } else {
      if (device) writeDeviceDraft(contentId, null);
      setDraft({ ...data });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, contentId]);

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

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (!canEdit) return undefined;
    const json = stableJson({ ...data, ...draft });
    if (json === savedJson.current) {
      // Typed and then undone back to the saved text: nothing left to keep.
      if (autosave === 'pending') { writeDeviceDraft(contentId, null); setAutosave('saved'); }
      return undefined;
    }
    // 1 — on this device, now.
    writeDeviceDraft(contentId, { base: savedJson.current, draft, at: new Date().toISOString() });
    setAutosave('pending');
    // 2 — on the server, once typing pauses. One save at a time, always the latest draft.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const run = async (): Promise<void> => {
        if (saving.current) await saving.current;
        const snapshotJson = stableJson({ ...data, ...draft });
        if (snapshotJson === savedJson.current) return;
        setAutosave('saving');
        try {
          await updateContent(contentId, { data: { ...data, ...draft } });
          savedJson.current = snapshotJson;
          onSaved({ ...data, ...draft });
          // The device copy is kept only while it holds more than the server.
          const device = readDeviceDraft(contentId);
          if (!device || stableJson({ ...data, ...device.draft }) === snapshotJson) writeDeviceDraft(contentId, null);
          else writeDeviceDraft(contentId, { ...device, base: snapshotJson });
          setAutosave('saved');
        } catch (e) {
          console.error('[marketing] writing autosave failed', contentId, e);
          setAutosave('failed');
        }
      };
      saving.current = run().finally(() => { saving.current = null; });
    }, AUTOSAVE_DELAY_MS);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, canEdit, contentId]);

  /* The row writer holds the drafts; report every change up so ONE submit can
     save all three members. Guarded on the serialized draft so an unchanged
     render does not re-notify the parent into a loop. */
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    if (!onDraftChange) return;
    const key = JSON.stringify(draft);
    if (lastEmitted.current === key) return;
    lastEmitted.current = key;
    onDraftChange(contentId, draft, dirty);
  }, [draft, dirty, contentId, onDraftChange]);

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

  /* ── النص — the caption, written HERE and approved with the writing ──
     Reversal of the 2026-08-26 split, deliberately. The canonical caption is
     `data.caption`; `mos_publications.caption` and the ad rows' primary text
     become per-platform OVERRIDES seeded from it. The writer must confirm the
     exact text — `caption_confirmed_text` holds what was confirmed, so any
     later edit silently invalidates the confirmation (exact comparison, no
     trimming: a trim-parity mismatch between JS and SQL is exactly how the
     2026-08-05 twin-fill bug shipped). */
  const state = useMemo(() => postWritingState(draft), [draft]);
  const captionText = str('caption');
  const captionConfirmed = state.captionConfirmed;
  const [captionBusy, setCaptionBusy] = useState(false);

  const applyCaption = (caption: string, source: 'ai' | 'fallback' | null): void => {
    setDraft((d) => ({
      ...d,
      caption,
      caption_source: source ?? '',
      // A fresh draft is NOT confirmed — the writer still has to read it.
      caption_confirmed_text: '',
      caption_confirmed_at: '',
    }));
  };

  const generateCaption = async (): Promise<void> => {
    setCaptionBusy(true);
    try {
      const res = await generateContentCaption(contentId);
      applyCaption(res.caption, res.source);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setCaptionBusy(false);
    }
  };

  /* ── the prefill, on opening the task ──────────────────────────────
     Once per item, and only over an EMPTY caption: the server refuses to
     overwrite text and returns `skipped: 'already_written'`. A failure to
     persist is surfaced (toast + console) rather than swallowed — a prefill
     that silently did nothing is the exact shape of the bugs this repo keeps
     paying for — but the draft still lands in the box either way. */
  const wantPrefill = (prefillCaption ?? canEdit) && canEdit;
  const prefillTried = useRef<string | null>(null);
  useEffect(() => {
    if (!wantPrefill) return;
    if (prefillTried.current === contentId) return;
    if (asString(data.caption).length > 0) return;
    prefillTried.current = contentId;
    let alive = true;
    setCaptionBusy(true);
    generateContentCaption(contentId, { prefill: true })
      .then((res) => {
        if (!alive) return;
        applyCaption(res.caption, res.source);
        if (res.persisted === false && res.persist_skipped && res.persist_skipped !== 'already_written') {
          console.error('[marketing] caption prefill not persisted', res.persist_skipped, res.persist_detail);
          addToast(
            isAr
              ? 'كُتبت مسودة التعليق لكنها لم تُحفظ — احفظ الكتابة لتثبيتها.'
              : 'The caption draft was written but not saved — save the writing to keep it.',
            'error',
          );
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.error('[marketing] caption prefill failed', e);
        addToast(
          isAr
            ? 'تعذّر توليد مسودة التعليق — اكتبه أو أعد المحاولة بزر التوليد.'
            : 'Could not draft the caption — write it, or retry with the generate button.',
          'error',
        );
      })
      .finally(() => { if (alive) setCaptionBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId, wantPrefill]);

  /* ── أسطر المنشور — the copy that lands on the design ───────────────
     An ORDERED list: a hook line, the fact lines, the call to action. Add,
     remove and MOVE — order is the copy's shape, so the third verb is not a
     convenience. Unlimited, none "approved". */
  const lines = asList(draft.headlines ?? data.headlines);
  const written = lines.filter((h) => h.trim() !== '').length;

  const setLine = (i: number, v: string): void => {
    const next = [...lines];
    next[i] = v;
    set('headlines', next);
  };
  const removeLine = (i: number): void => {
    set('headlines', lines.filter((_, idx) => idx !== i));
  };
  /** Move one line by `delta` places. A no-op at the ends, never a wrap. */
  const moveLine = (i: number, delta: number): void => {
    const to = i + delta;
    if (to < 0 || to >= lines.length) return;
    const next = [...lines];
    const [moved] = next.splice(i, 1);
    next.splice(to, 0, moved ?? '');
    set('headlines', next);
  };

  const lineCountTag = (): string => {
    if (written === 0) return isAr ? 'لا أسطر بعد' : 'none yet';
    return isAr ? `${num(written, true)} سطر` : `${written} line${written === 1 ? '' : 's'}`;
  };

  const hashtagList = str('hashtags').split(/\s+/).filter(Boolean);

  const nothingComposed = !has('idea') && !has('voiceover') && !has('headlines')
    && !has('design_brief') && !has('hashtags') && leftovers.length === 0;

  if (nothingComposed) {
    return (
      <div className="write" style={{ textAlign: 'center', color: 'var(--mute)', fontSize: 13 }}>
        {isAr ? 'لا حقول كتابة لهذا النوع.' : 'This type has no writing fields.'}
      </div>
    );
  }

  const autosaveLabel = autosave === 'failed'
    ? (isAr ? 'تعذّر الحفظ على الخادم — ما كتبته محفوظ على هذا الجهاز ويُعاد حفظه مع أي تعديل.' : 'Could not save to the server — what you typed is kept on this device and retried on your next change.')
    : autosave === 'pending' || autosave === 'saving'
      ? (isAr ? 'جارٍ الحفظ…' : 'Saving…')
      : autosave === 'saved'
        ? (isAr ? 'حُفظ' : 'Saved')
        : null;
  const saveBar = canEdit ? (
    autosaveLabel ? (
      <div
        role={autosave === 'failed' ? 'alert' : 'status'}
        style={{ fontSize: 12, fontWeight: 700, color: autosave === 'failed' ? 'var(--late)' : 'var(--mute)' }}
      >
        {autosaveLabel}
      </div>
    ) : null
  ) : embedded ? null : (
    <div style={{ fontSize: 12, color: 'var(--mute)' }}>
      {isAr
        ? 'للقراءة فقط — هذه المرحلة ليست لدى دورك.'
        : 'Read-only — this stage does not sit with your role.'}
    </div>
  );

  /* ════════════════════════════════════════════════════════════════════
     LOCKED — screen 36's «الحقول مقفلة أثناء المراجعة». The same cards, in
     the same E3 order, rendered as the mockups' filled states: text, not
     disabled inputs. This is also what the DESIGNER reads beside the slots —
     the lines and the brief are what gets laid out; the confirmed caption is
     context, not the thing being designed.
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

        {/* 1 — أسطر المنشور */}
        {has('headlines') && (
          <div className="write">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div className="doc-lbl" style={{ margin: 0 }}>
                {isAr ? 'أسطر المنشور' : 'Post lines'}
              </div>
              <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
                {lineCountTag()}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--mute)', marginBottom: 12 }}>
              {isAr
                ? 'النص الذي يظهر على التصميم، بترتيبه: خطاف، ثم الحقائق، ثم دعوة للتواصل.'
                : 'The copy that lands on the design, in order: a hook, the facts, then the call to action.'}
            </div>

            {lines.length === 0 ? (
              <p style={{ color: 'var(--mute)' }}>—</p>
            ) : (
              lines.map((h, i) => (
                <div key={i} className="opt" style={rowCentered}>
                  <span style={idxBadge}>{num(i + 1, isAr)}</span>
                  <div className="tx" style={{ flex: 1, minWidth: 0 }}>{h || '—'}</div>
                </div>
              ))
            )}
          </div>
        )}

        {/* 2 — النص (the canonical caption, as the reviewer sees it) */}
        <div className="write">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div className="doc-lbl" style={{ margin: 0 }}>
              {isAr ? 'التعليق' : 'Caption'}
            </div>
            <span
              className="tag"
              style={{
                marginInlineStart: 'auto',
                color: captionConfirmed ? 'var(--go)' : 'var(--wait)',
                borderColor: captionConfirmed ? 'var(--go)' : 'var(--wait)',
                background: 'transparent', fontWeight: 700,
              }}
            >
              {captionConfirmed
                ? (isAr ? 'أكّده الكاتب' : 'Writer confirmed')
                : (isAr ? 'مسودة لم تُؤكَّد' : 'Unconfirmed draft')}
            </span>
          </div>
          {captionText
            ? captionText.split(/\n{2,}/).map((p, i) => (
              <p key={i} style={{ lineHeight: 1.95, whiteSpace: 'pre-wrap' }}>{p}</p>
            ))
            : <p style={{ color: 'var(--mute)' }}>—</p>}
          <CaptionSourceNote source={state.captionSource} isAr={isAr} />
        </div>

        {/* 3 — موجز التصميم */}
        {has('design_brief') && (
          <div className="write">
            <div className="doc-lbl">
              {isAr ? 'موجز التصميم — للمونتير' : 'The design brief — for the editor'}
            </div>
            <div className="fld">
              <div className="k">{isAr ? 'الاتجاه البصري' : 'Visual direction'}</div>
              <div className="v">{str('design_brief') || '—'}</div>
            </div>
          </div>
        )}

        {/* 4 — مرجع بصري */}
        {has('design_brief') && (
          <div className="write">
            <div className="doc-lbl">{isAr ? 'مرجع بصري' : 'Visual reference'}</div>
            <ReferenceFilesStrip
              fileIds={refFileIds}
              fallbackTitles={legacyRefTitles}
              canEdit={false}
              isAr={isAr}
              onChange={() => {}}
            />
          </div>
        )}

        {/* 5 — الهاشتاقات */}
        {has('hashtags') && (
          <div className="write">
            <div className="doc-lbl">
              {isAr ? 'الهاشتاقات — تُضاف عند النشر' : 'Hashtags — appended at publish'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {hashtagList.map((t) => <span key={t} className="tag">{t}</span>)}
              {hashtagList.length === 0 && (
                <span style={{ color: 'var(--mute)', fontSize: 13 }}>—</span>
              )}
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

      {/* ── 1 · أسطر المنشور — تصنع المنشور، بلا عدد مفروض وبلا اعتماد ── */}
      {has('headlines') && (
        <div className="write">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div className="doc-lbl" style={{ margin: 0 }}>
              {isAr ? 'أسطر المنشور' : 'Post lines'}
            </div>
            <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
              {lineCountTag()}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginBottom: 12 }}>
            {isAr
              ? 'هذه الأسطر هي نص المنشور الذي يظهر على التصميم — خطاف، ثم الحقائق، ثم دعوة للتواصل. أضف ما يحتاجه العمل ورتّبها كما تُقرأ.'
              : 'These lines are the post copy shown on the design — a hook, the facts, then the call to action. Add as many as the piece needs and order them as they read.'}
          </div>

          {lines.map((h, i) => (
            <div key={i} className="opt" style={rowCentered}>
              <span style={idxBadge}>{num(i + 1, isAr)}</span>
              <input
                className="inp"
                style={{ ...bareInput, flex: 1 }}
                value={h}
                onChange={(e) => setLine(i, e.target.value)}
              />
              <button
                type="button"
                style={moveBtn}
                disabled={i === 0}
                onClick={() => moveLine(i, -1)}
                aria-label={isAr ? 'رفع هذا السطر' : 'Move this line up'}
                title={isAr ? 'رفع' : 'Move up'}
              >
                ↑
              </button>
              <button
                type="button"
                style={moveBtn}
                disabled={i === lines.length - 1}
                onClick={() => moveLine(i, 1)}
                aria-label={isAr ? 'خفض هذا السطر' : 'Move this line down'}
                title={isAr ? 'خفض' : 'Move down'}
              >
                ↓
              </button>
              <button
                type="button"
                style={delBtn}
                onClick={() => removeLine(i)}
                aria-label={isAr ? 'حذف هذا السطر' : 'Remove this line'}
              >
                ×
              </button>
            </div>
          ))}

          <NewLineRow
            index={lines.length + 1}
            isAr={isAr}
            onCommit={(v) => set('headlines', [...lines, v])}
          />
        </div>
      )}

      {/* ── 2 · النص — جزء من الكتابة، لا من التوزيع (2026-09-14) ─────── */}
      <div className="write">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <div className="doc-lbl" style={{ margin: 0 }}>
            {isAr ? 'التعليق' : 'Caption'}
          </div>
          {captionText.length > 0 && (
            <span
              className="tag"
              style={{
                color: captionConfirmed ? 'var(--go)' : 'var(--wait)',
                borderColor: captionConfirmed ? 'var(--go)' : 'var(--wait)',
                background: 'transparent', fontWeight: 700,
              }}
            >
              {captionConfirmed
                ? (isAr ? 'مؤكَّد' : 'Confirmed')
                : (isAr ? 'مسودة لم تُؤكَّد' : 'Unconfirmed draft')}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginInlineStart: 'auto' }}
            disabled={captionBusy}
            onClick={() => { void generateCaption(); }}
          >
            {captionBusy
              ? (isAr ? 'يكتب…' : 'Writing…')
              : captionText
                ? (isAr ? 'إعادة التوليد بالذكاء' : 'Regenerate with AI')
                : (isAr ? 'توليد بالذكاء' : 'Generate with AI')}
          </button>
        </div>
        <textarea
          className="inp"
          rows={6}
          style={{ fontSize: 13 }}
          value={str('caption')}
          placeholder={isAr ? 'اكتب التعليق، أو ولّده بالذكاء ثم راجعه.' : 'Write the caption, or generate it and review.'}
          onChange={(e) => set('caption', e.target.value)}
        />
        <CaptionSourceNote source={state.captionSource} isAr={isAr} />
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
            fontSize: 12.5, cursor: captionText ? 'pointer' : 'not-allowed',
            opacity: captionText ? 1 : 0.5,
          }}
        >
          <input
            type="checkbox"
            checked={captionConfirmed}
            disabled={!captionText}
            onChange={(e) => setDraft((d) => ({
              ...d,
              caption_confirmed_text: e.target.checked ? captionText : '',
              caption_confirmed_at: e.target.checked ? new Date().toISOString() : '',
            }))}
          />
          <span>
            {isAr ? 'أكّد التعليق — قرأته واعتمدته' : 'Confirm the caption — I read it and approve it'}
          </span>
        </label>
        {!captionConfirmed && (
          <div style={{ fontSize: 11.5, color: 'var(--late)', marginTop: 6 }}>
            {isAr
              ? 'لا يمكن إرسال الكتابة قبل كتابة التعليق وتأكيده.'
              : 'Writing cannot be sent until the caption is written and confirmed.'}
          </div>
        )}
      </div>

      {/* ── 3 · موجز التصميم ───────────────────────────────────────── */}
      {/* Per-PLATFORM caption overrides + paid ad copy still live in
          PlacementCaptions (the content tab renders it next to this); they are
          seeded from the canonical caption above. */}
      {has('design_brief') && (
        <div className="write">
          <div className="doc-lbl">
            {isAr ? 'موجز التصميم — للمونتير' : 'The design brief — for the editor'}
          </div>
          <textarea
            className="inp"
            rows={3}
            style={{ fontSize: 13 }}
            value={str('design_brief')}
            placeholder={isAr ? 'صور داخلية، ساعة ذهبية. بدون صور مخزون.' : 'Interior shots, golden hour. No stock photos.'}
            onChange={(e) => set('design_brief', e.target.value)}
          />
        </div>
      )}

      {/* ── 4 · مرجع بصري ──────────────────────────────────────────── */}
      {has('design_brief') && (
        <div className="write">
          <div className="doc-lbl">{isAr ? 'مرجع بصري' : 'Visual reference'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginBottom: 4 }}>
            {isAr
              ? 'ملفات من المكتبة يحتذي بها هذا التصميم — اختياري.'
              : 'Files from the library this design should take after — optional.'}
          </div>
          <ReferenceFilesStrip
            fileIds={refFileIds}
            fallbackTitles={legacyRefTitles}
            canEdit
            isAr={isAr}
            onChange={setRefFiles}
          />
        </div>
      )}

      {/* ── 5 · الهاشتاقات ─────────────────────────────────────────── */}
      {has('hashtags') && (
        <div className="write">
          <div className="doc-lbl">
            {isAr ? 'الهاشتاقات — تُضاف لكل المنصات عند النشر' : 'Hashtags — added to every platform at publish'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginBottom: 8 }}>
            {isAr
              ? 'وسوم مشتركة تُلحَق بتعليق الفيد وحده — الستوري بلا تعليق.'
              : 'Shared tags appended to the feed caption only — the story carries no text.'}
          </div>
          <input
            className="inp"
            dir="rtl"
            style={{ fontSize: 12.5 }}
            value={str('hashtags')}
            placeholder={isAr ? '#الوسوم مفصولة بمسافة' : '#hashtags separated by spaces'}
            onChange={(e) => set('hashtags', e.target.value)}
          />
          {hashtagList.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {hashtagList.map((t) => <span key={t} className="tag">{t}</span>)}
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

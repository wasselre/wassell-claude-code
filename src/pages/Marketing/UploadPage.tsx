/**
 * Upload & intake — design screen 23. The screen that actually replaces Drive.
 *
 * نور comes back from a shoot with 200 files on a card. If intake is slow or
 * fussy she keeps using Drive, the library stays empty, and everything built
 * on it collapses. So: drop everything at once, one panel applies to all,
 * kind is DETECTED not asked («النوع يُكتشف ولا يُسأل عنه»), duplicates are
 * caught at the door — six copies of the same rooftop photo is what makes
 * "used in N" meaningless — and every failure is loud with a retry, because a
 * file that silently vanished is what sends people back to Drive.
 *
 * Files stream browser→storage with real progress; only metadata goes through
 * the endpoint. Photos, videos, audio, PDFs, design files — everything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_ASPECT_RATIOS, ASSET_SOURCE_LABELS, MosAsset, MosShootRequest, deliverShoot,
  fetchAssets, fetchShoots, saveAsset,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Field, PageHead } from './components/kit';
import {
  IconBack, IconCheck, IconForward, IconLibrary, IconTrash, IconVideo,
} from './components/icons';
import { num } from './lib/format';
import {
  PickedFile, collectDropped, formatBytes, heicToJpeg, isBrowserImage, isHeic,
  kindFromFile, tagsFromPath,
} from './lib/upload';
import { assetErrorText, canonicalAssetFields, uploadCanonicalAsset } from './lib/canonicalUpload';

type RowStatus = 'waiting' | 'converting' | 'uploading' | 'done' | 'failed' | 'duplicate' | 'skipped';

/**
 * Per-file overrides of the «ينطبق على الجميع» panel. Only the keys the user
 * actually touched are present — everything absent falls back to the shared
 * value at upload time, so «apply to all» and «edit each separately» are the
 * same code path with different inputs. `tags`, when set, REPLACES the shared
 * tag list for that file (folder tags are still appended on top).
 */
interface RowOverride {
  title?: string;
  kind?: MosAsset['kind'];
  projectId?: string;
  source?: MosAsset['source'];
  shotOn?: string;
  rights?: string;
  aspectRatio?: string;
  tags?: string[];
}

interface Row {
  id: string;
  file: File;
  status: RowStatus;
  progress: number;
  error: string | null;
  /** The library asset this file appears to duplicate (name + size match). */
  duplicateOf: string | null;
  previewUrl: string | null;
  assetRef: string | null;
  /** Folder segments the file arrived under — they become tags automatically. */
  folderTags: string[];
  /** Set after HEIC→JPEG: the name the file was uploaded AS. */
  convertedName: string | null;
  /** Set when conversion failed and the original was uploaded instead. */
  conversionFailed: boolean;
  /** Fields this file overrides from the shared panel. Empty = fully shared. */
  overrides: RowOverride;
}

/** The name a file lands under when nothing overrides it: filename, no extension. */
const derivedTitle = (file: File): string => file.name.replace(/\.[^.]+$/, '');

const KIND_LABEL: Record<string, { ar: string; en: string }> = {
  photo:    { ar: 'صورة',  en: 'Photo' },
  video:    { ar: 'فيديو', en: 'Video' },
  audio:    { ar: 'صوت',   en: 'Audio' },
  document: { ar: 'مستند', en: 'Document' },
  design:   { ar: 'تصميم', en: 'Design' },
};

const USAGE_RIGHTS: Array<{ key: string; ar: string; en: string }> = [
  { key: 'full',       ar: 'ملكية كاملة — بلا قيود', en: 'Full ownership — no restrictions' },
  { key: 'developer',  ar: 'من المطوّر — للمشروع فقط', en: 'From the developer — this project only' },
  { key: 'licensed',   ar: 'مرخّصة — راجع الرخصة',   en: 'Licensed — check the licence' },
  { key: 'ugc',        ar: 'من عميل — بإذن',          en: 'From a client — with permission' },
];

export default function UploadPage() {
  const { isAr, can, projects } = useWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const addToast = useAppStore((s) => s.addToast);

  const [rows, setRows] = useState<Row[]>([]);
  const [existing, setExisting] = useState<MosAsset[]>([]);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // «ينطبق على الجميع» — one panel, applied to every file in the batch.
  const [projectId, setProjectId] = useState('');
  const [source, setSource] = useState<MosAsset['source']>('shoot');
  const [shotOn, setShotOn] = useState('');
  const [rights, setRights] = useState('full');
  const [aspectRatio, setAspectRatio] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');

  // The shoot this batch delivers. Arriving files are what mark the waiting
  // scenes covered — the wire that makes this not Drive.
  const [shoots, setShoots] = useState<MosShootRequest[]>([]);
  const [shootId, setShootId] = useState(params.get('shoot') ?? '');

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  // Counted in the upload lanes — the `rows` closure inside start() is stale
  // by the time the batch ends, so the delivery check reads this instead.
  const successRef = useRef(0);

  useEffect(() => {
    // The existing library, for duplicate detection at the door.
    void fetchAssets({ limit: 500 })
      .then((res) => setExisting(res.assets))
      .catch((e: unknown) => {
        console.error('[marketing] duplicate check unavailable', e);
        addToast(
          isAr ? 'تعذّر تحميل المكتبة — كشف التكرار معطّل لهذه الجولة.' : 'Could not load the library — duplicate detection is off for this batch.',
          'error',
        );
      });
    // Open shoot requests, for the delivery link. Non-fatal if unavailable.
    void fetchShoots()
      .then((res) => {
        const open = res.requests.filter((r) => r.status !== 'delivered' && r.status !== 'cancelled');
        setShoots(open);
        const preset = params.get('shoot');
        const match = preset ? open.find((r) => r.id === preset) : null;
        if (match?.project_id) setProjectId(match.project_id);
      })
      .catch((e: unknown) => {
        console.error('[marketing] shoot list unavailable for upload link', e);
      });
    return () => abortRef.current?.abort();
    // params is read once at mount by design — the preset should not re-apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addToast, isAr]);

  // Object URLs must be released or a 184-file batch leaks the whole card.
  useEffect(() => () => {
    rows.forEach((r) => { if (r.previewUrl) URL.revokeObjectURL(r.previewUrl); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback((picked: PickedFile[]) => {
    const list = picked.filter((p) => p.file.size > 0);
    if (list.length === 0) return;
    setRows((cur) => {
      const seen = new Set(cur.map((r) => `${r.file.name}|${r.file.size}`));
      const next = [...cur];
      for (const { file, folderTags } of list) {
        const key = `${file.name}|${file.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dup = existing.find(
          (a) => (a.original_name === file.name && a.size_bytes === file.size),
        );
        next.push({
          id: uuid(),
          file,
          status: dup ? 'duplicate' : 'waiting',
          progress: 0,
          error: null,
          duplicateOf: dup ? (dup.title || dup.ref || dup.id) : null,
          previewUrl: isBrowserImage(file) ? URL.createObjectURL(file) : null,
          assetRef: null,
          folderTags,
          convertedName: null,
          conversionFailed: false,
          overrides: {},
        });
      }
      return next;
    });
  }, [existing]);

  const patchRow = (id: string, patch: Partial<Row>): void =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // The row whose per-file editor is open («تعديل هذا الملف»). One at a time.
  const [editingId, setEditingId] = useState<string | null>(null);

  /** Set (or clear, with `undefined`) one override on a single file. */
  const patchOverride = (id: string, patch: RowOverride): void =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, overrides: { ...r.overrides, ...patch } } : r)));

  /** Drop every override on a file — it goes back to the shared panel. */
  const resetOverrides = (id: string): void =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, overrides: {} } : r)));

  const removeRow = (id: string): void =>
    setRows((cur) => {
      const row = cur.find((r) => r.id === id);
      if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
      return cur.filter((r) => r.id !== id);
    });

  const totalBytes = rows.reduce((a, r) => a + r.file.size, 0);
  const uploadable = rows.filter((r) => r.status === 'waiting' || r.status === 'failed');
  const doneCount = rows.filter((r) => r.status === 'done').length;

  const uploadOne = async (row: Row, signal: AbortSignal): Promise<void> => {
    patchRow(row.id, { progress: 0, error: null });
    try {
      // HEIC first: iPhones shoot it, browsers can't render it. A failed
      // conversion falls back to the ORIGINAL file with a visible note —
      // never a dropped file.
      let toSend = row.file;
      let conversionFailed = false;
      if (isHeic(row.file)) {
        patchRow(row.id, { status: 'converting' });
        try {
          toSend = await heicToJpeg(row.file);
          patchRow(row.id, {
            convertedName: toSend.name,
            previewUrl: URL.createObjectURL(toSend),
          });
        } catch (convErr) {
          console.error('[marketing] HEIC conversion failed', row.file.name, convErr);
          conversionFailed = true;
        }
      }
      if (signal.aborted) {
        patchRow(row.id, { status: 'waiting', progress: 0 });
        return;
      }

      patchRow(row.id, { status: 'uploading', conversionFailed });
      // Canonical intake: ONE object in the private wassel-files bucket + ONE
      // files row, referenced by the asset. No marketing-assets/mos/ copy.
      const fileRow = await uploadCanonicalAsset(toSend, {
        onProgress: (fraction) => patchRow(row.id, { progress: fraction }),
        signal,
      });
      // «ينطبق على الجميع ما لم يُخصَّص لملف»: each field is the file's own
      // override when it set one, otherwise the shared panel value.
      const o = row.overrides;
      const kind = o.kind ?? kindFromFile(toSend);
      const title = o.title?.trim() || toSend.name.replace(/\.[^.]+$/, '');
      const effProject = o.projectId ?? projectId;
      const effSource = o.source ?? source;
      const effShotOn = o.shotOn ?? shotOn;
      const effRights = o.rights ?? rights;
      const effAspect = o.aspectRatio ?? aspectRatio;
      // Folder names ride in as tags — Photos/Amenities tagged the file
      // before anyone typed anything. A per-file tag override replaces the
      // shared tags; folder tags are always appended on top.
      const baseTags = o.tags ?? tags;
      const allTags = Array.from(new Set([...baseTags, ...row.folderTags]));
      const res = await saveAsset({
        title,
        kind,
        source: effSource,
        project_id: effProject || null,
        shot_on: effShotOn || null,
        tags: allTags,
        ...canonicalAssetFields(fileRow),
        original_name: row.file.name,
        usage_rights: USAGE_RIGHTS.find((r) => r.key === effRights)?.[isAr ? 'ar' : 'en'] ?? effRights,
        aspect_ratio: effAspect || null,
        shoot_request_id: shootId || null,
      });
      patchRow(row.id, { status: 'done', progress: 1, assetRef: res.asset.ref });
      successRef.current += 1;
    } catch (e) {
      if (signal.aborted) {
        patchRow(row.id, { status: 'waiting', progress: 0 });
        return;
      }
      // An unsupported format or an over-cap file reports the specific reason
      // and the fix, in the reader's language, on the row itself.
      console.error('[marketing] upload failed', row.file.name, e);
      patchRow(row.id, { status: 'failed', error: assetErrorText(e, isAr) });
    }
  };

  const start = async (): Promise<void> => {
    if (uploadable.length === 0) return;
    setRunning(true);
    successRef.current = 0;
    const controller = new AbortController();
    abortRef.current = controller;

    // Two lanes: photos finish fast while a 4K clip grinds — the queue keeps
    // moving instead of standing behind the biggest file.
    const queue = [...uploadable];
    const lane = async (): Promise<void> => {
      while (queue.length > 0 && !controller.signal.aborted) {
        const next = queue.shift();
        if (next) await uploadOne(next, controller.signal);
      }
    };
    await Promise.all([lane(), lane()]);

    setRunning(false);
    if (!controller.signal.aborted) {
      addToast(
        isAr ? 'انتهى الرفع — راجع أي صف فشل.' : 'Upload finished — check any failed rows.',
        'success',
      );
      // The delivery wire: files arrived for this shoot, so the request is
      // delivered, its shot list is ticked, and the scenes that were waiting
      // flip to "have" — the approval checklist unblocks itself.
      if (shootId && successRef.current > 0) {
        try {
          const res = await deliverShoot(shootId);
          const shoot = shoots.find((s) => s.id === shootId);
          addToast(
            isAr
              ? `سُلِّم ${shoot?.ref ?? 'طلب التصوير'} — عُلِّمت ${num(res.scenes_marked, true)} لقطة منتظرة كمتوفرة.`
              : `${shoot?.ref ?? 'The shoot'} delivered — ${res.scenes_marked} waiting shots marked covered.`,
            'success',
          );
        } catch (e) {
          addToast(e instanceof Error ? e.message : String(e), 'error');
        }
      }
    }
  };

  const cancel = (): void => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const addTag = (): void => {
    const t = tagDraft.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  };

  const Back = isAr ? IconForward : IconBack;

  if (!can('manage_assets')) {
    return (
      <div className="body">
        <div className="notice">
          {isAr
            ? 'الرفع يتطلب دورًا يدير المواد — مشرف العمليات أو المونتير أو مدير التسويق.'
            : 'Uploading needs an asset-managing role — the ops supervisor, the editor, or the marketing manager.'}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHead
        title={isAr ? 'إضافة إلى المكتبة' : 'Add to the library'}
        crumb={
          <>
            <button type="button" onClick={() => navigate('/m/library')}>
              <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'مكتبة المواد' : 'Asset library'}
            </button>
            <span className="sep">/</span>
            <span>{isAr ? 'رفع' : 'Upload'}</span>
          </>
        }
        sub={rows.length > 0
          ? isAr
            ? `${num(rows.length, true)} ملفًا محددًا · ${formatBytes(totalBytes, true)} · ينطبق على الكل ما لم يُخصَّص لملف`
            : `${rows.length} files selected · ${formatBytes(totalBytes, false)} · applies to all unless a file overrides it`
          : isAr
            ? 'صور، فيديو، صوت، PDF، ملفات تصميم — كل شيء'
            : 'Photos, video, audio, PDFs, design files — everything'}
      >
        <button type="button" className="btn btn-d" onClick={() => (running ? cancel() : navigate('/m/library'))}>
          {isAr ? 'إلغاء' : 'Cancel'}
        </button>
        <button
          type="button"
          className="btn btn-p"
          disabled={running || uploadable.length === 0}
          onClick={() => void start()}
        >
          {running
            ? isAr ? 'جارٍ الرفع…' : 'Uploading…'
            : isAr ? 'بدء الرفع' : 'Start upload'}
        </button>
      </PageHead>

      <div className="body">
        <div className="grid rail-start">
          {/* ── ينطبق على الجميع ─────────────────────────────────────── */}
          <div className="card">
            <div className="card-h"><h4>{isAr ? 'ينطبق على الجميع' : 'Applies to all'}</h4></div>
            <div className="card-b" style={{ display: 'grid', gap: 13 }}>
              <Field label={isAr ? 'المشروع' : 'Project'}>
                <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">{isAr ? 'بدون' : 'None'}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
                  ))}
                </select>
              </Field>
              <div>
                <Field label={isAr ? 'التصوير' : 'The shoot'}>
                  <select
                    className="inp"
                    value={shootId}
                    onChange={(e) => {
                      setShootId(e.target.value);
                      const s = shoots.find((x) => x.id === e.target.value);
                      if (s?.project_id) setProjectId(s.project_id);
                    }}
                  >
                    <option value="">{isAr ? 'غير مرتبط بطلب' : 'Not linked to a request'}</option>
                    {shoots.map((s) => (
                      <option key={s.id} value={s.id}>{s.title}</option>
                    ))}
                  </select>
                </Field>
                {shootId && (
                  <div style={{ fontSize: 10.5, color: 'var(--copper)', marginTop: 5, fontWeight: 700 }}>
                    {isAr ? 'مرتبط بطلب التصوير ' : 'Linked to shoot request '}
                    <span className="ltr">{shoots.find((s) => s.id === shootId)?.ref ?? ''}</span>
                  </div>
                )}
              </div>
              <Field label={isAr ? 'المصدر' : 'Source'}>
                <select className="inp" value={source} onChange={(e) => setSource(e.target.value as MosAsset['source'])}>
                  {Object.keys(ASSET_SOURCE_LABELS).map((k) => (
                    <option key={k} value={k}>{isAr ? ASSET_SOURCE_LABELS[k]?.ar : ASSET_SOURCE_LABELS[k]?.en}</option>
                  ))}
                </select>
              </Field>
              <Field label={isAr ? 'تاريخ التصوير' : 'Shot on'}>
                <input type="date" className="inp ltr" value={shotOn} onChange={(e) => setShotOn(e.target.value)} />
              </Field>
              <Field label={isAr ? 'حقوق الاستخدام' : 'Usage rights'}>
                <select className="inp" value={rights} onChange={(e) => setRights(e.target.value)}>
                  {USAGE_RIGHTS.map((r) => (
                    <option key={r.key} value={r.key}>{isAr ? r.ar : r.en}</option>
                  ))}
                </select>
              </Field>
              <Field label={isAr ? 'المقاس (نسبة الأبعاد)' : 'Size (aspect ratio)'}>
                <select className="inp" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                  <option value="">{isAr ? 'بدون' : 'None'}</option>
                  {ASSET_ASPECT_RATIOS.map((r) => (
                    <option key={r.value} value={r.value}>{isAr ? r.ar : r.en}</option>
                  ))}
                </select>
              </Field>
              <div>
                <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'وسوم للجميع' : 'Tags for all'}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {tags.map((t) => (
                    <button key={t} type="button" className="fbtn on" onClick={() => setTags(tags.filter((x) => x !== t))}>
                      {t} <span className="x">×</span>
                    </button>
                  ))}
                  <input
                    className="fbtn"
                    style={{ borderStyle: 'dashed', minWidth: 74, outline: 'none' }}
                    placeholder={isAr ? '+ وسم' : '+ tag'}
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onBlur={addTag}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                  />
                </div>
              </div>
              <div
                style={{
                  background: 'var(--sand-2)', border: '1px solid var(--line)', borderRadius: 8,
                  padding: '11px 12px', fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.8,
                }}
              >
                <b>{isAr ? 'النوع يُكتشف ولا يُسأل عنه.' : 'Kind is detected, not asked.'}</b>{' '}
                {isAr
                  ? 'الصور والفيديو والصوت والمستندات تُفرز تلقائيًا، وأنت تصحح ما يخطئ فيه فقط.'
                  : 'Photos, video, audio and documents sort themselves; you correct only what it gets wrong.'}
              </div>
            </div>
          </div>

          {/* ── the drop zone + queue ────────────────────────────────── */}
          <div style={{ minWidth: 0 }}>
            <div
              className="drop"
              style={{
                marginBottom: 14,
                padding: 22,
                cursor: 'pointer',
                borderColor: dragOver ? 'var(--copper)' : undefined,
                background: dragOver ? 'color-mix(in srgb, var(--copper) 6%, transparent)' : undefined,
              }}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                // Folders drop too — their names arrive as tags.
                void collectDropped(e.dataTransfer.items).then(addFiles).catch((err: unknown) => {
                  console.error('[marketing] drop traversal failed', err);
                  addToast(isAr ? 'تعذّرت قراءة المجلد المفلَت.' : 'Could not read the dropped folder.', 'error');
                });
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--copper)" style={{ width: 24, height: 24, strokeWidth: 1.5 }} aria-hidden>
                <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
              </svg>
              <div style={{ fontSize: 13.5, color: 'var(--ink)', fontWeight: 700, marginTop: 9 }}>
                {isAr ? 'أفلت الملفات هنا، أو اختر من الجهاز' : 'Drop files here, or choose from the device'}
              </div>
              <div style={{ fontSize: 11.5, marginTop: 4 }}>
                {isAr
                  ? <>أسماء المجلدات تتحول إلى وسوم تلقائيًا — <b className="ltr">Photos/Amenities</b> ← وسما الملفات بداخلها</>
                  : <>Folder names become tags automatically — <b className="ltr">Photos/Amenities</b> tags everything inside it</>}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 10 }}
                onClick={(e) => { e.stopPropagation(); folderRef.current?.click(); }}
              >
                {isAr ? 'أو اختر مجلدًا كاملًا' : 'Or pick a whole folder'}
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) {
                    addFiles(Array.from(e.target.files).map((file) => ({ file, folderTags: [] })));
                  }
                  e.target.value = '';
                }}
              />
              <input
                ref={folderRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                {...({ webkitdirectory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
                onChange={(e) => {
                  if (e.target.files) {
                    addFiles(Array.from(e.target.files).map((file) => ({
                      file,
                      folderTags: tagsFromPath(
                        (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name,
                      ),
                    })));
                  }
                  e.target.value = '';
                }}
              />
            </div>

            {rows.length > 0 && (
              <div className="card">
                <div className="card-h">
                  <h4>{running ? (isAr ? 'جارٍ الرفع' : 'Uploading') : (isAr ? 'جاهز للرفع' : 'Ready to upload')}</h4>
                  <span className="r">
                    {isAr
                      ? `${num(doneCount, true)} من ${num(rows.length, true)}`
                      : `${doneCount} of ${rows.length}`}
                  </span>
                </div>
                <div className="card-b" style={{ padding: '12px 16px' }}>
                  <div className="meter" style={{ height: 5, margin: '0 0 14px' }}>
                    <i style={{ width: `${rows.length > 0 ? (doneCount / rows.length) * 100 : 0}%`, background: 'var(--copper)' }} />
                  </div>

                  {rows.map((r) => (
                    <QueueRow
                      key={r.id}
                      row={r}
                      isAr={isAr}
                      running={running}
                      projects={projects}
                      shared={{ projectId, source, shotOn, rights, aspectRatio, tags }}
                      editing={editingId === r.id}
                      onToggleEdit={() => setEditingId((cur) => (cur === r.id ? null : r.id))}
                      onPatchOverride={(patch) => patchOverride(r.id, patch)}
                      onResetOverrides={() => resetOverrides(r.id)}
                      onSkip={() => patchRow(r.id, { status: 'skipped' })}
                      onKeepBoth={() => patchRow(r.id, { status: 'waiting', duplicateOf: null })}
                      onRetry={() => patchRow(r.id, { status: 'waiting', error: null })}
                      onRemove={() => removeRow(r.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {shootId && (
              <div
                style={{
                  marginTop: 13, background: 'var(--sand-2)', border: '1px solid var(--line)',
                  borderRadius: 9, padding: '12px 15px', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85,
                }}
              >
                <b>
                  {isAr ? 'لأن هذا الرفع مرتبط بطلب التصوير ' : 'Because this upload is linked to shoot request '}
                  <span className="ltr">{shoots.find((s) => s.id === shootId)?.ref ?? ''}</span>
                </b>
                {isAr
                  ? '، ستُعلَّم اللقطات التي كانت تنتظره كمُغطّاة عند اكتمال الرفع، وتنفكّ قائمة الاعتماد المعطّلة وحدها. لا أحد مضطر للانتباه والربط بينهما.'
                  : ', the shots waiting on it will be marked covered when the upload finishes, and the blocked approval checklist unblocks itself. Nobody has to notice and connect them.'}
              </div>
            )}

            {doneCount > 0 && !running && (
              <div style={{ marginTop: 13, display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => navigate('/m/library')}>
                  <IconLibrary />
                  {isAr ? 'فتح المكتبة' : 'Open the library'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function QueueRow({
  row, isAr, running, projects, shared, editing,
  onToggleEdit, onPatchOverride, onResetOverrides,
  onSkip, onKeepBoth, onRetry, onRemove,
}: {
  row: Row;
  isAr: boolean;
  running: boolean;
  projects: Array<{ id: string; project_name?: string | null }>;
  shared: { projectId: string; source: MosAsset['source']; shotOn: string; rights: string; aspectRatio: string; tags: string[] };
  editing: boolean;
  onToggleEdit: () => void;
  onPatchOverride: (patch: RowOverride) => void;
  onResetOverrides: () => void;
  onSkip: () => void;
  onKeepBoth: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const [tagDraft, setTagDraft] = useState('');
  const kind = kindFromFile(row.file);
  const kindLabel = isAr ? KIND_LABEL[kind]?.ar : KIND_LABEL[kind]?.en;

  const hasOverride = Object.keys(row.overrides).length > 0;
  // The value the file will actually be saved with, field by field: its own
  // override when set, else the shared «ينطبق على الجميع» value.
  const eff = {
    title: row.overrides.title ?? derivedTitle(row.file),
    kind: row.overrides.kind ?? kind,
    projectId: row.overrides.projectId ?? shared.projectId,
    source: row.overrides.source ?? shared.source,
    shotOn: row.overrides.shotOn ?? shared.shotOn,
    rights: row.overrides.rights ?? shared.rights,
    aspectRatio: row.overrides.aspectRatio ?? shared.aspectRatio,
    tags: row.overrides.tags ?? shared.tags,
  };
  const effKindLabel = isAr ? KIND_LABEL[eff.kind]?.ar : KIND_LABEL[eff.kind]?.en;

  const addTag = (): void => {
    const t = tagDraft.trim();
    if (t) onPatchOverride({ tags: Array.from(new Set([...eff.tags, t])) });
    setTagDraft('');
  };

  // The per-file editor is offered only before the file is uploaded.
  const canEditRow = !running
    && (row.status === 'waiting' || row.status === 'duplicate' || row.status === 'failed' || row.status === 'skipped');

  return (
    <div style={{ marginBottom: 6 }}>
      <div
        className="file"
        style={{
          marginBottom: editing ? 0 : undefined,
          borderBottomLeftRadius: editing ? 0 : undefined,
          borderBottomRightRadius: editing ? 0 : undefined,
          opacity: row.status === 'skipped' ? 0.45 : 1,
          borderColor:
            row.status === 'duplicate'
              ? 'color-mix(in srgb, var(--wait) 45%, transparent)'
              : row.status === 'failed'
                ? 'color-mix(in srgb, var(--late) 45%, transparent)'
                : editing
                  ? 'var(--copper)'
                  : undefined,
        }}
      >
        <div className="th">
          {row.previewUrl
            ? <img src={row.previewUrl} alt="" />
            : eff.kind === 'video'
              ? <IconVideo />
              : <IconLibrary />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="nm ltr" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {/* Show the per-file name when set, with the source filename after it. */}
            {row.overrides.title?.trim() ? row.overrides.title : row.file.name}
            {row.convertedName && <> → {row.convertedName}</>}
          </div>
          <div
            className="mt"
            style={row.status === 'duplicate' ? { color: 'var(--wait)' } : row.status === 'failed' ? { color: 'var(--late)' } : undefined}
          >
            {row.status === 'duplicate' && row.duplicateOf
              ? isAr
                ? <>تبدو مطابقة لـ <b>{row.duplicateOf}</b> الموجودة في المكتبة</>
                : <>Looks identical to <b>{row.duplicateOf}</b> already in the library</>
              : row.status === 'failed'
                ? row.error
                : (
                  <>
                    {editing || hasOverride ? effKindLabel : kindLabel} · {formatBytes(row.file.size, isAr)}
                    {row.convertedName && <> · {isAr ? 'حُوِّلت إلى JPEG' : 'converted to JPEG'}</>}
                    {row.conversionFailed && (
                      <span style={{ color: 'var(--wait)' }}>
                        {' · '}{isAr ? 'تعذّر التحويل — رُفع الأصل' : 'conversion failed — original uploaded'}
                      </span>
                    )}
                    {row.folderTags.length > 0 && <> · {row.folderTags.join(' · ')}</>}
                    {row.status === 'done' && row.assetRef && <> · <span className="ltr">{row.assetRef}</span></>}
                  </>
                )}
          </div>
          {row.status === 'uploading' && (
            <div className="meter" style={{ height: 4, marginTop: 6 }}>
              <i style={{ width: `${row.progress * 100}%`, background: 'var(--copper)' }} />
            </div>
          )}
        </div>
        <div className="rt">
          {hasOverride && row.status !== 'done' && (
            <span className="pill p-wait">{isAr ? 'مخصّص' : 'Custom'}</span>
          )}
          {row.status === 'done' && (
            <span className="pill p-go"><IconCheck style={{ width: 10, height: 10 }} /> {isAr ? 'تم' : 'Done'}</span>
          )}
          {row.status === 'uploading' && (
            <span className="pill p-now">{num(Math.round(row.progress * 100), isAr)}{isAr ? '٪' : '%'}</span>
          )}
          {row.status === 'converting' && (
            <span className="pill p-wait">{isAr ? 'تُحوَّل…' : 'Converting…'}</span>
          )}
          {row.status === 'waiting' && <span className="pill p-idle">{isAr ? 'انتظار' : 'Waiting'}</span>}
          {row.status === 'skipped' && <span className="pill p-idle">{isAr ? 'تُخطّي' : 'Skipped'}</span>}
          {row.status === 'duplicate' && (
            <>
              <button type="button" className="btn btn-sm" onClick={onSkip}>{isAr ? 'تخطٍ' : 'Skip'}</button>
              <button type="button" className="btn btn-sm" onClick={onKeepBoth}>
                {isAr ? 'احتفظ بالاثنتين' : 'Keep both'}
              </button>
            </>
          )}
          {row.status === 'failed' && (
            <button type="button" className="btn btn-sm" onClick={onRetry}>{isAr ? 'إعادة المحاولة' : 'Retry'}</button>
          )}
          {canEditRow && (
            <button
              type="button"
              className={`btn btn-sm${editing ? ' btn-p' : ''}`}
              onClick={onToggleEdit}
              aria-expanded={editing}
            >
              {editing ? (isAr ? 'إغلاق' : 'Close') : (isAr ? 'تعديل' : 'Edit')}
            </button>
          )}
          {(row.status === 'waiting' || row.status === 'skipped' || row.status === 'duplicate') && !running && (
            <button type="button" className="btn btn-d btn-sm" onClick={onRemove} aria-label={isAr ? 'إزالة' : 'Remove'}>
              <IconTrash />
            </button>
          )}
        </div>
      </div>

      {/* Per-file editor — overrides the shared panel for THIS file only. */}
      {editing && canEditRow && (
        <div
          style={{
            border: '1px solid var(--copper)',
            borderTop: 'none',
            borderBottomLeftRadius: 10,
            borderBottomRightRadius: 10,
            padding: '13px 14px',
            display: 'grid',
            gap: 12,
            background: 'color-mix(in srgb, var(--copper) 4%, transparent)',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.7 }}>
            {isAr
              ? 'ما تغيّره هنا يطبَّق على هذا الملف وحده. اترك الحقل كما هو ليأخذ قيمة اللوحة المشتركة.'
              : 'Anything you change here applies to this file only. Leave a field as-is to inherit the shared panel.'}
          </div>

          <Field label={isAr ? 'الاسم' : 'Name'}>
            <input
              className="inp ltr"
              value={eff.title}
              onChange={(e) => onPatchOverride({ title: e.target.value })}
              placeholder={derivedTitle(row.file)}
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label={isAr ? 'النوع' : 'Kind'}>
              <select
                className="inp"
                value={eff.kind}
                onChange={(e) => onPatchOverride({ kind: e.target.value as MosAsset['kind'] })}
              >
                {Object.keys(KIND_LABEL).map((k) => (
                  <option key={k} value={k}>{isAr ? KIND_LABEL[k]?.ar : KIND_LABEL[k]?.en}</option>
                ))}
              </select>
            </Field>
            <Field label={isAr ? 'المشروع' : 'Project'}>
              <select
                className="inp"
                value={eff.projectId}
                onChange={(e) => onPatchOverride({ projectId: e.target.value })}
              >
                <option value="">{isAr ? 'بدون' : 'None'}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
                ))}
              </select>
            </Field>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label={isAr ? 'المصدر' : 'Source'}>
              <select
                className="inp"
                value={eff.source}
                onChange={(e) => onPatchOverride({ source: e.target.value as MosAsset['source'] })}
              >
                {Object.keys(ASSET_SOURCE_LABELS).map((k) => (
                  <option key={k} value={k}>{isAr ? ASSET_SOURCE_LABELS[k]?.ar : ASSET_SOURCE_LABELS[k]?.en}</option>
                ))}
              </select>
            </Field>
            <Field label={isAr ? 'تاريخ التصوير' : 'Shot on'}>
              <input
                type="date"
                className="inp ltr"
                value={eff.shotOn}
                onChange={(e) => onPatchOverride({ shotOn: e.target.value })}
              />
            </Field>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label={isAr ? 'حقوق الاستخدام' : 'Usage rights'}>
              <select
                className="inp"
                value={eff.rights}
                onChange={(e) => onPatchOverride({ rights: e.target.value })}
              >
                {USAGE_RIGHTS.map((r) => (
                  <option key={r.key} value={r.key}>{isAr ? r.ar : r.en}</option>
                ))}
              </select>
            </Field>
            <Field label={isAr ? 'المقاس (نسبة الأبعاد)' : 'Size (aspect ratio)'}>
              <select
                className="inp"
                value={eff.aspectRatio}
                onChange={(e) => onPatchOverride({ aspectRatio: e.target.value })}
              >
                <option value="">{isAr ? 'بدون' : 'None'}</option>
                {ASSET_ASPECT_RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>{isAr ? r.ar : r.en}</option>
                ))}
              </select>
            </Field>
          </div>

          <div>
            <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'وسوم هذا الملف' : 'Tags for this file'}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {eff.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="fbtn on"
                  onClick={() => onPatchOverride({ tags: eff.tags.filter((x) => x !== t) })}
                >
                  {t} <span className="x">×</span>
                </button>
              ))}
              <input
                className="fbtn"
                style={{ borderStyle: 'dashed', minWidth: 74, outline: 'none' }}
                placeholder={isAr ? '+ وسم' : '+ tag'}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onBlur={addTag}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              />
            </div>
            {row.folderTags.length > 0 && (
              <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 6 }}>
                {isAr ? 'وسوم المجلد تُضاف تلقائيًا: ' : 'Folder tags are added automatically: '}
                <span className="ltr">{row.folderTags.join(' · ')}</span>
              </div>
            )}
          </div>

          {hasOverride && (
            <div>
              <button type="button" className="btn btn-d btn-sm" onClick={onResetOverrides}>
                {isAr ? 'إرجاع إلى المشترك' : 'Reset to shared'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

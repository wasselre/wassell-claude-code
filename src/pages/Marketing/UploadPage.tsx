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
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_SOURCE_LABELS, MosAsset, fetchAssets, saveAsset,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Field, PageHead } from './components/kit';
import {
  IconBack, IconCheck, IconForward, IconLibrary, IconTrash, IconVideo,
} from './components/icons';
import { num } from './lib/format';
import {
  formatBytes, isBrowserImage, kindFromFile, storagePath, uploadToStorage,
} from './lib/upload';

type RowStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'duplicate' | 'skipped';

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
}

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
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
    return () => abortRef.current?.abort();
  }, [addToast, isAr]);

  // Object URLs must be released or a 184-file batch leaks the whole card.
  useEffect(() => () => {
    rows.forEach((r) => { if (r.previewUrl) URL.revokeObjectURL(r.previewUrl); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.size > 0);
    if (list.length === 0) return;
    setRows((cur) => {
      const seen = new Set(cur.map((r) => `${r.file.name}|${r.file.size}`));
      const next = [...cur];
      for (const file of list) {
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
        });
      }
      return next;
    });
  }, [existing]);

  const patchRow = (id: string, patch: Partial<Row>): void =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));

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
    const assetId = uuid();
    const path = storagePath(assetId, row.file.name);
    patchRow(row.id, { status: 'uploading', progress: 0, error: null });
    try {
      const result = await uploadToStorage(
        row.file,
        path,
        (fraction) => patchRow(row.id, { progress: fraction }),
        signal,
      );
      const kind = kindFromFile(row.file);
      const title = row.file.name.replace(/\.[^.]+$/, '');
      const res = await saveAsset({
        title,
        kind,
        source,
        project_id: projectId || null,
        url: result.publicUrl,
        thumb_url: isBrowserImage(row.file) ? result.publicUrl : null,
        shot_on: shotOn || null,
        tags,
        file_path: result.path,
        mime_type: row.file.type || null,
        size_bytes: row.file.size,
        original_name: row.file.name,
        usage_rights: USAGE_RIGHTS.find((r) => r.key === rights)?.[isAr ? 'ar' : 'en'] ?? rights,
      });
      patchRow(row.id, { status: 'done', progress: 1, assetRef: res.asset.ref });
    } catch (e) {
      if (signal.aborted) {
        patchRow(row.id, { status: 'waiting', progress: 0 });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error('[marketing] upload failed', row.file.name, e);
      patchRow(row.id, { status: 'failed', error: message });
    }
  };

  const start = async (): Promise<void> => {
    if (uploadable.length === 0) return;
    setRunning(true);
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
            : `${rows.length} files selected · ${formatBytes(totalBytes, false)} · the panel applies to all`
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
        <div className="grid" style={{ gridTemplateColumns: '304px minmax(0,1fr)', alignItems: 'start' }}>
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
                addFiles(e.dataTransfer.files);
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
                  ? 'صور · فيديو · صوت · PDF · ملفات تصميم — يمكن تحديد المئات دفعة واحدة'
                  : 'Photos · video · audio · PDFs · design files — hundreds at once is the point'}
              </div>
              <input
                ref={inputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
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
                      onSkip={() => patchRow(r.id, { status: 'skipped' })}
                      onKeepBoth={() => patchRow(r.id, { status: 'waiting', duplicateOf: null })}
                      onRetry={() => patchRow(r.id, { status: 'waiting', error: null })}
                      onRemove={() => removeRow(r.id)}
                    />
                  ))}
                </div>
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
  row, isAr, running, onSkip, onKeepBoth, onRetry, onRemove,
}: {
  row: Row;
  isAr: boolean;
  running: boolean;
  onSkip: () => void;
  onKeepBoth: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const kind = kindFromFile(row.file);
  const kindLabel = isAr ? KIND_LABEL[kind]?.ar : KIND_LABEL[kind]?.en;

  return (
    <div
      className="file"
      style={{
        opacity: row.status === 'skipped' ? 0.45 : 1,
        borderColor:
          row.status === 'duplicate'
            ? 'color-mix(in srgb, var(--wait) 45%, transparent)'
            : row.status === 'failed'
              ? 'color-mix(in srgb, var(--late) 45%, transparent)'
              : undefined,
      }}
    >
      <div className="th">
        {row.previewUrl
          ? <img src={row.previewUrl} alt="" />
          : kind === 'video'
            ? <IconVideo />
            : <IconLibrary />}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm ltr" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.file.name}
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
                  {kindLabel} · {formatBytes(row.file.size, isAr)}
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
        {row.status === 'done' && (
          <span className="pill p-go"><IconCheck style={{ width: 10, height: 10 }} /> {isAr ? 'تم' : 'Done'}</span>
        )}
        {row.status === 'uploading' && (
          <span className="pill p-now">{num(Math.round(row.progress * 100), isAr)}{isAr ? '٪' : '%'}</span>
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
        {(row.status === 'waiting' || row.status === 'skipped' || row.status === 'duplicate') && !running && (
          <button type="button" className="btn btn-d btn-sm" onClick={onRemove} aria-label={isAr ? 'إزالة' : 'Remove'}>
            <IconTrash />
          </button>
        )}
      </div>
    </div>
  );
}

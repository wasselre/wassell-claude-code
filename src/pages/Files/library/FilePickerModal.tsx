/**
 * ONE file picker, used everywhere a file is selected or uploaded — so "pick a
 * file" looks and behaves identically no matter where you are (the reference
 * picker, attach-to-record, marketing materials…). It IS the Files library grid:
 * the same search, the same `LibraryFileTile` cards, the same thumbnails.
 *
 * Upload uses the SAME structure as the Files library: pick one or MANY files,
 * then the real PostUploadModal (AI analysis + all the metadata fields). It
 * REPLACES the picker while open — never a second popup stacked behind it — and
 * returns to the refreshed grid afterward so the new files can be picked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Loader2, Search, ShieldAlert, ShieldCheck, Upload, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import type { BusinessFileRow, FileDocumentTypeRow, FileRow, LibraryFilters } from '@/types';
import type { AspectFamily } from '@/types/files';
import { errorText, listDocumentTypes, rightsBadgeFor, searchBusinessFiles } from '@/lib/files/library';
import { signViewUrls, uploadFile } from '@/lib/files/client';
import { useAppStore } from '@/stores/appStore';
import LibraryFileTile from './LibraryFileTile';
import PostUploadModal from './PostUploadModal';

/** Additive scoping for the picker (Post Creative Director, 2026-09-02): a
 *  caller (e.g. the creative package's asset picker) narrows the grid to what
 *  is eligible for the slot it is filling. Single values or arrays — both are
 *  normalized into the RPC's array filters. `linked_record_id` scopes to the
 *  files of ONE record (e.g. the content's project). */
export interface FilePickerFilters {
  linked_record_id?: string;
  primary_category?: string | string[];
  asset_nature?: string | string[];
  usage_rights?: string | string[];
  aspect_family?: AspectFamily | AspectFamily[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen file (existing or just-uploaded). */
  onPick: (file: { id: string; title: string }) => void;
  title?: string;
  sub?: string;
  /** Stamp uploaded files to a record so they converge into its Files section. */
  uploadModelId?: string | null;
  uploadRecordId?: string | null;
  /** Extra search filters merged into every query (see FilePickerFilters). */
  filters?: FilePickerFilters;
  /** Show asset nature / source / rights + verified badges under each tile. */
  showMeta?: boolean;
}

const DEBOUNCE_MS = 300;

/** Bilingual labels for the meta chips — the picker does not load the vocab
 *  tables, so the known values are mapped locally (raw slug as fallback). */
const NATURE_LABELS: Record<string, [string, string]> = {
  real: ['أصلي', 'Real'],
  ai_generated: ['مُولّد AI', 'AI-generated'],
  ai_edited: ['مُعدّل AI', 'AI-edited'],
  cgi_render: ['CGI', 'CGI'],
  graphic_design: ['تصميم', 'Design'],
  screenshot: ['لقطة', 'Screenshot'],
};
const SOURCE_LABELS: Record<string, [string, string]> = {
  developer: ['المطوّر', 'Developer'],
  internal: ['فريقنا', 'Internal'],
  competitor: ['منافس', 'Competitor'],
  client: ['عميل', 'Client'],
  partner: ['شريك', 'Partner'],
  public: ['عام', 'Public'],
  unknown: ['غير معروف', 'Unknown'],
};

const RIGHTS_BADGE_CLASSES: Record<string, string> = {
  verified: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  unverified: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  blocked: 'bg-red-500/10 text-red-700 border-red-500/30',
  reference_only: 'bg-charcoal/5 text-charcoal/60 border-charcoal/20',
  ai_review: 'bg-purple-500/10 text-purple-700 border-purple-500/30',
};

/** Nature / source / rights chips for one tile (showMeta mode). */
function FileMetaBadges({ file, isAr }: { file: BusinessFileRow; isAr: boolean }) {
  const rights = rightsBadgeFor(file);
  const chips: string[] = [];
  if (file.asset_nature) chips.push(NATURE_LABELS[file.asset_nature]?.[isAr ? 0 : 1] ?? file.asset_nature);
  if (file.acquisition_source) chips.push(SOURCE_LABELS[file.acquisition_source]?.[isAr ? 0 : 1] ?? file.acquisition_source);
  return (
    <div className="flex flex-wrap items-center gap-1 px-0.5">
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-bold ${RIGHTS_BADGE_CLASSES[rights.badge] ?? RIGHTS_BADGE_CLASSES.unverified}`}
        title={isAr ? 'حقوق الاستخدام' : 'Usage rights'}
      >
        {rights.badge === 'verified' ? <ShieldCheck size={10} aria-hidden /> : rights.badge === 'blocked' ? <ShieldAlert size={10} aria-hidden /> : <BadgeCheck size={10} aria-hidden />}
        {isAr ? rights.label_ar : rights.label_en}
      </span>
      {chips.map((c) => (
        <span key={c} className="px-1.5 py-0.5 rounded-md bg-cream border border-sand/30 text-[10px] font-bold text-charcoal/60" dir="auto">
          {c}
        </span>
      ))}
    </div>
  );
}

export default function FilePickerModal({
  open, onClose, onPick, title, sub, uploadModelId = null, uploadRecordId = null,
  filters = undefined, showMeta = false,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');

  const [q, setQ] = useState('');
  const [rows, setRows] = useState<BusinessFileRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [types, setTypes] = useState<FileDocumentTypeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  /** Just-uploaded files — while set, the real Files PostUploadModal shows in
   *  place of the grid (AI + metadata), exactly like the Files library. */
  const [uploaded, setUploaded] = useState<FileRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    listDocumentTypes().then((r) => { if (alive) setTypes(r); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);

  // The caller-supplied scoping, normalized into the RPC's filter shape.
  const mergedFilters = useMemo<LibraryFilters>(() => {
    const arr = (v?: string | string[]): string[] | undefined =>
      v === undefined ? undefined : Array.isArray(v) ? v : [v];
    const out: LibraryFilters = {};
    if (filters?.linked_record_id) out.record_id = filters.linked_record_id;
    const pcat = arr(filters?.primary_category);
    if (pcat?.length) out.primary_category = pcat;
    const nature = arr(filters?.asset_nature);
    if (nature?.length) out.asset_nature = nature;
    const rights = arr(filters?.usage_rights);
    if (rights?.length) out.usage_rights = rights;
    const aspect = arr(filters?.aspect_family);
    if (aspect?.length) out.aspect_family = aspect as LibraryFilters['aspect_family'];
    return out;
  }, [filters]);
  const filtersKey = JSON.stringify(mergedFilters);

  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    const id = window.setTimeout(() => {
      searchBusinessFiles({ q, sort: 'created_desc', pageSize: 48, filters: mergedFilters })
        .then((r) => { if (my === seq.current) { setRows(r.rows ?? []); } })
        .catch((e) => { if (my === seq.current) setError(errorText(e)); })
        .finally(() => { if (my === seq.current) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // filtersKey is the stable serialization of mergedFilters (object identity
    // would re-fire the search on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, reloadKey, filtersKey]);

  // Batch-sign image thumbnails for the visible slice — same as the library page.
  useEffect(() => {
    const ids = rows.filter((r) => r.kind === 'image').map((r) => r.id);
    if (ids.length === 0) { setThumbs({}); return; }
    let alive = true;
    signViewUrls(ids).then((m) => { if (alive) setThumbs(m); }).catch(() => { if (alive) setThumbs({}); });
    return () => { alive = false; };
  }, [rows]);

  // Upload one or MANY files (same as the Files library), then hand off to the
  // real PostUploadModal for AI + metadata (it replaces the grid below).
  const onUpload = useCallback(async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    const rowsUp: FileRow[] = [];
    try {
      for (const f of files) {
        try { rowsUp.push(await uploadFile(f, { modelId: uploadModelId, recordId: uploadRecordId })); }
        catch (e) { setError(errorText(e)); }
      }
      if (rowsUp.length > 0) setUploaded(rowsUp);
    } finally {
      setUploading(false);
    }
  }, [uploadModelId, uploadRecordId]);

  const heading = title ?? t('files.picker.title');
  const subtitle = sub ?? t('files.picker.sub');
  const empty = useMemo(() => !loading && !error && rows.length === 0, [loading, error, rows.length]);

  if (!open) return null;

  // While files are being reviewed, show the EXACT Files-library post-upload
  // popup (AI analysis + metadata) in place of the picker — one modal, never
  // stacked. Afterward, return to the picker with the grid refreshed so the new
  // files are pickable; for a single-file upload, auto-pick it.
  if (uploaded.length > 0) {
    const finish = () => {
      const first = uploaded[0];
      const single = uploaded.length === 1;
      setUploaded([]);
      setReloadKey((k) => k + 1);
      if (single && first) { onPick({ id: first.id, title: first.original_name }); onClose(); }
    };
    return (
      <PostUploadModal
        files={uploaded}
        types={types}
        onDismiss={finish}
        onApplied={finish}
      />
    );
  }

  const field = 'w-full px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30';

  return (
    <Modal open={open} onClose={uploading ? () => {} : onClose} maxWidth="max-w-4xl">
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-charcoal">{heading}</h2>
            <p className="mt-0.5 text-xs text-charcoal/50">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} disabled={uploading} aria-label={t('common.close')}
                  className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream disabled:opacity-40">
            <X size={16} aria-hidden />
          </button>
        </div>

        <input ref={fileInput} type="file" multiple className="hidden"
               onChange={(e) => { void onUpload(e.target.files); e.currentTarget.value = ''; }} />
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none" aria-hidden />
            <input className={`${field} ps-9`} dir="auto" autoFocus value={q}
                   placeholder={t('files.picker.search')} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-copper text-white text-sm font-bold hover:bg-terracotta disabled:opacity-50 whitespace-nowrap">
            {uploading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Upload size={15} aria-hidden />}
            {t('files.picker.upload')}
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/25 text-xs text-red-700" role="alert">{error}</div>
        )}

        <div className="min-h-[16rem] max-h-[60vh] overflow-auto">
          {loading && rows.length === 0 ? (
            <div className="py-16 flex justify-center"><Loader2 size={26} className="animate-spin text-copper" aria-hidden /></div>
          ) : empty ? (
            <p className="py-16 text-center text-sm text-charcoal/45">{t('files.picker.empty')}</p>
          ) : (
            <div className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 ${loading ? 'opacity-60' : ''}`}>
              {rows.map((f) => (
                <div key={f.id} className="space-y-1">
                  <LibraryFileTile
                    file={f}
                    types={types}
                    thumbUrl={thumbs[f.id] ?? null}
                    active={false}
                    selected={false}
                    selectionActive={false}
                    onOpen={(picked) => { onPick({ id: picked.id, title: picked.title || picked.original_name }); onClose(); }}
                    onToggle={() => {}}
                  />
                  {showMeta && <FileMetaBadges file={f} isAr={isAr} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

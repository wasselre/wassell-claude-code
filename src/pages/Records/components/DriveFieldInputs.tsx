import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileIcon,
  ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  Upload as UploadIcon,
  X,
} from 'lucide-react';
import { signViewUrl } from '@/lib/files/client';
import { kindAccent, kindIcon } from '@/lib/files/format';
import FilePreviewModal from '@/pages/Files/components/FilePreviewModal';
import DriveBrowserModal, {
  type DrivePickerResult,
} from '@/pages/Files/components/DriveBrowserModal';
import type { FileRow } from '@/types';
import { useFileRowMap, updateFileRowCache } from './useFileRowMap';
import { LegacyImagePreview } from './DriveCells';

/** Legacy public-URL value (pre-Files-system data, still written by the
 *  marketing/image flows) — render directly instead of treating it as a
 *  files.id. Mirrors the shim in DriveCells. */
function isLegacyUrlValue(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Tiny thumbnail loader for image files. Hits /api/files/sign-view-url so
 *  the URL is bound to the caller's identity (RLS-gated) and short-lived. */
function useSignedImageUrl(fileId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!fileId) {
      setUrl(null);
      return;
    }
    // Legacy public URL — already a fetchable src; the sign endpoint would
    // reject it (expects a files.id UUID).
    if (isLegacyUrlValue(fileId)) {
      setUrl(fileId);
      return;
    }
    let cancelled = false;
    void signViewUrl(fileId)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);
  return url;
}

/* ────────────────────────────────────────────────────────────────────────
 * Common UI bits
 * ──────────────────────────────────────────────────────────────────────── */

function ImageThumb({ fileId, onClick }: { fileId: string; onClick: () => void }) {
  const url = useSignedImageUrl(fileId);
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-24 h-24 rounded-xl overflow-hidden border border-sand/40 bg-cream/40 hover:opacity-80 transition-opacity cursor-zoom-in"
    >
      {url ? (
        <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-charcoal/30">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}
    </button>
  );
}

function FileChip({
  row,
  onClick,
  onRemove,
  removeAriaLabel,
}: {
  row: FileRow;
  onClick: () => void;
  onRemove: () => void;
  removeAriaLabel: string;
}) {
  const Icon = kindIcon[row.kind];
  const accent = kindAccent[row.kind];
  return (
    <div className={`inline-flex items-center gap-2 pe-1.5 ps-2 py-1.5 rounded-lg border border-sand/40 bg-white max-w-[260px] group`}>
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 min-w-0 flex-1 text-start"
        title={row.original_name}
      >
        <span className={`w-7 h-7 rounded-md flex items-center justify-center ${accent.bg} shrink-0`}>
          <Icon size={14} className={accent.fg} />
        </span>
        <span className="text-xs font-bold text-charcoal truncate">{row.original_name}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeAriaLabel}
        className="p-1 rounded-md text-charcoal/40 hover:text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function MissingChip({ id, onRemove, label }: { id: string; onRemove: () => void; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 pe-1.5 ps-2 py-1.5 rounded-lg border border-dashed border-red-200 bg-red-50/40 group" title={id}>
      <span className="text-[11px] text-red-500/80 italic">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="p-1 rounded-md text-red-400 hover:text-red-600 transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * IMAGE — single (legacy `image` field type)
 * ──────────────────────────────────────────────────────────────────────── */

interface SingleProps {
  value: string;
  onChange: (next: string) => void;
  isAr: boolean;
  acceptMime?: string;
  maxSizeMb?: number;
  defaultFolderId?: string | null;
  modelId?: string | null;
  recordId?: string | null;
}

export function ImageFieldInput({
  value,
  onChange,
  isAr,
  acceptMime = 'image/*',
  maxSizeMb = 25,
  defaultFolderId = null,
  modelId = null,
  recordId = null,
}: SingleProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // A legacy public-URL value renders as a plain image (and previews via the
  // legacy lightbox); it has no files row, so keep it out of useFileRowMap and
  // the missing-ref branch. Replace/Remove still work — Replace writes a
  // proper files.id.
  const isLegacy = !!value && isLegacyUrlValue(value);
  const { rows, missing } = useFileRowMap(value && !isLegacy ? [value] : []);
  const row = value ? rows.get(value) ?? null : null;
  const isMissing = value && !isLegacy && missing.includes(value);

  const handlePicked = (result: DrivePickerResult) => {
    if (result.kind !== 'files') return;
    const first = result.files[0];
    if (first) onChange(first.id);
  };

  if (!value) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="form-input flex items-center justify-center gap-2 hover:bg-cream/40 hover:border-copper/40 text-charcoal/60 border-dashed cursor-pointer transition-colors"
        >
          <ImageIcon size={16} />
          <span className="text-sm">{t('fields.attachment.add_from_drive')}</span>
        </button>
        <DriveBrowserModal
          open={pickerOpen}
          mode="pick-files"
          acceptMime={acceptMime}
          maxSizeMb={maxSizeMb}
          initialFolderId={defaultFolderId}
          attachToModelId={modelId}
          attachToRecordId={recordId}
          onClose={() => setPickerOpen(false)}
          onSelect={handlePicked}
        />
      </>
    );
  }

  return (
    <div className="flex items-start gap-3">
      {isMissing ? (
        <MissingChip id={value} onRemove={() => onChange('')} label={t('fields.attachment.missing_ref')} />
      ) : (
        <ImageThumb fileId={value} onClick={() => setPreviewOpen(true)} />
      )}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs font-bold text-copper hover:text-terracotta transition-colors"
        >
          {isAr ? 'تغيير' : 'Replace'}
        </button>
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-xs font-bold text-charcoal/50 hover:text-red-500 transition-colors"
        >
          {isAr ? 'إزالة' : 'Remove'}
        </button>
      </div>
      <DriveBrowserModal
        open={pickerOpen}
        mode="pick-files"
        acceptMime={acceptMime}
        maxSizeMb={maxSizeMb}
        initialFolderId={defaultFolderId}
        attachToModelId={modelId}
        attachToRecordId={recordId}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePicked}
      />
      {isLegacy && previewOpen ? (
        <LegacyImagePreview url={value} onClose={() => setPreviewOpen(false)} />
      ) : (
        <FilePreviewModal
          file={row}
          open={previewOpen && !!row}
          canEdit={false}
          canDelete={false}
          onClose={() => setPreviewOpen(false)}
          onShare={() => {}}
          onPermissions={() => {}}
          onDelete={() => {}}
          onRenamed={updateFileRowCache}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MULTI IMAGE — `multi_image` field
 * ──────────────────────────────────────────────────────────────────────── */

interface MultiProps {
  value: string[];
  onChange: (next: string[]) => void;
  isAr: boolean;
  acceptMime?: string;
  maxSizeMb?: number;
  maxItems?: number;
  defaultFolderId?: string | null;
  modelId?: string | null;
  recordId?: string | null;
}

export function MultiImageFieldInput({
  value,
  onChange,
  acceptMime = 'image/*',
  maxSizeMb = 25,
  maxItems,
  defaultFolderId = null,
  modelId = null,
  recordId = null,
}: MultiProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  // Entries may mix files.id UUIDs with legacy public URLs — only the former
  // have rows to resolve; legacy ones render directly + preview via the
  // legacy lightbox.
  const [legacyPreviewUrl, setLegacyPreviewUrl] = useState<string | null>(null);
  const { rows, missing } = useFileRowMap(value.filter((v) => !isLegacyUrlValue(v)));

  const handlePicked = (result: DrivePickerResult) => {
    if (result.kind !== 'files') return;
    const ids = result.files.map((f) => f.id);
    const merged = [...value];
    for (const id of ids) if (!merged.includes(id)) merged.push(id);
    onChange(maxItems ? merged.slice(0, maxItems) : merged);
  };

  const handleRemove = (id: string) => onChange(value.filter((v) => v !== id));

  const atCap = !!maxItems && value.length >= maxItems;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        {value.map((id) => {
          const legacy = isLegacyUrlValue(id);
          if (!legacy && missing.includes(id)) {
            return (
              <MissingChip
                key={id}
                id={id}
                onRemove={() => handleRemove(id)}
                label={t('fields.attachment.missing_ref')}
              />
            );
          }
          return (
            <div key={id} className="relative group">
              <ImageThumb
                fileId={id}
                onClick={() =>
                  legacy ? setLegacyPreviewUrl(id) : setPreviewFile(rows.get(id) ?? null)
                }
              />
              <button
                type="button"
                onClick={() => handleRemove(id)}
                aria-label={t('fields.attachment.remove')}
                className="absolute -top-1.5 -end-1.5 p-1 rounded-full bg-white border border-sand/40 text-charcoal/50 hover:text-red-500 hover:border-red-200 transition-colors opacity-0 group-hover:opacity-100 shadow-sm"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        {!atCap && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="w-24 h-24 rounded-xl border border-dashed border-sand/60 flex flex-col items-center justify-center gap-1 text-charcoal/40 hover:text-copper hover:border-copper/40 hover:bg-copper/5 transition-colors"
          >
            <Plus size={20} />
            <span className="text-[10px] font-bold">{t('fields.attachment.add_from_drive')}</span>
          </button>
        )}
      </div>
      <DriveBrowserModal
        open={pickerOpen}
        mode="pick-files"
        acceptMime={acceptMime}
        maxSizeMb={maxSizeMb}
        initialFolderId={defaultFolderId}
        attachToModelId={modelId}
        attachToRecordId={recordId}
        initialSelectedFileIds={value}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePicked}
      />
      <FilePreviewModal
        file={previewFile}
        open={!!previewFile}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreviewFile(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
        onRenamed={(updated) => {
          updateFileRowCache(updated);
          setPreviewFile(updated);
        }}
      />
      {legacyPreviewUrl && (
        <LegacyImagePreview url={legacyPreviewUrl} onClose={() => setLegacyPreviewUrl(null)} />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * FILE — single (`file` field)
 * ──────────────────────────────────────────────────────────────────────── */

export function FileFieldInput({
  value,
  onChange,
  isAr,
  acceptMime,
  maxSizeMb = 500,
  defaultFolderId = null,
  modelId = null,
  recordId = null,
}: SingleProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { rows, missing } = useFileRowMap(value ? [value] : []);
  const row = value ? rows.get(value) ?? null : null;
  const isMissing = value && missing.includes(value);

  const handlePicked = (result: DrivePickerResult) => {
    if (result.kind !== 'files') return;
    const first = result.files[0];
    if (first) onChange(first.id);
  };

  if (!value) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="form-input flex items-center justify-center gap-2 hover:bg-cream/40 hover:border-copper/40 text-charcoal/60 border-dashed cursor-pointer transition-colors"
        >
          <UploadIcon size={16} />
          <span className="text-sm">{t('fields.attachment.add_from_drive')}</span>
        </button>
        <DriveBrowserModal
          open={pickerOpen}
          mode="pick-files"
          acceptMime={acceptMime}
          maxSizeMb={maxSizeMb}
          initialFolderId={defaultFolderId}
          attachToModelId={modelId}
          attachToRecordId={recordId}
          onClose={() => setPickerOpen(false)}
          onSelect={handlePicked}
        />
      </>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {isMissing ? (
        <MissingChip id={value} onRemove={() => onChange('')} label={t('fields.attachment.missing_ref')} />
      ) : row ? (
        <FileChip
          row={row}
          onClick={() => setPreviewOpen(true)}
          onRemove={() => onChange('')}
          removeAriaLabel={t('fields.attachment.remove')}
        />
      ) : (
        <span className="text-xs text-charcoal/40 inline-flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" /> …
        </span>
      )}
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="text-xs font-bold text-copper hover:text-terracotta transition-colors"
      >
        {isAr ? 'تغيير' : 'Replace'}
      </button>
      <DriveBrowserModal
        open={pickerOpen}
        mode="pick-files"
        acceptMime={acceptMime}
        maxSizeMb={maxSizeMb}
        initialFolderId={defaultFolderId}
        attachToModelId={modelId}
        attachToRecordId={recordId}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePicked}
      />
      <FilePreviewModal
        file={row}
        open={previewOpen && !!row}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreviewOpen(false)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
        onRenamed={updateFileRowCache}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MULTI FILE — `multi_file` field
 * ──────────────────────────────────────────────────────────────────────── */

export function MultiFileFieldInput({
  value,
  onChange,
  acceptMime,
  maxSizeMb = 500,
  maxItems,
  defaultFolderId = null,
  modelId = null,
  recordId = null,
}: MultiProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const { rows, missing } = useFileRowMap(value);

  const handlePicked = (result: DrivePickerResult) => {
    if (result.kind !== 'files') return;
    const ids = result.files.map((f) => f.id);
    const merged = [...value];
    for (const id of ids) if (!merged.includes(id)) merged.push(id);
    onChange(maxItems ? merged.slice(0, maxItems) : merged);
  };

  const handleRemove = (id: string) => onChange(value.filter((v) => v !== id));

  const atCap = !!maxItems && value.length >= maxItems;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {value.map((id) => {
          if (missing.includes(id)) {
            return (
              <MissingChip
                key={id}
                id={id}
                onRemove={() => handleRemove(id)}
                label={t('fields.attachment.missing_ref')}
              />
            );
          }
          const row = rows.get(id);
          if (!row) {
            return (
              <div key={id} className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-charcoal/40">
                <Loader2 size={12} className="animate-spin" />…
              </div>
            );
          }
          return (
            <FileChip
              key={id}
              row={row}
              onClick={() => setPreviewFile(row)}
              onRemove={() => handleRemove(id)}
              removeAriaLabel={t('fields.attachment.remove')}
            />
          );
        })}
        {!atCap && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-sand/60 text-charcoal/60 hover:text-copper hover:border-copper/40 hover:bg-copper/5 transition-colors text-xs font-bold"
          >
            <Plus size={14} />
            {t('fields.attachment.add_from_drive')}
          </button>
        )}
      </div>
      <DriveBrowserModal
        open={pickerOpen}
        mode="pick-files"
        acceptMime={acceptMime}
        maxSizeMb={maxSizeMb}
        initialFolderId={defaultFolderId}
        attachToModelId={modelId}
        attachToRecordId={recordId}
        initialSelectedFileIds={value}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePicked}
      />
      <FilePreviewModal
        file={previewFile}
        open={!!previewFile}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreviewFile(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
        onRenamed={(updated) => {
          updateFileRowCache(updated);
          setPreviewFile(updated);
        }}
      />
    </div>
  );
}

/* Re-export icons used elsewhere — keeps imports tidy. */
export { FileIcon, Paperclip };

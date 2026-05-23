import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderIcon, Loader2, Plus, X } from 'lucide-react';
import { getFolder } from '@/lib/files/client';
import { kindAccent, kindIcon } from '@/lib/files/format';
import FilePreviewModal from '@/pages/Files/components/FilePreviewModal';
import DriveBrowserModal, {
  type DrivePickerResult,
} from '@/pages/Files/components/DriveBrowserModal';
import type { AttachmentRef, FileRow, FolderRow } from '@/types';
import { useFileRowMap } from './useFileRowMap';

interface Props {
  value: AttachmentRef[];
  onChange: (next: AttachmentRef[]) => void;
  /** Carried through from the form for parity with the other Drive inputs.
   *  Reserved for future locale-conditional copy (chip-level menus, etc.). */
  isAr?: boolean;
  defaultFolderId?: string | null;
  maxItems?: number;
  modelId?: string | null;
  recordId?: string | null;
}

/**
 * `attachment` field input. The field's stored value is an array of
 * AttachmentRef objects — each either a file reference or a folder
 * reference inside the user's Drive (the /files page).
 *
 * The user can:
 *   - browse and pick existing files / folders (DriveBrowserModal multi-pick)
 *   - upload a brand-new file from inside the picker (auto-selected on add)
 *   - create a brand-new folder from inside the picker (auto-selected on add)
 *   - click any file chip   → opens the FilePreviewModal
 *   - click any folder chip → re-opens the picker scoped to that folder
 *
 * Storage shape is `AttachmentRef[]`, deduped on (type, id). Persisting
 * the order is intentional — the user can reorder by removing + re-adding.
 */
export default function AttachmentFieldInput({
  value,
  onChange,
  defaultFolderId = null,
  maxItems,
  modelId = null,
  recordId = null,
}: Props) {
  const { t } = useTranslation();

  const fileIds = useMemo(() => value.filter((r) => r.type === 'file').map((r) => r.id), [value]);
  const folderIds = useMemo(
    () => value.filter((r) => r.type === 'folder').map((r) => r.id),
    [value],
  );

  const { rows: fileRows, missing: missingFiles } = useFileRowMap(fileIds);
  const { rows: folderRows, missing: missingFolders } = useFolderRowMap(folderIds);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStartFolderId, setPickerStartFolderId] = useState<string | null>(defaultFolderId);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);

  const handleAdd = (result: DrivePickerResult) => {
    if (result.kind !== 'mixed') return;
    // Dedup on (type, id). Preserve existing order, append new picks at the end.
    const seen = new Set(value.map((r) => `${r.type}::${r.id}`));
    const next: AttachmentRef[] = [...value];
    for (const ref of result.refs) {
      const key = `${ref.type}::${ref.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        next.push(ref);
      }
    }
    onChange(maxItems ? next.slice(0, maxItems) : next);
  };

  const handleRemove = (ref: AttachmentRef) => {
    onChange(value.filter((r) => !(r.type === ref.type && r.id === ref.id)));
  };

  const handleFolderClick = (folderId: string) => {
    setPickerStartFolderId(folderId);
    setPickerOpen(true);
  };

  const handleOpenPicker = () => {
    setPickerStartFolderId(defaultFolderId);
    setPickerOpen(true);
  };

  const atCap = !!maxItems && value.length >= maxItems;

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && (
        <p className="text-xs text-charcoal/40 italic">{t('fields.attachment.no_items')}</p>
      )}
      {value.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {value.map((ref) => {
            const key = `${ref.type}::${ref.id}`;
            if (ref.type === 'file') {
              if (missingFiles.includes(ref.id)) {
                return (
                  <MissingChip
                    key={key}
                    onRemove={() => handleRemove(ref)}
                    label={t('fields.attachment.missing_ref')}
                  />
                );
              }
              const row = fileRows.get(ref.id);
              if (!row) return <LoadingChip key={key} />;
              return (
                <FileRefChip
                  key={key}
                  row={row}
                  onClick={() => setPreviewFile(row)}
                  onRemove={() => handleRemove(ref)}
                  removeAriaLabel={t('fields.attachment.remove')}
                />
              );
            }
            // folder ref
            if (missingFolders.includes(ref.id)) {
              return (
                <MissingChip
                  key={key}
                  onRemove={() => handleRemove(ref)}
                  label={t('fields.attachment.missing_ref')}
                />
              );
            }
            const folder = folderRows.get(ref.id);
            if (!folder) return <LoadingChip key={key} />;
            return (
              <FolderRefChip
                key={key}
                folder={folder}
                onClick={() => handleFolderClick(folder.id)}
                onRemove={() => handleRemove(ref)}
                removeAriaLabel={t('fields.attachment.remove')}
              />
            );
          })}
          {!atCap && (
            <button
              type="button"
              onClick={handleOpenPicker}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-sand/60 text-charcoal/60 hover:text-copper hover:border-copper/40 hover:bg-copper/5 transition-colors text-xs font-bold"
            >
              <Plus size={14} />
              {t('fields.attachment.add_from_drive')}
            </button>
          )}
        </div>
      )}
      {value.length === 0 && (
        <button
          type="button"
          onClick={handleOpenPicker}
          className="form-input flex items-center justify-center gap-2 hover:bg-cream/40 hover:border-copper/40 text-charcoal/60 border-dashed cursor-pointer transition-colors"
        >
          <Plus size={16} />
          <span className="text-sm">{t('fields.attachment.add_from_drive')}</span>
        </button>
      )}

      <DriveBrowserModal
        open={pickerOpen}
        mode="pick-files-and-folders"
        initialFolderId={pickerStartFolderId}
        initialSelectedFileIds={fileIds}
        initialSelectedFolderIds={folderIds}
        attachToModelId={modelId}
        attachToRecordId={recordId}
        onClose={() => setPickerOpen(false)}
        onSelect={handleAdd}
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
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function FileRefChip({
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
    <div className="inline-flex items-center gap-2 pe-1.5 ps-2 py-1.5 rounded-lg border border-sand/40 bg-white max-w-[280px] group">
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

function FolderRefChip({
  folder,
  onClick,
  onRemove,
  removeAriaLabel,
}: {
  folder: FolderRow;
  onClick: () => void;
  onRemove: () => void;
  removeAriaLabel: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 pe-1.5 ps-2 py-1.5 rounded-lg border border-copper/30 bg-copper/5 max-w-[280px] group">
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 min-w-0 flex-1 text-start"
        title={folder.name}
      >
        <span className="w-7 h-7 rounded-md flex items-center justify-center bg-copper/10 shrink-0">
          <FolderIcon size={14} className="text-copper" />
        </span>
        <span className="text-xs font-bold text-charcoal truncate">{folder.name}</span>
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

function MissingChip({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 pe-1.5 ps-2 py-1.5 rounded-lg border border-dashed border-red-200 bg-red-50/40 group">
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

function LoadingChip() {
  return (
    <div className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-charcoal/40">
      <Loader2 size={12} className="animate-spin" />…
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Folder loader (mirrors useFileRowMap for folder rows)
 * ──────────────────────────────────────────────────────────────────────── */

const folderRowCache = new Map<string, FolderRow>();
const folderRowInflight = new Map<string, Promise<FolderRow | null>>();

async function loadFolderRow(id: string): Promise<FolderRow | null> {
  const cached = folderRowCache.get(id);
  if (cached) return cached;
  const pending = folderRowInflight.get(id);
  if (pending) return pending;
  const p = getFolder(id)
    .then((row) => {
      if (row) folderRowCache.set(id, row);
      return row;
    })
    .finally(() => {
      folderRowInflight.delete(id);
    });
  folderRowInflight.set(id, p);
  return p;
}

function useFolderRowMap(ids: readonly string[]): {
  rows: Map<string, FolderRow>;
  missing: string[];
} {
  const [rows, setRows] = useState<Map<string, FolderRow>>(() => {
    const m = new Map<string, FolderRow>();
    for (const id of ids) {
      const cached = folderRowCache.get(id);
      if (cached) m.set(id, cached);
    }
    return m;
  });
  const [missing, setMissing] = useState<string[]>([]);
  const key = useMemo(() => ids.join('|'), [ids]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(ids.map((id) => loadFolderRow(id))).then((results) => {
      if (cancelled) return;
      const next = new Map<string, FolderRow>();
      const miss: string[] = [];
      results.forEach((row, idx) => {
        const id = ids[idx]!;
        if (row) next.set(id, row);
        else miss.push(id);
      });
      setRows(next);
      setMissing(miss);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { rows, missing };
}

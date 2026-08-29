/**
 * Compact table-cell renderers for the Drive-backed field types
 * (image, multi_image, file, multi_file, attachment). They share the
 * `useFileRowMap` cache with the form-level inputs so revisiting a page
 * doesn't refetch file metadata.
 *
 * Click semantics:
 *   - image cell  → opens FilePreviewModal at the image
 *   - file chip   → opens FilePreviewModal at the file
 *   - folder chip → opens DriveBrowserModal scoped to that folder
 *     (or, in the compact cell, just shows the folder name and the
 *     user is expected to drill in via the record form)
 *
 * Cells are designed to be terse — at most one chip + an overflow
 * "+N" badge. The full list is visible in the record form.
 */
import { useEffect, useState } from 'react';
import { FolderIcon, Loader2 } from 'lucide-react';
import { getFolder } from '@/lib/files/client';
import { useSignedViewUrl } from '@/lib/files/signedViewUrlBatch';
import { kindAccent, kindIcon } from '@/lib/files/format';
import FilePreviewModal from '@/pages/Files/components/FilePreviewModal';
import type { AttachmentRef, FileRow, FolderRow } from '@/types';
import { useFileRowMap, updateFileRowCache } from './useFileRowMap';

/* ────────────────────────────────────────────────────────────────────────
 * IMAGE CELL — `image` type
 * ──────────────────────────────────────────────────────────────────────── */

export function ImageCell({ fileId, isAr }: { fileId: string; isAr: boolean }) {
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const { rows, missing } = useFileRowMap([fileId]);
  const row = rows.get(fileId);

  // Backwards compat: a few seed-model fields may carry a legacy public URL
  // string from the pre-Files-system era. Render those as a plain <img>.
  if (/^https?:\/\//i.test(fileId)) {
    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setPreviewFile({
              id: 'legacy',
              folder_id: null,
              model_id: null,
              record_id: null,
              uploaded_by_user_id: '',
              original_name: 'image',
              mime_type: 'image/png',
              size_bytes: 0,
              storage_bucket: '',
              storage_path: '',
              kind: 'image',
              preview_status: null,
              preview_storage_path: null,
              preview_error: null,
              preview_generated_at: null,
              // Synthesised from a legacy record value, not a stored row:
              // there is no object behind it, so there is no digest.
              content_etag: null,
              created_at: '',
              updated_at: '',
            });
          }}
          className="block cursor-zoom-in"
        >
          <img
            src={fileId}
            alt=""
            className="block w-10 h-10 rounded object-cover border border-sand/30 bg-cream/40 hover:opacity-80 transition-opacity"
            loading="lazy"
          />
        </button>
        {previewFile && (
          <LegacyImagePreview url={fileId} onClose={() => setPreviewFile(null)} />
        )}
      </>
    );
  }

  if (missing.includes(fileId)) {
    return <span className="text-charcoal/30 italic text-xs">—</span>;
  }
  if (!row) return <Loader2 size={14} className="animate-spin text-charcoal/30" />;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPreviewFile(row);
        }}
        className="block cursor-zoom-in"
        aria-label={isAr ? 'فتح الصورة' : 'Open image'}
      >
        <SignedThumb fileId={fileId} />
      </button>
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
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MULTI IMAGE CELL — `multi_image` type
 * ──────────────────────────────────────────────────────────────────────── */

export function MultiImageCell({ fileIds, isAr }: { fileIds: string[]; isAr: boolean }) {
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const { rows } = useFileRowMap(fileIds);
  if (fileIds.length === 0) {
    return <span className="text-charcoal/30 italic text-xs">—</span>;
  }
  const first = fileIds[0]!;
  const extra = fileIds.length - 1;

  // Same legacy-URL shim as ImageCell so old data still previews.
  const isLegacy = /^https?:\/\//i.test(first);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (isLegacy) {
            // No row for legacy URLs — handled by LegacyImagePreview below.
            setPreviewFile({
              id: 'legacy',
              folder_id: null,
              model_id: null,
              record_id: null,
              uploaded_by_user_id: '',
              original_name: 'image',
              mime_type: 'image/png',
              size_bytes: 0,
              storage_bucket: '',
              storage_path: '',
              kind: 'image',
              preview_status: null,
              preview_storage_path: null,
              preview_error: null,
              preview_generated_at: null,
              // Synthesised from a legacy record value, not a stored row:
              // there is no object behind it, so there is no digest.
              content_etag: null,
              created_at: '',
              updated_at: '',
            });
          } else {
            const row = rows.get(first);
            if (row) setPreviewFile(row);
          }
        }}
        className="relative inline-block cursor-zoom-in"
        aria-label={isAr ? 'فتح الصور' : 'Open images'}
      >
        {isLegacy ? (
          <img
            src={first}
            alt=""
            className="block w-10 h-10 rounded object-cover border border-sand/30 bg-cream/40"
            loading="lazy"
          />
        ) : (
          <SignedThumb fileId={first} />
        )}
        {extra > 0 && (
          <span className="absolute -top-1 -end-1 text-[10px] font-bold bg-copper text-white rounded-full px-1.5 py-0.5">
            +{extra}
          </span>
        )}
      </button>
      {previewFile?.id === 'legacy' ? (
        <LegacyImagePreview url={first} onClose={() => setPreviewFile(null)} />
      ) : (
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
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * FILE CELL — `file` type (single, non-image)
 * ──────────────────────────────────────────────────────────────────────── */

export function FileCell({ fileId, isAr: _isAr }: { fileId: string; isAr: boolean }) {
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const { rows, missing } = useFileRowMap([fileId]);
  if (missing.includes(fileId)) return <span className="text-charcoal/30 italic text-xs">—</span>;
  const row = rows.get(fileId);
  if (!row) return <Loader2 size={14} className="animate-spin text-charcoal/30" />;
  const Icon = kindIcon[row.kind];
  const accent = kindAccent[row.kind];
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPreviewFile(row);
        }}
        className="inline-flex items-center gap-1.5 max-w-[180px]"
        title={row.original_name}
      >
        <span className={`w-6 h-6 rounded-md flex items-center justify-center ${accent.bg} shrink-0`}>
          <Icon size={12} className={accent.fg} />
        </span>
        <span className="text-xs font-bold text-charcoal truncate">{row.original_name}</span>
      </button>
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
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MULTI FILE CELL — `multi_file` type
 * ──────────────────────────────────────────────────────────────────────── */

export function MultiFileCell({ fileIds, isAr }: { fileIds: string[]; isAr: boolean }) {
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const { rows, missing } = useFileRowMap(fileIds);
  if (fileIds.length === 0) return <span className="text-charcoal/30 italic text-xs">—</span>;
  const firstId = fileIds[0]!;
  const extra = fileIds.length - 1;
  if (missing.includes(firstId)) {
    return (
      <span className="text-xs text-charcoal/40">
        {fileIds.length} {isAr ? 'ملف' : 'file' + (fileIds.length === 1 ? '' : 's')}
      </span>
    );
  }
  const row = rows.get(firstId);
  if (!row) return <Loader2 size={14} className="animate-spin text-charcoal/30" />;
  const Icon = kindIcon[row.kind];
  const accent = kindAccent[row.kind];
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPreviewFile(row);
        }}
        className="inline-flex items-center gap-1.5 max-w-[200px]"
        title={row.original_name}
      >
        <span className={`w-6 h-6 rounded-md flex items-center justify-center ${accent.bg} shrink-0`}>
          <Icon size={12} className={accent.fg} />
        </span>
        <span className="text-xs font-bold text-charcoal truncate">{row.original_name}</span>
        {extra > 0 && (
          <span className="text-[10px] font-bold bg-copper text-white rounded-full px-1.5 py-0.5">
            +{extra}
          </span>
        )}
      </button>
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
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * ATTACHMENT CELL — `attachment` type (files + folders mixed)
 * ──────────────────────────────────────────────────────────────────────── */

export function AttachmentCell({ refs }: { refs: AttachmentRef[]; isAr?: boolean }) {
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const fileIds = refs.filter((r) => r.type === 'file').map((r) => r.id);
  const { rows: fileRows } = useFileRowMap(fileIds);
  const [folderRow, setFolderRow] = useState<FolderRow | null>(null);

  // Resolve the first folder (if first ref is a folder) — only one fetch
  // because we just need a label for the cell.
  useEffect(() => {
    if (refs.length === 0) {
      setFolderRow(null);
      return;
    }
    const first = refs[0]!;
    if (first.type !== 'folder') {
      setFolderRow(null);
      return;
    }
    let cancelled = false;
    void getFolder(first.id).then((row) => {
      if (!cancelled) setFolderRow(row);
    });
    return () => {
      cancelled = true;
    };
  }, [refs]);

  if (refs.length === 0) return <span className="text-charcoal/30 italic text-xs">—</span>;
  const first = refs[0]!;
  const extra = refs.length - 1;

  if (first.type === 'folder') {
    return (
      <span className="inline-flex items-center gap-1.5 max-w-[200px]" title={folderRow?.name ?? ''}>
        <span className="w-6 h-6 rounded-md flex items-center justify-center bg-copper/10 shrink-0">
          <FolderIcon size={12} className="text-copper" />
        </span>
        <span className="text-xs font-bold text-charcoal truncate">
          {folderRow?.name ?? <Loader2 size={10} className="animate-spin inline" />}
        </span>
        {extra > 0 && (
          <span className="text-[10px] font-bold bg-copper text-white rounded-full px-1.5 py-0.5">
            +{extra}
          </span>
        )}
      </span>
    );
  }

  const row = fileRows.get(first.id);
  if (!row) return <Loader2 size={14} className="animate-spin text-charcoal/30" />;
  const Icon = kindIcon[row.kind];
  const accent = kindAccent[row.kind];
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPreviewFile(row);
        }}
        className="inline-flex items-center gap-1.5 max-w-[200px]"
        title={row.original_name}
      >
        <span className={`w-6 h-6 rounded-md flex items-center justify-center ${accent.bg} shrink-0`}>
          <Icon size={12} className={accent.fg} />
        </span>
        <span className="text-xs font-bold text-charcoal truncate">{row.original_name}</span>
        {extra > 0 && (
          <span className="text-[10px] font-bold bg-copper text-white rounded-full px-1.5 py-0.5">
            +{extra}
          </span>
        )}
      </button>
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
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

function SignedThumb({ fileId }: { fileId: string }) {
  // Batched + TTL-cached signer: every thumbnail on screen coalesces into ONE
  // signViewUrls request instead of one round-trip per cell, and a remount
  // reuses the cache. Legacy raw-URL values are returned verbatim by the hook.
  // (2026-08 perf audit, B4.)
  const url = useSignedViewUrl(fileId);
  if (!url) {
    return (
      <div className="w-10 h-10 rounded border border-sand/30 bg-cream/40 flex items-center justify-center">
        <Loader2 size={12} className="animate-spin text-charcoal/30" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="block w-10 h-10 rounded object-cover border border-sand/30 bg-cream/40 hover:opacity-80 transition-opacity"
      loading="lazy"
    />
  );
}

/** Backwards-compat lightbox for legacy public URLs (pre-Files-system data).
 *  Reuses the simple ImagePreview lightbox shape so the user sees the same UX.
 *  Exported for the form-level inputs (DriveFieldInputs) which need the same
 *  shim when a record's image field holds a raw URL instead of a files.id. */
export function LegacyImagePreview({ url, onClose }: { url: string; onClose: () => void }) {
  // Lazy-load to avoid pulling the ImagePreview component into the main bundle.
  const [Comp, setComp] = useState<React.ComponentType<{
    url: string;
    onClose: () => void;
  }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('@/components/ui/ImagePreview').then((m) => {
      if (!cancelled) setComp(() => m.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!Comp) return null;
  return <Comp url={url} onClose={onClose} />;
}

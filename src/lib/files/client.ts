/**
 * Browser-side helpers for the Files System.
 *
 * Upload flow: browser uploads directly to the `wassel-files` Storage bucket
 * (bucket RLS gates writes to `<auth.uid()>/*`), then we insert the metadata
 * row into `public.files` so RLS can find it. If the INSERT fails after the
 * upload succeeded, we best-effort delete the orphan from storage and surface
 * the failure via toast — never silent (see CLAUDE.md "Silent Failures").
 *
 * Reads (list / sign / share / permissions): the SPA queries Supabase tables
 * directly under the user's JWT. The corresponding RLS policies + the
 * `wassell_can_access_file` / `wassell_can_access_folder` RPCs do the gating.
 * Signed-URL minting and the public /share/:token endpoints live in api/.
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import type {
  FileRow,
  FilePermission,
  FilePermissionRole,
  FilePreviewKind,
  FolderPermission,
  FolderRow,
  SharedFileResponse,
  SharedLink,
} from '@/types';

export const FILES_BUCKET = 'wassel-files';
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

// ─── Mime helpers ───────────────────────────────────────────────────────

/** Map a MIME type to a preview kind. The migration's CHECK constraint
 *  mirrors this set — keep them in sync. */
export function kindFromMime(mime: string): FilePreviewKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (
    m === 'application/zip' ||
    m === 'application/x-7z-compressed' ||
    m === 'application/x-rar-compressed' ||
    m === 'application/gzip'
  ) {
    return 'archive';
  }
  if (
    m === 'application/msword' ||
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    m === 'application/vnd.ms-excel' ||
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    m === 'application/vnd.ms-powerpoint' ||
    m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    m.startsWith('text/')
  ) {
    return 'document';
  }
  return 'other';
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/gzip': 'gz',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
};

function extFromMime(mime: string): string | null {
  return MIME_TO_EXT[(mime || '').toLowerCase()] ?? null;
}

function extFromName(name: string): string | null {
  const ix = name.lastIndexOf('.');
  if (ix < 0 || ix === name.length - 1) return null;
  const candidate = name.slice(ix + 1).toLowerCase();
  // Constrain to a-z0-9 so we never write a weird ext to disk.
  return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : null;
}

// ─── Error surfacing helper ─────────────────────────────────────────────

function surfaceError(scope: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[files] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — toast queue not ready. Console.error above is still loud.
  }
  return new Error(msg);
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Upload ─────────────────────────────────────────────────────────────

export interface UploadOpts {
  folderId?: string | null;
  modelId?: string | null;
  recordId?: string | null;
}

/**
 * Upload a single file. Two-phase: storage upload then DB insert. If the
 * DB insert fails, we best-effort delete the orphan storage object so we
 * don't accumulate garbage. The orphan-cleanup is the only narrow documented
 * silence — see CLAUDE.md "Silent Failures".
 */
export async function uploadFile(file: File, opts: UploadOpts = {}): Promise<FileRow> {
  if (!supabase) throw surfaceError('upload', new Error('Supabase not configured'));
  if (file.size > MAX_FILE_BYTES) {
    throw surfaceError(
      'upload',
      new Error(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
      ),
    );
  }
  const { data: session } = await supabase.auth.getSession();
  const authUid = session.session?.user?.id;
  if (!authUid) throw surfaceError('upload', new Error('Not signed in'));

  const fileId = crypto.randomUUID();
  const ext = extFromMime(file.type) || extFromName(file.name) || 'bin';
  const storagePath = `${authUid}/${fileId}.${ext}`;
  const kind = kindFromMime(file.type);

  const { error: upErr } = await supabase.storage.from(FILES_BUCKET).upload(storagePath, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) throw surfaceError('upload', upErr);

  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) {
    // Orphan cleanup — narrow documented silence.
    void supabase.storage.from(FILES_BUCKET).remove([storagePath]);
    throw surfaceError('upload', new Error('No current app user — cannot insert files row'));
  }

  const { data: row, error: insErr } = await supabase
    .from('files')
    .insert({
      id: fileId,
      folder_id: opts.folderId ?? null,
      model_id: opts.modelId ?? null,
      record_id: opts.recordId ?? null,
      uploaded_by_user_id: appUserId,
      original_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      storage_bucket: FILES_BUCKET,
      storage_path: storagePath,
      kind,
    })
    .select('*')
    .single();

  if (insErr || !row) {
    void supabase.storage.from(FILES_BUCKET).remove([storagePath]);
    throw surfaceError('upload', insErr ?? new Error('insert returned no row'));
  }

  void logFileActivity({
    event_type: 'upload',
    summary_ar: `رفع ملف: ${file.name}`,
    summary_en: `Uploaded file: ${file.name}`,
    details: {
      file_id: fileId,
      folder_id: opts.folderId ?? null,
      model_id: opts.modelId ?? null,
      record_id: opts.recordId ?? null,
      size_bytes: file.size,
      mime_type: file.type,
    },
  });

  return row as FileRow;
}

// ─── Folder-tree upload ─────────────────────────────────────────────────
// Two input shapes:
//   1. Drag-drop of directories — DataTransferItemList.webkitGetAsEntry()
//      gives a FileSystemEntry tree we walk recursively.
//   2. <input type="file" webkitdirectory> — gives a flat File[] where each
//      File has webkitRelativePath like "Contracts/2024/draft.pdf".
// Both are normalized into UploadItem[] then materialized as folders+files.

export interface UploadItem {
  file: File;
  /** Directory path segments above the file, e.g. ['Contracts','2024'] for
   *  'Contracts/2024/draft.pdf'. Empty array = root of the picked tree. */
  pathSegments: string[];
}

interface ParsedTree {
  items: UploadItem[];
  /** Every folder path encountered (relative, slash-joined), including
   *  empty directories so we still create them. */
  folderPaths: Set<string>;
}

/** Walk webkitGetAsEntry() results from a DataTransfer.items list. */
export async function readDataTransferTree(items: DataTransferItemList): Promise<ParsedTree> {
  const folderPaths = new Set<string>();
  const out: UploadItem[] = [];

  const walk = async (entry: FileSystemEntry, parentSegs: string[]): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      out.push({ file, pathSegments: parentSegs });
    } else if (entry.isDirectory) {
      const myPath = [...parentSegs, entry.name];
      folderPaths.add(myPath.join('/'));
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries() returns batches — call until empty.
      const children: FileSystemEntry[] = [];
      while (true) {
        const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        children.push(...batch);
      }
      for (const child of children) {
        await walk(child, myPath);
      }
    }
  };

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntry | null;
    }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    await walk(entry, []);
  }
  return { items: out, folderPaths };
}

/** Parse a flat File[] from <input webkitdirectory>. */
export function readWebkitDirectoryFiles(files: FileList | File[]): ParsedTree {
  const arr = Array.from(files);
  const folderPaths = new Set<string>();
  const items: UploadItem[] = [];

  for (const f of arr) {
    // webkitRelativePath looks like "Contracts/2024/draft.pdf" or just "name.pdf".
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const segs = rel.split('/').filter(Boolean);
    if (segs.length <= 1) {
      // No directory prefix → upload at the root of the picker.
      items.push({ file: f, pathSegments: [] });
    } else {
      const parent = segs.slice(0, -1);
      items.push({ file: f, pathSegments: parent });
      // Record every ancestor directory so empty mid-folders still appear.
      for (let i = 1; i <= parent.length; i++) {
        folderPaths.add(parent.slice(0, i).join('/'));
      }
    }
  }
  return { items, folderPaths };
}

interface TreeProgress {
  total: number;
  done: number;
  failed: number;
  currentFile?: string;
}

/**
 * Materialize a parsed tree under `rootParentFolderId`:
 *   1. Create every folder along each path (parents before children).
 *   2. Upload each file into its resolved folder.
 *
 * Failures on individual files don't abort the whole tree — the caller
 * gets a TreeResult with both successes and failures.
 */
export async function uploadTree(
  tree: ParsedTree,
  rootParentFolderId: string | null,
  onProgress?: (p: TreeProgress) => void,
): Promise<{
  uploadedFiles: FileRow[];
  createdFolders: FolderRow[];
  failures: Array<{ path: string; error: string }>;
}> {
  const uploadedFiles: FileRow[] = [];
  const createdFolders: FolderRow[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  // Collect every folder path we need — from explicit folderPaths AND from
  // any item's parent chain (defensive).
  const allFolderPaths = new Set<string>(tree.folderPaths);
  for (const item of tree.items) {
    for (let i = 1; i <= item.pathSegments.length; i++) {
      allFolderPaths.add(item.pathSegments.slice(0, i).join('/'));
    }
  }
  const sortedPaths = Array.from(allFolderPaths).sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );

  // Map "Contracts/2024" → folder_id. The empty-string key resolves to the
  // root parent so children of a root-level dropped file land correctly.
  const pathToFolderId = new Map<string, string | null>();
  pathToFolderId.set('', rootParentFolderId);

  for (const path of sortedPaths) {
    const segs = path.split('/');
    const name = segs[segs.length - 1] ?? '';
    const parentPath = segs.slice(0, -1).join('/');
    const parentId = pathToFolderId.get(parentPath) ?? rootParentFolderId;
    try {
      const folder = await createFolder(name, parentId);
      pathToFolderId.set(path, folder.id);
      createdFolders.push(folder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ path, error: msg });
      // Leave path unmapped — children files will land in the nearest mapped
      // ancestor (or root). Better than silently dropping them.
    }
  }

  let done = 0;
  let failed = 0;
  const total = tree.items.length;

  for (const item of tree.items) {
    const dirPath = item.pathSegments.join('/');
    // Walk up until we find a mapped ancestor (or hit root).
    let probe = dirPath;
    let folderId: string | null = rootParentFolderId;
    while (probe.length > 0) {
      const hit = pathToFolderId.get(probe);
      if (hit !== undefined) {
        folderId = hit;
        break;
      }
      const segs = probe.split('/');
      probe = segs.slice(0, -1).join('/');
    }

    onProgress?.({ total, done, failed, currentFile: item.file.name });

    try {
      const row = await uploadFile(item.file, { folderId: folderId ?? null });
      uploadedFiles.push(row);
      done += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fullPath = dirPath ? `${dirPath}/${item.file.name}` : item.file.name;
      failures.push({ path: fullPath, error: msg });
      failed += 1;
    }
    onProgress?.({ total, done, failed, currentFile: item.file.name });
  }

  return { uploadedFiles, createdFolders, failures };
}

// ─── Listing ─────────────────────────────────────────────────────────────

export async function listFolders(parentFolderId: string | null): Promise<FolderRow[]> {
  if (!supabase) return [];
  const query = supabase.from('folders').select('*').order('name');
  const { data, error } =
    parentFolderId === null
      ? await query.is('parent_folder_id', null)
      : await query.eq('parent_folder_id', parentFolderId);
  if (error) throw surfaceError('list folders', error);
  return (data ?? []) as FolderRow[];
}

export async function listFiles(folderId: string | null): Promise<FileRow[]> {
  if (!supabase) return [];
  const query = supabase.from('files').select('*').order('created_at', { ascending: false });
  const { data, error } =
    folderId === null ? await query.is('folder_id', null) : await query.eq('folder_id', folderId);
  if (error) throw surfaceError('list files', error);
  return (data ?? []) as FileRow[];
}

export async function listFilesForRecord(modelId: string, recordId: string): Promise<FileRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('model_id', modelId)
    .eq('record_id', recordId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('list record files', error);
  return (data ?? []) as FileRow[];
}

/**
 * Return only the *top-level* items shared with the caller — folders/files I
 * can see but didn't upload/create, AND whose parent is either NULL or a
 * folder I cannot see. That gives a clean root-of-shared-tree view; once the
 * user navigates in, RLS handles the rest.
 */
export async function listSharedWithMe(): Promise<{ folders: FolderRow[]; files: FileRow[] }> {
  if (!supabase) return { folders: [], files: [] };
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) return { folders: [], files: [] };

  // Pull everything visible to me — RLS already filters to grant-visible rows.
  const [foldersRes, filesRes] = await Promise.all([
    supabase.from('folders').select('*').order('name'),
    supabase.from('files').select('*').order('created_at', { ascending: false }),
  ]);
  if (foldersRes.error) throw surfaceError('shared folders', foldersRes.error);
  if (filesRes.error) throw surfaceError('shared files', filesRes.error);

  const allFolders = (foldersRes.data ?? []) as FolderRow[];
  const allFiles = (filesRes.data ?? []) as FileRow[];
  const visibleFolderIds = new Set(allFolders.map((f) => f.id));

  // Top-level shared folder = visible AND not created by me AND parent is null
  //   OR parent is not in the visible set (i.e., I can't see the parent).
  const sharedFolders = allFolders.filter(
    (f) =>
      f.created_by_user_id !== appUserId &&
      (f.parent_folder_id === null || !visibleFolderIds.has(f.parent_folder_id)),
  );

  // Top-level shared file = visible AND not uploaded by me AND parent folder
  //   is null OR not in the visible set.
  const sharedFiles = allFiles.filter(
    (f) =>
      f.uploaded_by_user_id !== appUserId &&
      (f.folder_id === null || !visibleFolderIds.has(f.folder_id)),
  );

  return { folders: sharedFolders, files: sharedFiles };
}

export async function getFolder(folderId: string): Promise<FolderRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('folders').select('*').eq('id', folderId).maybeSingle();
  if (error) throw surfaceError('get folder', error);
  return (data as FolderRow) ?? null;
}

export async function getFile(fileId: string): Promise<FileRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('files').select('*').eq('id', fileId).maybeSingle();
  if (error) throw surfaceError('get file', error);
  return (data as FileRow) ?? null;
}

// ─── Folder CRUD (direct via RLS) ───────────────────────────────────────

export async function createFolder(name: string, parentFolderId: string | null): Promise<FolderRow> {
  if (!supabase) throw surfaceError('create folder', new Error('Supabase not configured'));
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) throw surfaceError('create folder', new Error('Not signed in'));
  const trimmed = name.trim();
  if (!trimmed) throw surfaceError('create folder', new Error('Folder name is required'));

  const { data, error } = await supabase
    .from('folders')
    .insert({
      name: trimmed,
      parent_folder_id: parentFolderId,
      created_by_user_id: appUserId,
    })
    .select('*')
    .single();
  if (error || !data) throw surfaceError('create folder', error ?? new Error('insert returned no row'));

  void logFileActivity({
    event_type: 'folder_create',
    summary_ar: `إنشاء مجلد: ${trimmed}`,
    summary_en: `Created folder: ${trimmed}`,
    details: { folder_id: (data as FolderRow).id, parent_folder_id: parentFolderId },
  });
  return data as FolderRow;
}

export async function renameFolder(folderId: string, name: string): Promise<FolderRow> {
  if (!supabase) throw surfaceError('rename folder', new Error('Supabase not configured'));
  const trimmed = name.trim();
  if (!trimmed) throw surfaceError('rename folder', new Error('Folder name is required'));
  const { data, error } = await supabase
    .from('folders')
    .update({ name: trimmed })
    .eq('id', folderId)
    .select('*')
    .single();
  if (error || !data) throw surfaceError('rename folder', error ?? new Error('update returned no row'));
  return data as FolderRow;
}

export async function deleteFolder(folderId: string): Promise<void> {
  if (!supabase) throw surfaceError('delete folder', new Error('Supabase not configured'));
  // Refuse delete if non-empty — the FK on folders.parent_folder_id is RESTRICT
  // so PG would error anyway, but a clearer toast helps.
  const [{ count: subCount }, { count: fileCount }] = await Promise.all([
    supabase.from('folders').select('id', { count: 'exact', head: true }).eq('parent_folder_id', folderId),
    supabase.from('files').select('id', { count: 'exact', head: true }).eq('folder_id', folderId),
  ]);
  if ((subCount ?? 0) > 0 || (fileCount ?? 0) > 0) {
    throw surfaceError('delete folder', new Error('Folder is not empty'));
  }
  const { error } = await supabase.from('folders').delete().eq('id', folderId);
  if (error) throw surfaceError('delete folder', error);

  void logFileActivity({
    event_type: 'folder_delete',
    summary_ar: 'حذف مجلد',
    summary_en: 'Deleted folder',
    details: { folder_id: folderId },
  });
}

// ─── File operations ────────────────────────────────────────────────────

export async function moveFile(fileId: string, newFolderId: string | null): Promise<void> {
  if (!supabase) throw surfaceError('move file', new Error('Supabase not configured'));
  const { error } = await supabase.from('files').update({ folder_id: newFolderId }).eq('id', fileId);
  if (error) throw surfaceError('move file', error);

  void logFileActivity({
    event_type: 'move',
    summary_ar: 'نقل ملف',
    summary_en: 'Moved file',
    details: { file_id: fileId, folder_id: newFolderId },
  });
}

export async function renameFile(fileId: string, newName: string): Promise<FileRow> {
  if (!supabase) throw surfaceError('rename file', new Error('Supabase not configured'));
  const trimmed = newName.trim();
  if (!trimmed) throw surfaceError('rename file', new Error('Name is required'));
  const { data, error } = await supabase
    .from('files')
    .update({ original_name: trimmed })
    .eq('id', fileId)
    .select('*')
    .single();
  if (error || !data) throw surfaceError('rename file', error ?? new Error('update returned no row'));
  return data as FileRow;
}

export async function deleteFile(fileId: string): Promise<void> {
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fileId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw surfaceError('delete file', new Error(body.error ?? `HTTP ${res.status}`));
  }
}

export async function signViewUrl(
  fileId: string,
): Promise<{ url: string; original_name: string; mime_type: string }> {
  const res = await fetch('/api/files/sign-view-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fileId }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    original_name?: string;
    mime_type?: string;
    error?: string;
  };
  if (!res.ok || !body.url) {
    throw surfaceError('sign view url', new Error(body.error ?? `HTTP ${res.status}`));
  }
  return {
    url: body.url,
    original_name: body.original_name ?? '',
    mime_type: body.mime_type ?? '',
  };
}

export async function signDownloadUrl(fileId: string): Promise<{ url: string }> {
  const res = await fetch('/api/files/sign-download-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fileId }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) {
    throw surfaceError('sign download url', new Error(body.error ?? `HTTP ${res.status}`));
  }
  return { url: body.url };
}

// ─── Sharing (public links) ─────────────────────────────────────────────

export interface CreateShareLinkOpts {
  fileId: string;
  expiresAt?: string | null;
  password?: string | null;
  allowDownload?: boolean;
}

export async function createShareLink(opts: CreateShareLinkOpts): Promise<{ token: string; url: string }> {
  const res = await fetch('/api/share-links/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      fileId: opts.fileId,
      expiresAt: opts.expiresAt ?? null,
      password: opts.password ?? null,
      allowDownload: opts.allowDownload !== false,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; url?: string; error?: string };
  if (!res.ok || !body.token || !body.url) {
    throw surfaceError('create share link', new Error(body.error ?? `HTTP ${res.status}`));
  }
  return { token: body.token, url: body.url };
}

export async function revokeShareLink(linkId: string): Promise<void> {
  const res = await fetch('/api/share-links/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ linkId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw surfaceError('revoke share link', new Error(body.error ?? `HTTP ${res.status}`));
  }
}

export async function listShareLinks(fileId: string): Promise<SharedLink[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('shared_links')
    .select('*')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('list share links', error);
  return (data ?? []) as SharedLink[];
}

// ─── Permissions ────────────────────────────────────────────────────────

export interface GrantFilePermissionOpts {
  fileId: string;
  userId: string;
  role: FilePermissionRole;
}

export async function grantFilePermission(opts: GrantFilePermissionOpts): Promise<FilePermission> {
  if (!supabase) throw surfaceError('grant file permission', new Error('Supabase not configured'));
  const granter = useAppStore.getState().currentUserId;
  if (!granter) throw surfaceError('grant file permission', new Error('Not signed in'));
  const { data, error } = await supabase
    .from('file_permissions')
    .upsert(
      {
        file_id: opts.fileId,
        user_id: opts.userId,
        role: opts.role,
        granted_by_user_id: granter,
      },
      { onConflict: 'file_id,user_id' },
    )
    .select('*')
    .single();
  if (error || !data) throw surfaceError('grant file permission', error ?? new Error('no row'));
  void logFileActivity({
    event_type: 'permission_grant',
    summary_ar: 'منح صلاحية ملف',
    summary_en: 'Granted file permission',
    details: { file_id: opts.fileId, target_user_id: opts.userId, role: opts.role },
  });
  return data as FilePermission;
}

export async function revokeFilePermission(fileId: string, userId: string): Promise<void> {
  if (!supabase) throw surfaceError('revoke file permission', new Error('Supabase not configured'));
  const { error } = await supabase
    .from('file_permissions')
    .delete()
    .eq('file_id', fileId)
    .eq('user_id', userId);
  if (error) throw surfaceError('revoke file permission', error);
  void logFileActivity({
    event_type: 'permission_revoke',
    summary_ar: 'إلغاء صلاحية ملف',
    summary_en: 'Revoked file permission',
    details: { file_id: fileId, target_user_id: userId },
  });
}

export async function listFilePermissions(fileId: string): Promise<FilePermission[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file_permissions')
    .select('*')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('list file permissions', error);
  return (data ?? []) as FilePermission[];
}

export interface GrantFolderPermissionOpts {
  folderId: string;
  userId: string;
  role: FilePermissionRole;
}

export async function grantFolderPermission(opts: GrantFolderPermissionOpts): Promise<FolderPermission> {
  if (!supabase) throw surfaceError('grant folder permission', new Error('Supabase not configured'));
  const granter = useAppStore.getState().currentUserId;
  if (!granter) throw surfaceError('grant folder permission', new Error('Not signed in'));
  const { data, error } = await supabase
    .from('folder_permissions')
    .upsert(
      {
        folder_id: opts.folderId,
        user_id: opts.userId,
        role: opts.role,
        granted_by_user_id: granter,
      },
      { onConflict: 'folder_id,user_id' },
    )
    .select('*')
    .single();
  if (error || !data) throw surfaceError('grant folder permission', error ?? new Error('no row'));
  void logFileActivity({
    event_type: 'permission_grant',
    summary_ar: 'منح صلاحية مجلد',
    summary_en: 'Granted folder permission',
    details: { folder_id: opts.folderId, target_user_id: opts.userId, role: opts.role },
  });
  return data as FolderPermission;
}

export async function revokeFolderPermission(folderId: string, userId: string): Promise<void> {
  if (!supabase) throw surfaceError('revoke folder permission', new Error('Supabase not configured'));
  const { error } = await supabase
    .from('folder_permissions')
    .delete()
    .eq('folder_id', folderId)
    .eq('user_id', userId);
  if (error) throw surfaceError('revoke folder permission', error);
  void logFileActivity({
    event_type: 'permission_revoke',
    summary_ar: 'إلغاء صلاحية مجلد',
    summary_en: 'Revoked folder permission',
    details: { folder_id: folderId, target_user_id: userId },
  });
}

export async function listFolderPermissions(folderId: string): Promise<FolderPermission[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('folder_permissions')
    .select('*')
    .eq('folder_id', folderId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('list folder permissions', error);
  return (data ?? []) as FolderPermission[];
}

// ─── Public share endpoints (anon) ──────────────────────────────────────

export async function fetchSharedFile(token: string, password?: string): Promise<SharedFileResponse> {
  const res = await fetch('/api/share/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: password ?? null }),
  });
  const body = (await res.json().catch(() => ({}))) as SharedFileResponse & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body as SharedFileResponse;
}

export async function fetchSharedFileDownload(token: string, password?: string): Promise<{ url: string }> {
  const res = await fetch('/api/share/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: password ?? null }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return { url: body.url };
}

// ─── Effective role (client-side cascade lookup) ────────────────────────

/**
 * Compute the caller's effective role for a file. Mirrors the SQL helper
 * `wassell_can_access_file` so the UI can pre-disable actions without a
 * round-trip. Authoritative gating still happens server-side via RLS.
 * Returns the strongest role: own > direct > cascade.
 */
export function effectiveFileRole(
  file: FileRow,
  myAppUserId: string | null,
  filePerms: FilePermission[],
  cascadeRoleForFolder: (folderId: string) => FilePermissionRole | null,
): FilePermissionRole | null {
  if (!myAppUserId) return null;
  if (file.uploaded_by_user_id === myAppUserId) return 'owner';
  const direct = filePerms.find((p) => p.file_id === file.id && p.user_id === myAppUserId);
  if (direct) return direct.role;
  if (file.folder_id) {
    const c = cascadeRoleForFolder(file.folder_id);
    if (c) return c;
  }
  return null;
}

export function roleSatisfies(role: FilePermissionRole | null, kind: 'view' | 'edit' | 'delete'): boolean {
  if (!role) return false;
  if (kind === 'view') return true; // any role can view
  if (kind === 'edit') return role === 'editor' || role === 'owner';
  return role === 'owner';
}

// ─── Activity logging shim ──────────────────────────────────────────────

interface FileLogInput {
  event_type: string;
  summary_ar: string;
  summary_en: string;
  details?: Record<string, unknown>;
}

function logFileActivity(input: FileLogInput): void {
  try {
    const s = useAppStore.getState();
    const user = s.users.find((u) => u.id === s.currentUserId);
    s.appendActivityLog({
      category: 'file',
      event_type: input.event_type,
      actor_user_id: s.currentUserId ?? null,
      actor_email: user?.email ?? s.authEmail ?? null,
      target_model_id: null,
      target_record_id: null,
      target_label: null,
      summary_ar: input.summary_ar,
      summary_en: input.summary_en,
      details: input.details ?? {},
      duration_ms: null,
      status: 'info',
      error: null,
      workflow_run_id: null,
    });
  } catch (err) {
    // Activity log write is fire-and-forget; failures must NEVER block the
    // user action. Console-only is acceptable here (audit-trail gap, not data loss).
    console.error('[files] activity log failed:', err);
  }
}

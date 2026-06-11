/**
 * Types for the Files System (Google Drive-style file library inside Wassell CRM).
 * See docs/prd/files.md.
 */

export type FilePreviewKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'document'
  /** Native Wassel rich-text document (Google-Docs-style). Stored in
   *  public.wassel_documents — never has a Storage object. */
  | 'wassel_doc'
  | 'archive'
  | 'other';
export type FilePermissionRole = 'viewer' | 'editor' | 'owner';

export interface FolderRow {
  id: string;
  parent_folder_id: string | null;
  name: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  folder_id: string | null;
  /** Optional record attachment — file → record (model + record id). */
  model_id: string | null;
  /** Soft pointer; may reference a frozen-model row outside `records`. */
  record_id: string | null;
  uploaded_by_user_id: string;
  /** Display name, user-facing. Never used in the storage path. */
  original_name: string;
  mime_type: string;
  size_bytes: number;
  storage_bucket: string;
  /** Server-generated path: `<auth.uid()>/<file_id>.<safe_ext>`. */
  storage_path: string;
  kind: FilePreviewKind;
  /** Office-preview conversion cache (LibreOffice→PDF on the Fly worker).
   *  Null = never requested. See docs/prd/files.md "Office document preview". */
  preview_status: 'pending' | 'ready' | 'failed' | null;
  preview_storage_path: string | null;
  preview_error: string | null;
  preview_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Response of POST /api/files/office-preview — the SPA polls this while
 *  status='pending'. */
export interface OfficePreviewResponse {
  status: 'ready' | 'pending' | 'failed';
  /** Signed URL of the converted PDF. Present only when status='ready'. */
  url?: string;
  expires_at?: string;
  error?: string;
}

/** Response of POST /api/files/compress-pdf — the SPA polls this while
 *  status='pending'. 'none' = no compression job ever ran for the file. */
export interface PdfCompressResponse {
  status: 'none' | 'pending' | 'done' | 'failed';
  /** Id of the compressed COPY (a new files row). Null when no_gain. */
  result_file_id?: string | null;
  /** True when the PDF was already optimized and no copy was created. */
  no_gain?: boolean;
  original_bytes?: number | null;
  compressed_bytes?: number | null;
  error?: string;
}

export interface FilePermission {
  id: string;
  file_id: string;
  user_id: string;
  role: FilePermissionRole;
  granted_by_user_id: string;
  created_at: string;
}

export interface FolderPermission {
  id: string;
  folder_id: string;
  user_id: string;
  role: FilePermissionRole;
  granted_by_user_id: string;
  created_at: string;
}

/**
 * The body of a Wassel native document. 1:1 with a files row whose kind is
 * 'wassel_doc'. `content_json` is the TipTap document state; `content_html`
 * is the rendered HTML used by preview/export paths that can't run TipTap.
 */
export type DocApprovalStatus = 'draft' | 'review' | 'approved' | 'published';

export interface WasselDocumentRow {
  file_id: string;
  content_json: Record<string, unknown>;
  content_html: string;
  version: number;
  last_edited_by_user_id: string | null;
  /** Page settings JSONB ({} = defaults) — see lib/documents/pageSettings. */
  settings: Record<string, unknown> | null;
  /** Approval workflow (draft → review → approved → published). Content
   *  edits on approved/published docs auto-demote back to draft. */
  approval_status: DocApprovalStatus;
  approval_updated_by: string | null;
  approval_updated_at: string | null;
  updated_at: string;
}

export interface SharedLink {
  id: string;
  file_id: string;
  token: string;
  created_by_user_id: string;
  expires_at: string | null;
  /** Always null when exposed to the public; only populated for owner/admin reads. */
  password_hash: string | null;
  allow_download: boolean;
  is_active: boolean;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
}

/**
 * Payload returned to the anonymous `/share/:token` page.
 * When `requires_password=true`, all other detail fields are absent — the
 * caller must POST again with the password.
 */
export interface SharedFileResponse {
  /** Short-lived signed URL for inline preview. Absent until password (if any) is satisfied. */
  url?: string;
  /** Office documents only: signed URL of the cached PDF conversion, when it
   *  exists. The share page renders this inline instead of a download card. */
  preview_url?: string;
  original_name?: string;
  mime_type?: string;
  size_bytes?: number;
  kind?: FilePreviewKind;
  allow_download: boolean;
  requires_password?: boolean;
  /** ISO timestamp; when the signed URL stops working. */
  expires_at?: string;
}

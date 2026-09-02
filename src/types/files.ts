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
  /** B7. Content digest reported by Storage (MD5 for single-part uploads);
   *  the duplicate-detection key, always paired with size_bytes. NULL for
   *  multipart uploads and for anything Storage could not report — which
   *  means "not dedup-able", not "unique". */
  content_etag: string | null;
  created_at: string;
  updated_at: string;
  // Metadata Intelligence layers (Phase A/B). Optional; see BusinessFileRow.
  /** The one required primary "Document Type" (vocab: primary_category). */
  primary_category?: string | null;
  asset_nature?: string | null;
  acquisition_source?: string | null;
  usage_rights?: string | null;
  production_state?: string | null;
  ai_description?: string | null;
  width_px?: number | null;
  height_px?: number | null;
  duration_seconds?: number | null;
  page_count?: number | null;
  aspect_ratio?: string | null;
}

/** One row of a Metadata-Intelligence vocabulary (`file_vocabularies`) — the
 *  data-driven picklist for one of the new scalar axes. Same shape idea as
 *  FileDocumentTypeRow. Readable by any authenticated user; admin-only writes. */
export type FileVocabDimension =
  | 'asset_nature' | 'acquisition_source' | 'usage_rights' | 'production_state'
  /** The required, single-select primary "Document Type" (brochure / unit_plan /
   *  design / ai_content / raw_photo / raw_video / ready_video / voiceover / music
   *  … editable data). Distinct from the multi-value subject (document_type). */
  | 'primary_category';

export interface FileVocabRow {
  dimension: FileVocabDimension;
  value: string;
  label_ar: string;
  label_en: string;
  applies_to_kinds: string[];
  sort: number;
  active: boolean;
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
  /** Persisted Yjs CRDT state (base64) — collaboration bootstrap blob.
   *  NULL until the first collab-capable client seeds it. */
  ydoc_state: string | null;
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 3 · B5 — the Business Files Library
//
// `FileRow` above describes the STORAGE object. The types below describe the
// same file as a BUSINESS document: what it is, who is accountable for it,
// whether it is still valid, and which records use it. B1 added those columns
// to `files`; B2 made them queryable through `business_files_search`.
// ─────────────────────────────────────────────────────────────────────────

/** Lifecycle. Deliberately NOT an approval workflow — Wassel documents already
 *  have `approval_status` and two competing truths would be worse than none. */
export type FileStatus = 'draft' | 'active' | 'superseded' | 'archived';

/** Constrains reach, never grants it. `restricted` suppresses the B4
 *  record-derived view branch, so such a file is reachable only by an explicit
 *  grant, its uploader, or an admin. */
export type FileConfidentiality = 'public' | 'internal' | 'restricted';

/** How the row entered the system. Set by the write path, never user-editable. */
export type FileOrigin =
  | 'user_upload'
  | 'marketing_intake'
  | 'integration_inbound'
  | 'generated_document'
  | 'derived_rendition'
  | 'system_artifact';

/** business = eligible for the Library. system = machine artefact (a compressed
 *  copy, a preview rendition), shown only under its parent. */
export type FileClass = 'business' | 'system';

/** The seven sorts `business_files_search` accepts. Sending an eighth makes the
 *  RPC raise, so this union is the single source of truth on the client and is
 *  mirrored by the CHECK constraint on `file_views.sort`. */
export type BusinessFileSort =
  | 'created_desc'
  | 'created_asc'
  | 'updated_desc'
  | 'title_asc'
  | 'title_desc'
  | 'size_desc'
  | 'size_asc';

/** One row of the controlled document-type vocabulary (`file_document_types`,
 *  16 rows). Readable by any authenticated user as of B5; writes stay closed
 *  because every value is referenced by an FK. */
export interface FileDocumentTypeRow {
  value: string;
  label_ar: string;
  label_en: string;
  applies_to_kinds: string[];
  default_confidentiality: FileConfidentiality;
  sort: number;
  active: boolean;
}

/** A file as `business_files_search` returns it. Note what is ABSENT compared
 *  with `FileRow`: no `preview_*` cache, no `model_id`/`record_id`. The Library
 *  never needs them, and a file's record relationships are the many-to-many
 *  `file_links` graph, not the legacy single-record column. */
export interface BusinessFileRow {
  id: string;
  title: string;
  document_type: string;
  kind: FilePreviewKind;
  origin: FileOrigin;
  status: FileStatus;
  confidentiality: FileConfidentiality;
  tags: string[];
  description: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  owner_user_id: string;
  uploaded_by_user_id: string;
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_until: string | null;
  archived_at: string | null;
  folder_id: string | null;
  storage_bucket: string;
  storage_path: string;
  /** Edges in `file_links` the CALLER can see. Zero means "unlinked to me",
   *  which is not necessarily "unlinked" — both halves of a link are RLS-gated. */
  link_count: number;
  /** Present only when business_files_search is asked for it; the Library's
   *  duplicate filter keys off it server-side. */
  content_etag?: string | null;
  // ── Metadata Intelligence layers (Phase A/B, 2026-08-23). All optional: a
  //    file with none set is still valid. See docs/files-metadata-intelligence-plan.md.
  /** The required, single-select primary "Document Type" (vocab: primary_category).
   *  brochure / unit_plan / design / ai_content / raw_photo / raw_video /
   *  ready_video / voiceover / music (+ AI/admin additions). NULL only until the
   *  corpus backfill fills it. */
  primary_category?: string | null;
  /** Asset nature — real / ai_generated / cgi_render / screenshot … (vocab). */
  asset_nature?: string | null;
  /** Where we obtained it — developer / competitor / client … (vocab). */
  acquisition_source?: string | null;
  /** What we may DO with it — approved / do_not_use … (vocab, ≠ confidentiality). */
  usage_rights?: string | null;
  /** How ready it is — raw / edited / final / published (vocab, ≠ status). */
  production_state?: string | null;
  /** Short AI summary of contents. NULL until the AI enrichment phase. */
  ai_description?: string | null;
  width_px?: number | null;
  height_px?: number | null;
  duration_seconds?: number | null;
  page_count?: number | null;
  /** Snapped display ratio (16:9 / 9:16 / 1:1 …), captured at upload. */
  aspect_ratio?: string | null;
  /** Rights trust resolved from the LATEST usage_rights provenance row —
   *  returned by business_files_search (2026-09-02_29) for picker badges.
   *  'unknown' when no human or AI decision exists; verified only on a HUMAN
   *  decision. Optional so an older RPC still types. */
  rights_provenance?: string | null;
  rights_verified?: boolean | null;
  /** Full subject set (file_subjects); document_type is the primary one. */
  subjects?: string[];
}

/** One row of the AI review queue (`file_ai_review_queue`): a file that still
 *  carries unreviewed AI suggestions, plus exactly what the AI proposed. */
export interface AiReviewRow {
  id: string;
  original_name: string;
  kind: FilePreviewKind;
  mime_type: string;
  document_type: string;
  asset_nature: string | null;
  ai_description: string | null;
  tags: string[];
  /** Staged relationship suggestions (never auto-applied). */
  ai_suggestions: unknown;
  /** provenance field_paths still in the ai_suggested state (ai_description,
   *  asset_nature, tags, subject:<slug>…). */
  ai_fields: string[];
  /** Subject slugs the AI proposed (subset of the file's subjects). */
  ai_subjects: string[];
  created_at: string;
}

/** Facet counts, computed over the WHOLE filtered set rather than the page, so
 *  the filter bar shows real numbers and dead options can be hidden. */
export interface BusinessFileFacets {
  document_type: Record<string, number>;
  kind: Record<string, number>;
  origin: Record<string, number>;
  status: Record<string, number>;
  confidentiality: Record<string, number>;
  owner_user_id: Record<string, number>;
  tag: Record<string, number>;
  /** Keyed by `models.name`, counting DISTINCT files, not edges. */
  linked_model: Record<string, number>;
  role: Record<string, number>;
  health: { unlinked: number; expired: number; duplicate: number };
  // Metadata Intelligence axes (Phase B). Optional so an older RPC still types.
  asset_nature?: Record<string, number>;
  acquisition_source?: Record<string, number>;
  usage_rights?: Record<string, number>;
  production_state?: Record<string, number>;
  subject?: Record<string, number>;
}

export interface BusinessFilesSearchResult {
  page: number;
  page_size: number;
  total: number;
  rows: BusinessFileRow[];
  facets: BusinessFileFacets;
}

/**
 * The filter object handed verbatim to `business_files_search`. Every key is
 * optional and an absent key means "do not constrain on this".
 *
 * Kept structurally identical to the RPC's jsonb contract so a saved view can
 * be stored and replayed without a translation step — a translation step is
 * where a saved view silently loses a filter.
 */
/** Aspect family derived from the snapped aspect_ratio W:H (±5% = square).
 *  RPC filter added 2026-09-02_29. */
export type AspectFamily = 'portrait' | 'landscape' | 'square';

export interface LibraryFilters {
  /** Primary "Document Type" (single-select axis; multiple values = OR). */
  primary_category?: string[];
  /** Orientation family (derived from aspect_ratio W:H). */
  aspect_family?: AspectFamily[];
  document_type?: string[];
  /** Multi-value subject (file_subjects). ANY listed subject matches. */
  subject?: string[];
  asset_nature?: string[];
  acquisition_source?: string[];
  usage_rights?: string[];
  production_state?: string[];
  status?: FileStatus[];
  kind?: FilePreviewKind[];
  origin?: FileOrigin[];
  confidentiality?: FileConfidentiality[];
  /** file_links.role — what the file IS to the records that use it. */
  role?: string[];
  /** ALL listed tags must be present (the RPC uses the `@>` containment op). */
  tags?: string[];
  owner_user_id?: string[];
  uploaded_by_user_id?: string[];
  /** A specific record. `model_id` alone does nothing — pair it with `record_id`. */
  model_id?: string;
  record_id?: string;
  /** `models.name`, e.g. 'all_projects'. Any record of that model. */
  linked_model?: string;
  created_from?: string;
  created_to?: string;
  size_min?: number;
  size_max?: number;
  file_class?: FileClass;
  unlinked?: boolean;
  expired?: boolean;
  duplicate?: boolean;
  include_archived?: boolean;
}

/** How results are sectioned. `linked_model` needs the per-page link lookup
 *  (`fetchPageLinks`) because the search rows carry a count, not the models. */
export type LibraryGrouping = 'none' | 'document_type' | 'linked_model' | 'owner' | 'month';

export type LibraryLayout = 'grid' | 'list';

/** A saved Library query (`file_views`). The six SYSTEM views are NOT rows in
 *  this table — see `src/lib/files/views.ts` and the migration header for why. */
export interface FileViewRow {
  id: string;
  name: string;
  owner_user_id: string;
  filters: LibraryFilters;
  q: string | null;
  grouping: LibraryGrouping;
  sort: BusinessFileSort;
  layout: LibraryLayout;
  visibility: 'private' | 'shared';
  pinned: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Records that use a file, resolved per PAGE rather than per row so the list's
 *  "linked records" column and the linked-model grouping cost one query, not
 *  sixty. Counts are of edges the CALLER can see. */
export interface PageLinkSummary {
  file_id: string;
  model_name: string;
  model_label_ar: string | null;
  model_label_en: string | null;
  count: number;
}

/** A single record a file is linked to — resolved to its display title, not
 *  just the model. Used where the reviewer needs to see exactly what a file is
 *  attached to (the AI review tab). */
export interface FileLinkedRecord {
  file_id: string;
  model_id: string;
  model_name: string;
  model_label_ar: string | null;
  model_label_en: string | null;
  record_id: string;
  /** The record's title (project_name / name / … via recordTitle), or a short
   *  id fallback when the record is not visible under the caller's RLS. */
  label: string;
}

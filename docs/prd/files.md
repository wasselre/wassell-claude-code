# PRD: Files System (Drive-style file library)

**Status:** Live
**Last updated:** 2026-05-23 (initial PRD + Drive-backed record fields: `image`, `multi_image`, `file`, `multi_file`, `attachment` field types now read/write the Files System instead of the legacy `marketing-assets` bucket — uploads through any record field land in the Drive and get tagged with `files.model_id` + `files.record_id` so they appear in both the Drive's normal view AND under the record. See model-builder.md "Drive-backed fields".)
**Related PRDs:** [data-storage.md](data-storage.md), [access-control.md](access-control.md), [dashboards.md](dashboards.md) (public-link pattern), [logs.md](logs.md), [decks.md](decks.md) (storage bucket precedent), [model-builder.md](model-builder.md) (Drive-backed field types that consume this system), [record-management.md](record-management.md) (the form / cell rendering that displays Drive references)

## What it is (in plain English)
A Google-Drive-style file library inside Wassell CRM, reachable from the sidebar at `/files`. Users can upload images, PDFs, videos, documents, and archives, organize them into nested folders, preview them inside the app, and either share them with other Wassel users by role (viewer / editor / owner) or generate a public `/share/:token` URL for external customers. Folders cascade: sharing a folder grants the recipient access to every file and subfolder inside, recursively. A dedicated "Shared with me" tab shows everything other Wassel users shared with the caller. Public share pages are heavily Wassel-branded — the customer who opens a link sees the Wassel castle logo, brand palette, and Amiri typography front-and-center.

## Why it exists
Today users keep contracts, brochures, site photos, and references on Google Drive or WhatsApp media, disconnected from the CRM. This brings those assets into the workspace so a contract sits next to its client record, a brochure sits next to its project record, and external share links double as a sales asset — opening one is a small "wow" moment for customers.

## Key behaviors
- **Storage is private by default.** No file ever has a public URL — the SPA mints 5-minute signed URLs for previews; the public `/share/:token` endpoint mints 10-minute signed URLs after validating token + password.
- **Path traversal is impossible.** A file's storage path is server-built as `<auth.uid()>/<file_id>.<safe_ext>` from a fixed MIME→extension map. The user's original filename is display-only.
- **Permissions follow a three-rung ladder:** `viewer` < `editor` < `owner`. Owners can delete, regrant, and revoke. Editors can rename / move / share. Viewers can only see and download.
- **Folder sharing cascades.** Granting `viewer` on a folder gives the recipient `viewer` on every file/subfolder inside, transitively. Direct file grants always override the cascade (so a folder-`viewer` can be promoted to `editor` on a single file).
- **Frozen-model record attachments are soft FKs.** `files.record_id` can point at a row in `records` OR in a frozen-model table. No hard FK is enforced — UI handles "linked record gone" gracefully.
- **Record fields can store pointers into the Drive.** The Model Builder offers five field types — `image`, `multi_image`, `file`, `multi_file`, and `attachment` — that store `files.id` (or `folders.id`) on the record instead of inlining bytes or URLs. Uploads through these fields hit `uploadFile` with `model_id` + `record_id` populated, so the file appears under both the record AND the Drive's normal view. The `attachment` type can reference whole folders (`{type:'folder', id}`) so a record can point at "all photos for this property" as a moving target rather than a frozen list. See model-builder.md "Drive-backed fields" for the field-side config.
- **All file ops write to `activity_log`** with `category='file'` and `event_type` ∈ `upload | view | download | move | folder_create | folder_delete | permission_grant | permission_revoke | share_created | share_revoked | shared_view | delete`.
- **External share links** support optional password (bcrypt-hashed via pgcrypto), optional expiry, allow_download toggle, view counter, and one-click revoke.
- **MIME allowlist** (~25 common types: png/jpeg/webp/gif/heic/svg/bmp/tiff, pdf/doc/docx/xls/xlsx/ppt/pptx/txt/csv/md, zip/7z/rar/gz, mp4/webm/mov, mp3/wav/m4a/ogg). Executables and unknown types are rejected by the bucket itself.
- **Max file size:** 500 MB (bucket-level + client-side double-check).
- **`allow_download=false` is casual gating** — the inline-preview signed URL is still reachable, so a determined viewer could scrape it. Sufficient for "please don't download" intent, not for confidentiality.
- **Public share page is brand-first** — Wassel castle logo, gradient cream/sand background, Amiri serif headlines, copper-bronze CTAs. Reuse-of-brand is deliberate: every external customer who opens a link sees Wassel.

## User flows
1. **Upload + organize.** User navigates to `/files`, clicks Upload (or drags files anywhere on the page). Files appear in the current folder. Drag-and-drop overlay covers the full viewport on dragenter; per-file upload tickets stack in the bottom-right.
2. **Internal share via folder.** Owner opens a folder's kebab → Permissions, picks a user, sets role (viewer/editor/owner). The recipient sees the folder under "Shared with me" and can navigate in normally; everything inside inherits the role unless individually overridden.
3. **External share via link.** Owner opens a file → Share. Optionally sets expiry + password + allow_download. Clicks "Create link" — gets a `/share/<token>` URL with a Copy button. Sends to customer.
4. **Customer opens the link.** Customer lands on the brand-heavy share page. If password-protected, they hit a Lock screen with a password input. After unlock (or immediately if no password), they see the file rendered inline — image, PDF iframe, video player, audio player, or a metadata card for downloadable types — with a copper "Download" button (unless `allow_download=false`).
5. **Revoke + audit.** Owner re-opens Share, sees the link's view count and last-viewed timestamp, clicks Revoke. Next attempt at the URL hits the "Link not available" branded page. Every upload/view/download/share/revoke/delete is in `/logs`.
6. **Empty / error states.** Empty folder = an icon, the empty-state copy, and an Upload CTA. "Shared with me" with no grants = the empty-state copy only. Expired or revoked share link = the branded Not-Found card. Anonymous viewer's wrong password = inline red text under the input.

## Data touched
- **Reads + writes:**
  - `folders` — folder tree (`parent_folder_id` self-reference; ON DELETE RESTRICT for safety).
  - `files` — metadata for every uploaded artifact. Bytes live in Supabase Storage; this row is the source of truth for permissions and listing. Includes optional `model_id` + `record_id` for record-attachment.
  - `file_permissions` — per-file grants (override the cascade).
  - `folder_permissions` — per-folder grants (cascade to descendants).
  - `shared_links` — public token-based links; bcrypt password_hash; expiry; view_count.
  - `activity_log` — all file events under `category='file'`. Existing CHECK constraint was extended to include `'file'`.
- **Storage:**
  - Bucket `wassel-files` (private, 500 MB cap, MIME allowlist). Path schema `<auth.uid()>/<file_id>.<safe_ext>`. Four storage RLS policies gate by path prefix.
- **RLS helpers (new):**
  - `wassell_folder_cascade_role(folder_id, user_id)` — recursive CTE up the parent chain; returns the highest role grant found.
  - `wassell_can_access_folder(folder_id, kind)` — admin OR creator OR cascade-role satisfies kind.
  - `wassell_can_access_file(file_id, kind)` — admin OR uploader OR direct file_permission OR folder-cascade.
- **Anon RPCs (new):**
  - `get_shared_file(token, password?)` — SECURITY DEFINER; returns metadata if active+not-expired+password-matches; returns `requires_password=true` if password needed; returns no rows otherwise.
  - `record_shared_link_view(token)` — bumps `view_count`, sets `last_viewed_at`, inserts an activity_log row.
  - `set_shared_link_password(link_id, pw)` — service-role-only helper used by `/api/share-links/create` to hash via pgcrypto.

## Key files
| File | What it does |
|---|---|
| `supabase/migrations/2026-05-23_files_system.sql` | Single migration: 5 tables, RLS, helper RPCs, anon share RPCs, `wassel-files` bucket + path-prefix RLS, activity_log category extension. |
| `src/types/files.ts` | Type definitions (`FileRow`, `FolderRow`, `FilePermission`, `FolderPermission`, `SharedLink`, `SharedFileResponse`). |
| `src/lib/files/client.ts` | Service layer. `uploadFile` is load-bearing — two-phase upload (storage → row insert) with orphan cleanup. |
| `src/lib/files/format.ts` | `formatBytes`, `kindIcon`, `kindAccent`, `kindLabel` UI helpers. |
| `api/_lib/files.ts` | Server-side helpers: JWT/service/anon clients, `assertCanAccessFile`, `signFileUrl`, `logFileActivityServer`. |
| `api/files/sign-view-url.ts` | Mints a 5-min signed URL for in-app preview. Service-role signing after `wassell_can_access_file` gate. |
| `api/files/sign-download-url.ts` | Same with `?download=<name>` query. |
| `api/files/delete.ts` | Row-first delete; CASCADE removes permissions + shared_links; storage object best-effort. |
| `api/share-links/create.ts` | Creates link with pgcrypto-hashed password via `set_shared_link_password`. |
| `api/share-links/revoke.ts` | Sets `is_active=false`. |
| `api/share/view.ts` | **Anonymous.** Validates token via `get_shared_file`, mints signed URL, calls `record_shared_link_view`. |
| `api/share/download.ts` | **Anonymous.** Same but enforces `allow_download`. |
| `src/pages/Files/FilesPage.tsx` | Main `/files` page with tabs, breadcrumb, grids, modal orchestration. |
| `src/pages/Files/components/FilesTabs.tsx` | "My Files" / "Shared with me" segmented control. |
| `src/pages/Files/components/FilesBreadcrumb.tsx` | Parent-chain breadcrumb. |
| `src/pages/Files/components/FolderTile.tsx` | Folder card with kebab. |
| `src/pages/Files/components/FileCard.tsx` | File card with lazy image thumb + kebab. |
| `src/pages/Files/components/UploadDropzone.tsx` | Full-page drag overlay + hidden picker + per-file tickets. |
| `src/pages/Files/components/FilePreviewModal.tsx` | MIME-aware viewer (image / pdf iframe / video / audio / download card). |
| `src/pages/Files/components/ShareLinkModal.tsx` | Create / list / revoke share links. |
| `src/pages/Files/components/PermissionsPanel.tsx` | Grant/revoke per-file or per-folder permissions. |
| `src/pages/Files/components/MoveToFolderModal.tsx` | Folder-tree picker with descendant guard. |
| `src/pages/Files/components/CreateFolderModal.tsx` | New-folder prompt with duplicate guard. |
| `src/pages/Files/components/DriveBrowserModal.tsx` | Reusable Drive picker used by the record-form Drive-backed field inputs. Three modes — `pick-folder`, `pick-files`, `pick-files-and-folders` — with inline Upload + New Folder buttons. Returns the selection via an `onSelect` callback. |
| `src/pages/PublicShare/PublicShareFilePage.tsx` | The brand-heavy `/share/:token` page (loading / password / ready / not-found). |
| `src/App.tsx` | Routes: `/share/:token` (public), `/files`, `/files/shared`, `/files/:folderId` (protected). |
| `src/components/layout/Sidebar.tsx` | Sidebar "Files" entry with `FolderOpen` icon. |
| `src/lib/i18n.ts` | ~35 Files keys in both `ar.translation` and `en.translation`. |

## Open questions / known limitations
- **Storage orphans on browser crash.** If the user's tab dies between storage upload and DB insert, the storage object is orphaned. Future cron (not in v1): `SELECT name FROM storage.objects WHERE bucket_id='wassel-files' AND NOT EXISTS (SELECT 1 FROM files WHERE storage_path = name AND created_at < now() - interval '1 day')`.
- **`allow_download=false` is casual.** A determined viewer can scrape the inline-preview signed URL. Document as not-confidential; for confidential files use a password and a short expiry.
- **Folder share links not supported in v1.** Only files can have public `/share/:token` URLs. Folder cascade is internal-only.
- **No drag-to-reorder, no versioning, no comment threads.** Out of scope for v1.
- **Effective-role detection in the SPA is approximate.** The grid disables "Edit/Delete" kebab actions based on `uploaded_by_user_id === currentUserId`. RLS is the authoritative gate, so a permission-grantee will get a clean 403 if they try to edit through a different code path — UI cleanup is a polish task.
- **Upload progress UI is per-ticket boolean** (queued/uploading/done/error). Supabase JS doesn't expose progress events for sub-6 MB files in v2; for larger files the tus path inside the JS client provides progress that we don't surface yet.
- **Recursive CTE per permission check** — the cascade helper walks the folder chain on every access check. Fine for typical libraries (≤10k folders/user) but worth re-measuring at scale.
- **`record_id` is a soft pointer.** UI handles "linked record not found" gracefully but doesn't auto-clean files when the linked record is deleted (intentional — the file lives on its own).

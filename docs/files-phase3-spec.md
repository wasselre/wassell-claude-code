Wassell File Management · Phase 3

The Business Files Library

Phases 0–2 built canonical storage, a relationship graph and transactional synchronisation. None of it is visible to a user. Phase 3 turns that infrastructure into the product: one canonical file store, organised by metadata and relationships instead of folders, surfaced through global, domain and record-level views.

Status Draft for approvalBaseline main @ 4719b1cc, Phase 2 liveEvidence production read-only inspection

01Current state and gap analysis

Everything below was measured against the live database and origin/main, not assumed.

What exists and works

7,097canonical files rows, 6.45 GB

1storage bucket for business files (wassel-files)

9,054semantic edges in file_links

10,242provenance rows in file_link_sources

0projection drift, synchronised at commit

5,663files already carrying ≥1 relationship

Phase 0 collapsed marketing uploads onto one set of bytes. Phase 1 derived the file↔record graph from four authoritative sources. Phase 2 made that graph converge inside the writing transaction. The substrate is real and correct. Phase 3 adds no new storage concept — it adds meaning, retrieval and reach.

The gaps, in order of severity

GapEvidence from productionConsequence





No record-derived access

wassell_can_access_file grants on: admin, uploader, explicit grant, folder cascade, and a narrow marketing clause. 11 users, 1 admin; the top uploader owns 5,655 of 7,097 files; 15 explicit grants; 468 files in any folder.

For 9 of 11 users the library is effectively empty. This alone blocks the product goal.

No business metadata

files has 17 columns: identity, bytes, mime, a 5-value kind, preview cache. No title, description, type, status, tags, owner, dates, checksum.

Nothing to search or filter by. Filenames are the only handle.

Folders encode metadata as a path

108 folders, depth 7, holding only 468 files (6.6%). 6,629 files sit at root.

Structure that most files never enter, and that cannot express two axes at once.

Manual linking is invisible

document_links — the correct many-to-many table, already a Phase 2 sync source — holds 10 rows.

The relationship model exists but users never touch it.

Search is a filename LIKE

searchDrive runs ilike on folders.name, files.original_name, wassel_documents.content_html, capped at 50 each. No index on original_name.

Cannot find by project, type, tag or date. Does not scale.

Marketing is a parallel system

1,586 mos_assets — 1,269 canonical, 317 still URL-only. Its own read gate (wassell_mos_can), own metadata, own UI. mos_assets.file_id is UNIQUE.

The best file experience in the product is unreachable from the file system it sits on.

Marketing filtering is client-side

LibraryPage loads all assets and filters in JS. Fine at 1,586; fails at 7,097+.

The reference UX cannot be copied as-is.

990 dark files

No edge, no folder, no grant.

Reachable only by uploader and admin, invisible to everyone else, permanently.

The folder tree is the argument

Two sibling roots — المشاريع and مشاريع تحت الإدراج — contain the same projects (مينا 52, الماجدية 163, الرمز - سديم تاون…), because a folder can hold a file in exactly one place and the business needs two axes: which project and what stage. Below that, paths encode document type — محتوى المطور / صور, المخططات / الدور الأول — spelled four different ways (محتوى المطور, محتوي المطور, المحتوى-المطور, محتوى - المطور). Users are already doing metadata by hand, badly, in a structure that forces duplication. That is the whole case for Phase 3, live in production.

02System files versus business files

The boundary already mostly exists physically. Phase 3 makes it explicit and enforceable.

Today, almost everything system-generated never enters files at all — it lives in its own bucket with a URL on a record:

BucketObjectsContentsIn files?







wassel-files

7,778

Business files + cached office previews

Yes

market-detail

169,997

Market-listing scrape artefacts

No

marketing-assets

13,072

Legacy public marketing copies, image-gen output

No

listing-photos

9,509

Aqar photo mirror

No

wassel-migrations

1,442

Data-migration source spreadsheets

No

wassel-decks

69

Generated .pptx

No

call-recordings

8

Call audio

No

Call recordings are not files rows. 805 call_logs carry a recording_url; zero of them resolve to a files row. The requirement "system files stay hidden" is already satisfied for them by construction — and must stay that way.

Recommended rule

Add one controlled column, files.file_class ∈ {business, system}, default business, plus files.origin for provenance. The Library filters on file_class = 'business'; contextual surfaces may show system rows where they belong (a call recording on the call record, a rendition under its parent).

**origin**Written byClassIn the Library?







user_upload

Drive dropzone, record field, document editor

business

Yes

marketing_intake

canonicalUpload

business

Yes

integration_inbound

WhatsApp inbound, Haberchat

business

Yes, once linked

generated_document

document_jobs (reservations, offers)

business

Yes

derived_rendition

PDF compression, office preview

system

No — shown under its parent

system_artifact

Anything machine-only

system

No

Today this classifies 6 rows (the مضغوط compression copies) as system and everything else as business — cheap now, and the rule that keeps the Library clean as pipelines multiply. The hard boundary stays: machine artefacts that are not business documents never get a files row.

03Universal business-file metadata

One flat schema on files. Metadata that applies to every business file, regardless of domain.

FieldKindRule





title

new

Required, seeded from original_name minus extension. Editable. The display name everywhere.

document_type

new

Required, defaulted by inference (see §4). Controlled vocabulary.

description

new

Optional free text. Indexed for search.

tags[]

new

Optional, free-form with autocomplete over existing tags. Proven: 1,569 of 1,586 marketing assets are tagged across 57 tags.

status

new

Required, defaults active. draft · active · superseded · archived.

owner_user_id

new

Required, defaults to uploader. Transferable — uploader is history, owner is accountability.

origin, file_class

new

Automatic, set by the write path. Never user-editable.

checksum_sha256

new

Automatic at upload. Powers duplicate detection (§12).

valid_from, valid_until

new

Optional. Drives "expired" surfacing for price lists, permits, rights windows.

confidentiality

new

Required, defaults internal. public · internal · restricted. See §11 — it constrains, never grants.

archived_at

new

Automatic on archive. Soft-hide, not delete.

original_name, mime_type, size_bytes, kind, storage_*, uploaded_by_user_id, created_at, updated_at

existing

Automatic. Unchanged.

folder_id, model_id, record_id

existing

Retained, deprecated in UI. Still authoritative Phase 1/2 sources. Do not drop.

Linked records, roles, usage count, "unused"

derived

From file_links. Never stored on files.

Project / client / unit facets

derived

Rolled up from linked records at query time.

Dimensions, duration, page count

derived

Extracted post-upload where cheap. Not MVP.

Recommendation: do not make linking mandatory at upload

Requiring a link would be principled and would push users straight back to WhatsApp and email. Instead: "Unlinked" is a first-class saved view and a visible counter, so the backlog is nagged, not blocked. There are already 990 such files; a gate would not have prevented one of them.

04Types, classifications, status, tags, ownership, source

A seed vocabulary derived from what the business already says — not invented.

Three independent axes, deliberately not collapsed into one:

document_type — what the document is. Controlled, bilingual, admin-editable.

kind — what the bytes are (image / video / pdf / document / audio). Derived from MIME. Already exists.

origin — how it entered the system (§2). Automatic.

Marketing conflates all three into one kind column plus a source column; that is why "photo" and "document" sit in the same list as "shoot" and "developer". Phase 3 separates them.

Seed document_type vocabulary

Every value below is already asserted somewhere in production — by file_link_role_for, by a folder name, or by mos_assets.kind/source.

ValueArabicEvidence in production





floor_plan

مخطط

5,375 edges — the single largest role

gallery_image

صورة معرض

2,020 edges; folders صور

marketing_asset

مادة تسويقية

1,252 edges

main_image / hero_image

صورة رئيسية / غلاف

87 + 23 edges

developer_content

محتوى المطوّر

8 edges; the most common folder name, in 4 spellings

brochure

بروشور

folder البروشورات والوحدات

video

فيديو

63 video files; folders فيديو

price_list

قائمة أسعار

offer_prices generated PDFs

reservation_form

نموذج حجز

reservations generated PDF

contract

عقد

document template registry

id_document

هوية

6 client-attached PDFs

supporting_document

مستند مساند

10 edges — the manual-link default

reference / source

مرجع / مصدر

39 edges; design references

task_attachment

مرفق مهمة

role vocabulary

other

أخرى

the honest escape hatch

Vocabulary becomes a table, as Phase 1 planned for

src/lib/files/linkRoles.ts already states the migration path: "When manual linking ships, the roles become a real table and file_link_role_for reads it instead." Phase 3 is that moment. Create file_document_types (value, label_ar, label_en, applies_to_kinds, sort, active) and keep the TypeScript constant as a label fallback only.

Status

draft → active → superseded → archived. Deliberately not an approval workflow: Wassel documents already have approval_status, and duplicating it here would create two competing truths. superseded is set automatically when a newer version is registered (§12).

Ownership

uploaded_by_user_id stays immutable history. New owner_user_id is the accountable person and is transferable — necessary because one uploader currently holds 80% of the library, and that person should be able to hand a document over without re-uploading it.

05Many-to-many file↔record behaviour

The smallest possible change: the write surface already exists and is already synchronised.

Four authoritative sources already feed file_links. Exactly one of them is a true many-to-many table a user can write to: document_links — unique on (file_id, model_id, record_id), indexed both directions, RLS-gated on file access, and already a Phase 2 trigger source. It has ten rows because it has almost no UI, not because it is the wrong shape.

Recommendation

Make document_links the universal manual link table and add one column: role (FK to the document-type vocabulary, nullable → supporting_document). Build the UI on it. No new relationship table. Phase 2's trigger already converges every insert, update and delete into file_links inside the writing transaction — manual linking inherits correctness for free.

Behaviour

ActionEffect



Link file → record

Insert document_links. Edge appears in file_links at commit. No bytes copied, no second row.

Link to many

N inserts, one file. A brochure can sit on a project, three units and a campaign simultaneously.

Unlink

Delete the document_links row. The edge survives if another source still proves it — e.g. the file is also in the record's floor_plan field. This is already tested and correct.

Unlink the last source

Edge disappears. File remains in the Library, now "unlinked".

Relink

Delete + insert. Presented as one "Move link" action; two rows underneath.

Field-derived links

read-only Cannot be unlinked from the Files UI — the truth is the record field. The panel says so and deep-links to the field.

This distinction — manual links are editable, derived links are not — is the one piece of conceptual load Phase 3 puts on users. It is worth it: the alternative is a Files UI that silently disagrees with a record form.

06Global Business Files Library UX

Generalise the Marketing Library, which the business already uses successfully, onto the canonical store.

Route /files becomes the Library. Folders move to a secondary Legacy folders tab (§8, §13).

Header band — result count, total size, distinct linked projects. Mirrors Marketing's «N مادة · N مشروعًا · N ميغابايت», which reads as orientation rather than chrome.

Filter bar — type, project, client, tag, status, owner, date, plus a free-text box. Chips are removable and the active set is URL-encoded, so any filtered state is a shareable link.

Grouped results — default grouping project × document type, exactly Marketing's project × kind sectioning. Grouping is switchable (flat, by type, by client, by month).

Grid and list — grid for visual types, list for documents. List columns: title, type, linked records, owner, date, size.

Badges in priority order — unlinked → expired → duplicate → status → type. Marketing's badge ladder, retargeted at file health.

Detail panel — preview, editable metadata, and the Used in panel from Phase 1, promoted from flag-gated to primary. It is already built and already correct.

Server-side pagination from day one, at 60 per page. Marketing's load-everything-and-filter-in-JS is the one thing not to copy.

07Search and filtering

One server-side RPC returning a page plus facet counts. Filenames stop being the only handle.

business_files_search(q, filters, sort, page) — SECURITY INVOKER, so RLS remains the only authority on visibility. Returns rows and facet counts, so the filter bar shows real numbers rather than dead options.

FilterSourceIndex





Free text

title, description, original_name, tags

GIN trigram over a generated column, folded through wassell_search_norm so Arabic أ/إ/آ→ا, ة→ه, ى→ي match — reusing the existing translation-search normaliser rather than inventing a second folding rule

Document type, status, kind, origin, confidentiality

files columns

btree

Tags

tags text[]

GIN

Linked record

file_links (model_id, record_id)

file_links_record_idx — exists

Linked project / client / unit

file_links → model name

same index, filtered by model

Relationship role

file_links.role

add btree

Owner, uploader, date, size

files columns

btree; idx_files_uploader exists

Unlinked / unused

NOT EXISTS on file_links

anti-join

Expired

valid_until < now()

partial btree

Duplicate

checksum_sha256 with >1 row

btree

Document body search stays limited to wassel_documents.content_html as today. Full-text extraction from PDFs and Office files is real work with a real payoff and belongs in a later batch, not the MVP.

08Saved views, collections, and what happens to folders

A view is a saved query. It has no membership, so it can never drift.

New table file_views: name, owner_user_id, filters jsonb, grouping, sort, visibility ∈ {private, shared}, pinned. A view is evaluated live and inherits the caller's RLS, so two people opening the same shared view correctly see different row counts.

Ship these system views on day one

Unlinked files — the 990-file backlog, made visible and actionable.

Recently added — last 30 days.

My files — owned by me.

Project pack — one project, grouped by document type. This is the direct replacement for المشاريع / ….

Marketing library — origin = marketing_intake, reproducing today's Marketing view from the canonical store.

Expiring soon — valid_until within 30 days.

Static collections

later A manually curated, ordered set ("client handover pack"). Genuinely useful for sending a bundle, but it is a second membership concept and every folder problem returns with it. Defer until dynamic views have been in real use for a quarter, then revisit with evidence.

Folders

Frozen, not deleted. No new folder can be created; existing ones remain browsable under Legacy folders and keep working, including the cascade permission path that 3 grants depend on. Each folder page shows a banner offering the equivalent saved view. Folders are removed only when the equivalent view is in use and the folder has been empty of unique reach for a full quarter — a Phase 4 decision with its own evidence, not a Phase 3 action.

09Contextual files inside records

The same canonical store, pre-filtered. Never a different file system.

One component, RecordFilesPanel, mounted on every record form, replacing the current split between LinkedDocumentsPanel and RecordDocumentsPanel. It queries file_links for (model_id, record_id) and groups by role.

RecordDefault groupingContextual system files





Project

Floor plans · Gallery · Brochures · Developer content · Marketing · Documents

—

Unit

Floor plan · Gallery · Price list · Documents

—

Client

ID documents · Contracts · Reservations · Correspondence

Call recordings, read-only, clearly labelled system

Task

Attachments

—

Offer / Reservation

Generated document · Supporting

Generation history

Marketing asset

The canonical file, plus its usage

Renditions

Every panel offers Attach existing (search the Library, create a link) beside Upload new (upload then auto-link). Field-derived entries render read-only with a jump to the field. This is the surface that finally makes many-to-many visible: the same brochure appears under three units, and the panel says linked, not copied.

10Upload, link, and bulk workflows

Upload once

One intake path for every business file: uploadFile → wassel-files → files row. Marketing's canonicalUpload already does exactly this and becomes a thin wrapper that sets origin = 'marketing_intake'. Uploading computes the checksum; an exact byte match offers "Link the existing file instead" with the match shown, and creating the copy anyway requires a deliberate click.

Post-upload metadata

A single inline strip, not a modal: title (pre-filled), type (inferred), project or record (pre-filled from context), tags. Dismissible. Skipping leaves the file active and unlinked, where the "Unlinked" view will find it.

Bulk

Multi-select drives: set type · add or remove tags · link to record · unlink · set owner · archive · download. All bulk operations run one record per transaction — this is not a preference but a Phase 2 constraint: a single transaction dirtying more than 100 targets takes the global projection lock exclusively and blocks every other committing writer. A 500-file bulk link must be 500 transactions with a progress bar, and the implementation note belongs in the code.

Carried forward from Phase 2

Bulk paths must never become set-based statements over records, files, document_links or mos_assets. Measured: 2,000 rows in one transaction costs +27 s on UPDATE, +11.6 s on DELETE, and statement_timeout does not bound it.

11Permissions

This is the decision that determines whether Phase 3 succeeds or ships an empty page.

Today wassell_can_access_file(file_id, kind) returns true for: admin · uploader · explicit file_permissions grant · folder cascade · and a view-only clause for marketing library assets. With 1 admin, 2 uploaders, 15 grants and 468 foldered files, a typical user sees almost nothing.

Recommendation — generalise the clause that already exists

Add one view-only branch: a user may view a file if it has a file_links edge to a record that user can already see in unified_records. Edit, delete and share paths are untouched.

This is not a new principle. The marketing clause is already relationship-derived view access, approved and live. This generalises it from one relationship to all of them, and it is the only mechanism that makes 5,663 of 7,097 files reachable without hand-granting.

Why it is safe

It cannot exceed record visibility: the predicate is an intersection with unified_records, which already enforces every profile scope rule. A user who cannot see a project cannot reach its files.

Phase 1's file_links_select policy is already both-sides — file access and record visibility. The graph has never widened access and still will not.

confidentiality = 'restricted' suppresses the derived branch, so an ID document or contract stays owner-and-grant-only even when linked to a visible client. This is the escape valve, and it defaults conservatively for id_document and contract types.

What it changes, stated plainly

A sales rep who can see a project will be able to view that project's brochures, floor plans and marketing images. Today they cannot. That is the intended product change; it is also a real expansion of read access and must be an explicit product decision, not an implementation detail. It ships behind VITE_FEATURE_FILES_LIBRARY plus a database-side toggle, with a measurement step that reports, per user, exactly how many files become newly visible before anyone is let in.

If this is rejected

Phase 3 must fall back to explicit sharing plus folder cascade, the Library stays near-empty for 9 of 11 users, and the honest recommendation is to not build the global Library — ship only the record-level panels and the metadata layer, which work within today's access model. Half of Phase 3 is not worth building on an access model that hides its content.

12Archive, deletion, orphans, retention, duplicates, versions

ConcernRulePhase





Archive

Sets archived_at + status='archived'. Hidden from default views, still reachable by direct link and by the "Archived" view. Links survive untouched. Reversible.

MVP

Delete

Owner or admin only. If edges exist, the dialog lists every affected record and requires confirmation. Deletes the row and the storage object; file_links and file_link_sources cascade. Archive is the default action in the UI; delete is behind a menu.

MVP

Remove-from vs delete

Unchanged from the accepted Phase 0 rule: removing a marketing asset removes mos_assets and leaves the canonical file. The UI must finally say "Remove from Marketing Library", not "Delete".

MVP

Orphans

"Unlinked" is a saved view, not an error. Storage objects with no files row are a separate operator report.

MVP

Duplicates

Checksum at upload; offer to link the existing file instead. A "Duplicates" report groups by checksum. No automatic merge — merging would rewrite relationships users did not ask to change.

MVP detect · later merge

Versions

Lineage, not byte-diff: supersedes_file_id on the new file; the old one flips to superseded and keeps its links. "Upload new version" copies metadata and links forward.

later

Retention

valid_until surfaces expiry in views. No automatic deletion, ever. Real estate documents have legal significance and this team has one admin.

MVP surface only

13Migration

Additive, reversible, and nothing is deleted in Phase 3.

AssetVolumeStrategy





Folder structure

108 folders, 468 files

Backfill only: derive document_type from leaf names (صور→gallery_image, فيديو→video, المخططات→floor_plan, البروشورات→brochure, all four spellings of محتوى المطور→developer_content) and add the project folder name as a tag. Folders remain, untouched and browsable.

Marketing metadata

1,269 canonical assets

Copy title, tags, note→description, kind+source→document_type, archived_at onto the files row. mos_assets keeps its marketing-specific columns (ref, usage_rights, shoot_request_id, rights_expiry) and becomes a sidecar, not a parallel store. Its UNIQUE(file_id) makes this 1:1 and safe.

Marketing URL-only assets

317

Canonicalise: copy bytes from marketing-assets into wassel-files, create the files row, set file_id. Idempotent, resumable, one asset per transaction. This is the last of the Phase 0 work and the only data-moving step in Phase 3.

Legacy duplicated public copies

1,252 pairs, ~1.08 GB

No action. Public URLs may already be in customer messages. Unchanged from the accepted Phase 0 decision.

media_assets

1,731, none promoted

No action. Image-generation scratch, public bucket by design. It enters the Library only when a user promotes one, which already creates a proper files row.

Field-attached files

6,565

Nothing to migrate — file_links already covers them.

Unlinked files

990

No bulk guess. Surfaced in the "Unlinked" view for humans to triage.

Every backfill is a separate idempotent script with a dry-run mode, and each writes one row per transaction for the Phase 2 reason.

14The Phase 3 MVP boundary

The smallest thing that changes how people actually work.

In: the metadata columns and the type vocabulary · the system/business split · manual many-to-many linking with a real UI · the global Library with server-side search, filters and facets · saved dynamic views with six seeded ones · the unified record-level panel · record-derived view access behind a flag · archive, duplicate detection, unlinked triage · Marketing rebuilt on the canonical store · the folder and marketing backfills.

Out — deliberately: static collections · versioning · PDF and Office body text extraction · automatic duplicate merge · retention automation · external sharing changes · any folder deletion · any change to Phase 0 lifecycle rules · renditions and derivatives beyond what exists.

Implementation sequence

B1Metadata foundationMVP

Additive migration: new files columns, file_document_types, document_links.role, indexes. Backfill title from original_name, owner from uploader, document_type inferred from existing file_links.role where one exists. No UI.

Ships dark

Nothing user-visible.

Rollback

Drop the new columns; nothing reads them yet.

B2Search RPC and facetsMVP

business_files_search with pagination and facet counts, trigram and GIN indexes, Arabic folding via the existing normaliser. Verified against RLS as three different users.

Rollback

Drop the function; the old searchDrive is untouched throughout.

B3Access measurementdecision gate

A read-only report: for each of the 11 users, how many files are visible today and how many would become visible under the record-derived clause, broken down by document type and confidentiality. No code path changes. This is the evidence the §11 decision should be made on.

Gate

Product owner approves or rejects record-derived view access.

B4Record-derived view accessMVP

The wassell_can_access_file branch, plus confidentiality suppression. Behind a DB toggle so it can be disabled without a deploy. Requires B3 approval.

Rollback

Flip the toggle. One statement, instant, no data change.

B5Library UI and saved viewsMVP

/files becomes the Library: filter bar, grouping, grid and list, detail panel with metadata editing, file_views and the six seeded views. Folders move to a Legacy tab. The Phase 1 "Used in" panel is promoted to primary and its flag retired.

Rollback

Feature flag returns the old folder-first page.

B6Linking and record panelMVP

Manual link and unlink on document_links, "Attach existing" search, the unified RecordFilesPanel across project, client, unit, task, offer and reservation. Derived links render read-only.

Rollback

Hide the panel; links already written stay valid and keep syncing.

B7Upload, dedupe, bulkMVP

Checksum on upload, duplicate offer, post-upload metadata strip, bulk actions with per-record transactions and a progress bar.

Rollback

Disable the strip and bulk bar; upload reverts to today's behaviour.

B8Marketing convergenceMVP

Canonicalise the 317 URL-only assets; copy marketing metadata onto files; rebuild the Marketing Library as a saved view over the canonical store with its sidecar columns retained. Marketing keeps its own route and capability gate — only the storage substrate merges.

Rollback

Marketing UI reverts to reading mos_assets directly; the canonicalised rows are additive and harmless.

B9Folder backfill and freezeMVP

Derive types and tags from folder paths; disable folder creation; add the "here is the equivalent view" banner. No folder is deleted or emptied.

Rollback

Re-enable creation; the derived tags are additive.

Later, in order: body-text extraction · versioning lineage · static collections · duplicate merge · retention automation · folder retirement.

15Acceptance criteria and rollback boundaries

BatchAccept whenRollback boundary





B1

Every file has a non-empty title, an owner and a document_type; file_class marks exactly the 6 rendition rows as system; file_links count unchanged at 9,054; reconcile drift 0.

Columns are additive and unread. Drop them.

B2

Search returns correct results for Arabic and Latin queries with folding; facet counts match a naïve count; p95 < 300 ms at 7,097 files; three test users get three different row sets.

Drop the function; searchDrive untouched.

B3

The report runs and is reviewed. No pass/fail — it is a decision input.

Read-only.

B4

Newly visible counts match B3's prediction exactly; a user without project access still cannot see its files; restricted files are unreachable through the derived branch; no change to edit, delete or share for any user.

DB toggle off — one statement, no data change.

B5

Library lists, filters, groups and paginates; every seeded view returns sensible rows; folders still browsable; "Used in" shows correct records; no console errors; RTL correct in both languages.

Flag returns the folder-first page.

B6

Linking a file to three records produces three edges and one file; unlinking one leaves the others; unlinking the last removes the edge; a field-derived link cannot be unlinked from the UI; reconcile drift 0 after every operation.

Hide the panel; written links remain valid.

B7

Re-uploading identical bytes offers the link; bulk-linking 200 files produces 200 transactions and 0 deadlocks; dirty-target table empty at rest; interactive save latency within the Phase 2 band.

Disable strip and bulk bar.

B8

All 317 assets carry a file_id; byte-identical to source; marketing metadata present on files; the Marketing view returns the same assets as before; no marketing permission changed.

Marketing reverts to mos_assets; canonical rows harmless.

B9

Every foldered file has a type and a project tag; folder pages still open; the 3 folder-cascade grants still grant; creation disabled.

Re-enable creation; tags additive.

Global halt conditions, every batch

Stop and roll back if file_links_reconcile() reports non-zero drift · file_link_dirty_targets is non-empty at rest · any user gains edit or delete reach they did not have · interactive save latency exceeds the Phase 2 measured band · any Phase 0 lifecycle behaviour changes.

◆Architecture

Phase 3 adds two layers and one access branch. Everything below the dashed line already exists and runs in production.

PHASE 3 — VIEWSBusiness Files Library/files · search · facetsSaved viewsfile_views (dynamic)Record files panelproject · client · unit · taskMarketing Librarya view + sidecar, not a storePHASE 3 — MEANINGFile metadata on `files`title · document_type · tags · status · ownerconfidentiality · checksum · validity · file_classManual links — document_links + rolethe many-to-many write surface (already a Phase 2 source)link · unlink · relink — no bytes copiedPHASE 1–2 — RELATIONSHIP GRAPH (LIVE)file_links — 9,054 semantic edges(file_id, model_id, record_id, role)derived · read-only · both-sides RLSfile_link_sources — 10,242 proofsfield · attachment · manual · marketingconverged at COMMIT by 4 triggers + deferred drainPHASE 0 — CANONICAL STORE (LIVE)files — 7,097 rows · 6.45 GBone row per set of byteswassel-files (private, single bucket)Authoritative sourcesrecords.data fields · files.model_id/record_iddocument_links · mos_assetsSYSTEM STORES — NEVER IN THE LIBRARYcall-recordings (8) · market-detail (169,997) · listing-photos (9,509) · wassel-decks (69) · wassel-migrations (1,442) · marketing-assets legacy (13,072)

Solid copper outlines are existing infrastructure carried forward unchanged. Dashed terracotta outlines are new in Phase 3. The system stores at the foot have no files row and stay out of the Library by construction.

◆Decisions for you

Everything else in this document is a recommendation I will implement as specified. These four genuinely need your call.

D1 — Record-derived view access blocking

May a user view a file because they can already see a record it is linked to? Recommended: yes, view-only, with restricted suppression. Without it the Library is empty for 9 of 11 users and §6–§8 are not worth building. Decide after B3 produces the per-user numbers.

D2 — Does Marketing keep its own page? shapes B8

Recommended: yes. Marketing keeps its route, its capability gate and its sidecar columns; only the storage and search substrate merge. The alternative — folding Marketing into the Library as a saved view with no dedicated page — is cleaner architecturally and would disrupt a workflow that currently works well. I recommend against it.

D3 — Default confidentiality for client documents policy

Recommended: id_document and contract default to ****restricted, so they never reach anyone through D1 even when linked to a visible client. This is conservative and may annoy people who expect to see a client's paperwork. Confirm it matches how you want client data handled.

D4 — Folder end-state direction

Phase 3 freezes folders and deletes nothing. Recommended: commit now to retirement in Phase 4, conditional on the saved views being in real use — so the team knows the legacy tab is temporary. The alternative is keeping both indefinitely, which means keeping two mental models and the folder-cascade permission path forever.

Assumptions I have applied without asking

Manual linking reuses document_links rather than a new table.

Static collections, versioning and body-text search are out of the MVP.

No automatic deletion or retention enforcement, ever.

The 1,252 legacy duplicated public copies stay untouched, per Phase 0.

media_assets stays a separate generation scratch store until promotion.

Every bulk operation is one record per transaction, per the Phase 2 limits.

Compiled from read-only inspection of wassell-prod and origin/main @ 4719b1cc. No code, migration, flag or production state was changed in producing this specification.
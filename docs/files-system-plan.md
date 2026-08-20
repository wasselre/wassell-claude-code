# Wassell File Management — the whole plan

**Status:** living document · **Last updated:** 2026-08-20 (B6, B7, B8 built)

This is the governing plan for the Files system across **all five phases (0–4)**.
Until now it existed only as `phase3-business-files-spec.md` in an untracked
folder on one laptop, covering Phase 3 alone; Phases 0–2 and 4 had no plan
document at all and survived only as history entries in `docs/prd/files.md` and
a single forward reference. That is why this file exists.

Two companion documents, and the division of labour between them:

| document | answers |
|---|---|
| **this file** | what we are building, in what order, and why — and what is left |
| `docs/prd/files.md` | what the system does *today* (the living PRD) |

Every number below is measured against production, dated. Where something is
inferred rather than measured it says so.

---

## 1. The business goal

Wassell holds ~7,500 business files — floor plans, brochures, gallery images,
marketing assets, and eventually contracts and IDs. Almost none of it is
findable.

**The goal: one canonical file store, organised by metadata and relationships
instead of folders, reachable from wherever the user already is** — the project,
the unit, the client, or a global library.

A salesperson should be able to ask *"the floor plan for unit 12 in Al-Majdiah"*
and get it, instead of guessing a filename inside a folder tree that 93% of
files never enter.

### What "done" looks like

- Any file is findable by **project, type, tag, date, owner or status** — not
  just by filename.
- A file attached to a record is visible **from that record**, and a record's
  files are visible from the file.
- **One** storage substrate. Marketing's library becomes a view over it rather
  than a parallel system.
- Folders survive as legacy navigation, not as the place metadata lives.

### The gaps this is fixing (measured pre-Phase-3)

| gap | evidence | consequence |
|---|---|---|
| No record-derived access | 11 users, 1 admin; top uploader owns 5,655 of 7,097 files; 15 explicit grants; 468 files in any folder | **For 9 of 11 users the library is effectively empty.** This alone blocks the product goal. |
| No business metadata | `files` had 17 columns — identity, bytes, mime, a 5-value `kind`, preview cache | Nothing to search or filter by. Filenames are the only handle. |
| Folders encode metadata as a path | 108 folders, depth 7, holding 468 files (**6.6%**); 6,629 at root | Structure most files never enter, and which cannot express two axes at once |
| Manual linking invisible | `document_links` — the correct many-to-many table — held **10 rows** | The relationship model exists but users never touch it |
| Search is a filename `LIKE` | `searchDrive` ilike over names, capped at 50, no index | Cannot find by project, type, tag or date. Does not scale. |
| Marketing is a parallel system | 1,586 `mos_assets`, its own gate, metadata and UI | The best file experience in the product is unreachable from the file system it sits on |
| Marketing filtering is client-side | `LibraryPage` loads all assets, filters in JS | Fine at 1,586; fails at 7,500+ |
| **990 dark files** | no edge, no folder, no grant | Reachable only by uploader and admin. Invisible to everyone else, permanently. |

---

## 2. The roadmap — Phases 0–4

There are **five top-level phases, 0 through 4**. Phase 3 is the large one and
carries nine implementation batches. (An earlier draft of this file claimed
"seven phases"; that was wrong and is corrected here.)

| phase | goal | status |
|---|---|---|
| **0 — Canonical storage** | Store each business file once in the private canonical store; keep backend/system files separate. | ✅ Done |
| **1 — Relationship graph** | Connect files to projects, units, clients, tasks, marketing assets. | ✅ Done |
| **2 — Live synchronization** | Keep those relationships accurate automatically whenever records change. | ✅ Done |
| **3 — Business Files Library** | Deliver the folderless, metadata-driven experience. | 🟡 In progress |
| **4 — Folder retirement** | Once saved views prove themselves, retire legacy folders and folder-based permissions. | ⏳ Not started |

Phase 4 is conditional by design — the spec commits to retirement *"conditional
on the saved views being in real use"*, so B5 has to earn it before Phase 4 may
begin. Nothing is ever deleted: B9 freezes folder creation and keeps a Legacy
tab.

---

## 3. Phases 0–2 — the substrate (SHIPPED)

These built storage and a relationship graph. **None of it is visible to a
user** — that is Phase 3's job.

### Phase 0 — canonical storage
Collapsed marketing uploads onto one set of bytes in the `wassel-files` bucket.
Established file lifecycle behaviour that later phases must not change (it is a
global halt condition).

### Phase 1 — the relationship graph
Derived the file↔record graph from four authoritative sources into `file_links`
(semantic edges) and `file_link_sources` (provenance), plus a backfill. This is
what makes "which records is this file used in" answerable.

### Phase 2 — transactional convergence
Made the graph converge **inside the writing transaction**: four `AFTER` row
triggers mark affected `(model_id, record_id)` targets dirty, and a deferred
constraint trigger drains them at commit. Drift is 0 at rest, by construction.

**A Phase 2 behaviour that matters downstream:** `tg_files_sync_file_links()`
exits early unless `model_id`/`record_id` changed. This makes metadata backfills
free — and means a **folder move or owner change never reaches `file_links`**,
which is exactly why B2A.4 needed its own trigger.

---

## 4. Phase 3 — the Business Files Library

Turns the substrate into the product. Nine batches, each independently
rollback-able.

### Status as of 2026-08-20

| batch | deliverable | state |
|---|---|---|
| **B1** | Metadata foundation: title, type, owner, tags, confidentiality, status | ✅ **Live** (applied dark) |
| **B2** | Fast server-side search, Arabic folding, filters and facets | ⚠️ **Live, and now CALLED** — B5 is its first consumer (behind B5's flag). 6,933 ms → 350–1,100 ms, still misses the 300 ms bar (§6.1, §6.2). |
| **B3** | Measure how record-linked access changes visibility | ✅ **Done** — D1 approved |
| **B4** | Let users view files through records they can access, excluding restricted files | ✅ **LIVE — toggle ON since 2026-08-19 11:09 UTC** |
| **B5** | Global Files Library, saved views, grouping, grid/list, metadata editing | ✅ **Built — shipped behind a flag, default OFF** (§4.1) |
| **B6** | Manual linking/unlinking and Files panels inside records | ✅ **Built — flag default OFF; acceptance bar fully met once the `units` schema was restored (§6.5)** (§4.2) |
| **B7** | Upload metadata, duplicate detection, bulk actions | ✅ **Built — behind the Library flag, default OFF** (§4.3) |
| **B8** | Move the remaining Marketing assets onto the canonical file system | ✅ **173 canonicalised on prod; 143 are non-file references (§4.4)** |
| **B9** | Convert folder names into metadata, freeze folder creation, retain Legacy folders | ⏳ Not started |

**Plus one branch that is in no spec but IS live on production:**

| | | |
|---|---|---|
| **B2A · B2A.2 · helper scoping · B2A.4** | file-authorization performance | ✅ **Live** — 20.9 s → 0.48 s |

### Reading the statuses

"Applied dark" is not the same as "pending", and the difference is operational:

- **B2 and B4 are ON PRODUCTION right now.** Their objects exist; nothing calls
  them. A roadmap that shows them as "pending" hides the fact that there is a
  switch on production (`file_access_settings.derived_view_enabled`) which, if
  flipped, moves three users from ~1,280 files to ~6,100.
- **"Blocked" describes an acceptance gate, not a deployment state.** B2 is
  deployed and unaccepted at the same time.

### The unplanned branch: B2A

B2A–B2A.4 do not appear in the original spec. They exist because B2 was the
first feature to read the whole corpus and it exposed a pre-existing
authorization cost. Recorded here so the sequence makes sense later:

- **B2A** hoisted per-caller values into InitPlans.
- **B2A.1** dropped the identity invariant and **widened production reach for 99
  seconds** before rollback. Root cause: the CI fixture was gentler than
  production.
- **B2A.2** restored the invariant at the policy's top level; a follow-up
  caller-scoped three helpers that were callable directly over PostgREST.
- **B2A.3** was built, measured and **rejected** — materialising the visible-file
  set made aggregates 3.6× faster and point lookups **59× slower**. Never applied.
- **B2A.4** carried the authorization inputs onto `file_links` instead.
  **7,133 ms → 98 ms**, flat across callers, reach byte-identical (+0/−0).

**The lesson worth keeping:** B2A.3 materialised the *answer*; B2A.4
materialised the *inputs*. That distinction is the whole difference.

### 4.1 B5 — built, and why it was safe to build now

B5 was blocked on two things and both cleared before it started:

1. **B4 is ON** (§6.3), so the Library is not empty. Verified in the browser:
   the three record-derived users see 6,092–6,112 files, matching §5 exactly.
2. **§6.1 is largely resolved** — 6,933 ms → 350–1,100 ms. Still over B2's own
   300 ms bar, but that is **B2's acceptance gate, not B5's**, and B5's bar
   (lists, filters, groups, paginates; seeded views return sensible rows;
   folders browsable; "Used in" correct; no console errors; RTL correct) does
   not depend on it. What B5 owes the budget is not making it worse: free text
   is debounced 400 ms, every page is one round trip, and thumbnails and
   per-page link lookups are one batched request each.

**Shipped behind a flag, default OFF** — `?library=1` / `?library=0` per person
(remembered, no deploy needed) over `VITE_FEATURE_FILES_LIBRARY` per
environment. The rollback boundary is one component, `FilesRoot`, and it was
exercised: flag off returns the folder-first page byte-for-byte.

**Three bugs the browser pass found that no test would have:**

1. Arabic printed **English**. i18next resolves six plural categories for
   Arabic and does NOT fall back to `_other` within the language — a missing
   `_many` falls through to `fallbackLng`. "7542 files" on an Arabic page.
2. The error card rendered **`[object Object]`**. supabase-js resolves failures
   as a plain `PostgrestError`, not an `Error`, so the idiomatic
   `e instanceof Error ? e.message : String(e)` produces literally that. The
   same idiom is used ~7 more times across `src/pages/Files/**` and
   `src/lib/files/client.ts` — **pre-existing, not fixed here**, and worth a
   sweep.
3. The detail panel went **read-only after the first successful save**. The
   state reset keyed on the file OBJECT (which a save replaces) while the role
   fetch keyed on the file ID (unchanged), so the role was cleared and never
   refilled.

All three are the same shape: **a wrong answer that looks like a right one.**
None would have been caught by a green build.

### 4.2 B6 — manual linking and the record panel

`RecordFilesPanel` replaces the Phase 1 "Linked documents" list on the record
form. It reads the **projection**, not `document_links`, so a record's files
arrive from all four mechanisms in one list, grouped by what each file IS to
that record. Behind `?recordfiles=1` / `VITE_FEATURE_RECORD_FILES`, default OFF.

**Verified on production, 2026-08-20**, with a link created and removed leaving
`document_links` back at exactly its original 10 rows:

- a project with 12 edges rendered 12 files in 3 role groups, matching the
  database exactly; derived rows carried their source field (`من حقل
  project_images`) and **no** Unlink button
- attaching one file took the record 12 → 13 edges with `file_rows = 1` — one
  file, nothing copied — and exactly **one** Unlink button appeared
- unlinking took it back to 12

**Three things the browser found that no test would have.**

1. **The picker offered files the user cannot link.** Linking needs EDIT on the
   file; the search returns everything VIEWABLE, and after B4 those sets diverge
   enormously. A real non-admin saw 25 Link buttons, every one of which answers
   42501. Now resolved per row via `effectiveFileRoles` and rendered as a
   disabled "no rights" label — measured after the fix: 0 buttons, 25 labels.
2. **`document_links.role` was write-only.** B1 added it for "the document type
   asserted by the person who made the manual link"; the projection hardcoded
   `supporting_document` and never read it. Attaching as "brochure" produced a
   `brochure` row and a `supporting_document` edge. Fixed in
   `2026-08-19_12_manual_link_role.sql` — see below.
3. **`document_links` granted TRUNCATE to `anon` and `authenticated`**, and
   **TRUNCATE is not subject to row-level security**. The table's three careful
   per-row policies did not stand between that grant and an empty table; what
   stopped it was PostgREST never emitting TRUNCATE — middleware, not the
   database. Revoked in `2026-08-19_11_manual_link_write_surface.sql`.
   **`records`, `files` and `folders` measure the same way and were NOT
   touched** — re-granting the CRM's core tables needs its own change with its
   own verification.

**The role fix was proved a no-op before it was applied**: the whole live-source
derivation is byte-identical across all 11,166 sources before and after, for
both the global function and its scoped twin, and the two still agree with each
other (Phase 2's equality invariant). All 10 existing links carry `role = NULL`,
so the coalesce cannot move a row that exists today.

**Deliberate scope call:** B6 replaces `LinkedDocumentsPanel`, NOT
`RecordDocumentsPanel`. The latter is document *generation* — template picker,
job queue, send-to-customer — and folding it in is cosmetic reorganisation with
real regression risk. Generated PDFs already appear in the new panel anyway,
because the generator writes a `document_links` row and arrives through the
projection like everything else.

**Mounted on the custom detail pages too** (2026-08-20). The generic
`RecordFormPage` covers units, tasks, offers and reservations, but
`all_projects`, `our_projects`, `clients` and `followups` render CUSTOM pages
that bypass it — so the panel was initially reachable on projects and clients
only via `?generic=1`, which is to say not at all. It now mounts on the
project's **Media** tab and the client's **Related** tab. Verified on both:
a project shows its 12 files without `?generic=1`, a client shows 3.

Deliberately NOT deduplicated against what those tabs already render. A gallery
image appears in the Media tab as a picture AND in the panel as a linked file
with its role, because they answer different questions — "what does this project
look like" versus "what is attached to it, and can I unlink it".

**One label bug the mount exposed:** the client panel rendered a section heading
of `ATTACHMENT3` — the raw slug, uppercased by the heading style, on an Arabic
page. `attachment` is Phase 1's reserved role-NEUTRAL sentinel (the legacy
`files.record_id` column proves an association and refuses to invent a role for
it) and it is deliberately absent from `file_document_types`; 564 edges carry
it. Adding it to the vocabulary would have been the wrong fix — it would then be
offered in the "link as" picker as though a person could choose it. Given
bilingual labels in the resolver instead, alongside the `unmapped` sentinel.

### 4.3 B7 — duplicate detection, and the digest that was already here

**The Library's duplicate filter has always answered zero.** It keys off
`checksum_sha256`, which B1 left NULL on purpose: back-computing it means
downloading 6.6 GB. A control that can never do anything is worse than an
absent one — it reads as "there are no duplicates here".

**Supabase Storage had already computed one.** `storage.objects.metadata` holds
an eTag per object, and for a single-part upload that eTag IS the MD5 of the
content. Measured on production:

| | |
|---|---|
| objects in `wassel-files` | 8,414 |
| plain 32-hex content MD5 | 8,298 (98.6%) |
| multipart eTags (`<hash>-<parts>`) | 116 — not a content digest |
| business files matched to a digest | **7,417 of 7,542 (98.3%)** |
| duplicate groups | **1,392** |
| files sitting in a duplicate group | **2,975** |
| redundant copies | **1,583** |
| storage wasted by them | **922 MB — 14% of the corpus** |

`files.content_etag` is backfilled from that, and `business_files_search`'s
duplicate filter and health facet now key off it (paired with `size_bytes`).
Verified: the filter goes **0 → 2,975**, matching a raw SQL count exactly, while
an ordinary search returns byte-identical rows and `updated_at` is untouched
across all 7,547 distinct values.

**Re-uploading identical bytes now offers the link** (spec §10's acceptance
item). Verified on production end-to-end: uploading a file, then uploading
byte-identical bytes, produced the prompt naming the existing match; choosing
"use the existing" left **one file row and one storage object** — the redundant
copy's bytes removed, no orphan. The test file was then deleted, leaving the
corpus at exactly 7,542.

Three deliberate choices in that flow:

- **The hook is OPT-IN.** `uploadFile` gained an optional `onDuplicate`
  callback and its absence means "keep", so all six existing callers — record
  fields, marketing intake, chat templates, the Drive picker, tree upload —
  behave exactly as they did. Silently changing dedup behaviour across six call
  sites is how a dedup feature becomes a data-loss report.
- **Detection happens AFTER the bytes land**, because the digest is the storage
  backend's. The cost is uploading something you may discard; for a corpus
  whose largest file is 43 MB that is a fair trade for one hashing authority.
- **Prompts are serialised** through a promise chain, with "apply to the rest".
  Uploads run three at a time, and asking three questions on top of each other
  is how people learn to click the first button without reading it.

**Bulk link/unlink — and where the spec's own rule had to be overruled.**
Spec §10 says "a 500-file bulk link must be 500 transactions", and gives its
reason: a transaction dirtying more than ~100 TARGETS takes the Phase 2
projection lock exclusively. That reason does not describe this operation —
linking N files to ONE record dirties ONE target, whatever N is. Measured on
production for 200 files onto one record, rolled back:

| approach | time | dirty targets | edges |
|---|---|---|---|
| one statement | **346 ms** (106 insert + 240 drain) | 1 | 201 |
| row-per-transaction | **32,815 ms** | 1 each | 201 |

**94.8× slower for an identical result**, because each separate transaction
drains the dirty set and every drain reconverges the WHOLE target. So bulk
operations batch by DISTINCT TARGET, not by row — following the reason rather
than the letter, which is recorded in the code so the next reader does not
"fix" it back. The rule still governs anything that genuinely spans many
targets; such an operation must chunk below ~100.

Verified through the UI on production, then cleaned up: 3 files linked to one
record produced 3 manual links, 3 converged edges, and **an empty dirty-target
table at rest** — the acceptance item. Unlinking removed all three and the
edges converged away, leaving `document_links` at its original 10 and reconcile
drift at 0.

**The post-upload strip, and the upload path the Library did not have.** Spec
§10 asks for "a single inline strip, NOT a modal: title (pre-filled), type
(inferred), project or record, tags. Dismissible." A modal makes metadata
compulsory in practice — it blocks the screen, so the fastest way past it is to
fill it with anything. The strip lets a person ignore it; skipping leaves the
file `active` and unlinked, where the Unlinked view finds it. The backlog is
nagged, not gated.

Building it exposed a gap: **the Library had no upload affordance at all.**
With the flag on, the only way to add a file was to switch to the Legacy
folders tab. It now has an Upload button and the dropzone, uploading
FOLDERLESS by design (`folderId` null) — dropping into a hidden "current
folder" would be the folder model creeping back into the page built to replace
it.

Verified on production, then cleaned up: uploading one file showed the strip
with the title pre-filled from the original name, type defaulting to "keep the
inferred type", tags, and a link-to-record picker. Applying wrote all of it —
renamed title, `brochure`, both tags, digest recorded, `folder_id` null.

**Why not SHA-256 in the browser.** WebCrypto omits MD5, so a browser could hash
a NEW upload but never produce a key comparable to the 7,417 files already here
— two dedup keys and a permanent seam between "before B7" and "after". Letting
the storage backend be the single hashing authority removes the seam and keeps
43 MB files out of browser memory. `uploadFile` reads the digest back after the
object lands; a null digest means "not dedup-able", never an error.

**This is not a security control.** MD5 is not collision-resistant against an
adversary; it answers "did someone upload this twice". It is paired with
`size_bytes` everywhere — measured: no digest in the corpus spans two different
sizes, so the pairing currently disambiguates nothing and is pure insurance.

**The bug worth remembering.** The first version rewrote the RPC with
`replace()` and multi-line string literals. Two of three silently did nothing
and the migration reported success: **this repo's .sql files are CRLF**, so a
multi-line literal contains `
` while `pg_get_functiondef` returns `
`.
The single-LINE replacement matched; the multi-line ones could not. Nothing
raised, because the guard only asked whether the text had changed AT ALL — and
it had, thanks to the one that worked. Now: regex on `\s+`, and every step
guarded separately, because one end-guard cannot tell "three of three" from
"one of three".

### What B5 did NOT do

- No authorization change. No branch in `wassell_can_access_file`, no policy on
  `files` or `file_links`, no `file_links` row touched. CI asserts the
  projection is byte-identical across the apply and that the `files` /
  `file_links` policy text is unchanged.
- No folder change. B9 still owns freezing creation; nothing is deleted.
- **"Expiring soon" shipped as "Expired"** — `business_files_search` has no
  `valid_until_before` filter and its date bounds are on `created_at`. The view
  is named for what it returns rather than for a window it cannot apply. Adding
  the real one is a B2 change. Production has zero files with any `valid_until`,
  so the two only diverge once somebody dates a contract.
- **No total-bytes figure** in the header band: the RPC returns per-page sizes
  only, and summing the page prints a number that changes as you paginate.

---

## 5. Live state (measured 2026-08-18/19, production)

| | |
|---|---|
| files | 7,548 — **all `internal`**, zero `restricted` |
| edges in `file_links` | 9,856 (9,855 unfrozen, 1 frozen) |
| files with ≥1 link | 6,114 |
| files in a folder | 468 |
| users | 7 (2 admin, 1 deactivated) |
| document types present | floor_plan 4,002 · gallery_image 2,735 · marketing_asset 357 · supporting 163 · other 112 · main_image 87 · video 64 · reference 19 · developer_content 8 · hero_image 1 |
| `id_document` / `contract` | **zero rows** |

**Consequence of that last line:** confidentiality suppression is currently
**dormant but load-bearing** — it protects nothing today and becomes the only
barrier the moment someone uploads a contract. It cannot be validated against
production data; it must be tested against a manufactured fixture.

### What B4 would change (measured, read-only)

| user | today | gain | after |
|---|---|---|---|
| admin ×2 | 7,548 | 0 | 7,548 |
| e350f736 | 1,270 | +4,843 | 6,113 |
| ad5e1e47 | 1,284 | +4,818 | 6,102 |
| b30d0678 | 1,292 | +4,800 | 6,092 |
| ae48de5f (no record access) | 1,270 | 0 | 1,270 |
| deactivated | 0 | **0** | 0 |

A **4.8× reach expansion** for three real people. The two zero rows are the
load-bearing ones.

---

## 6. Open problems

### 4.4 B8 — Marketing convergence, and the "317" that was really 173

The spec's "317 URL-only assets" is one number covering three unrelated things.
Measured on production 2026-08-20 before touching anything:

| the 317 url-only assets | count | can it be canonicalised? |
|---|---|---|
| bytes in our own `marketing-assets` bucket | 179 | **yes — server-side copy** |
| youtube.com links | 117 | no — a video REFERENCE, not a file |
| drive.google.com links | 16 | no — access-gated share URLs |
| genuinely fetchable external | 4 | later — needs a download |
| no url at all | 1 | nothing to move |

Of the 179, exactly 178 objects still exist (1 dangling url). **173 were
canonicalised**; the other 5 are 4 audio files (not in the marketing-mime
allowlist) and the dangling one.

**Server-side copy, no download.** Both buckets are Supabase Storage, so the
bytes move via the storage copy API (verified: cross-bucket copy returns 200) —
no browser, no 43 MB ArrayBuffer, and no third-party egress. The last point is
not incidental: the repo has a scar from Aqar 403-ing Fly's datacenter IPs, and
a B8 that downloaded the 137 external URLs would have re-learned it. The 117
YouTube references are the right thing to leave as URLs anyway — you cannot
canonicalise a video you do not host.

**How it ran.** `scripts/canonicalise-marketing-assets.mjs`, operator-run and
idempotent: per asset it copies the object to `<auth_uid>/<file_id>.<ext>` (the
path the storage RLS requires), inserts a `files` row with
`origin='marketing_intake'` and the digest from the SOURCE object's eTag, then
points `mos_assets.file_id` at it and nulls the legacy `url`/`thumb_url`/
`file_path`. Each step checks "already done" first, so a crash is recovered by
re-running. The source object is left in place — storage does not cascade, and
pruning 1.5 GB of now-duplicated bytes is a separate, deliberate decision once
the Marketing view is confirmed reading `file_id`.

**No app code changed.** `resolveAssetUrl` (`src/pages/Marketing/lib/assetUrls.ts`)
already returns `asset.url` for legacy assets and signs `file_id` for canonical
ones — so the 173 moved assets route straight through the canonical branch and
render via signed URLs. Verified end to end on one asset first: the owner sees
the new `files` row under RLS, `wassell_can_access_file(...,'view')` is true,
and `mos_assets` reach is unchanged (owner still sees all 1,587). Then the
batch: 173 done, 4 skipped, 0 failed, reconcile drift 0.

**Where it landed:** canonical 1,270 → 1,444; url-only 317 → 143 (5 in-bucket
remnants + 133 external references + a handful of edge cases). A file name was
derived from the marketing `title` ("جزيل — فيديو 3") for the 163 assets whose
`original_name` was null, since a uuid would have been a worse handle than the
context the asset already carried.

### 6.1 Per-row record-visibility cost — LARGELY RESOLVED (2026-08-19)

Two migrations, both live: `2026-08-19_01_record_scope_fast_path` (B2A.5, hoists
the per-model scope class out of `records_view`) and
`derived_file_ids_fast_path` (the same lemma applied to B4's helper, which
called `wassell_can_view_record` directly and so bypassed the policy fast path
entirely).

**`business_files_search`: 6,933 ms → 395 ms median (17.5x).** Reach byte-identical
for all 7 users, +0/-0, verified transactionally and again on production.

Residue is now thin rather than concentrated: `linked_model` facet 121 ms (was
7,924), `file_links` scan 92 ms (was 1,457), `files` scan 37 ms (was 1,566).

**Three lessons worth more than the fix:**

1. **The plan is the unit of cost, not the predicate.** The obvious fix — paste
   the fast-path disjunct into B4's helper — measured 2.3x SLOWER (731 ->
   1,693 ms). The existing plan carried a **Memoize** node deduplicating
   `can_view_record` to one call per distinct linked record; the extra `OR` made
   the planner abandon it for a Hash Join seq-scanning all 39,975 records. What
   shipped instead PARTITIONS (branch 1 = unrestricted models, no function call;
   branch 2 = the residue, 3 links and 2 calls) rather than disjoins.
2. **Two guards will be "tidied" away by someone.** `WHERE s.model_id IS NOT NULL`
   protects a `NOT IN` — one NULL silently narrows the result (CI mutant: 2,943
   ids lost). And the zero-permission guard MUST stay two statements, or the
   planner pushes the filter below the `DISTINCT` and evaluates 9,856 links
   instead of 10 models (389 ms vs 2 ms).
3. **Measuring RLS requires `SET LOCAL ROLE authenticated`, not just JWT claims.**
   `business_files_search` is SECURITY INVOKER; claims alone measure 89 ms with
   RLS never applied. Two earlier readings on this issue were wrong for exactly
   this reason.

**Still open:** 395-460 ms against a 300 ms bar. The next lever is B2's own —
the helper is invoked once per internal query (~24 ms each), recomputing a
caller-constant set. That is a B2 optimisation, not another authorization fix.

### 6.2 B2 is applied, now called, and still not accepted
Acceptance is *"p95 < 300 ms at 7,097 files."* Re-measured on production
2026-08-19 as the `authenticated` role, per user, 4 runs each: **350–1,100 ms**
(admin 346–600, the three record-derived users 481–617, the no-record-access
user 991–1,085). The gate is unmet by 1.2–3.6×.

**This is no longer a dark object.** B5 is its first caller, so from the moment
anyone turns the Library flag on, this latency is what a user waits for. Two
mitigations are in B5 rather than in B2: the free-text box is debounced 400 ms
(one query per pause, not one per keystroke) and responses are sequence-guarded
so a slow early answer cannot overwrite a fast later one.

**The most useful measurement is the counter-intuitive one:** the user who can
see the FEWEST files (1,270) is the SLOWEST (≈1,020 ms), and the admin who can
see all 7,542 is the fastest (≈460 ms). Cost is therefore dominated by a fixed
per-call overhead, not by how many rows come back — which is consistent with
the helper being recomputed once per internal query while being
caller-constant, and inconsistent with any remaining per-row authorization
theory. Whoever picks this up should start there and should NOT reach for
another authorization change.

### 6.3 B4 is LIVE — the toggle is ON (was: "do not flip")

**`file_access_settings.derived_view_enabled = true` since 2026-08-19 11:09 UTC.**
This is deliberate and verified. A parallel session reading this document raised
a security flag because the doc still said OFF while production said ON — the
doc was stale, not production. Recording the state so that cannot recur.

Validated in CI (all 7 B4 assertions incl. the manufactured restricted-file
boundary) and on production before/after:

| user | before | after | gain | predicted |
|---|---|---|---|---|
| `e350f736` | 1,270 | 6,112 | +4,842 | 4,842 same-instant |
| `ad5e1e47` | 1,284 | 6,102 | +4,818 | 4,818 |
| `b30d0678` | 1,292 | 6,092 | +4,800 | 4,800 |
| `ae48de5f` | 1,270 | 1,270 | 0 | 0 (no record access) |
| deactivated | 0 | 0 | 0 | 0 |

Zero write policies reference the derived branch — it stayed a view grant.

**B4's reach is dynamic.** It is record-derived, so it tracks record visibility
continuously: a day-old prediction drifted by one file overnight purely because
654 records were updated (files and edges were unchanged). "Matches the
prediction exactly" can only hold at a single instant on a live database.

Rollback remains one statement:
`UPDATE public.file_access_settings SET derived_view_enabled = false;`

### 6.5 The `units` schema was flattened, and the runbook would have made it worse — RESOLVED (2026-08-20)

Recorded because it was found from inside a Files batch, because the fix
changed a Phase 2 assumption, and because the trap it exposed is still the
first thing to check if reconcile ever reports drift again.

**What happened.** On 2026-08-20 at 06:43:17 UTC — 26 seconds after a sign-in —
24 model rows were rewritten in a four-second burst. `units` went from **47
declared fields to 9**, byte-identical to its definition in
`src/data/seedModels.ts`. Nothing else lost fields; a per-model diff of the
generated PRDs put `all_projects` at +1 and `market_listings` at +13 (ordinary
growth) against `units` at **-38**.

**The data was never in danger.** All 48 keys stayed in `records.data`
(`unit_code` on 7,826 rows, `unit_plan` on 5,706), and the record form seeds
itself from the whole row and writes `{ ...formData }` back, so ordinary saves
preserved undeclared keys. What broke was visibility: users saw 9 of 47 fields.

**Root cause.** `supabaseLoad` returns `null` when a query ERRORS but `[]` when
it succeeds and returns nothing — an RLS-empty read on a boot where the user is
not yet bound. The backfill guard only tested for `null`, so an empty read was
read as "none of these models exist" and all 26 seed models were upserted over
the live ones.

**The trap, which was the dangerous part.** `file_links_reconcile()` reported
5,706 orphan edges and 787 reclassified, and the PRD's own runbook says a
non-zero value means "run `file_links_resync_all()`". Measured at the time, on
one representative target of each class in a rolled-back transaction:

| edge class | count | what the documented repair would have done |
|---|---|---|
| floor-plan edges with only a field source | **4,919** | **deleted outright** |
| floor-plan edges with an attachment backup | 787 | role degraded to `attachment` |

So following the runbook literally would have destroyed 4,919 floor-plan
relationships. Ordinary saves were NOT doing this — verified twice — because
the Phase 2 trigger only marks a target dirty when a *declared candidate field*
moves, and `units` declared none. The damage was latent, not ongoing. (My first
instinct was the opposite and was wrong; the measurement is what corrected it.)

**Resolution.** Another session restored the schema at 10:04:49 UTC: `units` is
back to **48 fields across 8 sections** with `unit_plan` declared as `image`,
and 5,706 records carry a value — exactly the orphan count, which is what made
the diagnosis conclusive. Reconcile is now **0 on all four counters**, with the
graph intact at 9,856 edges / 11,166 sources and an empty dirty set.

**The root cause is closed at the DATABASE, not just in the client.** A new
`models_guard_schema_shrink` trigger refuses two fingerprints from any caller
carrying a browser JWT (service_role passes through): a `created_at` rewrite,
which is the seed-upsert signature, and any field-count SHRINK on an
`is_system` model. Schema changes to system models now have to come through a
migration. That is the right layer — the client guard can be missed again by a
stale bundle, and this cannot.

**Two things to carry forward.** `file_links_resync_all()` converges in BOTH
directions and will delete any edge the live derivation cannot currently see —
so before running it, confirm the schema is intact rather than assuming drift
means the projection is wrong. And a reconcile that reports drift is a question,
not an instruction: here the projection was right and the *schema* was wrong.

### 6.4 Scheduled PRD sync is broken
60/60 runs failing since 2026-08-17 on a TipTap peer-dependency conflict, so
`docs/prd/models/**` and `docs/prd/workflows/**` are drifting. Unrelated to
Files; noted because it silently erodes the record of in-app changes.

---

## 7. After Phase 3

From the spec, in order: body-text extraction from PDFs and Office files ·
versioning lineage · static collections · duplicate merge · retention
automation · folder retirement.

---

## 8. Rules that outlived their batch

Earned the hard way; violating them has already cost production incidents.

1. **A test that cannot fail is not evidence.** Non-vacuity guards belong in
   every suite. Two vacuous passes were caught this way; one restricted-file
   test had to manufacture its own fixture because production could not
   falsify it.
2. **Counts are not equivalence.** Compare sorted-ID fingerprints.
3. **A fixture gentler than production is how a security bug ships.** That is
   precisely how B2A.1 reached production.
4. **Measure before designing.** Five hypotheses were refuted by measurement in
   a single day — `unified_records` cost, the COST hint, temp-table RLS,
   facet passes, union scanning. Instrumenting a failure costs one run.
5. **Trust the SHA, not the prose.** A commit message in this repo claimed a
   deletion that never happened, because the `git rm` was chained to a command
   that died at parse time.
6. **Denormalized authorization carries a synchronisation obligation.** A stale
   column does not show a wrong number — it grants access that was revoked.
   Test it under every mutation that can disturb it.
7. **Ship dark, activate deliberately.** Reach changes are a separate decision
   from a deploy.

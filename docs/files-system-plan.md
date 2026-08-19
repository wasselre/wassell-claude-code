# Wassell File Management — the whole plan

**Status:** living document · **Last updated:** 2026-08-19 (B5 shipped)

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

### Status as of 2026-08-19

| batch | deliverable | state |
|---|---|---|
| **B1** | Metadata foundation: title, type, owner, tags, confidentiality, status | ✅ **Live** (applied dark) |
| **B2** | Fast server-side search, Arabic folding, filters and facets | ⚠️ **Applied dark** — 0 callers. 6,933 ms → 395 ms, but still misses the 300 ms bar (§6.1). |
| **B3** | Measure how record-linked access changes visibility | ✅ **Done** — D1 approved |
| **B4** | Let users view files through records they can access, excluding restricted files | ✅ **LIVE — toggle ON since 2026-08-19 11:09 UTC** |
| **B5** | Global Files Library, saved views, grouping, grid/list, metadata editing | ✅ **Built — shipped behind a flag, default OFF** (§4.1) |
| **B6** | Manual linking/unlinking and Files panels inside records | ⏳ Not started |
| **B7** | Upload metadata, duplicate detection, bulk actions | ⏳ Not started |
| **B8** | Move the remaining 317 Marketing assets onto the canonical file system | ⏳ Not started |
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

### 6.2 B2 is applied but not accepted
Acceptance is *"p95 < 300 ms at 7,097 files."* It is 1.5–2.9 s. Applied dark,
zero callers, so nothing is broken — but the gate is unmet.

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

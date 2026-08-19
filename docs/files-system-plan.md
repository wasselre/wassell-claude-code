# Wassell File Management — the whole plan

**Status:** living document · **Last updated:** 2026-08-19

This is the governing plan for the Files system across all phases. Until now it
existed only as `phase3-business-files-spec.md` in an untracked folder on one
laptop, covering Phase 3 alone; Phases 0–2 had no plan document at all and
survived only as history entries in `docs/prd/files.md`. That is why this file
exists.

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

## 2. Phases 0–2 — the substrate (SHIPPED)

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

## 3. Phase 3 — the Business Files Library

Turns the substrate into the product. Nine batches, each independently
rollback-able.

### Status as of 2026-08-19

| batch | what it is | state |
|---|---|---|
| **B1** | business metadata on `files` (title, type, status, tags, owner, dates, confidentiality) | ✅ shipped dark |
| **B2** | `business_files_search` — server-side search, filters, facets | ⚠️ applied dark, **fails its own acceptance bar** |
| **B2A / .1 / .2 / .4** | file-authorization performance (not in the original spec — inserted when B2 exposed the cost) | ✅ live |
| **B3** | read-only per-user access report | ✅ done; D1 approved |
| **B4** | record-derived view access + confidentiality suppression | ⚠️ applied **dark**; ON path unvalidated |
| **B5** | Library UI and saved views | ⛔ blocked (see below) |
| **B6** | linking and the unified record panel | not started |
| **B7** | upload, dedupe, bulk | not started |
| **B8** | Marketing convergence — canonicalise the 317 URL-only assets | not started |
| **B9** | folder backfill and freeze | not started |

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

### Why B5 is blocked

B5 is next in sequence and cannot usefully start:

1. It consumes `business_files_search`, which misses its budget (§5).
2. Its content depends on **B4 being ON**. The spec's own justification for D1:
   *"Without it the Library is empty for 9 of 11 users."*

Starting B5 now builds a page that is **slow and mostly empty**.

---

## 4. Live state (measured 2026-08-18/19, production)

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

## 5. Open problems

### 5.1 Per-row record-visibility cost on bulk link reads — the real one

**Measured 2026-08-19.** `business_files_search` takes 1.5–2.9 s against a
300 ms budget. Attribution:

| group | ms |
|---|---|
| base + total | 20.5 |
| six simple facets | 15.4 |
| tag facet | 11.9 |
| **`linked_model` + `role` facets** | **1,136.2** |
| **health block** | **565.7** |

Root cause: both hot groups read `file_links` in **bulk**, and every candidate
row calls `wassell_can_view_record`.

| | |
|---|---|
| `wassell_can_view_record` | **0.118 ms/call** |
| bare row access | 0.0014 ms/row |
| full `file_links` scan under RLS | 691 ms |

The function costs ~85× the row it guards. ~9,856 rows × ~0.1 ms ≈ 0.7 s per
scan; the search does ~2.5 of them.

**Two explanations were wrong and are recorded so they are not re-proposed:**
the eight "expensive" facets cost **27 ms combined** (the CTE materialises
once), and `unified_records` **prunes correctly** — a keyed probe executes one
branch and marks the four frozen branches `(never executed)`.

**This is not B2's bug.** B2 is the first feature to read links in bulk.
**B5's "Used in" panel and B6's linking UI will hit the same wall.** It should
be fixed at the authorization layer, before B5.

Tracked as [#32](https://github.com/wasselre/wassell-claude-code/issues/32).

### 5.2 B2 is applied but not accepted
Acceptance is *"p95 < 300 ms at 7,097 files."* It is 1.5–2.9 s. Applied dark,
zero callers, so nothing is broken — but the gate is unmet.

### 5.3 B4's ON path is unvalidated
Installed dark and verified inert (all personas byte-identical, toggle `false`,
zero write policies touched). **Do not flip
`file_access_settings.derived_view_enabled` until CI is green on the ON path.**

### 5.4 Scheduled PRD sync is broken
60/60 runs failing since 2026-08-17 on a TipTap peer-dependency conflict, so
`docs/prd/models/**` and `docs/prd/workflows/**` are drifting. Unrelated to
Files; noted because it silently erodes the record of in-app changes.

---

## 6. After Phase 3

From the spec, in order: body-text extraction from PDFs and Office files ·
versioning lineage · static collections · duplicate merge · retention
automation · folder retirement.

---

## 7. Rules that outlived their batch

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

# Files Metadata Intelligence — phased build plan

**Status:** proposal, not started. **Owner:** to assign. **Created:** 2026-08-23.

Turns the "unified file metadata" proposal into an executable, phased program. The
goal is **one consistent file-intelligence system** — layered metadata + AI
enrichment + provenance — that later powers search, content creation, project
content analysis, and automation.

This plan is deliberately **incremental**: every phase ships something usable on
its own and has its own rollback. Do not attempt it as one change.

---

## 0. Guiding principles (read before touching anything)

1. **The app already separates axes on purpose.** `kind` = what the bytes are;
   `document_type` = what it IS; `origin` = how it arrived; `confidentiality` =
   who sees it. This plan *extends* that philosophy — it does not replace it.
2. **No naming collisions.** `origin`, `status`, and `confidentiality` already
   exist with specific meanings. The new axes use **new names** (`asset_nature`,
   `acquisition_source`, `usage_rights`, `production_state`). Never overload the
   existing three.
3. **Vocabularies are DATA, not code.** Every picklist is admin-editable rows
   (bilingual), following the existing `file_document_types` pattern. Adding a
   subject/nature/source is a data edit, never a deploy.
4. **AI proposes, humans dispose — and we remember who decided.** Every enriched
   field carries provenance: `ai_suggested | human_approved | human_modified`.
   Mirrors the translation system's `classification_status` (proposed→confirmed).
5. **AI never auto-applies relationships.** A wrong auto-link to a project/unit
   silently corrupts search + analytics — worse than no link. Relationship
   suggestions are always staged and human-confirmed.
6. **Enrichment is a worker queue, same as the other 9.** No HTTP request is ever
   held open for an AI call (the standing rule for decks/images/previews/
   documents/migration/translation/listing-mirror).
7. **Backfill is operator-run, throttled, and bounded.** Never an unbounded auto
   sweep (the listing-mirror lesson). New uploads enrich automatically; the
   existing corpus is a metered batch.
8. **Fail loudly.** No silent catches; surface enrichment failures, keep the file
   usable (a file with no AI description is fine, just un-enriched).

---

## 1. Target data model

### 1a. What already exists (reuse, do not rebuild)

| Layer (proposal) | Existing home |
|---|---|
| Media Type | `files.kind` (auto from MIME) |
| Classification / Subject | `files.document_type` (single) + `file_document_types` vocab |
| Tags | `files.tags text[]` |
| Relationships | `file_links` + `file_link_sources` (source_key `field:/attachment:/manual:/marketing:`); `document_links.role` |
| Technical (partial) | `size_bytes`, `mime_type`, `content_etag`, `created_at`, `uploaded_by_user_id` |
| Confidentiality (visibility) | `files.confidentiality` (public/internal/restricted) — **kept separate from rights** |
| Lifecycle | `files.status` (draft/active/superseded/archived) — **kept separate from production state** |

### 1b. New axes (all nullable at first, backfilled later)

Scalar columns on `public.files`:

```
asset_nature       text   -- real | ai_generated | ai_edited | cgi_render | graphic_design | screenshot
acquisition_source text   -- developer | internal | competitor | client | partner | public | unknown
usage_rights       text   -- approved | use_after_edit | attribution_required | internal_only | restricted | do_not_use | needs_review
production_state    text   -- raw | edited | final | published
ai_description     text    -- short AI summary of contents (source language)
-- technical (captured at upload / by enrichment):
width_px           integer
height_px          integer
duration_seconds   numeric
page_count         integer
```

Each new scalar axis is backed by a **data-driven vocabulary** so the business
can edit the picklists. Two options — **recommendation: Option A**:

- **Option A (recommended): one generic `file_vocabularies` table.**
  `(dimension text, value text, label_ar text, label_en text, applies_to_kinds text[], sort int, active bool, PRIMARY KEY(dimension, value))`
  where `dimension ∈ {asset_nature, acquisition_source, usage_rights, production_state}`.
  One admin screen manages all of them; FKs are `(dimension, value)` composite.
  Leaves `file_document_types` (subject vocab) untouched.
- Option B: a separate table per axis (mirrors `file_document_types` exactly).
  More tables, more boilerplate; only pick this if per-axis columns diverge.

### 1c. Subject becomes multi-value (least-disruptive path)

- Keep `files.document_type` as the **primary subject** (existing FK + search +
  back-compat all keep working).
- Add junction `file_subjects (file_id uuid, subject text REFERENCES file_document_types(value), PRIMARY KEY(file_id, subject))`
  for the **full** set of subjects.
- `business_files_search` learns to match either the scalar OR the junction.
- Subject options are filtered by media type via `file_document_types.applies_to_kinds`
  (already exists) — that gives "subject list depends on media type" for free.

### 1d. Relationships: the "about vs. used-in" split

The single highest-value new idea. Add to `file_links` (or `file_link_sources`):

```
relation_kind text  -- 'subject' (the file is ABOUT this record) | 'usage' (the file is USED IN this record)
```

Default derivation (overridable by a human):
- `field:` / `attachment:` links on a project/unit/developer → `subject`.
- `marketing:` / content-piece / campaign links → `usage`.
- `manual:` → default `subject`, user can flip.

Keep the existing convergence machinery (`file_links_reconcile()`,
`file_links_drain_dirty()`, global vs. scoped derivation twins) intact — this
adds a column, it does not change the projection engine.

### 1e. Provenance (per field, not per file)

```
file_metadata_provenance (
  file_id     uuid,
  field_path  text,          -- 'asset_nature' | 'tags' | 'ai_description' | 'subject:floor_plan' | 'link:<record_id>' ...
  state       text,          -- 'ai_suggested' | 'human_approved' | 'human_modified'
  model       text,          -- which model/run produced a suggestion (null for pure-human)
  confidence  numeric,       -- 0..1 for AI suggestions
  decided_by  uuid,          -- who approved/modified
  decided_at  timestamptz,
  PRIMARY KEY (file_id, field_path)
)
```

Two write postures, by blast radius:
- **Safe layers** (description, tags, subject, nature, technical): AI writes the
  **live** column with `state='ai_suggested'`; the UI shows an "AI" badge with
  approve/modify. Approving flips to `human_approved`; editing → `human_modified`.
- **Dangerous layer** (relationships, acquisition_source when it implies a link):
  AI writes to a **staging** area (`files.ai_suggestions jsonb`), never the live
  link. The user promotes suggestions explicitly. AI never mutates `file_links`.

---

## 2. AI enrichment pipeline (worker queue #9)

`file_enrichment_jobs` on the existing Fly worker — same shape as the other
queues (enqueue-on-upload trigger, claim/complete/fail/watchdog RPCs, no held
HTTP). Branches by `kind`:

| kind | Analysis | Produces |
|---|---|---|
| image | vision model (Claude/Kimi vision) + read dimensions | subject(s), nature, tags, description, width/height |
| pdf / document | text extract (reuse office-preview→PDF path; Modal OCR `wassel-ocr` for scanned) | subject, description, tags, page_count |
| video | ASR transcript (Modal Whisper) + sampled frame vision | description, subject, tags, duration_seconds |
| audio | ASR transcript | description, tags, duration_seconds |

**Model routing** reuses the existing posture:
- Text reasoning → DeepSeek (`TEXT_LLM_PROVIDER` kill switch).
- Vision → Claude / Kimi.
- Batch backfill → the **Claude Code runner** (subscription, not metered API),
  the same lane the marketing content/OCR pipelines already use, to control cost.
- Video ASR → **Modal** (extend the existing `wassel-ocr` GPU app with Whisper).

**Output contract:** the worker writes suggestions + `file_metadata_provenance`
rows (and, for relationships, `files.ai_suggestions`). It never auto-applies a
link. Every terminal write is a single row-locked patch (the `clean_text_entry_patch`
lesson — avoid whole-`data` rewrites that convoy).

---

## 3. Phases

Each phase: **flag**, **acceptance bar**, **rollback**.

### Phase 0 — Taxonomy lock (no code)
Sit with the business and fix the initial vocab VALUES for the 4 new axes +
the subject list. Start SMALL (3–4 values each; the list is data, grow later).
Decide the about/used default per link source.
- **Acceptance:** a signed-off seed list.
- **Rollback:** n/a.

### Phase A — Schema (shipped dark)
Migration(s) under `supabase/migrations/`: new nullable columns on `files`,
`file_vocabularies` (+ seed), `file_subjects` junction, `relation_kind` on
`file_links`, `file_metadata_provenance`, `files.ai_suggestions jsonb`,
technical columns. `business_files_search` + `v_*` views unchanged functionally.
Apply to prod (standing rule), verify, no user-visible change.
- **Acceptance:** columns/tables exist; existing Library + search behave
  identically; `unified_records` / frozen artifacts still build (files is
  UNFROZEN — but re-run the view-chain check if that ever changes).
- **Rollback:** drop the new objects (down migration); nothing read them yet.

### Phase B — Manual editing UI (no AI)
Extend the surfaces that already exist:
- `LibraryDetailPanel.tsx` — edit new axes (data-driven selects from
  `file_vocabularies`), multi-subject, about/used badge, provenance badges.
- `PostUploadModal.tsx` — capture nature/source/subject at upload; client-side
  probe of image dimensions / video duration → store.
- `RecordFilesPanel.tsx` — show about/used distinction, new badges.
- `business_files_search` — filter/facet on the new axes + multi-subject.
- **Acceptance:** a human can fully set every layer by hand, in AR + EN, RTL
  correct; search filters on the new axes; no console errors.
- **Rollback:** feature-flag the new panel sections off (existing flag pattern).

### Phase C — Enrichment queue, SAFE layers only
Queue #9 + worker branch (image/pdf first; video/audio next). On new upload →
enqueue → suggestions to live columns with `ai_suggested` provenance → approve/
modify in the panel. Relationships NOT yet.
- **Acceptance:** a newly uploaded image/PDF gets a description + tags + subject
  + nature suggestion within the job SLA; the badge + approve/modify works;
  provenance recorded; a failed job leaves the file usable with a loud error.
- **Rollback:** disable the queue (env kill switch); manual editing (Phase B)
  unaffected.

### Phase D — Backfill (operator-run, throttled, metered)
A resumable script (`scripts/backfill-file-enrichment.mjs`, `--dry-run` first)
that drains the existing corpus through the queue in bounded batches via the
Claude Code runner. Cost-estimated up front; video last (most expensive).
- **Acceptance:** corpus enriched in batches with a progress + cost log; a
  `max_queue_depth`-style guard prevents flooding the shared worker.
- **Rollback:** stop the script; partial enrichment is fine (it's additive).

### Phase E — Relationship suggestions (conservative)
AI proposes about/used links to staging (`files.ai_suggestions`), high-confidence
top-1 only, **human-confirm to apply**. Applying writes through the normal
`file_links` path (never a direct AI write).
- **Acceptance:** suggestions surface in the panel with confidence; confirming
  creates a real link with `human_approved` provenance; rejecting discards; no
  link is ever auto-created.
- **Rollback:** hide the suggestions section; staged data is inert.

### Phase F — Payoff surfaces
Now the metadata is rich, wire the consumers: upgraded Library/global search
(subject + nature + rights + description), content-creation pickers that filter
by usage-rights + production-state, project content-analysis, automations.
- **Acceptance:** each consumer reads the new axes; measured search latency stays
  within the existing budget (watch the 350–1,100 ms line; trigram GIN on
  `ai_description` + tags).
- **Rollback:** per-consumer flags.

---

## 4. Hard rules (do not violate)

1. Keep `origin` / `status` / `confidentiality` meanings intact — new axes get
   new names.
2. Vocabularies are data (`file_vocabularies` / `file_document_types`), never
   hardcoded enums in TS.
3. AI never mutates `file_links` — relationships are staged + human-confirmed.
4. Provenance is per-field; every AI write records `ai_suggested`.
5. No held HTTP for any AI call — queue #9 + Realtime, like every other lane.
6. Backfill stays operator-run, throttled, bounded; new uploads enrich inline.
7. Worker copies of shared libs stay in sync with their `src`/`api` originals
   (the standing `worker/src/*` rule).
8. Migrations: apply yourself to prod, verify, mind the frozen view-chain if
   `files` is ever frozen (today it is UNFROZEN).
9. Surface every failure; an un-enriched file is a valid file.

---

## 5. Key files this program will touch

- **DB:** `supabase/migrations/` (Phase A + queue), `supabase/schema.sql`.
- **Vocab admin:** new settings screen (pattern: existing document-type/vocab admin).
- **Search:** `business_files_search` RPC; `src/lib/files/library.ts`, `libraryUrl.ts`.
- **UI:** `src/pages/Files/library/LibraryDetailPanel.tsx`, `PostUploadModal.tsx`,
  `LibraryFilterBar.tsx`; `src/pages/Records/components/RecordFilesPanel.tsx`.
- **Relationships:** `src/lib/files/recordFiles.ts`, `file_links` machinery.
- **Enrichment worker:** `worker/src/runEnrichmentJob.ts` (+ `index.ts` poll loop),
  copies of any shared analysis libs; Modal `wassel-ocr` extended with ASR.
- **Backfill:** `scripts/backfill-file-enrichment.mjs`.
- **PRD:** update `docs/prd/files.md` at each user-facing phase.

---

## 6. Open decisions for the operator

1. Vocab values per axis (Phase 0) — start minimal or comprehensive?
2. Usage-rights granularity — 7 states is a lot; which earn their place now?
3. Backfill scope + budget — whole corpus, or marketing assets first?
4. Video enrichment — worth the ASR+frame cost now, or images/PDFs first and
   video later?
5. Where the AI description feeds the durable AR/EN translation pipeline (it
   should, eventually — but that's a Phase F concern).

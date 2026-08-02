# PRD: Document Generation (templated branded PDFs from records)

**Status:** Live
**Last updated:** 2026-08-02 (**Bilingual W4 — render language:** the Generate panel passes the user's UI language; `document_jobs.language` carries it to the Fly worker, which renders labels/dates/filenames in that language AND overlays every token-source record (source / client / unit / project) with its current translations from the durable bilingual store — an English user's generated PDF quotes the unit's English notes. Default stays Arabic; template TEXT stays as authored — only chrome + token values localize.) | 2026-07-13 (**Schedulable sends:** the Send-to-customer confirm modal gains a «جدولة» / Schedule button (shared `SchedulePopover` from the chats feature) — the PDF is uploaded to Haberchat now but the document message waits in Haberchat’s delivery queue until the chosen time (`deliverAt`, validated ≥1 min ahead by `/api/send-document`). The activity log distinguishes scheduled sends («جُدول إرسال مستند») from immediate ones.)
**Related PRDs:** [files.md](files.md) (Documents = the template surface + where PDFs land), [record-management.md](record-management.md) (the record form the actions live on), [chats.md](chats.md) (Haberchat send), [decks.md](decks.md) (the Fly worker + queue pattern this reuses)

## What it is (in plain English)

Turns a CRM record into an official, branded **A4 PDF** generated from a reusable template — no manual formatting. On a record (e.g. a Reservation or an Offer Price), a "Generate documents" panel offers **Generate document**: the system loads the official template, fills its `{{variables}}` from the record and its linked client / unit / project, renders an A4 branded PDF (logo, header/footer, Arabic typography, terms, signature fields), saves it into the Files system, and links it back to the client / unit / project records. The user can then **Preview**, **Download**, or **Send to customer** over WhatsApp (with a confirmation showing the recipient + device first).

A **template is just an ordinary Wassel document** (`kind='wassel_doc'`) — authored, branded, and versioned in the normal Documents editor — bound to a record model. This is ONE engine for the whole platform: Reservations and Offers today; Financing, Deed transfer, Contracts, and Brochures later by adding another template, with zero engine changes.

## Why it exists

A reservation/offer was only data — staff had no way to produce the formal document a customer actually receives without re-typing and hand-formatting it. This makes the record the single source of truth: enter/select the data once, and Wassel produces a clean official PDF and sends it, every time identically.

## Key behaviors

- **Templates are editable Wassel documents.** Admins author them at **Settings → Document Templates** (or via the normal `/files/doc/:id` editor). All branding (logo image, A4 page size, header/footer, terms, signature lines) lives in the document; the engine never hardcodes layout.
- **A template binds to a model** via `document_templates` (`model_id`, `template_key`, bilingual label, `is_default`). The Generate panel lists active templates for the record's model; one template generates directly, multiple show a picker, the default sorts first. At most **one default per model** (DB-enforced).
- **Variables resolve at generation time** from the record + its linked records, walked **source → client → unit → unit's project → project** (first non-empty wins). Same formatting as the editor's live preview (dropdown→label, currency→`N ر.س`, date→localized, range→min–max, lookup→title). Engine-added tokens: `{{today}}` (Riyadh date), `{{sales_rep}}` (assignee→user name), `{{client_phone}}` (canonical KSA E.164).
- **Rendering is server-side** on the Fly worker: template content → branded **DOCX** (logo embedded as a real image) → **LibreOffice → PDF** (the same engine that powers office previews — correct Arabic/Amiri). The browser never waits on the render; it enqueues and polls (no SSE — same hard rule as every worker queue).
- **The generated PDF is a first-class `files` row** (`kind='pdf'`), owned by the generator, attached to the source record (`files.model_id`/`record_id`), and linked via `document_links` to the client / unit / project — so it surfaces on each of those records' "Linked documents" panel. On the source record it appears in the "Generate documents" panel (driven by `document_jobs`), not double-listed.
- **Send to customer = generate → confirm → send.** The confirm modal shows the resolved client name + **canonical phone** and the WhatsApp device (default, switchable when >1), with an editable bilingual caption. It blocks (never silently fails) when the client has no valid phone or no active device exists. The PDF is re-hosted to Haberchat and sent as a document message — immediately via **Send**, or at a future time via **«جدولة» / Schedule** (shared `SchedulePopover`; Haberchat’s delivery queue holds the message, so it sends even with the app closed). The send is logged to `activity_log` (`category='file'`, `event_type='document_sent'`, with `deliver_at` and a «جُدول» summary for scheduled sends).
- **The panel self-hides** when the record's model has no templates and no generated PDFs — zero change for models without templates.
- **Author token palette:** opening a template in the Documents editor shows the bound model's available `{{slug}}` tokens (model fields + lookup/`unit_picker` targets, depth 1, + the engine extras) in the CRM-variables popover, instead of the empty "link a record" state.

## User flows

1. **Author a template (admin):** Settings → Document Templates → New template → pick the document type (model) + an optional starter (e.g. "Unit Reservation") → it's created as a Wassel doc and opens the editor → add the logo, adjust terms/branding/page settings → it's bound + default automatically.
2. **Generate (sales):** open a Reservation → "Generate documents" panel → Generate document → the PDF appears within seconds → Preview / Download.
3. **Send to customer:** click Send to customer on the generated PDF → confirm recipient + device + caption → Send → the customer receives the PDF on WhatsApp; the send is logged.
4. **Empty / error states:** model with no templates → no panel. Generation failure or timeout → an inline failure card with Retry (never a dead spinner). No client phone / no device → an amber block in the send modal with a clear fix.

## Data touched

- **Reads:** `document_templates`, `unified_records` (source + client/unit/project), `models`, `wassel_documents` (template body + page settings).
- **Writes:** `document_jobs` (queue), `files` (the generated PDF), `document_links` (PDF ↔ client/unit/project), `activity_log` (the send). Storage: the generated PDF under `<owner_auth_uid>/<file_id>.pdf` in the private `wassel-files` bucket.

## Key files

| File | What it does |
|---|---|
| `supabase/migrations/2026-06-21_document_templates.sql` | Template registry (binds a wassel_doc to a model; RLS: read all, write admin). |
| `supabase/migrations/2026-06-21_document_generation_pipeline.sql` | `document_jobs` queue + enqueue/claim/complete/fail/watchdog RPCs (service-role). |
| `worker/src/runDocumentJob.ts` | The pipeline: resolve tokens → DOCX → soffice PDF → upload → files row → links. |
| `worker/src/documents/{variables,docx,pageSettings}.ts` | COPIES of `src/lib/documents/*` (resolver, DOCX builder **with logo embedding**, page geometry) — the worker can't import `src/`. Keep in sync. |
| `api/generate-document.ts` | Validate + enqueue (202 + job id). |
| `api/document-status.ts` | Poll one job (ready/pending/failed) + list a record's generated PDFs. |
| `api/send-document.ts` | Resolve phone → download PDF → Haberchat upload + send (optional validated `deliverAt` for scheduled delivery) → log. |
| `src/lib/documents/templateRegistry.ts` | Template CRUD service (list/create/bind/default/delete). |
| `src/lib/documents/generate.ts` / `sendDocument.ts` | Enqueue + poll + list; send-to-customer. |
| `src/lib/documents/recordDocTemplates.ts` | STARTER content builders (Reservation, Offer) — editable seeds, never the engine. |
| `src/pages/Records/components/RecordDocumentsPanel.tsx` | The on-record panel (generate + list + preview/download/send). |
| `src/pages/Records/components/SendDocumentModal.tsx` | Confirm-and-send modal (recipient + device + caption + guards). |
| `src/pages/DocumentTemplates/DocumentTemplatesPage.tsx` + `components/NewTemplateModal.tsx` | Admin template management at `/settings/document-templates`. |
| `src/lib/documents/variables.ts` | `buildTemplateTokenGroups` — author token palette (in addition to the shared resolver). |

## Open questions / known limitations

- **Starters are seeds, not the engine.** They bootstrap an editable template; once created, the live document is authoritative. The official Reservation/Offer templates must be created once (Settings → Document Templates) before the panel appears on those records.
- **`{{project_name}}` source.** Resolved preferring the unit's `all_projects` project (reliable `project_name`), then the record's `our_projects` link. If a model links projects differently, add the slug to the template explicitly.
- **DOCX layout fidelity.** Formal text + table + signature documents render faithfully via LibreOffice. Brochure-grade pixel layouts may later warrant an HTML→Chromium renderer (the engine is structured so that's an additive swap).
- **Send uses the env default device** when the caller doesn't pick one; multi-device tenants should pick explicitly in the confirm modal.
- **No per-template versioned "official" lock yet.** Editing a template changes future generations; already-generated PDFs are immutable files and unaffected.

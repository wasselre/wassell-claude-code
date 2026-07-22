# PRD: Marketing Operations (Template-Driven Design Generator)

**Status:** ⛔ ARCHIVED (2026-07-22) — hidden from the UI in the dormant-module cleanup; data preserved
**Last updated:** 2026-07-22
**Related PRDs:** [templates-library.md](templates-library.md) (the design templates this module consumes — archived together), [record-management.md](record-management.md) (project lookup, section_mirror), [data-storage.md](data-storage.md) (Supabase + storage bucket)

## ⛔ ARCHIVED (2026-07-22) — read first

The Marketing Operations module was archived in the dormant-module cleanup (commit `203f410`): the `marketing_operations` model (along with its Designs-suite siblings `design_templates`, `image_presets`, `prompt_snippets`, `reel_scripts`, `competitors`) was added to `ARCHIVED_MODULE_MODELS` in `src/lib/featureFlags.ts`, hiding its sidebar entry and routing deep links to the "section archived" notice (`src/components/RetiredAssistantNotice.tsx`). **Non-destructive to data:** the model, all records, and the `marketing-assets` bucket contents remain in Supabase. Unlike the other archived modules, most of this module's code is **still in the repo** — the form fields live in the generic record form, and `api/marketing/generate.ts` + `api/_lib/imageGen.ts` are KEPT (they back the generic custom-button plumbing in `RecordFormPage` and are shared with icon generation). **Restore path:** `git revert 203f410` + remove `'marketing_operations'` from `ARCHIVED_MODULE_MODELS`. Everything below documents the feature as it existed when archived.

## What it is (in plain English)

A workspace where a marketer turns a project + a saved design template into a finished branded image. One record = one design generation.

The marketer:
1. Picks a project from `all_projects`. The project's information shows up read-only as a mirrored section.
2. Picks a template from the Templates Library. The template's variables (e.g. `{{PROJECT_NAME_AR}}`, `{{UNIT_SIZE}}`) appear as input rows.
3. Fills each variable either by typing manually or by linking it to a field on the chosen project.
4. Uploads the project's raw building photograph.
5. Clicks **Generate Design**.

Server-side, the app runs a two-phase Higgsfield orchestration: phase 1 cleans up the raw photo, phase 2 produces the final branded design. Both images land back on the record.

## Why it exists

The previous Marketing Operations module was an agent pipeline (5 Supabase Edge Functions, 11 seeded workflows, Claude-powered research + content generation). It was experimental, expensive to operate, and never settled into a flow the team used. This rebuild swaps the agent system for a deterministic template + image-generation pipeline so the marketing team can produce on-brand visuals quickly without prompt engineering.

The Competitors library — once an input to the agents — is preserved as a standalone reference (no longer wired into anything but still useful internally).

## Key behaviors

- **Project Info section is read-only.** Implemented via the existing `section_mirror` field type, pointing at the linked `all_projects` record's base section, with `edit_mode='none'`. Edits go to the project from the Builder, never from here.
- **Template variables are dynamic.** They aren't fixed schema fields — the `template_variables` field type renders one input row per variable defined on the linked template, at runtime. When the template changes, orphan keys are dropped and missing variables initialize empty.
- **Three ways to fill a variable: manual entry, project-field link.** AI auto-link is **deferred** to v2.
- **Mirror values resolve at generate time, not at fill time.** A user who picks `mirror → project.unit_size` stores `{ source: 'mirror', mirror_field: 'unit_size' }`. The server reads the live value from the project on Generate, so the latest value always reaches Higgsfield.
- **Substitution uses double-brace placeholders.** `{{NAME}}` only — single-brace `{NAME}` is reserved for legacy paseet workflows. Single source of truth at [src/lib/templateUtils.ts](../../src/lib/templateUtils.ts).
- **Phase 1 is skipped on re-run when inputs haven't changed.** A SHA-256 of `raw_photo URL + cleanup_prompt` is stored as `cleanup_input_hash`. Identical hash + existing `cleaned_photo` → re-Generate jumps straight to phase 2.
- **Status is the single source of UI truth.** The form's stepper reflects `record.data.status`: `draft → cleaning → generating → complete`, or `cleanup_failed` / `generation_failed`. The realtime subscription on `records` (already running in the store) updates the form mid-run with no SSE.
- **Errors fail loudly.** Higgsfield 4xx/5xx, network errors, or timeouts all write `status=*_failed` plus a human-readable `error_message` and surface a red toast. No silent swallows (CLAUDE.md "Silent Failures").
- **Stub mode for offline dev.** Set `HIGGSFIELD_API_KEY=stub` to skip the network and return canned `picsum.photos` URLs after a 2 s sleep — same UI flow, no API spend.

## User flows

1. **Happy path:**
   1. Sidebar → Designs → Marketing Operations → New.
   2. Pick a project → Project Info section auto-populates read-only.
   3. Pick a template from the Templates Library.
   4. Template Variables section renders one row per variable. Toggle each row to "Manual" or "Link to project field" and fill.
   5. Upload Raw Photo (image field; lands in `marketing-assets/raw/<uuid>.png`).
   6. Save the record.
   7. Click **Generate Design**. Status flips `cleaning` → cleaned photo appears → `generating` → final design appears → `complete`.

2. **Re-run after cleanup-input change:** edit the cleanup prompt on the template, return to the marketing record, click Generate. The hash mismatches → phase 1 reruns. If only the design prompt changed, the hash matches → phase 1 is skipped.

3. **Failure (Higgsfield 5xx):** status flips to `cleanup_failed` (or `generation_failed`), `error_message` is set, a red toast appears. Click Generate again to retry.

4. **Empty template:** picking a template with no variables renders the Template Variables section as "This template has no variables" — Generate still works (substitutes nothing).

## Data touched

- Reads:
  - `unified_records` (the marketing record itself, its linked template, its linked project)
  - `models` (schema for project field discovery, template variable list)
- Writes:
  - `record_save` RPC on the marketing record (`status`, `cleaned_photo`, `final_design`, `error_message`, `cleanup_input_hash`)
  - `marketing-assets` Supabase Storage bucket (raw photos via the form, cleaned + final via Higgsfield URLs we copy back if needed; v1 stores Higgsfield's CDN URL directly).

## Key files

| File | What it does |
|---|---|
| [src/data/seedModels.ts](../../src/data/seedModels.ts) | Seeds the `marketing_operations` model — sections, fields, custom Generate button. |
| [src/pages/Records/RecordFormPage.tsx](../../src/pages/Records/RecordFormPage.tsx) | Hosts the form. Custom-button click handler dispatches `generate_design` to `/api/marketing/generate`. |
| [src/pages/Records/components/TemplateVariablesField.tsx](../../src/pages/Records/components/TemplateVariablesField.tsx) | Renders the dynamic per-template variable inputs (manual / link toggle). |
| [src/pages/Records/components/DynamicField.tsx](../../src/pages/Records/components/DynamicField.tsx) | Image upload UI for `raw_photo` / `cleaned_photo` / `final_design`. |
| [src/lib/imageUpload.ts](../../src/lib/imageUpload.ts) | Wraps Supabase Storage `marketing-assets` bucket. |
| [src/lib/templateUtils.ts](../../src/lib/templateUtils.ts) | `substituteTemplate({{slug}})` + shared template-variable types. |
| [api/marketing/generate.ts](../../api/marketing/generate.ts) | Two-phase orchestrator. Loads record + template + project, resolves variables, runs the image generation, writes results back via `record_save`. **KEPT after the 2026-07-22 archive** (generic custom-button plumbing). |
| `api/_lib/higgsfield.ts` | **No longer exists** — the Higgsfield adapter was superseded by the fal.ai adapter `api/_lib/imageGen.ts` (KEPT; also used by icon generation). This PRD's Higgsfield prose predates that swap. |

## Open questions / known limitations

- **AI auto-link is not in v1.** Roadmap item: a button that asks Claude to map every template variable to a project field automatically.
- **Higgsfield request shape is best-effort.** Public docs don't fully specify Soul-ID, reference-image, and webhook params. Confirm against the sandbox before going live and adjust [api/_lib/higgsfield.ts](../../api/_lib/higgsfield.ts) accordingly.
- **Logo URL is derived from the deployment origin** (`{origin}/assets/logo-full.png`). On preview deploys with non-public domains, Higgsfield may not be able to reach the URL — workaround is to upload the logo to `marketing-assets/reference/wassel-logo.png` once and hardcode that URL.
- **Vercel timeout** is `maxDuration: 240`. Cleanup + design easily fit, but extreme cases (queues, retries) could time out — return surfaces as `generation_failed`.
- **Image bucket is public-read in v1.** If we later restrict, switch [src/lib/imageUpload.ts](../../src/lib/imageUpload.ts) to signed URLs (1 h TTL is plenty for review cycles).

# PRD: Marketing Operations (Reels + Posts)

**Status:** Live
**Last updated:** 2026-04-24 (edge functions now tracked in git — narrowed the gitignore to `supabase/functions/haberchat-webhook/`)
**Related PRDs:** `record-management.md` (project lookup), `data-storage.md` (Supabase), `workflow-automation.md` (webhook triggers + http_request action), `model-builder.md` (table field type)

## What it is (in plain English)

A Marketing area in the Wassell CRM where the team creates a "marketing
operation" for a real-estate project and gets back AI-generated reels
(short video scripts) and Instagram-style posts ready for human review.

The pipeline is **100% user-configurable** — there are no hardcoded
marketing tables and no hardcoded automation. Every marketing artifact
(operations, reels, posts, questions, competitors) is a regular record
in the generic `records` table, driven by a system-seeded model. The 5
AI agents are stateless edge functions that read records and POST
webhooks; user-editable workflows turn those webhooks into record
writes. Admins can edit the models in the Builder, re-wire the
workflows in the Workflows page, and never touch code.

## Why it exists

The original OMA pipeline lived in Google Sheets + Apps Script. The v1
Wassell port moved it into a dedicated Postgres schema with its own
pages, but the behavior was still locked into agent code. The v2
workflow-driven rewrite closes the last gap: the pipeline becomes
data — the same model-builder + workflow-engine users already use for
every other CRM feature.

## Key behaviors

- **Every artifact is a record.** `marketing_operations`, `reels`,
  `posts`, `research_questions`, and `competitors` are all regular
  system models defined in `src/data/seedModels.ts`. Create, edit, and
  list them via the standard `/model/<slug>` pages — no bespoke UI.
- **Agents are read-only on Postgres.** The 5 edge functions
  (`marketing-research`, `marketing-research-resume`,
  `marketing-content`, `marketing-reels`, `marketing-posts`) load the
  trigger record from the `records` table, run Claude, and POST
  webhook payloads into the app's own `/functions/v1/inbox/<slug>`
  endpoint. They never INSERT or UPDATE a record directly.
- **Workflows own all writes.** 11 seeded workflows (see
  `src/data/seedWorkflows.ts`) glue the pieces together:
  1. `on_create marketing_operations` → http_request marketing-research
  2. `on_update research_questions (status=answered)` → http_request
     marketing-research-resume (agent self-gates on "all answered")
  3. `webhook research-complete` → update operation + http_request
     marketing-content
  4. `webhook research-contradictions` → update operation status to
     `research_waiting_answers` + save partial research output
  5. `webhook research-question` → create one research_questions record
  6. `webhook reel-generated` → create one reels record
  7. `webhook post-generated` → create one posts record
  8. `webhook reels-ready` → flag `reels_batch_done=true` on operation
  9. `webhook posts-ready` → flag `posts_batch_done=true` on operation
  10. `webhook content-done` → operation status = `ready_for_review`
  11. `webhook operation-failed` → operation status = `failed`
     + capture error in `research_error`
- **Per-item webhooks fan out N records.** The workflow engine can't
  iterate arrays in a single action, so agents fire one
  `reel-generated` / `post-generated` / `research-question` webhook
  per generated item; the matching workflow's `create_record` action
  creates one record each.
- **Completion is agent-side.** `marketing-reels` and `marketing-posts`
  re-query the records table after their batch finishes; if both sides
  have enough child records, they POST `content-done`. This is the
  only piece of workflow logic that doesn't fit the declarative model
  (workflows have no aggregate/count primitives).
- **Re-entrancy guard on content.** `marketing-content` skips if any
  child reel/post already exists for the operation — protects against
  the research-complete webhook firing twice (clean research + resume
  research both land on the same slug).
- **Research table edits.** Facts, sources, notFound, confidence, and
  research_notes are stored as regular fields on the marketing
  operation record (facts and sources are `table` fields). Users edit
  them inline via the standard record form like any other record.
- **Competitors library is just records.** `/model/competitors` shows
  the same CRUD as any other model. Agents re-query it on every run via
  `loadCompetitors()` (`data.type='reel_script'|'post_example'`), with
  Anthropic prompt caching on the formatted block.

## Running pipeline

```
┌──────────────────────────────┐
│ User saves new operation rec │
└────────────┬─────────────────┘
             ▼
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│ WF: on_create marketing_ops     │───► │ fn: marketing-research       │
└─────────────────────────────────┘     │  - reads operation record    │
                                        │  - reads project record      │
                                        │  - runs Claude + web tools   │
                                        └────────┬─────────────────────┘
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          │                      │                      │
                          ▼                      ▼                      ▼
           webhook research-contradictions   webhook research-question  webhook research-complete
                          │                      │  (N times)           │
                          ▼                      ▼                      │
                 WF 4: update status      WF 5: create question         │
                                                                         │
                 (user answers questions)                                │
                          │                                              │
                          ▼                                              │
                 WF 2: on_update → fn: marketing-research-resume        │
                          │ (self-gates: only runs when all answered)   │
                          ▼                                              │
                          └────────────────────► webhook research-complete
                                                                         │
                                                                         ▼
                                                 WF 3: update operation + http_request marketing-content
                                                                         │
                                                                         ▼
                                                      fn: marketing-content fans out →
                                                                  ▼                    ▼
                                                     fn: marketing-reels     fn: marketing-posts
                                                       │    │                       │    │
                                                       ▼    ▼                       ▼    ▼
                                                     reel-    reels-ready         post-    posts-ready
                                                     generated    │               generated    │
                                                     (N times)    ▼               (N times)    ▼
                                                       │     WF 8: flag done         │     WF 9: flag done
                                                       ▼                              ▼
                                                     WF 6: create reel              WF 7: create post

(both agents re-count; when both sides complete)
                                                       │
                                                       ▼
                                                 webhook content-done
                                                       │
                                                       ▼
                                                 WF 10: status=ready_for_review
```

## User flows

1. **Main happy path**
   1. Open `/model/marketing_operations` → click **+ New**.
   2. Fill out the form: pick a project (lookup to all_projects), set
      reels count/type/platform/voiceover + posts count/type/usage.
   3. Save. `on_create` workflow fires marketing-research.
   4. Research completes → operation record gets `facts`, `sources`,
      etc. filled in via webhook → content workflow kicks off.
   5. Reels and posts records appear under the operation (via the
      `operation` lookup back-reference). Status flips to
      `ready_for_review`.
   6. Reviewer opens each reel/post record and edits freely. Flipping
      status to `approved` is a regular record save.
2. **Contradictions flow**
   1. Research finds conflicting sources → fires N `research-question`
      webhooks + one `research-contradictions` webhook.
   2. N research_questions records appear under the operation; status
      flips to `research_waiting_answers`.
   3. Reviewer opens each question record, fills in `answer`, flips
      `status` to `answered`.
   4. Each status change fires the resume workflow; only the FINAL
      answered-transition triggers real work in the agent (it checks
      "all answered" itself). The agent then fires
      `research-complete`, which re-enters the main flow.
3. **Failure**
   - Any agent catches an exception → fires `operation-failed`. The
     operation record status becomes `failed` with the error in
     `research_error`.

## Data touched

All marketing data lives in two generic tables:

- **`models`** — 5 system-seeded marketing models (is_system=true):
  `marketing_operations`, `research_questions`, `reels`, `posts`,
  `competitors`. Grouped under `MARKETING_GROUP_ID`.
- **`records`** — all user data, keyed by `model_id`. `data` is a
  JSONB blob keyed by field slug.
- **`workflows`** — 11 seeded pipeline workflows (deterministic ids
  `00000000-0000-4000-a000-00000000000X`) plus whatever the user adds.
- **`webhook_slugs`** + **`webhook_payloads`** — the inbound webhook
  infrastructure. 9 marketing-pipeline slugs are seeded via migration:
  `research-complete`, `research-contradictions`, `research-question`,
  `reel-generated`, `post-generated`, `reels-ready`, `posts-ready`,
  `content-done`, `operation-failed`.

No dedicated marketing tables exist anymore. The v1
`marketing_operations` / `reels` / `posts` / `research_questions` /
`competitors` / `marketing_notifications` tables were dropped in the
cutover migration (2026-04-23); the 10 legacy competitor rows were
migrated into `records`.

## Key files

| File | What it does |
|---|---|
| `src/data/seedModels.ts` | Defines the 5 marketing system models (competitors, marketing_operations, research_questions, reels, posts). Facts/sources/scenes are `table` fields on the operation/reels records. |
| `src/data/seedWorkflows.ts` | Builds the 11 pipeline workflows at runtime — resolves model ids + webhook slug ids from the loaded state and bakes the Supabase URL into http_request actions. Stable workflow ids so re-seeding is idempotent. |
| `src/stores/appStore.ts` | On `initialize()`, backfills missing workflows from `buildMarketingSeedWorkflows()`. Subscribes to `webhook_payloads` INSERTs so every inbound webhook fans out to the workflow engine via `claimAndRunWebhookPayload` (atomic; prevents multi-tab double-firing). |
| `src/lib/workflowEngine.ts` | Runs record-event and webhook-event workflows. Handles the `http_request` action (supports `{field_slug}` token substitution in URLs + bodies, fire-and-forget with AbortController timeout). `update_record` matches on top-level record id when `filter_field_id === 'id'`. |
| `supabase/functions/_shared/marketingOperation.ts` | Reads operation record from `records` into a flat `OperationRecord`. Also `getModelIdBySlug` (per-install model lookup) and `countChildRecords` (completion check). |
| `supabase/functions/_shared/competitors.ts` | Reads competitors from `records` table (model.name='competitors'), filters by `data.type`, formats the competitors block for the prompt. |
| `supabase/functions/_shared/projectData.ts` | Reads the project record from `records`; builds the research user message + markdown representation. |
| `supabase/functions/_shared/webhookOutbox.ts` | Fire-and-forget POST to `/functions/v1/inbox/<slug>` with `EdgeRuntime.waitUntil` so the isolate lives long enough for the request to land. |
| `supabase/functions/_shared/anthropic.ts` | Claude client + JSON extraction. |
| `supabase/functions/_shared/prompts.ts` | 4 agent prompts as string constants. |
| `supabase/functions/_shared/web.ts` | `fetch_url` tool schema + Deno implementation. |
| `supabase/functions/marketing-research/index.ts` | Research agent. Tool-use loop (web_search + fetch_url) + forced-tool retry on non-JSON output. POSTs `research-complete` (clean) OR `research-contradictions` + N × `research-question` (conflicts). |
| `supabase/functions/marketing-research-resume/index.ts` | Reads all research_questions records for the operation; noops if any are still unanswered. POSTs `research-complete` on success. |
| `supabase/functions/marketing-content/index.ts` | Orchestrator. Re-entrancy guard (skips if child records exist). Invokes reels/posts agents in parallel via `invokeFunction`. |
| `supabase/functions/marketing-reels/index.ts` | Reels writer. POSTs N × `reel-generated` + 1 `reels-ready` + optional `content-done` if posts side is also complete. |
| `supabase/functions/marketing-posts/index.ts` | Posts writer. Mirror of reels. |
| `supabase/functions/inbox/index.ts` | Generic webhook receiver. Verifies HMAC signature, inserts into `webhook_payloads`. The app's realtime listener claims + runs workflows. |
| `src/pages/Settings/WebhookSlugsPage.tsx` | CRUD for webhook slug definitions (name, slug, secret, payload schema). Agent slugs are seeded via migration but editable from here. |

## Open questions / known limitations

- **Deterministic model ids.** Model UUIDs are per-install — generated
  on first seed load. `buildMarketingSeedWorkflows` looks them up by
  `name` (slug) every init, so workflow seeding works across installs.
  The first app load on a brand-new Supabase project has to finish
  seeding models + webhook slugs before the workflow seeder can run;
  the ordering inside `initialize()` guarantees this.
- **Completion check lives in the agents.** Workflows can't aggregate
  record counts, so the "both batches complete?" decision is made by
  each content agent re-querying the records table. This is the
  single piece of non-declarative logic in the pipeline. A
  future `aggregate_condition` workflow primitive could move it
  out, but the ergonomics aren't obviously worth it.
- **Anon key RLS.** Workflows and webhook slugs are gated by the
  `authenticated full access` policy, so unauthenticated previews
  see zero seeded workflows. The seeder only runs once the user
  signs in and webhook slugs hydrate.
- **No tests yet.** Manual verification only. The engine's `http_request`
  + webhook-trigger paths would benefit from targeted unit tests.
- **Deploys are still CLI-only.** The marketing edge function sources
  are tracked in git, but no CI job builds or deploys them on merge.
  Updates currently require a manual `supabase functions deploy` or
  an MCP deploy call.

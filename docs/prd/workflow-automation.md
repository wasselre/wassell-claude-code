# PRD: Workflow Automation

**Status:** Live
**Last updated:** 2026-04-23 (**`http_request` action (new):** outbound HTTP call with method, URL, header pairs, JSON body template, and timeout. URL / headers / body support `{field_slug}` templating against the trigger record. Trace captures method, resolved URL, body snippet, response status + first 500 chars of the body. 4xx/5xx is logged as failed; network errors and timeouts as failed with the cause. Foundation for webhook-driven pipelines.) | 2026-04-22 (action-row min-widths reduced so condition rows wrap more cleanly inside the existing `flex-wrap` container on narrow screens — no behavior change, just mobile-friendliness) | 2026-04-20 (branching workflows: one trigger can now fan out into if / else-if / else arms, each with its own conditions + actions, rendered as a top-down tree in the editor)
**Related PRDs:** model-builder.md, record-management.md, access-control.md

## What it is (in plain English)
Workflows let users automate repetitive work without writing code. A workflow has a single **trigger** (what starts it — e.g. "a new Client record is created"), then a tree of **branches**. Each branch is an if / else-if / else arm with its own **conditions** (only run if X is true) and its own **actions** (do these things — send a notification, update a field, create another record, assign to someone). The engine walks branches top-to-bottom and runs the first one whose conditions all pass. It's like Zapier built into the CRM and aware of the user's models, with real branching so a single rule can express "if hot lead do A, else if warm lead do B, else do C".

## Why it exists
Real-estate teams have lots of standard follow-up rules: "when a new lead comes in, create a follow-up task and assign it to the sales lead who owns the region". Hardcoding these would not scale across customers, so we expose them as data.

## Key behaviors
- URL: `/workflow` (list), `/workflow/:workflowId` (editor).
- **Triggers** fire on record-level events on a chosen model: `on_create`, `on_update`, `on_delete`.
- **Branches (if / else-if / else)** are the new primary unit of control flow. A workflow always has at least one branch; the editor starts new workflows with a single branch. The user can add more non-else branches (each acts as an "else if"), and at most one final **else** branch that runs when no earlier branch matched. Branches are evaluated strictly top-to-bottom and short-circuit: once one wins, the rest are skipped. Each branch has an optional display name ("Hot lead", "Warm lead") that shows up in the editor and the run detail page.
- **Conditions** live inside a branch and are boolean checks over the triggering record's field values, AND-joined within the branch, supporting equals / not-equals / contains / intersects / greater / less / is-empty / in-list. `contains` treats arrays as supersets (left contains all of right) and falls back to substring for strings; `intersects` returns true when the two sides share at least one element (scalars are treated as singletons). A branch with zero conditions always matches (useful as a catch-all without using the explicit `else` branch).
- **"Only on change" condition mode** (per condition, only meaningful for `on_update`): when checked, the condition passes only on the false→true transition. Editing a record without flipping that condition does not re-fire the rule, which prevents duplicate runs from repeated saves while the condition remains true.
- **Actions** run sequentially and can:
  - Update a field on the triggering record
  - Update a record in any model: pick the target model, pick the field to search by, and give the match value. The match value has its own source toggle — either a **static value** (type it directly) or a **field on the trigger record** (pick from a dropdown). Example: a Follow-Up is created with `client_id = X`, and the workflow updates the matching Client record by searching `id = {trigger.client_id}`. **Lookup-aware matching**: when the trigger field used as the match source is a single lookup pointing at the target model, the stored value is the target record's internal UUID, so the engine matches by record id directly. The run detail page labels this with "Match strategy: by record id" so it's obvious why the match succeeded even though the configured filter field would never equal a UUID.
  - Create a record in another model (with field mappings from trigger record). Optional **"skip if exists"** guard: pick one of the mapped target fields as a dedup key, and the action will not create a duplicate when an existing target record already has the same value in that field.
  - Assign the record to a user, role, or dynamic role-field value (see access-control.md). When assigning by role, each role-field condition (the "where role fields equal…" row) can compare against either a **static value** or a **field on the trigger record** via a per-row source toggle. Example: find a sales consultant whose role `projects` field intersects with the client's `preferred_projects`. The full operator set (equals / not-equals / contains / intersects / greater / less) is available here too.
  - Send a notification (toast)
  - More action types can be added in `src/lib/workflowEngine.ts`
- **Field mapping value sources** for create/update actions: static value, field from the trigger record, current date, current user, trigger record ID, role variable (assignees only), **date expression** (only offered when the target field is `date` or `datetime`), and **formula**. A formula is a live computation written in the same grammar as the `formula` field type — `{field_slug}` tokens reference fields on the trigger record, and the expression supports basic math (`+`, `−`, `×`, `÷`), comparisons, and the `IF` / `CONCAT` / `DAYS` / `ADD_DAYS` / `ROUND` / `ABS` / `MIN` / `MAX` / `SUM` functions. Range fields expose `{slug.min}` and `{slug.max}` sub-tokens. The builder shows inline parse errors and flags unknown field refs. At run time the engine evaluates against the trigger record's `data`; error sentinels (`#ERR` / `#DIV0` / `#REF` / `#CYCLE`) resolve to `null` so records stay clean, and numeric strings are coerced to numbers when the target field is `number` or `currency`. Common use: compute a commission from `{price}`, pro-rate a fee from `{qty} * {unit_price}`, or concatenate a display label from several fields. A date expression takes a base date — either the current date or a date field on the trigger record — and applies one or more offsets. Each offset is built in the UI from three controls: an operation dropdown (add `+` / subtract `−`), a number input, and a unit dropdown (minute, hour, day, week, month, year). The user can chain multiple offsets via "+ Add offset", and they are serialized to a string of tokens like `+5d`, `-2w`, `+3mo`, `+1y`, `+2h`, `-30min` joined by spaces (e.g. `+5w -2h`). The engine parses the tokens and writes the result formatted for the target field type: `YYYY-MM-DD` for `date`, `YYYY-MM-DDTHH:MM` (local time) for `datetime`, so the HTML form inputs re-hydrate it correctly. `current_date` is formatted the same way.
- **Execution** happens client-side right after the record save resolves. The workflow engine walks triggers, evaluates conditions, runs actions, and surfaces toasts on success/failure.
- **Enable/disable** toggle per workflow — disabled workflows don't fire.
- **Workflow can be bilingual** — Arabic/English name and description.

## User flows
1. **Create workflow:** `/workflow` → "+ New Workflow" → editor opens showing the trigger panel plus one empty branch card below.
2. **Configure trigger:** Pick a model + event (create/update/delete).
3. **Fill the first branch:** Optionally name the branch. Add conditions ("+ condition" — field / operator / value) and actions ("+ action" — pick type, fill config).
4. **Add more branches (optional):** "Add branch (else if)" inserts another branch after the last non-else branch. "Add default case (else)" pins a trailing else branch that runs when nothing else matched. Each branch card can be collapsed to a one-line summary once its body gets long.
5. **Save & enable:** Toggle "Enabled" → save → from now on, matching record events fire the workflow and the engine picks the first winning branch.
6. **Debug a workflow:** Disable, trigger manually via record edit, re-enable when fixed. Open a run in the log to see the full branch trace — which arms were evaluated, which passed, which won.

## Data touched
- Reads/writes: `workflows` table (definition as JSONB).
- Reads: `models`, `records` (to evaluate conditions and run actions).
- Writes: `records` (when an action creates/updates records).

## Key files
| File | What it does |
|---|---|
| `src/pages/Workflow/WorkflowListPage.tsx` | List of all workflows (shows branch + action counts per rule) |
| `src/pages/Workflow/WorkflowEditorPage.tsx` | Trigger + branch tree editor — vertical flow with one branch card per arm |
| `src/pages/Workflow/components/TriggerPanel.tsx` | Trigger picker (model + event) |
| `src/pages/Workflow/components/BranchCard.tsx` | One if / else-if / else arm — wraps a condition list + action list |
| `src/pages/Workflow/components/ConditionList.tsx` | Condition builder (embedded inside a branch card) |
| `src/pages/Workflow/components/ActionList.tsx` | Action builder (embedded inside a branch card) |
| `src/pages/Workflow/components/FieldValueInput.tsx` | Type-appropriate value input for conditions |
| `src/lib/workflowEngine.ts` | Executes workflows after record mutations; walks branches top-down, first match wins |
| `src/lib/fieldRename.ts` | Propagates slug renames across both legacy flat conditions/actions and every branch |
| `src/types/index.ts` | `Workflow`, `WorkflowBranch`, `WorkflowCondition`, `WorkflowAction`, `WorkflowBranchTrace` |
| `src/stores/appStore.ts` | `workflows` state, `saveWorkflow`, `runWorkflowsForEvent` |

## Open questions / known limitations
- No scheduled/cron triggers yet (only record events).
- No webhook triggers.
- Execution logs now exist — see `docs/prd/workflow-logs.md` — capped at 500 most-recent runs per installation.
- Loops / recursion protection is bounded by a depth limit (3) in the engine and by the per-condition "only on change" mode, but cycles between two workflows that flip each other's fields are still possible.

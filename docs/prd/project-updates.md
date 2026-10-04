# PRD: Automated project updates (portals + developer WhatsApp groups)

**Status:** Live (Riva portal weekly; WhatsApp groups of Al-Ramz, Safa, Riva)
**Last updated:** 2026-10-04
**Related PRDs:** projects-units.md, chats.md, lead-portal-registration.md, data-migration.md (archived wizard)

## What it is (in plain English)
Every project in the update list (تحديثات الوحدات, `unit_updates`) is kept current without anyone running it by hand. Two sources feed it:

- **Broker portals** — once a week the worker signs in to the developer's / marketer's broker portal, reads every unit, and brings the CRM in line: status (available / reserved / sold), price, newly released units with their floor plan. A project on the portal that the CRM has never seen is **created** (project + units + its own row in the update list).
- **Developers' WhatsApp groups** — the operations line sits in the broker groups of Al-Ramz, Safa and Riva. Every new message there (with its PDFs and images) is read a few minutes after it arrives. Bookings («ريا النخيل مبنى 6 | شقة 2»), available-unit price lists, "only these are left" notes, commission / handover / payment-plan terms and new projects become CRM changes.

Nothing waits for approval. Every change is recorded with its old and new value, so any run can be undone in one call.

## Why it exists
On 2026-10-04, 34 of the 37 active projects in the update list were past their update date: the weekly refresh was a manual Claude session following each project's `migration_instructions`, and developers' WhatsApp updates were applied only when someone read them. Reps were quoting prices and availability that had changed weeks earlier (Aknan 23 had dropped ~20% on the portal; four Raya Al-Nakheel bookings announced on 13–17 Sep were still "available").

## Key behaviors
- **One reconciler for every source.** A source only fetches + parses into a common snapshot; `reconcile.ts` decides what changes. Units are matched on, in order: our unit code (U-n) / the source's own unit id (`developer_unit_code`, e.g. `RIVA-901`), the unit title, block + number, building + number, block + building + floor, building + floor — each used only when it points at exactly ONE unit on both sides. A unit that matches two is reported as ambiguous, never guessed.
- **The source's status wins; prices only from a real price.** A source showing no price («عند الطلب») never clears ours. A "starting from" headline is never written as a unit price.
- **Units missing from a source:** a portal that hides cards → left alone. A complete "available units" list → units it does not list become sold, but **only inside the buildings / blocks the list's own rows name** (a list for buildings 1+2 never sells building 3).
- **Per-project scope** (`unit_updates.auto_scope`): `full` (default) · `status_only` — the portal is secondary: status moves only forward, no prices, no new units (ستون الندى: Al-Ramz's own price files lead, Riva's portal lags) · `off`.
- **Chat bookings move status only forward** (a booking cannot un-sell a unit). A portal-led project takes bookings and terms from its group but not price lists (the portal is the source of truth); `status_only` projects take the chat's lists.
- **Safety brake, not approval:** a project whose run would flip more than half its units (≥ 6) to sold/reserved, or a scrape that returns no units for a project that has some, is HELD — nothing written, a ⛔ line in its update log, retried the next day.
- **Grounding of the WhatsApp reader (enforced in code):** each item must cite the messages it came from and quote the text verbatim (normalised) unless it comes from an attached file; the project must be one of the group's own developer/marketer's projects; the model never picks a CRM unit — it only transcribes identifiers.
- **New projects** are created from what the source states (portal: the broker share text — district, developer, type, public page; licence; description) plus the house fields of a sibling project (marketer, city/region, classification). A name that matches or contains an existing CRM project is reported, never duplicated (Riva's «جديل الرمال» = our «أدوار جديل الرمال»). New projects are **not** added to `our_projects` — publishing to wassel.re stays a human decision.
- **Groups stay outside the sales funnel** (already true in `api/webhook/waha.ts`): no bot reply, no lead, no follow-up task from a developer group.
- **Ended terms are dropped** (a commission or offer whose period is over is history, not an update).

## User flows
1. **Weekly portal run:** the worker's scheduler (every 10 min, every machine; idempotent) queues `schedule:riva_broker` when any active Riva project is due → sign in → list portal projects → per project scrape + reconcile + brake + apply → stamp `last_migrated_at`, `next_due` (+7 days), a line in `migration_log`, and `all_projects.last_source_update`. New portal projects are created; registered projects missing from the portal are reported (retirement stays manual).
2. **WhatsApp message:** a group message arrives → trigger queues `wa:<group>` 3 minutes out (pushed back by each new message, max 15 min) → the worker waits for any PDF/image still being saved → one Claude read of the batch → validate → apply → advance the group's `read_through`.
3. **Undo:** `select project_update_revert('<run id>')` restores every value the run changed (only where the record still holds what the run wrote — a later human edit is kept) and deletes what it created.
4. **Dry run:** `select project_update_enqueue('<source>', '<key>', 'manual', true, '{...}')` — the summary shows exactly what a live run would change, nothing is written. A WhatsApp catch-up uses `params.since` (no watermark move) and optionally `params.only_kinds`.

## Data touched
- `project_update_settings` (kill switch, `scheduled_sources`, brake thresholds, `whatsapp_enabled`, debounce)
- `project_update_runs` (queue + summary), `project_update_changes` (before/after per record), `project_update_code_hwm` (U-/م ش code allocator)
- `project_update_groups` (group → company ids, `read_through`)
- Writes `records` via `record_save`: `units` (status, price, `developer_unit_code`, new units + `unit_plan`), `all_projects` (`last_source_update`, `internal_sales_notes`, `handover_date`, new projects), `unit_updates` (stamps, log, new rows); `files` + `wassel-files` storage for plans
- Reads `lead_portals` (portal login), `chat_messages` + `whatsapp-media/` (group messages and files), `inbound_media_jobs`
- AI: `claude-opus-5-5` through `trackedAnthropic` (area `sales`, call site `worker/projectUpdates/whatsapp`)

## Key files
| File | What it does |
|---|---|
| `supabase/migrations/2026-10-04_10_project_update_engine.sql` | queue, changes + revert, scheduler, code allocator |
| `supabase/migrations/2026-10-04_11_unit_updates_auto_scope.sql` | `auto_scope` field, `whatsapp_group` source option |
| `supabase/migrations/2026-10-04_12_project_update_whatsapp.sql` | groups table, debounce trigger on `chat_messages`, defer/sweep/advance RPCs |
| `worker/src/runProjectUpdateJob.ts` | the run: Riva portal loop, new-project discovery, stamping, dispatch |
| `worker/src/projectUpdates/reconcile.ts` | the one reconciler + safety brake |
| `worker/src/projectUpdates/riva.ts` | Riva broker portal: login, scrape, parse |
| `worker/src/projectUpdates/whatsapp.ts` | WhatsApp group reader |
| `worker/src/projectUpdates/newProject.ts` | create a project + units + registry row |
| `worker/src/projectUpdates/apply.ts` | writes + change log + plan upload |
| `worker/src/__tests__/projectUpdates.test.ts` | rules above, pinned |

## Open questions / known limitations
- **Only Riva is on the weekly portal schedule.** Safa (broker portal with SMS code + public site), Menaco, Almajdiah's API, Binghatti's portal and Al-Ramz's Drive sheets still need their adapters; their projects keep the manual recipe until then.
- A Riva project that leaves the portal is reported, not retired (retirement removes it from the website — a human decision).
- WhatsApp videos and PowerPoint files are not read (only text, PDFs and images).
- A "complete" list without building/block numbers is skipped (it cannot say which units it covers).

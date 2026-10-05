# PRD: Automated project updates (portals + developer WhatsApp groups)

**Status:** Live — Riva portal, Almajdiah API and Safa (portal snapshot + public site) weekly; WhatsApp groups of Al-Ramz, Safa, Riva. Al-Ramz portal being explored; Binghatti blocked (reCAPTCHA).
**Last updated:** 2026-10-05
**Related PRDs:** projects-units.md, chats.md, lead-portal-registration.md, data-migration.md (archived wizard)

## What it is (in plain English)
Every project in the update list (تحديثات الوحدات, `unit_updates`) is kept current without anyone running it by hand. Two sources feed it:

- **Broker portals** — once a week the worker signs in to the developer's / marketer's broker portal, reads every unit, and brings the CRM in line: status (available / reserved / sold), price, newly released units with their floor plan. A project on the portal that the CRM has never seen is **created** (project + units + its own row in the update list).
- **Developers' WhatsApp groups** — the operations line sits in the broker groups of Al-Ramz, Safa and Riva. Every new message there (with its PDFs and images) is read a few minutes after it arrives. Bookings («ريا النخيل مبنى 6 | شقة 2»), available-unit price lists, "only these are left" notes, commission / handover / payment-plan terms and new projects become CRM changes.

Nothing waits for approval. Every change is recorded with its old and new value, so any run can be undone in one call.

## Why it exists
On 2026-10-04, 34 of the 37 active projects in the update list were past their update date: the weekly refresh was a manual Claude session following each project's `migration_instructions`, and developers' WhatsApp updates were applied only when someone read them. Reps were quoting prices and availability that had changed weeks earlier (Aknan 23 had dropped ~20% on the portal; four Raya Al-Nakheel bookings announced on 13–17 Sep were still "available").

## Sources
| Source (`source_type`) | How it is read | Status |
|---|---|---|
| Riva broker portal (`riva_broker`, 21 projects) | plain-HTTP sign-in with the `lead_portals` Riva login; unit JSON in each card | weekly, live |
| Almajdiah API (`developer_api`, 10 projects) | public `etmaam.almajdiah.com/api/client/v1/projects/<id>` — every unit with its real status; price = `price_before_tax` | weekly, live |
| Safa (`safa_broker`, 12 projects) | public `safainv.sa/project/units/<id>` + the broker cards the portal's DAILY STATUS CHECK saves (`save_items` step → `portal-registrations/inventory/<portal>/units.json`; one SMS code a day through the WhatsApp relay covers both) | weekly, live (first live run 2026-10-05: 179 units created for صفا 101/102; 4 projects held) |
| Developer WhatsApp groups | Claude Opus 5.5 reads new messages + PDFs/images | live |
| Al-Ramz Drive sheets | the Drive FOLDER is not publicly listable (only single files are) | not automatable as is — Al-Ramz updates arrive through the WhatsApp group; the Al-Ramz broker portal's projects page is captured daily (`save_items` key `projects`) to see whether it carries units |
| Binghatti broker portal | sign-in = user id + SMS code + Google reCAPTCHA | **not automated by design** — we don't build automation around a CAPTCHA |

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
- **Almajdiah:** a complete source — its status wins both ways; units it does not list are reported, not touched. Identity = the full unit code where the API uses one (`TY01-H-0-1`), else building + number; مكانة carries `developer_unit_code = MAJD-<id>` (mapped once 2026-10-04, every pair's area agreed).
- **Safa:** neither source shows sold/reserved, so "absent from BOTH lists → sold" applies only when the broker snapshot is < 36 h old AND the public site returned units for at least one project in the run (a soft-blocked public site answers «لا توجد نتائج» for everything — that must never read as "sold out"). Prices come ONLY from broker cards (the public price is on another basis — VAT / discount); a public-only new unit is created without a price, the public figure in its notes. A unit WE marked reserved is never flipped back to available by a list that cannot show reservations (`keepReserved`).
- **A source that shares NO unit with the CRM is held** (≥ 5 units each side) — a wrong project link or a different numbering, not a reason to stack a second inventory (دروازة: the API lists Block 1, our 22 units are Blocks 3–4).
- **Safa card facts (verified on the real snapshot, 2026-10-05):** the code is `.unit-title` in two formats («SF085-A01-F01-001-APT», and «299-C5-4-41» for صفا 101/102); the price is the «السعر:» line, never the «مبلغ العمولة:» line; floors come as GF/FF/SF/TF/RF/4F…/«سَطح»/Arabic ordinals; a card without a price is a not-yet-on-sale unit → under construction. **Existing Safa prices are REPORTED, not written** (`price_diffs_sample` in the run summary): the card price is not on one basis with ours (صفا 80: ours +5% on 28 of 31 units, صفا 85: equal) until a person settles which price we store. New units take the card price; their unit type stays empty when the card does not state it.
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
| `worker/src/projectUpdates/almajdiah.ts` | Almajdiah public units API |
| `worker/src/projectUpdates/safa.ts` | Safa public site + broker snapshot, union, freshness/health guards |
| `worker/src/portals/recipe.ts` (`save_items`) | the status-check step that saves a portal's unit cards |
| `supabase/migrations/2026-10-04_13_register_almajdiah_updates.sql` | Almajdiah projects in the update list |
| `supabase/migrations/2026-10-04_14_safa_status_check_saves_units.sql` | Safa / Al-Ramz status recipes save their pages |
| `worker/src/projectUpdates/whatsapp.ts` | WhatsApp group reader |
| `worker/src/projectUpdates/newProject.ts` | create a project + units + registry row |
| `worker/src/projectUpdates/apply.ts` | writes + change log + plan upload |
| `worker/src/__tests__/projectUpdates.test.ts` | rules above, pinned |

## Open questions / known limitations
- Menaco (2 projects) has no adapter yet. Binghatti (43) cannot be signed into unattended (reCAPTCHA) — options: someone downloads its all-units Excel weekly and the system ingests the file, or a human-assisted sign-in. Al-Ramz's Drive folder is private; its updates come through the WhatsApp group.
- دروازة's update-list link points at a different phase than our units (held every week until the link is fixed).
- A Riva project that leaves the portal is reported, not retired (retirement removes it from the website — a human decision).
- WhatsApp videos and PowerPoint files are not read (only text, PDFs and images).
- A "complete" list without building/block numbers is skipped (it cannot say which units it covers).

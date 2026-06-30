# PRD: Sales Rep Workspace (My Clients + My Tasks)

**Status:** Live
**Last updated:** 2026-06-30
**Related PRDs:** access-control.md, clients-cockpit.md, followups-workspace.md, sales-process.md, record-management.md

## What it is (in plain English)
A simplified, profile-assignable workspace for sales representatives — two pages that replace the full internal admin-style CRM for day-to-day selling. **My Clients** is a clean, tabbed sales list of the rep's own clients (with strong search/filters and a situational card per client). **My Tasks** organizes the rep's daily work: today's follow-ups, late follow-ups, a placeholder for incomplete-preference tasks, and the rep's other tasks. An admin/manager grants the workspace to a sales profile in Settings → Profiles; reps then see only their own clients and tasks, while managers/admins see everyone (with a rep filter / "All reps" toggle). Both pages reuse the existing Client 360 detail and Follow-up Workspace for click-through — only the index/listing surfaces are new.

## Why it exists
The generic model UI and the full Clients/Sales cockpits expose far more than a rep needs and aren't scoped to "my" book of business. Reps needed a focused operating screen: who are my clients, what state are they in, and what do I have to do today — without opening ten records.

## Key behaviors
- **Profile-assignable, opt-in.** Both pages are registered in `src/lib/customPages.ts` as custom (non-model) pages with `default_access: 'admin'` — hidden until an admin grants `my_clients` / `my_tasks` to a profile via the Sales Operations card. Registering the `CUSTOM_PAGES` entry auto-wires the Sidebar link, the `PageAccessMatrix` toggle, and the `RequirePageAccess` route guard. No migration — keys live in the existing `profiles.page_access` JSONB.
- **Self-scoping.** Reps see clients where `client_owner` === their user id and follow-up/other tasks where `sales_rep` / `responsible_officer` (or creator) === their user id. Managers/admins (`is_admin`) see all and get a rep/owner filter (My Clients) + an "All reps" toggle (My Tasks). Server-side RLS remains the trust boundary; this is a UX scope on top.
- **My Clients tabs** (a client can appear in several): **All / Old Customers** (everyone assigned); **Interested** (active early-funnel — no visit, no appointment, no offer, no reservation, not a serious stage); **Serious** (booked an appointment, visited, asked for / received an offer, has a reservation, or sits in a serious stage — junk like wrong-number/duplicate excluded); **Active** (not lost / unqualified / inactive-status / closed); **Late** (has a follow-up scheduled before today, not completed); **Unqualified / Inactive** (lost / unqualified / not-interested / cold / long-no-response).
- **"Late" is calendar-day-strict.** A follow-up is late only when its scheduled day is strictly before today AND it isn't done (completed/cancelled/skipped). A task scheduled *earlier today* is still today's task, never late — matches the Sales Queue's `computeSla` overdue rule.
- **My Client card** shows: Client ID (the `client_id` auto_id), name, phone, stage, status, assigned rep, lifecycle-health badge, visit-rating stars, latest follow-up type + outcome, next scheduled follow-up (with overdue emphasis), and a related-records summary (appointments / visits / offers / reservations counts). Quick actions: open next follow-up, in-app WhatsApp, call. Clicking the card opens the existing Client 360 (`/model/clients/:id`).
- **My Tasks sections:** **Today's Follow-ups** and **Late Follow-ups** each split into **Calls** vs **Conversations** sub-tabs (channel resolved from the follow-up type's `primary_channel`; `whatsapp_follow_up` / `rating_request` → Conversations, `*_call` → Calls). **Incomplete Client Preferences** is an intentional empty-state placeholder (logic deferred). **Other Tasks** lists the rep's open `tasks` rows (not completed/approved), with a "New task" button when the rep has create permission on the Tasks model.
- **Conversation cards** surface the WhatsApp sub-state: no state yet → "Message to send"; `message_sent_waiting_response` → "Waiting for reply"; `replied` → "Replied"; plus a colored channel accent (green WhatsApp / copper Call / red Overdue) for fast scanning.
- **Reuse:** follow-up cards open the Follow-up Workspace (`/model/followups/:id?returnTo=…`); WhatsApp uses the shared in-app popup (`useClientWhatsApp`); filters reuse the Clients cockpit's `ClientsFilterBar` + `ClientFilters` (owner/rep dropdown hidden for reps via the new `hideOwner` prop).
- **States:** loading (until store `initialized`), per-tab/section empty states, a "no clients assigned to you yet" empty state, and a "Clients/Tasks model unavailable" guard.

## User flows
1. **Assign the workspace:** admin → `/settings/profiles/:profileId` → Sales Operations card → check **My Clients** + **My Tasks** → Save. Reps on that profile immediately get both sidebar links + route access.
2. **Work my clients:** rep opens **My Clients** → picks a tab (e.g. Late) → searches/filters → clicks a client → handles them in Client 360 → returns.
3. **Work my day:** rep opens **My Tasks** → Today's Follow-ups → Calls → taps Call (or Conversations → WhatsApp) → opens the follow-up to log the outcome → moves to Late Follow-ups.
4. **Manager view:** an admin opens either page → sees all reps' data → uses the rep/owner filter (My Clients) or the "All reps" toggle (My Tasks).
5. **Empty state:** a rep with no assigned clients sees "No clients are assigned to you yet"; an empty tab/sub-tab shows a contextual empty message.

## Data touched
- Reads: `records` for `clients`, `followups`, `tasks`, `visits`, `appointments`, `offer_prices`, `reservations`, `phone_calls` (all via the store; RLS-scoped). `models.schema` for field options (stages/statuses/follow-up types/task status). `profiles.page_access` for the access gate.
- Writes: none directly — creating a task routes to the generic `tasks` create form; logging a follow-up happens in the Follow-up Workspace.

## Key files
| File | What it does |
|---|---|
| `src/pages/Sales/MyClientsPage.tsx` | My Clients page — tabs, filters, rep scoping, list |
| `src/pages/Sales/MyTasksPage.tsx` | My Tasks page — 4 sections, Calls/Conversations sub-tabs, Other Tasks, rep scoping |
| `src/pages/Sales/components/MyClientCard.tsx` | Situational client card (id/name/phone/stage/status/rep/latest+next action/related summary/quick actions) |
| `src/pages/Sales/components/FollowupTaskCard.tsx` | Follow-up task card (channel action button, type/objective, schedule, status/WhatsApp-state/outcome pills) |
| `src/pages/Sales/lib/myWork.ts` | Channel classifier, day bucket (late/today/future), follow-up task builder, per-client follow-up summary index |
| `src/pages/Sales/lib/salesClients.ts` | Related-counts index, tab predicates (interested/serious/active/late/unqualified), enrich, per-tab counts |
| `src/pages/Sales/lib/__tests__/*.test.ts` | Unit tests for the lateness rule, channel split, tab predicates, related-counts index |
| `src/lib/customPages.ts` | Registry entries `my_clients` / `my_tasks` (route, label, icon, `default_access: 'admin'`) |
| `src/pages/Clients/lib/clientView.ts`, `clientFilters.ts`, `components/ClientsFilterBar.tsx` | Reused client resolver + filter logic + filter bar (gained a `hideOwner` prop) |
| `src/pages/Clients/lib/useClientWhatsApp.tsx`, `components/ClientQuickActions.tsx`, `components/clientChips.tsx` | Reused in-app WhatsApp popup, quick actions, chips |

## Open questions / known limitations
- **Incomplete Client Preferences** is a deliberate empty-state placeholder; the detection logic (which preference fields count as "missing") is not built yet.
- Tab membership is intentionally non-exclusive (a serious client can also be late). Counts on the tab badges reflect the current field-filter context.
- Manager scope follows `is_admin`; there is no separate "team lead sees their team only" tier yet — managers see everyone.
- Resolving the full client list each render mirrors the existing Clients cockpit; if the client count grows substantially, consider a lighter resolver that skips the unused per-client counts inside `resolveClientView`.

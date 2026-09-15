# The Monthly Operating Model — a simplification proposal

**Status:** Proposal, with the operating rules settled in discussion on 14 and 15 September 2026. Not implemented. **Date:** 2026-09-15.
**The question this answers:** how can choosing three projects automatically create and operate an entire reliable month of paid and organic marketing with the least possible human planning?

Everything below is grounded in a read of the live application on 2026-09-14: 35 routes, 28 pages, 70 components, 16 settings screens, the production database, and the four workers that run behind it. Where a number appears it was measured, not estimated; where a claim is a judgement it is marked as one.

---

## 0. The three facts that decide everything

Before the map, three measurements that reframe the whole question.

**1. The system has never run at the volume the monthly model requires.**
The Marketing OS is two months old in production. Lifetime totals: 24 content records, 6 campaigns, 10 publications, 42 ads. The stated monthly model is 54 organic posts plus 60 paid creatives in October, about 114 items. That is four to five times the entire lifetime usage, every month. A workflow that asks a person to create each item by hand cannot survive that. The monthly model is not a nice-to-have on top of the current app; it is the only way the current app could ever be used at the intended scale.

**2. The team is one writer, one manager, and one designer.**
Role holders in production: one marketing manager (you), one writer, one designer, and nobody at all holding the operations role that owned every publish check until three days ago. A second montage account exists under your own name and is not a second designer. Five roles were designed; one carries every approval and two carry nothing.

**3. Capacity is three numbers, and the month fits.**
Capacity is counted the way you count it: how many tasks each person finishes in a day, times the working days in the month. There is no "days per task". A video counts as more than one slot, set once in settings. October has 26 working days with Friday off.

| Who | Per day | October needs | Average per day | Load |
|---|---|---|---|---|
| Writer (post and caption are one task) | 10 | 114 | 4.4 | 44% |
| Designer | 4, a floor they exceed | 114 | 4.4 | 110% of the floor |
| Marketing manager, two approvals per item | no limit, by decision | 228 | 8.8 | fits |

The writer has room. The designer is at the floor with about ten designs over the month, which you have said they absorb. You approve about nine items a day, every working day, and you have chosen not to cap that. So the month fits the current team.

Two things follow. The engine I built last week counts capacity with two knobs, slots per day and days per task, and I had seeded days per task at two for design; that silently halved the designer's throughput and produced a false "does not fit". The month screen must count throughput per person per day, one number each, and show the daily average next to the floor so you judge it yourself. And the one dependency no number removes is that every item passes through you twice; that is a fact about the design of the workflow, not a capacity problem.

---

## 1. How the current app actually works

### 1.1 The map

```
/m  (35 routes, 19 rail items, 16 settings screens)
│
├─ PLANNING       Campaigns → wizard (3 steps, ~30–55 controls) → approve → shell
│                 Goals (mandatory before any campaign)
│
├─ PRODUCTION     Content list ⇄ Content detail (5 tabs) ⇄ My work ⇄ Team
│                 Workflow: writing → writing review → design → writer review → final approval
│                 Tasks: workflow_role_tasks (by role) + mos_manual_tasks (6 kinds)
│
├─ PUBLISHING     Publish tab (per platform, per publication) → Publishing board → Release page
│                 Release sweep: hands due posts to bundle.social, raises a task only when a person is needed
│
├─ PAID           Execution (Meta plan: 7 fields) → Ad sets → Ads → worker builds the Meta ad (PAUSED)
│                 Weekly refresh: ranks creatives, opens a decision task that has no screen
│
├─ REPORTING      Overview · Analytics · Weekly numbers · Platform pulse · My profile · Performance desk
│
├─ PROJECT FILES  Content inventory · Content readiness   (about project files, not content)
│
└─ SETTINGS       People · Roles · Access · Workflows · Content types · Load & SLA · Capacity & calendar
                  · Cadence · Platforms · Audiences · Measures · Notifications · Brand kit · Writer rules
                  · AI roles · Creative flags
```

Behind it: four background lanes (Meta ad builder, weekly refresh, planning sweep, release sweep), a hand-maintained twin of the Meta client in the worker, and 152 `mos_*` object references in live code.

### 1.2 The journey of one organic post today

| Step | Who | Where |
|---|---|---|
| Create the content row | anyone with `write_content` | New content modal: title, type, projects, campaign, date, platforms |
| Write | writer | My work → content tab: idea, hook, message, headlines, caption, hashtags, brief, references |
| Confirm the caption | writer | a checkbox on the same card |
| Submit | writer | button |
| Review the writing | manager | one of six approval surfaces |
| Design two files | montage | materials tab: square 1:1 and vertical 9:16 |
| Sign off the design | writer, again | approval |
| Final approval | manager, again | approval, with ad preflight if paid |
| Schedule the post | someone | publish tab, per platform: account, files, date, time, caption override |
| Publish or confirm | someone | release page, only if a person is needed |

Seven human touchpoints across three people for one post, with the writer and the manager each appearing twice. Cross-post to three platforms and the scheduling step happens three times. **Nothing owns the scheduling step**: the workflow ends at approval, and an approved post that nobody dated sits invisible in a draft filter that is not the default. The publishing board's own empty-state copy admits this.

### 1.3 The journey of one paid campaign today

To reach an approved plan: 5 to 7 surfaces, 4 to 5 blank required inputs, around 30 controls for paid and around 55 for organic once frequency and per-project quantity cards expand.

Then the part the wizard does not do. Approving a plan creates a **shell**: each platform campaign is an unnamed draft with a blank Meta plan, zero ad sets and zero ads. A person then opens the execution modal and fills seven blank fields (objective, budget mode, budget, destination, optimisation goal, start, end), two of which the commit already wrote onto that same row. Then a tree modal for ad sets, then an ad modal for creative fields the tree modal does not show. Ten to twelve distinct screens to a campaign that can actually run. This reverses a decision you made on 20 August, recorded in the product document, that a paid campaign may never be created as an empty envelope; the only code that enforced it lives in a builder that is now unreachable.

Then the part nothing does. Every ad the worker builds is created **paused**, and there is no control anywhere in the app that activates one. The function exists in the client with zero callers. Every automated ad ends in Ads Manager anyway.

Then the weekly refresh. It runs every minute, ranks creatives correctly on real Meta numbers, opens a decision task for you every week, and routes it to a screen that does not exist. The list and decide functions exist server-side with zero callers. With automatic application switched off, no cycle can ever complete. They accumulate in `deciding` forever.

### 1.4 What is genuinely good and must survive

These took real effort against a real external system and cannot be rebuilt cheaply:

- **The Meta integration core**: the 83-key enhancement opt-out list, the only creative shape Meta accepts for Click-to-WhatsApp, base64 image upload, the feed/story ad-set pair, the asynchronous policy-verdict poll, the transient-versus-permanent error table, the full-undo build closure, the welcome-template duplication, the 255-character name cap, the 20 SAR minimum, and the rollback of a partial push.
- **The creative ranking**: pure, unit-tested, cost per lead computed the right way round, fatigue detection, sound data gates.
- **The workflow engine**: pinned versions, role-owned tasks, one open task per subject, advance-on-close, revision targets. Not elegant, but correct and load-bearing.
- **The scheduling engine**: working-day calendar, backward scheduling from the publish date, the single capacity ledger, sound infeasibility proofs, the concurrency-safe commit. Built last week for the wrong shape of problem, but the algorithm is exactly what a month compiler needs.
- **The release split**: content ends at approval; a release is one destination on one date; a task appears only when a person is needed.
- **The content record itself** and its approval locks, asset links and caption hashes.
- **bundle.social publishing** and its status sync.
- **The competitor intelligence system** (`mkt_*`, 120,000 ingestion runs). A different product sharing the app. Untouched by this proposal.
- **The ad-to-WhatsApp-to-client attribution chain**, which is how marketing reaches sales.

---

## 2. Where the complexity actually comes from

Not from any one bad decision. From four structural mistakes repeated across the app.

### 2.1 The app models a general agency, not this company

Every layer is built to express any campaign for any client on any platform with any frequency and any policy. That generality is what the 30 to 55 wizard controls are for. But this company runs one shape: three projects, one paid campaign each for a month, five creatives a week each, one Instagram row per project per week plus one general row. That shape has no parameters worth asking about. Modelling it as "a campaign with requirements" is why a constant became a form.

### 2.2 The same fact is asked more than once, and the machine's own facts are asked back

Measured on the campaign path: the campaign name is auto-generated, then shown as a required field, then asked again in the edit form, then silently overwritten by the brief modal. Budget is asked at three levels that can disagree. Dates are asked in the wizard and again, blank, in the Meta plan. Ad-set and ad names are auto-generated, then presented as required inputs with regenerate buttons, in two places, with validation that can never fire. The Meta ad id is a machine-owned value re-typed by hand with bespoke duplicate detection built to catch typos in that re-entry.

### 2.3 Parallel implementations of the same thing

- Three ways to create a campaign, with three rule sets; one of them a single text field that bypasses every rule the other two enforce.
- Three campaign editors writing the same columns with different intent.
- Two ad-entry modals, each with fields the other lacks.
- Six approval surfaces plus a seventh for captions; two rejection dialogs, one of which silently drops the revision targets.
- Four screens with three different definitions of "my work", and a rail badge that changes the moment you open the page.
- Two capacity settings screens. The one the runtime task placer reads is not the one labelled Capacity.
- Two builders, 845 lines, reachable from nothing, with an orphaned template feature behind three live API actions.
- Two products called "content": the content library, and per-project file inventories about brochures and floor plans.

### 2.4 Pipes without taps

Things built end to end except the last step that would make them usable:

- Ads are created paused; nothing activates them.
- The refresh opens weekly decisions; no screen shows them.
- Real per-ad daily Meta metrics are pulled hourly and read by no page; the analytics page shows hand-keyed approximations instead.
- The capability matrix cannot grant 9 of the 28 capabilities that gate real buttons.
- The publishing capacity bucket is seeded and uneditable.
- A "process approvals" card on the team page advertises a split between two roles, one of which nobody holds and whose only step was deleted.

### 2.5 What this costs you personally

For one month at the target volume, the current app would ask you for: 3 campaign wizards (about 90 to 165 controls), 3 Meta plans (21 blank fields), 3 ad-set trees, roughly 60 ad rows typed by hand, 228 approval clicks, 60 ad activations in Ads Manager, 4 refresh decisions with no screen to make them on, and 54 scheduling actions that no task will ever remind anyone to do. That is not an operating system. That is a data-entry job with a workflow engine attached.

---

## 3. The simplest possible target experience

### 3.1 The whole normal month, for you

1. Around the 17th, a notification: «حدّد مشاريع أكتوبر». The date is computed: first publishing day minus production lead time minus a safety margin.
2. Open one screen: **الشهر**. It shows October, three project slots, and last month's three pre-filled.
3. Keep or change them.
4. Read one summary: what will be produced, when the first row publishes, when production starts, whether the team fits, and when November must be chosen. The capacity line is either green or it names the one thing that does not fit and the smallest change that would make it fit.
5. Press «اعتماد الشهر».

That is the entire planning involvement. Five actions, one screen, once a month.

### 3.2 The whole normal month, for the system

From that one confirmation the system does all of the following without asking:

- Creates the organic program and one paid campaign per project, at the standing budget (2,000 riyals a project a month, 6,000 in all, on a settings page), as records nobody needs to open.
- Lays the organic calendar: Sunday A, Tuesday B, Thursday C, Saturday general, each a row of three posts, for every week in the month. Each row is one batch with one publish moment.
- Lays the paid calendar: five creatives per project on the campaign's first day, then five per project per refresh week, each week's batch dated.
- Schedules production backward from each batch date using the live capacity ledger, one throughput number per person per day, and reserves the people. A row is one task to work and counts as three.
- Opens each row task and each creative task on its production start date, assigned by capacity, with its due date.
- Builds the Meta campaign and ad sets from the standing template at confirmation, and builds each ad when its creative is approved, paused.
- On each weekly batch date, activates the five new ads, judges every running ad on its own first seven days, keeps the one with the lowest cost per lead from our leads among those Meta scaled, keeps both on a tie, and pauses the rest. Nothing is ever deleted (section 3.6).
- Hands each approved organic row to bundle.social at its batch time: three feed posts in row order with the first-read post published last, and three stories of the picture alone, at the same slot. A month of 54 posts is 108 organic releases.
- Pulls Meta spend and impressions and our WhatsApp leads, and shows cost per lead per project from our numbers.
- Sends the next-month reminder on the computed date.

### 3.3 What you see between confirmations

One list, «يحتاج قرارك», on the same screen. It is empty when everything follows the rules. When it is not empty, each row is one exception with the smallest decision that resolves it:

- A row is not complete by its batch date. The whole row waits; it never goes out as two posts. Options: move the row to the next slot, or drop the late post and go with a new one.
- A creative was rejected three times. Options: replace it, or drop it from the row.
- An ad failed at Meta, with Meta's own message. Options: retry, or replace the creative.
- A publish failed. Options: retry, or record it by hand.
- A project sold out. Option: pick a replacement project; it takes over the remaining rows and paid slates for the rest of the month, its first rows starting as soon as production lead time allows.
- November's projects are due in four days.

Nothing else reaches you. Two scaled ads within the noise are both kept, not escalated. Approvals reach you as rows, not posts (section 3.5).

### 3.4 The material rule, settled on 2026-09-14

How a release gets its files and its caption without anyone choosing. Agreed in discussion; recorded here so it is a rule, not a memory.

1. **What a release needs is decided by its destination.** A feed post takes the square design; a story takes the vertical; the Meta feed ad set takes the square and the story ad set the vertical. A creative's requirements are the union of its destinations, which the month sets on day one.
2. **Every creative produces both files.** Square and vertical, always, organic or paid, because organic posts go out as a feed post and a story. One designer checklist, no variation.
3. **The files come from the two named design slots** the designer already fills and the Meta worker already reads. There is no file picker in the normal path.
4. **The caption comes from the writing task**, confirmed by the writer and approved in the writing review, with the shared hashtags appended at publish. A story carries no caption, only the picture.
5. **Resolution happens at publish time and is checked against the approval.** The design does not exist when the month is created, so the release reads the slots on the day. It must post what was approved: if a slot's file no longer matches the hash the final approval recorded, the release becomes an exception instead of posting an unapproved file.
6. **Readiness is checked when the designer submits.** A submission with an empty required slot is refused, with the person who can fix it. The platform rulebook runs again at publish; with the first check in place it should almost never fail.
7. **What went out is recorded.** After a successful post the release writes the file ids and the caption it actually sent onto the publication row, which becomes the record for reporting.

Choices made: square is the feed shape; carousels stay outside the standing month as an advanced case; a story posts the same day at the same slot with no caption.

### 3.5 The row task, settled on 2026-09-15

The three posts of a project day are one task to work and one task to approve, with three post records inside it.

- **The writer** opens the row, writes the three posts side by side in one place, arranges them in the order they should read on the profile, and sends the row once.
- **The designer** opens the same row, sees three pairs of slots, uploads six files, and sends once. Readiness is checked at that submit (section 3.4).
- **The writing review and the final approval are per row.** You see the three drafts together, then the three squares together with last week's row dimmed above. You may change the order at approval. Sending back is per post; the other two keep their approval.
- **Order is honoured at publish.** Instagram shows the newest post first, so the post you placed first publishes last within the row's slot.
- **Capacity counts three.** The row is one card in the queue and one submit, but it is three writing slots and three design slots in the ledger.
- **No fixed jobs for the three posts.** Writing them side by side is what makes them different; a row note (section 3.7) says more when you want it. A row-level check still names two identical headlines or a missing design.
- **Why three records underneath.** Each post publishes on its own and has its own story; each can be reused as an ad on its own; a post returned for changes comes back alone. Making the row a single record would break all three.

The Saturday row is the same shape. The same shape can later serve a project's five weekly ad creatives, written as one slate rather than five tasks.

### 3.6 The weekly ad rule, settled on 2026-09-15

- **Each ad is judged on its own first seven days from activation, never on a calendar week.** The live data supports this on every ad: the ones Meta favoured were scaled by day three or four, and the ones Meta declined were declined by day three and never came back, one to two riyals after day seven every time.

| Ad | d1 | d2 | d3 | d4 | d5 | d6 | d7 | First 7 days | After day 7 |
|---|---|---|---|---|---|---|---|---|---|
| Akanan 3 | 26 | 33 | 25 | 59 | 59 | 45 | 28 | 274 | 173 |
| Akanan 2 | 36 | 39 | 52 | 113 | 25 | 33 | 8 | 306 | 10 |
| Akanan 4 | 43 | 10 | 5 | 0 | 0 | 1 | 1 | 60 | 1 |
| Akanan 7 | 12 | 19 | 8 | 3 | 1 | — | — | 42 | — |
| ربوة 3 | 3 | 1 | 5 | 0 | 0 | 0 | 0 | 9 | — |

- **Meta's allocation is the verdict.** An ad Meta did not scale in its first week is paused. That is the test; the declined designs are not wasted work, they are the cost of finding the one that runs.
- **Among the ads Meta scaled** (at least 150 riyals and 2,000 impressions in their seven days, both settings), keep the one with the lowest cost per lead. Cost per lead is spend divided by **our** leads: WhatsApp conversations whose opening message carried the ad, counted over the same days as the spend, with the feed and story ads of one creative summed. Today the app shows Meta's lead count; that changes.
- **Guards, both settings:** the leader must have at least 5 leads and be at least 20 percent better than the next scaled ad. If the gap is inside that, keep both; at these lead counts a 20 percent difference is noise, and a second week resolves it. If leads are too few to compare, fall back to cost per click, which sits on the cost axis and agreed with cost per lead in the data where click rate did not.
- **Fatigue on the only scaled ad means keep it and flag it**, never pause it. The current code would pause it and hand the campaign to five untested ads.
- **Then publish five new. Nothing is deleted;** paused ads keep their history in Meta.
- **Two horizons for leads.** Weekly decisions use cost per lead. Monthly project choice uses cost per qualified lead, derived from the client's stage, which the chat already links to.
- **Known cost:** adding ads each week returns the ad set to Meta's learning phase. Already the practice, already producing leads.
- Review the four numbers after one full month.

### 3.7 Instructions to the writer, settled on 2026-09-15

- **Where you write them.** On the schedule grid of the month screen, before you confirm. A note on a row cell applies to that row; a note on a project's column applies to every row of that project this month; a note on the month applies to everything. Nothing is required, and confirming never waits on a note.
- **When.** At confirmation, around the 20th of the month before, because production for the first week starts about ten working days before it publishes. Notes can be added or changed later.
- **What the writer sees.** On the row task, one panel with whatever applies, stacked, each line labelled by where it came from. Empty levels do not appear. The AI first draft reads the same panel.
- **Editing after work started.** Free until the task opens. After that, the panel shows the note as changed with the old text kept. After approval, changing a note asks whether to reopen the writing, so the note and the post never drift apart silently.
- **The Saturday row.** Its cell note is the topic. A rotating topic bank in settings is the fallback for a cell left blank.
- **Where notes live.** On the plan, not on the records, because the records do not exist until production starts. The row task reads them live.

## 4. Before, during, and after each month

| When | You | The team | The system |
|---|---|---|---|
| **Before** (the 17th onward) | choose three projects, read one summary, confirm | nothing yet | compiles the month, reserves capacity, opens the first tasks on their start dates, builds the Meta campaigns |
| **During** | clear the exceptions list when it is not empty; approve batches | write, design, review in My work exactly as now | advances tasks, builds and activates ads, publishes posts, runs the weekly refresh, raises exceptions |
| **After** (the 1st) | read the month page, which has become a report | nothing | closes the month, carries any unfinished item into the next month's first batch, sends the next reminder |

There is no month-end ceremony. The month page is both the plan and the report; it changes tense on the 1st.

---

## 5. What should disappear, hide, merge, stay, or change

### 5.1 Remove from the product entirely

| What | Why |
|---|---|
| The campaign wizard as the normal path | Its 30 to 55 controls express a constant. The month screen replaces it. Keep the engine underneath. |
| Goals as a prerequisite | A mandatory detour before any campaign can exist, serving a "strategic layer" for spend that the month template makes implicit. |
| Success measures editor, measure types, the main-measure flag | Two parallel measure models that only agree by accident. The month has one measure: cost per lead per project, computed. |
| The two dead builders, the execution template feature, its three API actions | 845 lines reachable from nothing. |
| Content inventory and content readiness pages from the marketing rail | They are about project files. Move them to the project record, where they belong, or under an advanced section. Readiness ships a permanent "this check does not work yet" banner. |
| The inline organic-campaign backdoor | One text field that bypasses every rule. |
| The task card's inline reject dialog and third approval button | A degraded copy that loses revision targets. One approval surface, one rejection dialog. |
| The `ceo` and `ops_supervisor` roles from the content paths | Nobody holds one; the other does nothing on any path. Keep the CEO signature as a threshold rule, not a role. |
| Weekly numbers entry as a rail item | bundle.social fills most of it. What remains (X, omitted fields) is an exception, not a weekly screen. |
| The Meta ad id as a typed field | Machine-owned. |
| Owner-role dropdown, execution label, ad-set name, ad name as inputs | Auto-generated and never read. |

### 5.2 Hide behind «متقدم», retain for exceptions

| What | When a person needs it |
|---|---|
| Campaign detail and execution pages | Investigating one campaign, editing a Meta plan for a one-off |
| The publish tab per publication | Overriding a caption or account for one destination |
| Settings: workflows, content types, load, capacity, cadence, platforms, audiences, brand kit, writer rules, AI roles, creative flags | Changing a standing rule. Once a quarter, not once a month. |
| Calendar page | Seeing the month as a grid. The month screen carries the summary; the calendar carries the detail. |
| Team page | Watching load. Becomes the capacity view under the month screen. |
| Shoot requests, library, search | Unchanged. Real, used, orthogonal. |

### 5.3 Merge

| These | Into |
|---|---|
| Load & SLA + Capacity & calendar | One capacity screen that edits the numbers the runtime actually reads, with the four buckets including publishing |
| Publishing board + Release page + Publish tab | One release surface: the board lists, the release page acts, the tab is gone |
| Six approval surfaces | One approval component used everywhere, with the readiness gate on all of them, not one |
| My work + My profile + Team | One work queue by person, not role, with a manager scope. One definition of "mine". |
| Overview + Analytics | One month page. Analytics reads the real daily Meta table, not the hand-keyed one. |
| Ad modal + Tree modal | One ad editor, advanced only |

### 5.4 Retain unchanged

The Meta integration core, the creative ranking, the workflow engine, the content record, the release sweep, bundle.social publishing, the competitor intelligence system, the attribution chain, the asset library, and the shoot requests.

### 5.5 Redesign

| What | Into |
|---|---|
| The scheduling engine | A month compiler: the same calendar, backward scheduling, ledger and commit, but fed a standing template instead of a wizard, run once a month, with no search and no alternatives. Capacity conflicts become exceptions with a proposed smallest fix, never a red line of text above a live commit button. |
| The refresh cycle | Automatic. Each ad judged on its own first seven days; keep the lowest cost per lead from our leads among the ads Meta scaled; keep both on a tie; pause the rest; publish five new. No decision screen needed in the normal week (section 3.6). |
| Ad activation | Part of the batch, not a human act. Created paused, activated on the batch date by the same lane that pauses all but the best-ranked running ad. |
| Capacity | One number per person per day, the throughput you already think in. Enforced at confirmation, one screen, read by the placer and the compiler alike. "Days per task" leaves the engine for posts; a video counts as more than one slot, set once. |
| Tasks | One table. A row is one task to work with three post records inside, counted as three (section 3.5). The five system kinds stop wearing the manual-task table's clothes. |
| Roles | Three: manager, writer, designer. Approvals go to the manager; a second approver is a capacity setting, not a role. |

---

## 6. Does the previous planning proposal survive?

Partly, and the honest split matters.

**Genuinely required, and already built:**

- The working-day calendar, Riyadh, Friday weekend, holidays as data.
- Backward scheduling from the publish date with per-stage deadlines.
- The single capacity ledger and the reservation swap.
- The concurrency-safe commit with the advisory lock and the plan-signature check.
- The release model.
- The paid cycle forecast.
- The weekly refresh lane and its ranking.

**Not required by the monthly model, and should be removed or buried:**

- The requirements wizard and everything that renders a plan for human approval: the grid, the drag-and-drop reorder, the load table, the alternatives, the conflict list as a preview artefact. The month has a fixed grid; nobody reorders it.
- The distribution search. Instagram's rules were satisfied by a search over arbitrary requests; the standing rule satisfies them by construction. Sunday A, Tuesday B, Thursday C is never two of the same project in a row.
- "Campaign planning" as a visible activity, a visible plan record, a plan id a person sees, a preview-then-commit ritual per campaign. One confirmation per month replaces it.
- Per-campaign refresh policy fields. The policy is a standing rule.
- The fifth-creative policy choice. Five per week is the rule; the "banked spare" mechanism stays as an internal optimisation.
- The alternatives search (earliest feasible range, largest count that fits). Replaced by exception rows with one proposed fix each.
- Per-step "effort in working days" for posts. It was a second knob on top of slots per day, and the seed I gave it doubled the designer's load. Throughput per day is the only capacity number a post needs.

**So**: roughly the algorithmic third of last week's work is the foundation of this proposal. The user-facing two thirds should not remain the normal path. That is a real reduction, not a screen on top.

---

## 7. Transition from the current app

No table is dropped and no live integration is touched until the last phase. Two campaigns are live with real spend; existing content keeps its pinned workflow; the intelligence system is not in scope.

**Phase 0, stop the bleeding (days).** Add the ad activation step to the refresh lane so paid work stops ending in Ads Manager. Turn on automatic application of the refresh decision, with the uncertain-ranking exception. Fix round zero. Delete the two dead builders and the orphaned template feature. Correct the stale approval copy that promises something the database refuses.

**Phase 1, the month screen (weeks).** One new page and one new settings screen, on top of the existing engine and commit. The settings screen holds the standing month: the four posting weekdays, posts per row, paid creatives per project per week, campaign length, paid budget per project, the Meta template, lead times. The month page compiles it, shows the summary and the capacity verdict, and confirms. The commit creates the organic program, three paid campaigns, their executions with the Meta plan filled from the template, and their ad sets. Existing wizard, campaign pages and everything else stay exactly where they are. Run one real month this way.

**Phase 2, the exception list and batch approvals (weeks).** Route every exception source that already exists (at-risk batch, rejected three times, ad failed, publish failed, refresh uncertain, capacity breach) into the one list on the month page. Add the November reminder. Add batch approval for organic rows. Collapse the four "my work" definitions into one.

**Phase 3, the rail (days).** Reduce the normal rail to: الشهر · مهامي · المحتوى · النشر · المكتبة · الإعدادات. Everything else moves under an advanced entry, reachable, not gone. Merge the two capacity screens into one that the runtime reads. Move the project-file pages to the project record.

**Phase 4, retire (after two clean months).** Remove the wizard, goals, success measures, the extra approval surfaces and the duplicate modals from the codebase. Only now consider dropping the zero-row tables.

Rollback at every phase is a rail edit, because nothing is deleted until phase 4.

---

## 8. Decisions, all settled

Every business decision this proposal depends on was settled in discussion on 14 and 15 September 2026. Recorded here so they are rules, not memories.

| Decision | Settled as |
|---|---|
| Capacity | writer 10 a day, designer 4 a day as a floor, manager uncapped; counted as throughput per person per day, no "days per task" |
| The second montage account | yours, not a designer's; loses the montage role |
| Paid budget | 2,000 riyals per project per month, 6,000 in all, on a settings page |
| Feed shape | square; carousels stay outside the standing month |
| Files | every creative produces the square and the vertical, because organic goes out as a feed post and a story |
| Readiness | checked when the designer submits |
| Story | same day, same slot, the picture alone |
| The row | one task to work and approve, three records inside, counted as three; order set by the writer, editable at approval, first-read publishes last; writing review and final approval per row; send-back per post |
| An incomplete row | waits; never goes out as two; one exception |
| Instructions | notes per row cell and per project column on the month grid, written at confirmation, nothing required |
| Ads | activate on the batch date without you; judged on their own first seven days; keep the lowest cost per lead from our leads among those Meta scaled, keep both on a tie, pause the rest, publish five new; nothing deleted; fatigue on the only scaled ad means keep and flag |
| Cost per lead | spend divided by our WhatsApp leads over the same days, feed and story summed; monthly project choice uses cost per qualified lead |
| A project that sells out | you pick a replacement; it takes over the remaining rows and slates |
| Carry-over | unfinished work joins next month's first batch and counts against it |
| CEO signature | not needed for the standing budget; only for a month that exceeds it |

Nothing is open.

## 9. Ideas to make it simpler still

Some of these change the arithmetic in section 0.

- **Derive paid creatives from the organic row.** Every organic creative now carries both the square and the vertical, so it is already ad-ready. Use the project's three row posts as three of that week's five paid creatives and produce two fresh. Fresh designs a month fall from 114 to 78, about 3 a day against the designer's floor of 4. The single change with the largest effect, and it costs nothing now that both files are standard.
- **Suggest the three projects.** From units available, days since last featured, and last month's cost per lead. The screen pre-fills; you confirm or swap one. Most months the choice is a glance.
- **A topic bank for Saturday.** The Saturday cell's note is the topic; a rotating bank in settings fills a cell you leave blank, so the general row never needs a decision.
- **Same three projects next month by default.** Rollover is the common case. The reminder says "keep these three?" with a yes.
- **Every item passes through you twice.** You have chosen not to cap approvals, and nine a day fits. It is still the one dependency the month cannot route around: a day you are away is a day nothing advances. A second approver for writing reviews, leaving you finals only, is the option if that ever matters. A capacity setting, not a role.
- **Hide the ad-set pair from the interface.** Feed and story ad sets are a Meta constraint, not a decision. The month template holds them; nobody names them.

---

## 10. Current versus proposed

| | Today | Proposed |
|---|---|---|
| To start a month | 3 wizards, 3 Meta plans, 3 ad-set trees, ~60 ad rows, 1 goal detour | choose 3 projects, confirm |
| Screens involved in planning | 10 to 12 | 1 |
| Blank required inputs per campaign | 4 to 5, then 7 more, then per ad set, then per ad | 0 |
| Where publishing dates come from | typed per publication, per platform | the standing calendar |
| Who schedules an approved post | nobody owns it | the release sweep, on the batch date |
| Ad activation | Ads Manager, by hand, every ad | the batch date |
| Weekly refresh | a task with no screen; never completes | automatic; each ad judged on its own first week |
| Capacity | advisory text over a live button, on numbers the runtime does not use | enforced at confirmation, one set of numbers |
| Your approvals | 228 a month across 6 surfaces | 18 row reviews and 18 row approvals for organic, plus paid finals, on one surface |
| Rail items | 19 | 6 |
| Settings screens in normal use | 16 | 1 |
| Definitions of "my work" | 4 | 1 |
| Exceptions | found by browsing | one list, one decision each |
| Reporting | 6 pages, paid numbers hand-keyed | the month page, real Meta numbers |
| Next month | remembered by a person | a computed reminder |

---

## 11. The month screen

One page, no tabs. Arabic, right to left.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  الشهر                                     ‹ سبتمبر   أكتوبر ٢٠٢٦   نوفمبر › │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  المشاريع الثلاثة                                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                     │
│  │ أ  أكنان ٢٥   │ │ ب  تل الربوة │ │ ج  ربوة الرمز │   [ اقتراح آخر ]    │
│  │ ٤٤ وحدة متاحة │ │ ٣١ وحدة      │ │ ٦٠ وحدة       │                     │
│  │ آخر ظهور: أغسطس│ │ جديد          │ │ ت.ع. ٦٤ ر.س   │                     │
│  └──────────────┘ └──────────────┘ └──────────────┘                     │
│                                                                          │
│  ماذا سيُنتَج                                                            │
│   ٥٤ منشورًا عضويًا   ١٨ يوم نشر   ٦٠ تصميمًا مدفوعًا   ٤ تحديثات       │
│   أول نشر: الأحد ٤ أكتوبر    يبدأ الإنتاج: الثلاثاء ٢٢ سبتمبر           │
│   اختيار نوفمبر مطلوب قبل: ٢٠ أكتوبر                                     │
│                                                                          │
│  هل يتّسع الفريق؟                                                        │
│   الكتابة   ٤٫٤ يوميًا من ١٠         ████████░░░░░░░░░░  ٤٤٪               │
│   التصميم   ٤٫٤ يوميًا من ٤ حدًّا أدنى ██████████████████▓ ١١٠٪ ضمن المتاح  │
│   الاعتماد  ٨٫٨ يوميًا · بلا حد                                           │
│                                                                          │
│   ✓ الشهر يتّسع للفريق الحالي.                                            │
│                                                                          │
│                                                     [ اعتماد الشهر ]     │
├──────────────────────────────────────────────────────────────────────────┤
│  يحتاج قرارك                                                   (فارغ)   │
├──────────────────────────────────────────────────────────────────────────┤
│  الأسابيع                                                                │
│   الأسبوع ١   أحد ٤   ثلاثاء ٦   خميس ٨   سبت ١٠      دفعة مدفوعة: ٤     │
│              [أ][أ][أ] [ب][ب][ب] [ج][ج][ج] [ع][ع][ع]   ● ● ● ● ●  ×٣     │
│   الأسبوع ٢   …                                                          │
│                                                                          │
│  الأرقام  (بعد بدء الشهر يصبح هذا القسم التقرير)                         │
│   الإنفاق · العملاء المحتملون · ت.ع. لكل مشروع · الوصول · المتابعون      │
└──────────────────────────────────────────────────────────────────────────┘
```

Before confirmation the page is a plan. After the 1st it is the same page with live numbers, past rows marked published, and the exceptions list doing the work. There is no other screen a normal month requires.

---

## 12. The minimum technical foundation

What actually has to exist for this to be reliable, and how much of it does.

| Foundation | Status |
|---|---|
| Working-day calendar with holidays | exists |
| Backward scheduling from a batch date with per-stage deadlines | exists |
| One capacity ledger; reservations swapped for tasks; concurrency-safe commit | exists |
| Release model; release sweep; automatic publishing via bundle.social | exists |
| Meta campaign and ad-set creation from a template | exists as a manual push; needs the template feed |
| Ad build on approval | exists |
| **Ad activation on the batch date** | missing; one lane step |
| Material resolved at publish from the approved slots, checked against the approval hash | missing; one rule |
| Instagram feed post through bundle.social | built; never exercised on a real post from this app |
| Instagram story through bundle.social | built; never exercised |
| Weekly ranking on our leads, per ad over its own first seven days, keep-both on a tie, cost-per-click fallback, fatigue keep-and-flag | missing; the ranking exists but reads Meta's leads and a fixed window |
| The row task: one card, three records, one submit, review and approval per row, order honoured at publish | missing |
| Instructions on the month grid and the resolved brief on the row task | missing; notes live on the plan |
| The paid budget as a setting feeding the Meta template | missing; today typed in three places |
| Sold-out replacement flow | missing; one exception with a project picker |
| Weekly ranking | exists |
| **Refresh decision applied automatically; uncertain case as an exception** | missing; one setting plus one rule |
| **Month template as data** | missing; one settings row, about ten fields |
| **Month compiler** | missing; a thin function over the existing engine that turns the template and three project ids into the plan input |
| **The month page** | missing; one page |
| **The exceptions list** | missing; one query over six existing sources |
| **The next-month reminder** | missing; one cron rule |
| **Batch approval** | missing; one approval action over three items |
| Enforced capacity, one throughput number per person per day | half; two tables must become one, and the per-step effort knob goes |
| One task table | half; the six kinds already exist, the split is cosmetic |

Roughly: eight small things missing, the foundation largely present. Nothing here is a rewrite. The work is mostly removal, which is the point.

---

## The answer to the central question

Choosing three projects can run a reliable month because the month is a constant. Everything that made the current app hard, the forms, the wizards, the builders, the six approval surfaces, exists to express choices that this company does not make. Take those choices out of the interface and into one settings row, compile them against the calendar and the team once a month, put every deviation on one list with one decision each, and the app that remains is small, and yours.

The month fits the team you have, counted the way you count it: ten a day, four a day, and no limit on you. Its rules are now written down, and none of them needs a decision each month. The engine must count the same way, one number per person, so the month screen can show 4.4 designs a day against a floor of 4 and let you judge it, instead of hiding a seed that says otherwise.

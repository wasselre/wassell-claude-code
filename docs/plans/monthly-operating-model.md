# The Monthly Operating Model — a simplification proposal

**Status:** Proposal, not implementation. **Date:** 2026-09-14.
**The question this answers:** how can choosing three projects automatically create and operate an entire reliable month of paid and organic marketing with the least possible human planning?

Everything below is grounded in a read of the live application on 2026-09-14: 35 routes, 28 pages, 70 components, 16 settings screens, the production database, and the four workers that run behind it. Where a number appears it was measured, not estimated; where a claim is a judgement it is marked as one.

---

## 0. The three facts that decide everything

Before the map, three measurements that reframe the whole question.

**1. The system has never run at the volume the monthly model requires.**
The Marketing OS is two months old in production. Lifetime totals: 24 content records, 6 campaigns, 10 publications, 42 ads. The stated monthly model is 54 organic posts plus 60 paid creatives in October, about 114 items. That is four to five times the entire lifetime usage, every month. A workflow that asks a person to create each item by hand cannot survive that. The monthly model is not a nice-to-have on top of the current app; it is the only way the current app could ever be used at the intended scale.

**2. The team is one writer, one manager, and one or two designers.**
Role holders in production: one marketing manager (you), one writer, two montage accounts (one of which is a second account under your own name), and nobody at all holding the operations role that owned every publish check until three days ago. Five roles were designed; one carries every approval and two carry nothing.

**3. Design capacity is the binding constraint, and the model is over it.**
Using the live effort estimates (design = 2 working days per item) and live daily capacity (two designers at 4 slots a day):

| Month | Working days | Items | Design days needed | Design days available | Load |
|---|---|---|---|---|---|
| October 2026 | 26 | 114 | 228 | 208 | 110% |
| November 2026 | 26 | 111 | 222 | 208 | 107% |
| February 2027 | 24 | 108 | 216 | 192 | 113% |

If the second montage account is not a real full-time designer, the load is 219% to 225%. The writer sits at 44%. The manager does roughly nine approvals every working day, which fits inside the approvals budget but makes you the single point of delay on every one of the 114 items.

This is the first thing the monthly screen must say, before anything is generated. It is also the first genuine decision only you can make (section 8).

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

Then the part the wizard does not do. Approving a plan creates a **shell**: each platform campaign is an unnamed draft with a blank Meta plan, zero ad sets and zero ads. A person then opens the execution modal and fills seven blank fields (objective, budget mode, budget, destination, optimisation goal, start, end), two of which the commit already wrote onto that same row. Then a tree modal for ad sets, then an ad modal for creative fields the tree modal does not show. Ten to twelve distinct screens to a campaign that can actually run.

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

- Creates the organic program for the month and one paid campaign per project, as records nobody needs to open.
- Lays the organic calendar: Sunday A, Tuesday B, Thursday C, Saturday general, three posts each, for every week in the month. Each posting day is one batch with one publish moment.
- Lays the paid calendar: one launch slate of five per project on the campaign's first day, then five per project per refresh week, with each week's batch dated.
- Schedules production backward from each batch date using the live capacity ledger, and reserves the people.
- Opens the first task of each item on its production start date, assigned by capacity, with its due date.
- Moves each item through the same five-step path it uses today.
- Builds the Meta campaign and ad sets on the standing template when the month is confirmed, and builds each ad when its creative is approved.
- **Activates** each week's ads on the batch date and retires the outgoing ones, applying the ranking's default decision unless the ranking is uncertain.
- Hands each approved organic post to bundle.social at its batch time.
- Pulls Meta and Instagram numbers and shows them on the month screen.
- Sends the November reminder on the computed date.

### 3.3 What you see between confirmations

One list, «يحتاج قرارك», on the same screen. It is empty when everything follows the rules. When it is not empty, each row is one exception with the smallest decision that resolves it:

- A batch is at risk because its designer is behind. Options: move the post one row later, or reassign.
- An item was rejected three times. Options: replace it, or drop it from the row.
- A refresh ranking is uncertain because two creatives are within the noise. Options: keep A, keep B.
- An ad failed at Meta with the platform's own message. Options: retry, or replace the creative.
- A publish failed. Options: retry, or record it by hand.
- A project sold out. Options: pause its campaign and re-plan its slots, or continue.
- November's projects are due in four days.

Nothing else reaches you. Approvals reach the manager role as they do today, but as batches, not items (section 9).

---

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
| The refresh cycle | Automatic by default. The decision task appears only when the ranking is uncertain, and it has a screen. Round zero is applied like any other round. |
| Ad activation | Part of the batch, not a human act. Created paused, activated on the batch date by the same lane that retires the outgoing ones. |
| Capacity | Enforced, not advisory. One set of numbers, one screen, read by the placer and the compiler alike. |
| Tasks | One table. The five system kinds stop wearing the manual-task table's clothes. |
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

## 8. Decisions that genuinely need you

These are business decisions, not implementation choices. Each changes what the compiler produces.

1. **Design capacity.** The model needs about 220 design days a month and the team has 208 on paper, or 104 if the second montage account is not a full-time designer. Three ways out, each a different business: cut design effort for paid creatives to one day by treating them as template variants (load falls to about 75%), add a designer, or reduce the paid slate from five to four per project per week. Which one?
2. **Is the second montage account a real designer?** The compiler must know.
3. **Paid budget per project per month.** One number, standing. Today budget is typed in three places that disagree.
4. **Ads live on the batch date, or paused until you look?** Automatic activation is what makes the week run without you. It is also money spent by a machine. I recommend automatic, with a spend cap per project as the safety.
5. **Automatic refresh decisions.** The ranking is sound. Letting it apply by default means creatives are retired by a machine. I recommend yes, with the uncertain case routed to you.
6. **The Saturday general row.** Three non-project posts a week is 12 to 15 topics a month. Who supplies them? A topic bank in settings that rotates, or a monthly choice alongside the three projects. Without a source, Saturday becomes the row that is always late.
7. **A project that sells out mid-month.** Proposed rule: its remaining organic slots are re-planned to the other two projects, its paid campaign is paused, and its unfinished creatives are dropped. Confirm or change.
8. **The CEO signature threshold** on a standing monthly budget. Once at confirmation, or never, because the number is a rule?
9. **Carry-over.** An item unfinished at month end joins the next month's first batch, or is dropped. Proposed: joins, and counts against the next month's capacity.

---

## 9. Ideas to make it simpler still

Some of these change the arithmetic in section 0.

- **Approve rows, not posts.** The three posts on a project day are one batch. Let the manager approve the batch as one unit, with the three previews side by side. That cuts final approvals from 54 to 18 a month for organic, and matches how the batch is meant to be judged.
- **Derive paid creatives from the organic row.** Each week, the project's three organic posts already exist as approved square and vertical designs. Use them as three of the five paid creatives, produce two fresh. Design load for paid drops from 120 to 48 days a month, and the month fits comfortably inside the current team. This is the single change with the largest effect.
- **Suggest the three projects.** From units available, days since last featured, and last month's cost per lead. The screen pre-fills; you confirm or swap one. Most months the choice is a glance.
- **A topic bank for Saturday.** Twenty evergreen topics in settings, rotated, so the general row never needs a monthly decision.
- **Same three projects next month by default.** Rollover is the common case. The reminder says "keep these three?" with a yes.
- **One approver is a bottleneck by design.** Nine approvals a day, every day, is the real ceiling on the whole month. A second approver for writing reviews, leaving you the final approvals only, halves your daily load. This is a capacity decision, not a role.
- **Retire the ad-set pair from the interface.** Feed and story ad sets are a Meta constraint, not a decision. The month template holds them; nobody names them.

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
| Weekly refresh | a task with no screen; never completes | automatic; uncertain cases only |
| Capacity | advisory text over a live button, on numbers the runtime does not use | enforced at confirmation, one set of numbers |
| Your approvals | 228 a month across 6 surfaces | 18 row approvals plus paid finals, on one surface |
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
│   الكتابة  ████████░░░░░░░░░░  ٤٤٪                                        │
│   التصميم  ██████████████████▓  ١١٠٪   ▲ ٢٠ يومًا فوق الطاقة              │
│   الاعتماد ████████░░░░░░░░░░  ٤٤٪    ٩ اعتمادات يوميًا                   │
│                                                                          │
│   ▲ التصميم لا يتّسع. أصغر تغيير يحلّه:                                   │
│     ○ اعتبار التصاميم المدفوعة نسخًا من منشورات الأسبوع  (١٠٤٪ ← ٧٣٪)     │
│     ○ أربعة تصاميم مدفوعة لكل مشروع أسبوعيًا بدل خمسة    (١١٠٪ ← ٩٨٪)     │
│     ○ المتابعة كما هي وقبول تأخر الدفعة الأخيرة                          │
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
| Weekly ranking | exists |
| **Refresh decision applied automatically; uncertain case as an exception** | missing; one setting plus one rule |
| **Month template as data** | missing; one settings row, about ten fields |
| **Month compiler** | missing; a thin function over the existing engine that turns the template and three project ids into the plan input |
| **The month page** | missing; one page |
| **The exceptions list** | missing; one query over six existing sources |
| **The next-month reminder** | missing; one cron rule |
| **Batch approval** | missing; one approval action over three items |
| Enforced capacity from one set of numbers | half; two tables must become one |
| One task table | half; the six kinds already exist, the split is cosmetic |

Roughly: eight small things missing, the foundation largely present. Nothing here is a rewrite. The work is mostly removal, which is the point.

---

## The answer to the central question

Choosing three projects can run a reliable month because the month is a constant. Everything that made the current app hard, the forms, the wizards, the builders, the six approval surfaces, exists to express choices that this company does not make. Take those choices out of the interface and into one settings row, compile them against the calendar and the team once a month, put every deviation on one list with one decision each, and the app that remains is small, and yours.

The one thing no compiler can remove is the fact that the current team does not fit the stated model. That is section 0, and it is the first decision on the month screen, not the last thing you find out.

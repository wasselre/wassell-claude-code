# Sales OS — Redesign Brief (Figma Make prompts)

> **How to use this file.** This is the source material for redesigning the four
> Sales Operating System screens. Open Figma Make (figma.com/make) and run **one
> screen at a time**. For each screen, paste the **Brand Preamble** first, then
> the **Screen block**. Iterate visually in Figma until you like it, then hand the
> result back to Claude (Figma Dev Mode link, or a screenshot of each frame).
>
> **Claude's job afterward:** translate the approved visuals onto the real React
> pages listed in each screen's "Implements" line — **restyle only, never change
> behavior, data, or which regions exist.** RTL/Arabic, i18n, the Zustand store,
> and `@/components/ui` wiring all stay; only the look changes.

---

## Brand Preamble — paste this at the top of EVERY Figma Make prompt

> Design for **Wassel (وصل العقارية)**, a Saudi real-estate CRM. This is a
> **restyle of existing screens** — keep every region I list, do not invent or
> remove features.
>
> **Direction:** Arabic, **right-to-left (RTL)** is the primary layout. Mirror
> everything. Phone numbers and Latin numerals stay left-to-right inside their
> chips.
>
> **Typography:** Amiri (serif) for all text, Arabic and English.
>
> **Color tokens (use these exact hex values, nothing else):**
> - Primary / actions / active state — Copper Bronze `#B8734F`
> - Hover / secondary — Deep Terracotta `#8E4E3A`
> - Badges / highlights — Subtle Gold `#C09B5F`
> - Borders / dividers — Warm Sand `#D4B896`
> - Page background — Soft Cream `#F5EDE0`
> - Card / surface background — White `#FFFFFF`
> - Headings / dark contrast — Rich Chocolate Brown `#4A2C2A`
> - Body text — Charcoal Slate Gray `#4A4E54`
> - Sidebar (context only) — Charcoal Slate Gray `#4A4E54`
> - Success — `#10B981`  ·  Warning — `#C09B5F`  ·  Danger — `#8E4E3A`
>
> **Shape:** 8px radius on inputs, 12px on cards, 16px on modals. Soft, warm,
> calm — not flat-corporate-blue. Currency is SAR (ر.س).
>
> **Quality bar:** generous whitespace, clear visual hierarchy (one obvious
> primary action per screen), consistent card system, restrained use of the
> copper accent so it means "do this". Aim for the polish of Linear/Notion but
> in this warm earthy palette.

---

## Screen 1 — Follow-Up Workspace  *(the hero screen — start here)*

**Implements:** `src/pages/Followups/FollowUpWorkspacePage.tsx` and its panels in
`src/pages/Followups/components/` (MissionHeader, PrimaryAction, ScriptPanel,
OutcomePanel, CallEvidence, ContextPanel, PreferenceSummary, TimelinePanel).

**Figma Make prompt:**

> A single-task "do this one follow-up" workspace for a salesperson. Three-zone
> layout on desktop, stacked on mobile.
>
> **Top — Mission header (full width card, copper accent edge):** the follow-up
> type as the title (e.g. "First contact call"), a one-line objective under it,
> the **client name large**, the client phone (LTR), and a row of small status
> chips: pipeline stage, status, priority. On the trailing side: the **due date**
> (turns red with a warning icon when overdue) and an "Attempt 2" badge.
>
> **Main column (≈2/3 width):**
> - **Primary action card:** one big primary button for the channel (Call or
>   WhatsApp — WhatsApp uses its green `#25D366`), plus quieter ghost buttons
>   "Open appointment" and "View client".
> - **Call guidance card:** a short bulleted script the rep reads.
> - **Outcome card (the heart of the screen):** the main outcome as one large
>   filled button tinted by tone (positive=green, neutral=gold, negative=
>   terracotta); secondary outcomes as outline pills. Selecting an outcome
>   **reveals only the relevant fields** (a datetime picker, a reason dropdown,
>   a notes textarea, an optional "attach the call" evidence list). Below that a
>   calm preview box ("What happens next: move to stage X, set status Y, create
>   next action Z") and a single **Complete & Save** primary button, disabled
>   until valid. Inline validation: red for errors, gold for warnings.
>
> **Sidebar (≈1/3 width), three stacked cards:**
> - **Context** — a tidy label/value list of only the fields this follow-up type
>   needs (lead source, budget, area, etc.).
> - **Client preferences** — budget range, areas, neighborhoods, unit type,
>   city, language, with an "Edit full preferences" link.
> - **Timeline** — a vertical activity feed (colored dot per entry by tone) of
>   recent follow-ups, appointments, visits, and phone calls.
>
> A quiet "Advanced fields" link sits at the very bottom. Make the Outcome card
> the clear focal point of the whole screen.

---

## Screen 2 — Sales Tasks (the daily queue)

**Implements:** `src/pages/Sales/SalesTasksPage.tsx`

**Figma Make prompt:**

> A salesperson's daily task queue. Page header "Sales Tasks" with an icon.
>
> Directly under it, a **health banner** (appears only when count > 0): a soft
> warning strip "N active clients with no next action — should be zero", clickable.
>
> A horizontal **tab bar** (underline style, active tab underlined in copper)
> with a count badge on each tab — overdue/no-next-action badges in danger
> terracotta, the rest in sand. Tabs: My Tasks, Due Now, Overdue, Today,
> Tomorrow, Waiting for Customer, High Priority, No Owner, Completed, No Next
> Action.
>
> A **triage row** under the tabs: a sort dropdown (newest/oldest) and filter
> dropdowns (rep, type, stage), a "Clear" link, and a right-aligned item count.
>
> The **task list**: each row shows the client name (bold) + phone (LTR), an
> objective line, and a metadata line (Due · Attempt · Stage · Status · Rep).
> Overdue rows get a terracotta leading edge. On the trailing side of each row, a
> single channel icon button (call or WhatsApp). Empty state: a calm "No tasks"
> card; the "No Next Action" view when empty shows a green "Every active client
> has a next action ✓". Rows are large, tappable, scannable — this is used all day.

---

## Screen 3 — Sales Process Studio  *(admin, read-only)*

**Implements:** `src/pages/SalesProcess/SalesProcessStudioPage.tsx`

**Figma Make prompt:**

> A read-only visual map of a sales pipeline. Header "Sales Process Studio" with
> a small "Read-only" badge and a one-line legend.
>
> A **responsive grid of stage cards** (2→3→4 columns). Each stage card has a
> 3px colored top edge (the stage's own color), the stage name, "X active" and
> "Y overdue" counts, and small indicators: a link icon + count when workflows
> are bound, a warning icon + count when activities have no workflow. Cards are
> selectable; hover and selected states tint sand.
>
> Below the grid, a **detail panel** for the selected stage: its name + "(N
> active clients)", then a list of **activity blocks**. Each activity block has a
> summary row (activity label, objective, channel icon 📞/💬, and a status badge
> — green "Linked" / gold "Advanced" / red "Missing workflow") that expands to
> show its outcomes (as sand pills with required fields) and workflow links
> ("Open in Workflow Builder", "View runs", or a "no workflow yet" note).
>
> Clean, diagram-like, calm. This is a map you read, not a form you fill.

---

## Screen 4 — Sales Manager Dashboard  *(admin)*

**Implements:** `src/pages/Sales/SalesManagerPage.tsx`

**Figma Make prompt:**

> A sales operating-health dashboard. Header "Sales Manager" with a chart icon.
>
> **Headline stat cards** (4 across on desktop, 2 on mobile), each a white card
> with a 3px colored top edge tinted by health: **No Next Action** (big number,
> green when 0 / red when > 0, "should be zero" hint, clickable), **Overdue**
> (amber when > 0), **Open Follow-ups**, **Completed (30d)** (with an "N late"
> hint).
>
> A thin **rates strip** on sand background: total clients, no-answer rate,
> on-time completion rate (each falls back to "Not enough data").
>
> A **2-column section grid** of horizontal bar lists in copper: Pipeline by
> Stage, Completed Outcomes, Lost Reasons; plus a compact **per-rep table** (Rep
> · Open · Completed). Numbers are the hero here — large, legible, well-spaced,
> RTL-correct with Latin numerals kept LTR.

---

## Notes for implementation (Claude reads this, not Figma)

- **Restyle only.** The region list per screen above is the contract — every
  region must survive the redesign. No new features, no removed data.
- **Replace ad-hoc class strings with the shared system** where it fits: prefer
  `@/components/ui/Button` over the hand-rolled `callBtn`/`waBtn`/`ghost` strings
  in `OutcomePanel`/`PrimaryAction` (the `btn-*` classes are unstyled in this
  repo — never use them).
- **Keep all behavior:** outcome→field reveal, validation, optimistic-concurrency
  save, the channel-aware call/WhatsApp logic, evidence matching, timeline reads.
- **RTL + i18n stay:** every label keeps its `label_ar`/`label_en` + `t()` path;
  no hardcoded strings.
- **Verify live** on `app.wassel.re` per screen after applying (deploy = rebase +
  push to main, then confirm the Vercel SHA + smoke-test).

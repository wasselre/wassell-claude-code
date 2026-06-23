# PRD: Sales Valuation (تقييم المبيعات) — Sales Quality & Coaching

**Status:** Live (data + automation layer + dedicated custom operational UI for all 5 pages in the تقييم المبيعات group)
**Last updated:** 2026-06-23
**Related PRDs:** [sales-process.md](sales-process.md), [followups-workspace.md](followups-workspace.md), [dashboards.md](dashboards.md), [access-control.md](access-control.md), [record-management.md](record-management.md)

## What it is (in plain English)
A daily quality-and-coaching loop layered on top of completed follow-ups. When a sales rep completes a follow-up, the system can open a **valuation review** for the manager. The manager judges whether the rep handled it correctly; if there was a mistake they classify it, score it, and (optionally) raise a **correction task**. Each rep then gets **one daily coaching summary** rolling up their reviews, which they can acknowledge or dispute. It is a learning loop, not a punishment log — the rep-facing surface is named **التوجيه اليومي للمبيعات** (Daily Sales Coaching), the manager surface **قائمة تقييم المبيعات** (Sales Valuation Queue). All visible labels are Arabic; English slugs exist only as internal API values.

## Why it exists
Managers need a structured, repeatable way to review how reps handle follow-ups, turn mistakes into coaching, and track improvement over time — without manually trawling the follow-ups list and without making reps feel surveilled.

## Key behaviors
- **Five models** in their own dedicated sidebar group **تقييم المبيعات** (Sales Valuation), unfrozen JSONB in `records`: `sales_valuation_reviews` — labeled **قائمة تقييم المبيعات** (the manager queue), `sales_mistake_categories` (تصنيفات أخطاء المبيعات, 13 seeded categories), `sales_correction_tasks` (مهام تصحيح المبيعات), `sales_rep_daily_valuations` (التوجيه اليومي للمبيعات), `sales_valuation_settings` (single settings record).
- **Review creation is automatic and going-forward only.** A SECURITY DEFINER trigger fires when a follow-up transitions to `followup_status = completed` and creates ONE review if any criterion holds: review-all, high-risk result (not interested / lost / offer request / visited), missing next step, a detected system flag, or a random sample (% from settings). It **never creates a duplicate** review for the same follow-up and snapshots the client name, type, and result so the review stays readable even if the follow-up changes later.
- **System flags** (deterministic, surfaced as "إشارات المراجعة", not "AI"): `لا توجد خطوة تالية`, `ملاحظات ضعيفة` (notes < 15 chars), `احتمال نتيجة غير متطابقة` (interest words in notes vs a negative result), `زيارة غير مسجلة`, `تأخير في المتابعة` (completed > 1 day after schedule).
- **Scoring (0–100):** Correct = 100, Minor = 85, Major = 65, Critical = 40 — **unless** a mistake category is chosen, then `max(0, 100 − category deduction)`. A **manager-entered score is always preserved** (only a blank score is auto-filled).
- **Status is derived** on save: outcome Correct → `تمت المراجعة — لا يوجد خطأ`; a mistake → `يتطلب تصحيح` (if correction required) or `تم رصد ملاحظة`; rep dispute → `معترض عليه من المندوب`; a manager final decision → `مغلق` (and the dispute is mapped Confirmed→rejected / Cancelled→accepted / Adjusted→adjusted, with `closed_at` stamped).
- **Correction tasks** are auto-created (and back-linked) when a review requires correction, due next business day (Riyadh, skips Fri/Sat) unless a deadline is set, with no duplicate per review. Overdue open/in-progress tasks are swept to `متأخرة`.
- **Daily summary** is one record per rep per day, maintained by a trigger that recomputes total reviewed / correct / mistakes / average score / main category / open tasks while **preserving the manager's written summary, improvement points, and the rep's acknowledgement/notes**. An empty draft is not created for a day with nothing reviewed yet.
- **The review screen shows the real source, not just the system read:** beyond the snapshots/flags, the review form mirrors the **live** follow-up (rep's actual notes, scheduled vs actual time, next-step), a read-only **تفضيلات العميل** (client preferences) section mirrored from the client, and a **سجل المكالمات** (call history) section listing the client's Hatif calls — each expandable to its **recording (audio), AI summary, and transcript** so the manager can listen and read. The client's phone is snapshotted onto the review so call history resolves.
- **Manager queue** = saved views on the reviews model: `قائمة المراجعة — بانتظار` (default), `أولوية مرتفعة`, `معترض عليها`, `تتطلب تصحيح`, `كل التقييمات`.
- **Two dashboards**: a manager board (pending, reviewed-today, mistakes-today, critical-today, avg score by rep, mistakes by category, overdue corrections, disputed) and a rep board (my score today, open corrections, repeated mistakes, my summaries) — the rep board auto-scopes to the viewer via RLS.
- **Operation toggle:** `sales_valuation_settings.is_enabled` (default true). Setting it false pauses all review creation. The settings record also holds the per-criterion toggles, sample percentages, daily-summary time, and the default sales manager.

## User flows
1. **Manager happy path:** open المبيعات → تقييمات المتابعات (default = pending queue) → open a review (context section on top, evaluation section below, rep-response/closure last) → pick an outcome (+ category/details/correct action/coaching note) → save. Score/status auto-fill; a correction task and the rep's daily summary update automatically.
2. **Correction:** review with "يتطلب تصحيح" → a task appears in مهام تصحيح المبيعات for the rep; the rep adds a note and moves it to قيد التنفيذ / مكتملة; manager approves.
3. **Rep coaching / dispute:** rep opens التوجيه اليومي للمبيعات (own records only) → reads the day's summary and feedback → acknowledges, or sets a review's dispute to "معترض عليه" with a response → it lands in the manager's "معترض عليها" view → manager sets a final decision → review closes.
4. **Empty state:** with no pending reviews the default queue shows "لا توجد سجلات بعد"; the operation populates as real follow-ups are completed going forward.

## Data touched
- **Reads:** `records.data` of `followups` (status, result, type, notes, dates, client/rep/visit), `clients` (name), `sales_valuation_settings`, `sales_mistake_categories`.
- **Writes:** `records.data` of `sales_valuation_reviews`, `sales_correction_tasks`, `sales_rep_daily_valuations` (all via triggers / generic record saves).
- **Permissions:** `profiles.model_permissions` (manager + admin full; rep scoped view/edit on reviews/tasks/daily, view on categories).
- **UI config:** `model_views` (queue), `dashboards` (manager + rep boards).

## Key files
| File | What it does |
|---|---|
| `supabase/migrations/2026-06-23_sales_valuation_operation.sql` | Consolidated migration: automation engine (functions + triggers), permissions, notes |
| `public.svr_create_review_on_followup_complete()` | Review creation trigger (eligibility, flags, dedup, snapshots) |
| `public.svr_fill_review_computed()` | Score + status derivation on review save (preserves manager score) |
| `public.svr_create_correction_task()` | Correction-task creation + back-link |
| `public.svr_recompute_daily_summary()` | Per-rep/day rollup (preserves manager/rep text) |
| `public.svr_sweep_overdue_tasks()` | Flips past-due open tasks to overdue |
| `src/pages/SalesValuation/QueuePage.tsx` | Manager review queue — KPI cards, filter tabs, table + row actions |
| `src/pages/SalesValuation/ReviewDetailPage.tsx` | Single-review decision screen (summary card, evidence modals, progressive decision panel) |
| `src/pages/SalesValuation/CorrectionBoardPage.tsx` / `CorrectionDetailPage.tsx` | Correction kanban board + task detail |
| `src/pages/SalesValuation/CoachingPage.tsx` | Rep daily coaching dashboard |
| `src/pages/SalesValuation/CategoriesPage.tsx` / `SettingsPage.tsx` | Mistake-category settings table + operation settings |
| `src/pages/SalesValuation/components/shared.tsx` | Shared primitives (cards, pills, label resolution from model options, evidence modals) |
| `src/App.tsx` | `RecordListDispatcher`/`RecordDetailDispatcher` route the 5 models to the custom pages (generic form via `?generic=1`) |

## Open questions / known limitations
- **No field-level permissions** in the platform: reps have scoped EDIT on their own reviews (so acknowledge/dispute works), which technically lets them edit manager-only fields on *their own* review. Mitigations: the manager's final-decision/close gate and the version/updated_at audit. A bespoke locked rep screen is the recommended Phase-2 hardening.
- **Overdue stored-status** depends on activity (the daily-summary trigger sweeps overdue tasks opportunistically) + the callable `svr_sweep_overdue_tasks()`. For guaranteed time-based flips independent of activity, schedule that function (Vercel cron / Fly worker) — pg_cron is off on wassell-prod. The manager dashboard already counts overdue live.
- **Automations are DB triggers, not client Workflow rows**, so they don't appear in the Workflow editor (by design — they need cross-record reads + dedup the client engine can't do, and must fire on server/direct writes).
- **Bespoke screens shipped:** all 5 group models now render purpose-built operational UIs (queue workbench, review decision screen, correction kanban + detail, rep coaching dashboard, categories + settings) dispatched by model name in `App.tsx`. The generic record form remains available per-record via `?generic=1` for admin/advanced edits. The Builder's per-record saved views on `sales_valuation_reviews` still exist but the queue page is the default experience.

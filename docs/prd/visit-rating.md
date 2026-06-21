# PRD: Visit Experience Rating

**Status:** Live
**Last updated:** 2026-06-21
**Related PRDs:** [sales-process.md](sales-process.md), [followups-workspace.md](followups-workspace.md), [workflow-automation.md](workflow-automation.md), [chats.md](chats.md), [clients.md](clients.md), [dashboards.md](dashboards.md), [files.md](files.md)

## What it is (in plain English)
After a client visits one of our projects, Wassell asks them how the visit went. About two hours after the visit is registered, the client receives a WhatsApp with a short link. Tapping it opens a clean, login-free, Wassel-branded page that shows only which project they visited and the date, and a row of five stars. They tap a score from 1 to 5, hit "Submit rating," and they're done. The score flows back into the CRM: it shows on the visit, on the client's timeline and account, and in dashboards — so the sales team and managers can see how visit experiences are trending and follow up on poor ones.

It's the customer-facing feedback loop for the Visit stage of the Sales Operating System. The whole thing is automated — no rep action is needed to send the request or record the score.

## Why it exists
The Sales OS tracks the visit happening, but the team had no read on the *quality* of the visit experience. A one-tap rating, sent automatically at the right moment, gives an honest signal (the client rates from their own phone, no rep in the room) that surfaces unhappy visits early and gives managers a measurable visit-experience metric without adding any manual work for reps.

## Key behaviors
- **The rating link is sent automatically, ~2h after the visit, server-side.** Registering a visit fires the Visit → After-Visit workflow (W6), which — besides moving the client and creating the after-visit call — arms a `rating_request` timer follow-up: status `scheduled`, scheduled `+2h`, carrying the visit's `phone` (via the client lookup) and its `rating_token`. When that timer comes due, the `on_due` workflow **"Send Visit Rating"** sends the WhatsApp with the link. Nothing is sent at the instant the visit is logged; the delay is deliberate.
- **The link is a stable, opaque token.** Each visit carries a write-once `rating_token`, generated client-side when the visit form is created (a `default_dynamic: 'token'` field that produces a random UUID) and backstopped by a DB BEFORE-INSERT trigger (`records_stamp_visit_rating_token`) for any visit created server-side. The token never changes and is hidden/read-only on the form. The public URL is `https://app.wassel.re/rate/{rating_token}`.
- **The public page is login-free and PII-free.** `/rate/:token` is outside the authenticated app (no AppLayout, paints its own brand canvas like the public file-share page). It reads only a minimal, no-personal-information context — the project name and visit date — via the anonymous `get_visit_for_rating` RPC. It never exposes the client's name, phone, or any other field.
- **The client picks 1–5 and submits.** Five stars; tapping one sets the score, "Submit rating" writes it. Submission goes through the anonymous `submit_visit_rating` RPC, which validates the score is 1–5, is idempotent (re-submitting just overwrites), writes `visit_rating` + `rated_at` onto the visit, and mirrors a latest-only convenience pointer (`latest_visit_rating` / `latest_visit_rated_at`) onto the client. An invalid or unknown token shows a friendly "this link is invalid or has expired" message; a successful submit shows a thank-you state.
- **The visit is the source of truth; the client mirror is convenience only.** The authoritative score lives on the visit (`visit_rating`). The client mirror is a latest-only pointer for quick display on the account. All client/visit-level analytics read the visit-level value (`v_visits.visit_rating`), never the client mirror.
- **The score surfaces in four places.** The **visits table** (`visit_rating` is shown), the **client timeline** in the Follow-up Workspace (visit entries carry a "تقييم الزيارة: N/5 / Visit rating: N/5" subtitle, colored by tone — negative ≤2, positive ≥4, neutral otherwise), the **client account** (the latest mirror), and **dashboards** (numeric in the `v_visits` view → the analytics engine, so it can be charted/aggregated).
- **The send workflow is gated behind a go-live switch.** The "Send Visit Rating" workflow was created `is_active = false` so customers could never receive a `/rate/<token>` link before the frontend route was deployed; it is enabled only after the deploy reaches READY. Until then, timers accumulate but no message is sent.
- **Everything stays workflow-driven.** The timer creation (W6), the send (the on_due workflow), and the score write-back (the RPC) are the only moving parts; nothing about the rating flow is hardcoded in React beyond the public page itself. The architectural rule of the Sales OS — the workflow engine is the only executor — holds here.
- **Bilingual + RTL.** The public page renders Arabic/English (via the sanctioned `isAr ? ar : en` pattern, since it sits outside the i18n-keyed authenticated surface) and sets `dir`/`lang` on `<html>` accordingly.

## User flows
1. **Client rates a visit (happy path):**
   1. A rep registers the client's visit (from the Follow-up Workspace or the Visits form). W6 arms the `rating_request` timer.
   2. ~2h later the timer comes due → the "Send Visit Rating" workflow WhatsApps the client a link.
   3. The client taps the link → the page loads, showing "Visit to <project> on <date>" and five stars.
   4. The client taps a score and **Submit rating** → thank-you screen. The score is written to the visit and mirrored to the client.
   5. Back in the CRM the rep/manager sees the score in the visits table, the client timeline, the client account, and dashboards.
2. **Invalid / expired link:** the token doesn't match any visit → the page shows "This link is invalid or has expired." (no further action).
3. **Re-submit:** the client opens the link again and submits a different score → the RPC overwrites the previous value idempotently (no duplicate, no error).
4. **Pre-deploy / disabled state:** if the "Send Visit Rating" workflow is still `is_active = false`, the `rating_request` timers are created but no message is sent — no client receives a link until the workflow is enabled.

## Data touched
- **Reads:** `records` for the visit (project id, scheduled date) and the project (name) via the anonymous `get_visit_for_rating` RPC — exposing only project name + visit date.
- **Writes:** `records.data` on the visit (`visit_rating`, `rated_at`) and the latest-only mirror on the client (`latest_visit_rating`, `latest_visit_rated_at`) via the anonymous `submit_visit_rating` RPC.
- **Storage shapes (all on `records.data`, unfrozen JSONB):**
  - **visits:** `rating_token` (text, hidden, immutable, write-once), `visit_rating` (number 1–5, read-only on the form, `show_in_table`), `rated_at` (datetime, read-only).
  - **followups:** the `rating_request` timer carries `followup_type = rating_request`, `followup_status = scheduled` (invisible to the rep queue), and a copied `rating_token`.
  - **clients:** `latest_visit_rating` (number), `latest_visit_rated_at` (datetime) — latest-only convenience mirror.
- **SQL (all in the 2026-06-21 migration):** the `records_stamp_visit_rating_token` BEFORE-INSERT trigger; the anon SECURITY DEFINER RPCs `get_visit_for_rating(p_token)` and `submit_visit_rating(p_token, p_rating)` (both `GRANT EXECUTE ... TO anon, authenticated`).

## Key files
| File | What it does |
|---|---|
| `src/pages/PublicRate/RateVisitPage.tsx` | The public `/rate/:token` page — loads PII-free context, the five-star picker, submit, thank-you / invalid states; brand canvas + RTL (mirrors PublicShareFilePage) |
| `src/App.tsx` | Registers the public route `/rate/:token` outside AppLayout |
| `src/pages/Records/hooks/useFieldDefaults.ts` | `default_dynamic: 'token'` — stamps a write-once `rating_token` (random UUID) into a new visit's form on mount |
| `src/pages/Followups/components/TimelinePanel.tsx` | Renders the "تقييم الزيارة: N/5" subtitle + tone on visit timeline entries |
| `src/pages/Followups/components/RegisterVisitAction.tsx` | Registering a visit is what arms the rating timer (via W6) — see [followups-workspace.md](followups-workspace.md) |
| `supabase/migrations/2026-06-21_visits_rating_and_after_visit.sql` | Visit rating fields + token trigger + anon RPCs + W6/W7 edits + the "Send Visit Rating" on_due workflow |

## Open questions / known limitations
- **One rating per visit; the latest write wins.** Re-submitting overwrites the score (idempotent by design). There's no per-attempt history of changed scores — only the latest value and its timestamp.
- **No reminder / re-send.** A single rating request is sent ~2h after the visit. If the client doesn't tap the link, no follow-up nudge is sent.
- **The send depends on the on_due sweeper and the go-live switch.** The "Send Visit Rating" workflow runs on the `on_due` sweeper cron — the same gap that affects all on_due automation applies (see [workflow-automation.md](workflow-automation.md)) — and it only sends once it's been flipped `is_active = true` after the frontend deploy.
- **No free-text feedback.** The page captures a 1–5 star score only; there's no comment box. A qualitative-feedback field is a possible future addition.
- **Latest-only client mirror.** A client with several visits shows only the most recent rating on their account; the per-visit history lives on the visits records / the `v_visits` view, which is what analytics use.

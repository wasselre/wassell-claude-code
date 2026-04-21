# PRD: Home Page

**Status:** Live
**Last updated:** 2026-04-18
**Related PRDs:** navigation-layout.md, dashboards.md, record-management.md

## What it is (in plain English)
The home page is what users see when they land on the app (`/`). It's a welcome/overview screen that orients the user: a greeting, Wassell branding, summary counters (how many clients, projects, follow-ups), and quick links to the most-used models and the Builder. It is NOT the full dashboard system — that's a separate area (see dashboards.md).

## Why it exists
Dropping a user straight into a specific model feels arbitrary. A home page gives a consistent starting point and surfaces quick entry points to the day's work.

## Key behaviors
- URL: `/`.
- Shows Wassell logo and welcome text (bilingual via i18n).
- Displays small stat tiles (record counts per key model — clients, projects, follow-ups).
- Provides quick-action buttons/links: "New Client", "New Follow-Up", "Open Builder".
- Respects current language (AR or EN) for all text and direction.

## User flows
1. **Land on app:** Go to `/` → see greeting + tiles + quick actions.
2. **Click a stat tile:** Navigate to that model's record list.
3. **Click a quick-action:** Jump directly to `/model/:modelName/new` or `/builder`.

## Data touched
- Reads: `records` (for counts per model).
- Reads: `models` (to know which models exist).

## Key files
| File | What it does |
|---|---|
| `src/pages/Home/HomePage.tsx` | The home page component |
| `src/stores/appStore.ts` | Provides record/model data for counts |

## Open questions / known limitations
- Stats are static snapshots (count at render time) — no sparkline or trend.
- No per-user personalization (e.g. "your tasks for today").
- No pinned widgets or embedded dashboard widgets yet — home is fixed content.

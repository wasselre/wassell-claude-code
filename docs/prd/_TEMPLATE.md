# PRD: <Feature Name>

**Status:** Live
**Last updated:** YYYY-MM-DD
**Related PRDs:** <list other PRDs this depends on or feeds into>

## What it is (in plain English)
One paragraph. No code. Describe what the user sees and does.

## Why it exists
What problem does this solve for the user?

## Key behaviors
- Bullet list of the most important things this feature does
- Include any non-obvious rules (e.g. "base sections always show regardless of section selector")
- State defaults and edge cases

## User flows
1. **Main happy path:** numbered step-by-step
2. **Alternate flow:** any branch worth documenting
3. **Error/empty state:** what the user sees when something is missing

## Data touched
Which tables/JSONB shapes are read or written. Example:
- Reads: `models.schema.sections`
- Writes: `records.data` (JSONB)

## Key files
| File | What it does |
|---|---|
| `src/pages/.../SomePage.tsx` | Main page / top-level component |
| `src/lib/someUtil.ts` | Business logic |

## Open questions / known limitations
- Anything not yet decided or a known gap

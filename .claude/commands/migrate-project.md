---
description: Migrate a real-estate developer's project + ALL its units into the CRM (accepts a project URL and/or files)
---

Invoke the `migrate-project` skill and run its full pipeline to migrate the project the user is giving
you — a developer project page URL (almajdiah.com, alajlaninvest.com, …) and/or files (units
spreadsheet, brochure PDF, plans PDF/images, screenshots) — into the Wassell CRM (`all_projects` +
`units`).

Follow the skill's `SKILL.md` exactly: discover the units API and/or parse the files, read the brochure
and unit plans, find-or-create the developer and project (dedup by `project_name`), write every unit
linked via `project_id`, assign auto-IDs, create any missing options via `add_field_option`, and let
the DB triggers compute the rollups. Honor every rule in the skill's Decisions Log, and when you must
ask the user something new, record the answer back into the skill so it's never asked again.

Project input (URL and/or attached files): $ARGUMENTS

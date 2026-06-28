# migrate-project reference scripts

Proven on **Almajdiah** (project 229). They are the reference implementation of each pipeline step.
All load secrets from `C:\Users\rayan\Claude\wassell-claude-code\.env.local`
(`SUPABASE_SERVICE_ROLE_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`).

Run order (parameterize the project id / URL at the top of each — currently hardcoded to the Almajdiah
229 example; generalize per project):

1. `01-discover-api.mjs` — open the project page in Browserbase, capture network requests, find the
   units JSON API + pagination + any plans/brochure links.
2. `02-extract-units.mjs` — page through the units API → `proj_<id>.json` (project meta + all units).
3. `03-read-project-page.mjs` — Browserbase page text + brochure/map links. (Then download the brochure
   PDF; render to PNG with PyMuPDF if no text layer; read visually for amenities/services/landmarks/features.)
4. `04-build-and-write.mjs` — build + write the project and all units via `record_save` (service key),
   resolve/create developer + project, create options via `add_field_option`, link units. **Add
   `record_assign_auto_id` for `project_id` (all_projects) + `unit_code` (units) on real runs.**
5. `05-plans-to-unit_plan.mjs` — download each `chart_file_urls` plan, upload to `wassel-files`, insert
   `files` row, set `unit_plan`, merge plan-read components.

A `cleanup.mjs` pattern (delete files+storage, units, project, revert options) is in the skill body.

**Non-Almajdiah developers** (Alajlan Invest, etc.): step 1 is the adapter — each site has its own
units endpoint + field shape. Document each new site in `SKILL.md` → Open questions as you learn it.

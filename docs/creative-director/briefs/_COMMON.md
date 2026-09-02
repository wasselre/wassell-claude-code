# Common rules for every coder on the Post Creative Director build

You are one coder on a parallel team. Worktree root = the current directory
(`marketing-writing-posts-590cfc`). Work ONLY inside it. NEVER run `git commit`,
`git push`, `git stash`, `git checkout`, or `git reset` — the lead handles git.
NEVER edit files owned by another agent (ownership table: `docs/creative-director-contracts.md` §12).
If you need a change in someone else's file, write the request into your report instead.

READ FIRST, fully: `docs/creative-director-contracts.md` (the canonical contract) and
`src/lib/creative/contracts.ts` (canonical types; the worker copy is `worker/src/creative/contracts.ts`).
Sibling (already-applied, reused) contract: `docs/marketing-script-visual-contracts.md`.
Reused modules you must NEVER edit: `worker/src/ai/**`, `worker/src/marketing/script/{types,facts,entities,claims,brief}.ts`,
`scripts/eval/_lib/env.mjs`, `scripts/_lib/serviceClient.mjs`.

Environment: deps are installed (`node_modules`, `worker/node_modules`); `.env.local` has
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `FAL_KEY`. You have NO database
MCP. To READ live data, write a small `node` script using `scripts/_lib/serviceClient.mjs`
(PostgREST: `.from().select()`, `.rpc()`); you cannot run raw SQL. NEVER apply migrations —
write the `.sql` files; the lead applies them and reports back. Known live facts:
- `generation_jobs` kind CHECK today: ('image','video','audio','clean-text','video-convert','listing-mirror').
- `claude_jobs` kind CHECK today: ('ping','client_study','mkt_content_enrichment','mkt_campaign_summary','whatsapp_reply','mkt_visual_ocr','aqar_listing_extract').
- `mkt_social_accounts` columns: id, organization_id, platform (instagram|tiktok|snapchat|youtube|x|facebook), handle, profile_url, external_account_id, display_name, followers, verified, is_active (default true), provider (apify|youtube|browserbase), provider_metadata jsonb, sync_cursor, last_synced_at, scrape_status (idle|ok|auth_failed|rate_limited|unavailable|error), created_at, updated_at, collection_enabled (default false), cadence jsonb, last_incremental_at, last_metrics_at.
- `mkt_organizations` columns: id, org_type (developer|marketer|agency|influencer|internal|publisher), name_ar, name_en, website, developer_record_id, hq_city, followers_cached, status, metadata, created_at, updated_at. Wassel is NOT registered yet. Wassel handles (from `mos_platform_accounts`): instagram `wassel.re`, tiktok `wasselre`, snapchat `wasselre`, x `@wassel_sa`.
- `notification_rules` columns: role_id uuid, event text, channel text, timing text, enabled bool, updated_at. Existing events: budget_signature, changes_requested, content_approved, manual_task_assigned, mentioned_in_comment, monthly_report_ready, publish_due, publish_failed, task_assigned, task_due_soon, task_overdue. There is NO `video_script_ready` rule (the video lane emits it via `notify_emit` without a rule — in-app bell always fires).
- `mos_settings(key text PK, value jsonb, updated_by_user_id, updated_at)`; existing keys include `ai_roles`, `script_writer_rules`, `script_writer_v2`.
- `mkt_content_library` current signature: (p_shelf text, p_org uuid, p_format text, p_platform text, p_has_offer boolean, p_q text, p_limit int DEFAULT 40, p_offset int DEFAULT 0); latest body in `supabase/migrations/2026-08-31_08_content_library_project_link.sql`.
- `business_files_search(p_q text, p_filters jsonb, p_sort text, p_page int, p_page_size int)`; latest body in `supabase/migrations/2026-08-31_03_search_primary_category.sql`.
- `file_enrichment_complete(p_job_id uuid, p_result jsonb)` latest body in `2026-08-31_02_enrichment_primary_category.sql`.
- `vector` extension installed. `mos_script_brief(p_content_id)` RPC exists (returns jsonb brief).
- Runner lane→kind mapping lives in `supabase/migrations/2026-07-29_aqar_listing_extract_lane.sql` (v_ocr_kinds etc.) — read it before touching kinds.

Coding rules: TypeScript strict, no `any`, bilingual UI strings (`isAr ? 'عربي' : 'English'`), RTL-first,
no silent catches (every catch names its case and logs `console.error`), stable error prefixes
(`provider:`, `facts_insufficient:`, `validation_unrepaired:`, `rights_blocked:`, `policy_blocked:`, `budget_exceeded:`),
additive migrations only (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING; never DROP/RENAME),
never privatize competitor media. Worker is a standalone package: it cannot import from `src/` or `api/`
(copy + mark as copy). Tests: vitest (`cd worker && npx vitest run src/creative`; root `npx vitest run <path>`).
Typecheck: `cd worker && npm run typecheck`; root `npx tsc --noEmit -p tsconfig.json`; api `npx tsc --noEmit -p tsconfig.api.json`.
Peer modules may not exist yet: code against the CONTRACTED names/signatures and, if a peer file is
missing when you typecheck, declare the minimal local interface in YOUR OWN file — never create or stub the peer's file.

When done, write `docs/creative-director/reports/<AGENT>.md` with: files created/changed, exported
signatures, migrations written (not applied), tests + typecheck results (paste the command output tail),
contract deviations you propose, and anything other agents/the lead must do. Finish only when your own
typecheck passes for the files you own (peer-missing errors are allowed only if isolated to peer imports — list them).

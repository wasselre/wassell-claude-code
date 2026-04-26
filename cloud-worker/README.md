# cloud-worker — Wassell presentations cloud runtime

This is the **Phase 0** scaffold for the cloud-side replacement of the local
`daemon/` folder. It's a small Node process that polls Supabase for queued
presentation jobs and runs them against the Anthropic API.

It's intentionally minimal right now: the only thing it does to a job is
make one trivial Anthropic API call and write the response back as the
result. The point of Phase 0 is to prove the cloud → Anthropic → Supabase
roundtrip works end-to-end, before we layer on tools, the template builder,
or Paseetah.

See `docs/prd/presentations.md` for the full plan. Phase numbering used
inside this folder matches that doc.

## What's running where after Phase 0

| Piece | Today (local daemon) | After Phase 0 (this folder) |
|---|---|---|
| Job poller | `daemon/src/index.ts` on your laptop | This worker, on Fly.io (or wherever) |
| Job runner | `claude --print /wassel <brief>` (CLI on your laptop) | Anthropic API call from the cloud |
| Supabase queue | `presentation_jobs` table | Same table, no schema change |
| App-side polling | `usePresentationJobsPolling.ts` | Unchanged |

The two workers can technically coexist (both call `claim_next_presentation_job`
which uses `FOR UPDATE SKIP LOCKED`), but during Phase 0 testing we recommend
running only **one at a time** — otherwise jobs go to whichever picks first.

## Local development

```bash
cd cloud-worker
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
npm install
npm start
```

The worker will:

1. Print `[cloud-worker] starting v0.1.0-phase0 as cloud:<host>:<pid>`
2. Heartbeat into `daemon_status` immediately (the app's offline banner clears within ~15s)
3. Poll `presentation_jobs` every 5 seconds for queued rows
4. For each claimed job: call Claude Opus 4.7 with a 1-line smoke prompt, then mark the row `completed` with the response text in `result.warnings`

Stop it with `Ctrl+C`. It writes a final heartbeat marking a clean shutdown.

## Production deploy (Fly.io)

```bash
cd cloud-worker
fly launch --no-deploy            # pick an app name; this writes app= into fly.toml
fly secrets set \
  SUPABASE_URL=https://...supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
  ANTHROPIC_API_KEY=sk-ant-...
fly deploy
fly logs                          # watch it boot
```

The Dockerfile installs production deps + tsx, no compile step. fly.toml
sets a single shared-cpu-1x machine in Frankfurt (`primary_region = "fra"`)
— change that to whatever's closest to your Supabase region.

This worker has no HTTP listener and no public port. It only talks to
Supabase and the Anthropic API. There's nothing to scale to zero on, so the
machine stays running 24/7 (~$15/mo on Fly.io's smallest tier).

## Switching from the local daemon

After this worker is deployed and you've verified it picks up a job:

1. Stop the local `daemon/` (Ctrl+C, or `Stop-Service` if you installed it as a Windows service).
2. Click "+ New Presentation" in the app, pick the `ping-test` template, hit Generate.
3. Watch the cloud worker logs: `fly logs`.
4. The job should flip from `queued` → `running` → `completed` within a few seconds, with the smoke-test response visible in the detail page's warnings.

You can run **both** workers simultaneously during testing, but a queued
job will only be picked up by one of them — whoever wins the race.

## What this does NOT do (yet)

- **Tools.** No web search, no record lookup, no PowerPoint building, no Drive upload. That's Phase 1.
- **Template steps.** All jobs get the same hardcoded smoke prompt. The `template.input_schema` is ignored. That's Phase 3.
- **Paseetah.** No paseet.ai access from the cloud. That's Phase 4.
- **Job timeout.** `JOB_TIMEOUT_SECONDS` is read from env but not yet enforced — the smoke call returns in seconds, so it doesn't matter at Phase 0.
- **Streaming progress.** No `progress_*` updates land mid-run; the row jumps straight from `running` to `completed`. That's Phase 3.

## File map

| File | What it does |
|---|---|
| `src/index.ts` | Main loop — sweep stale jobs, heartbeat, poll, dispatch to runner |
| `src/runner.ts` | Phase 0 runner — one Anthropic call, write `completed` |
| `src/anthropic.ts` | Anthropic SDK client + default model constant |
| `src/heartbeat.ts` | 15s upsert to `daemon_status` (id='presentations') |
| `src/supabase.ts` | Service-role Supabase client |
| `src/env.ts` | Env loading + validation |
| `src/version.ts` | Version string written to `daemon_status.version` |
| `src/types.ts` | Narrow row types — only fields we actually read/write |
| `Dockerfile` | Container image (node:22-alpine + tsx) |
| `fly.toml` | Fly.io deploy config |

# Claude Code runner — always-on intelligence execution

**Last updated:** 2026-07-26

The runner executes Wassel's marketing-intelligence *judgement* work as headless
Claude Code sessions, authenticated with the **paid Claude subscription**. It is
no longer a script on a developer laptop: it runs continuously on Fly.

> **Billing language — use this wording.** Work executed through the runner
> carries **no incremental per-token API charge**; it is **included within the
> existing Claude subscription** and is **subject to that subscription's shared
> capacity**. It is not "free" — heavy runner use consumes the same capacity as
> interactive sessions.

---

## 1. Where it runs

| | |
|---|---|
| Fly app | `wassel-claude-runner` |
| Region | `sin` (Singapore) — `bom` had no capacity for a 1 GB machine on 2026-07-26. Region is latency-only; all work is DB-queued. |
| Machines | 1 primary + 1 Fly standby, `shared-cpu-1x` / 1 GB |
| Image | `runner/Dockerfile` (node:22-slim + pinned Claude CLI + tini) |
| Config | `runner/fly.toml` |
| Entry | `scripts/claude-study-runner.mjs` |
| Public surface | **none** — no `[http_service]`. Liveness is the DB lease heartbeat. |

Deploy from the repo root (the build context needs `scripts/` and `.claude/skills/`):

```bash
flyctl deploy --config runner/fly.toml --dockerfile runner/Dockerfile --app wassel-claude-runner
```

Logs: `flyctl logs --app wassel-claude-runner`.
Health: `select claude_runner_health();`, or the **Intelligence runner** card in
Settings → Marketing Operations.

### Machines stopped after a deploy

`flyctl deploy` updates config but does **not** start machines that were already
stopped. If health shows no live lease, check `flyctl machines list` and
`flyctl machine start <id>`.

---

## 2. Authentication (subscription, not API key)

The container authenticates with `CLAUDE_CODE_OAUTH_TOKEN`, injected as a Fly
runtime secret.

| Question | Answer |
|---|---|
| Token type | Long-lived OAuth token from `claude setup-token` (`sk-ant-oat01…`) |
| Owner | The Wassel Claude subscription account (`r.abanumay@wassel.re`) |
| Where stored | `fly secrets` on `wassel-claude-runner` **only** — never in an image layer, git, build args, or logs |
| Where else it exists | `.env.local` on the owner's machine |
| Renewal | Not automatic. Regenerate with `claude setup-token`, then `flyctl secrets set CLAUDE_CODE_OAUTH_TOKEN=… --app wassel-claude-runner` (triggers a restart). |
| Rotation | Same command; rotation is a restart, not a redeploy |
| Failure mode | Sessions fail; jobs go `failed` with the CLI's auth error; the Operations card shows failures and the queue backs up. The lease stays live (the process is healthy), so **watch `failures_24h`, not just liveness**, for auth expiry. |

**The container has no `ANTHROPIC_API_KEY`** — verified: `env | grep -c
ANTHROPIC_API_KEY` returns `0`. `runClaude()` additionally deletes
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` from the
child environment. The runner therefore **cannot silently fall back to metered
API billing** — if the subscription is unavailable, work stops visibly.

Verified in-container on 2026-07-26: Claude CLI `2.1.220`, fetched account policy
from Anthropic, and a real `claude -p` session returned `PONG` in 30 s.

To secure secrets without echoing them:

```bash
flyctl secrets import --app wassel-claude-runner < secrets.env   # then shred the file
```

---

## 3. Exactly one runner (singleton)

`claude_runner_lease` (lease name `marketing_intelligence`) is the authority:
atomic compare-and-set acquire, 30 s heartbeat, 120 s TTL, all comparisons on the
**database clock**.

Three layers, because each catches something the others cannot:

1. **Dev-mode gate** — the script refuses to start unless `RUNNER_ENV=fly` (baked
   into the image) or `RUNNER_ALLOW_LOCAL=1`. Stops a laptop from *becoming* the
   production owner.
2. **Lease acquisition** — a second process waits out the TTL, then exits 0 if a
   live owner still holds it.
3. **`claude_job_claim_next` requires the lease** (2026-08-02) — a worker that
   does not own a live lease is **refused with an exception naming the real
   owner**. This is the layer that matters: the lease previously only governed
   *our* process, and on 2026-07-26 an unrelated Fly app (`wassel-wa-agent`,
   worker id `wa-agent-48e71eea972308`) claimed a `mkt_campaign_summary` job
   directly while the runner was down. The invariant now lives in the database.

### Proven behaviours (2026-07-26)

| Scenario | Result |
|---|---|
| Local runner while Fly holds the lease | Refused, named the Fly owner, exit 0 |
| Second Fly machine started | Refused, exit 0, machine stopped |
| Expiry takeover (A holds → B refused → A expires → B acquires → A refused) | All four assertions passed |
| Restart **during** a job | Grace period let the session finish; job `ready`, `attempts=1`, no duplicate run |
| Hard `SIGKILL` (machine loss) | Auto-reboot, lease reacquired within seconds |
| Non-owner calling `claude_job_claim_next` | Exception `42501` naming the owner |

### Two bugs this testing exposed (both fixed)

- **`kill_timeout` was 5 s** while graceful shutdown waits up to 60 s — a restart
  would have SIGKILLed mid-job. Now `90s` in `fly.toml`.
- **Restart inside the TTL window exited 0 and stayed down.** After a SIGKILL the
  lease is still held by our own *dead* predecessor; the restarted process saw
  "another runner owns the lease", exited 0, and Fly does not restart on exit 0 —
  the app was down ~25 minutes. Boot now **waits out the TTL** before concluding
  someone else owns it.

---

## 4. Crash recovery

`claude_jobs_watchdog()` is invoked *by the runner* every 5 minutes and only
sweeps jobs `running` > 45 min — useless while the runner itself is dead. So
`claude_jobs_recover_orphaned(p_owner)` runs **once at boot, right after winning
the lease**. Winning the lease proves the previous owner stopped heartbeating for
a full TTL, so anything still `running` under a *different* owner is abandoned:

- `attempts < 3` → requeued
- `attempts >= 3` → failed loudly (a job that kills the runner every time must
  not crash-loop)
- jobs owned by *this* worker, or younger than 180 s, are never touched

Recovery is seconds instead of 45 minutes. The watchdog remains the backstop.

**This fired on a real incident within minutes of shipping**: it reclaimed the
`mkt_campaign_summary` job that `wassel-wa-agent` had stranded, requeued it, and
the runner completed it normally.

---

## 5. Skills

| Kind | Skill | Evidence RPC | Validator |
|---|---|---|---|
| `mkt_content_enrichment` | `.claude/skills/content-enrichment` | `mkt_intelligence_evidence` | `scripts/lib/mkt-enrichment-validate.mjs` |
| `mkt_campaign_summary` | `.claude/skills/campaign-summary` | `mkt_campaign_evidence` | `scripts/lib/mkt-campaign-summary-validate.mjs` |
| `client_study` | `.claude/skills/client-study` | — | result-sentinel contract |
| `ping` | — | — | expects `PONG` |

Every intelligence Skill follows the same shape, on purpose — a second bespoke
pattern would be a second thing to operate:

> scoped evidence RPC → temp `evidence.json` → Skill session → strict
> `result.json` → **pure validator** → scoped upsert RPC

**Claude never writes to the database.** The validator is the gate. For campaign
summaries it enforces that `evidence_refs ⊆ that campaign's own members`, which
is what keeps a narrative falsifiable — a summary citing another campaign's post
is either a hallucination or a batch mix-up, and both fail loudly.

### Evidence is never silently truncated

Caps are generous (caption 8 000, transcript 16 000, OCR 12 000; no production
post has ever approached them — max observed 804 / 1 081 / 1 360) and every
package reports `evidence_lengths` + `evidence_truncated` per field. Campaign
evidence likewise reports `members_omitted` and `siblings_omitted`, and the
validator **forces those caveats into the stored summary** even when the Skill
forgets them.

This exists because a review judged from a 45-character preview reversed a
*correct* attribution. The same lesson is now enforced in three places: the
evidence RPCs report their own limits, `matchSnippet()` centres the stored
snippet on the match instead of taking the caption head, and the Skills are told
to read the whole evidence.

---

## 6. Visual processing — benchmark and recommendation

`worker/src/marketing/content/vision.ts` is the **only remaining direct Anthropic
API call in marketing intelligence** (`claude-sonnet-4-6`, forced-tool structured
output, ≤8 images per call). It runs inside `content_process` on the
**5-machine** `wassel-deck-worker`, in parallel.

### Measured cost (production, to date)

| Metric | Value |
|---|---|
| Total vision spend | **$2.2865** |
| Posts with OCR | 82 of 765 |
| Rows | 364 |
| **Cost per post** | **$0.0279** |
| Rows extracting no text | 39 / 364 (10.7 %) |
| Projected cost to OCR all 765 posts | ≈ **$21** |

### Benchmark, on identical real inputs

Four production creatives (stylised Arabic marketing typography over
gradient/photographic backgrounds, bilingual map labels, letter-spaced Arabic).

| Option | Quality | Incremental cost | Throughput |
|---|---|---|---|
| **A — Anthropic API (current)** | Baseline; full bilingual extraction + structured fields | $0.0279/post | Parallel across 5 worker machines |
| **B — Claude Code visual Skill on the runner** | **Matched A** on both images tested — identical landmark lists, phone `920033158`, URL, handle; caught everything A caught | No incremental per-token API charge (subscription capacity) | **Sequential, 1 machine**: ~30–90 s per post → ~7–17 h for the 683 remaining posts, and it would block enrichment/summaries the whole time |
| **C — deterministic OCR + Claude interpretation** | **NOT MEASURED** — Tesseract is not installed locally, in the container, or available in the slim image's package lists | Would still need a Claude pass for the structured fields | Unknown |

### Recommendation — keep vision on the Anthropic API for now

Not because B is worse at the task (it is not — it matched A on every sample),
but because of what it costs *operationally*:

1. **The runner is a single sequential machine by design.** Vision is per-post
   mechanical work at ~0.9 posts/minute; moving it to the runner would serialise
   the entire media pipeline behind one machine and starve the judgement work
   (enrichment, campaign summaries) that genuinely needs Claude.
2. **Subscription capacity is shared and finite.** Spending it on OCR displaces
   interactive sessions and the intelligence Skills.
3. **The cost being avoided is small and known**: $2.29 to date, ≈$21 to process
   every post currently held.

**Revisit if** vision spend exceeds roughly **$25/month**, or if post volume
grows past a few thousand — at which point the right move is B for *backfill*
(off-peak, when the runner is idle) while keeping A on the live path. Option C is
not recommended without evidence: it cannot remove the model call (the structured
fields still need Claude), so it adds a Tesseract + Arabic-traineddata dependency
to replace only the part Claude already does well.

---

## 7. Total intelligence cost position

| Workload | Execution | Incremental API cost |
|---|---|---|
| Content enrichment + attribution | Claude Code runner | none (subscription) |
| Campaign summaries | Claude Code runner | none (subscription) |
| Client studies | Claude Code runner | none (subscription) |
| Visual text / OCR | Anthropic API (`vision.ts`) | $0.0279/post — **$2.2865 total** |
| Transcription | FAL wizper | provider-billed (unchanged) |
| Collection | Apify / YouTube / Browserbase | provider-billed (unchanged) |

Marketing-intelligence **judgement** work now carries no incremental per-token
API charge. The only metered Anthropic spend left in this vertical is visual
extraction, quantified above.

---

## 8. Operational visibility

`claude_runner_health()` (exposed as `ops_runner_health`, admin-gated, rendered
by `RunnerHealthCard`) returns lease owner/host/pid/heartbeat age, queue depth by
status, oldest pending age, current job, 24 h failure groups, subscription-limit
blocks, last completion, and posts awaiting intelligence. It returns identifiers,
states, counts and ages only — **no OAuth token, credentials, job payloads, or
customer evidence**.

`runnerStatus()` (`src/lib/marketing/ops.ts`, unit-tested) classifies:

| Condition | Severity |
|---|---|
| No lease / lease expired | **critical** → Down |
| Heartbeat older than 75 s (renewal is 30 s) | warning |
| Pending jobs aging past 15 min | warning |
| A job running past 30 min | warning |
| Subscription-limit blocks in 24 h | warning |
| ≥5 failures in 24 h | warning |
| Posts `awaiting_intelligence` with **nothing queued** | warning |

The last one matters most: it is the failure the runner cannot self-report —
idle and healthy while work is stranded upstream because enqueue never happened.

---

## 9. Known state / follow-ups

- **Campaign grouping produces singletons.** All 23 campaigns hold exactly one
  member — signatures include the per-post key message, so nothing collapses.
  Summaries are therefore per-post and correctly report `is_single_item` with low
  confidence. Grouping was explicitly out of scope for this run; fixing it is
  what would make campaign summaries genuinely valuable.
- **`wassel-wa-agent` claims `claude_jobs`.** A separate Fly app, deployed
  2026-07-26 05:47, drained a job from this queue. It is now refused by
  `claude_job_claim_next`. **Its owner should either stop draining `claude_jobs`
  or coordinate on the lease** — if it needs its own queue, it must not reuse
  this one.
- **Recovery after a hard kill can take up to the 120 s TTL** when the restarted
  process gets a different pid. Acceptable; the TTL exists for this.

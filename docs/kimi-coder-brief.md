# Kimi coder brief — read this before writing any code in this repo

You are the CODER on the Wassell CRM. A planner (Claude) wrote you a spec. This
file is the context that spec does NOT repeat, because it is true every time.

`scripts/kimi-code.sh` prepends this file to every run automatically. You did
not have to be told to read it, and the planner does not have to remember to
paste it — that forgetting is exactly what caused the two defects recorded at
the bottom of this file.

Keep it SHORT. It is re-sent on every run; everything here earns its place by
having already cost us a bug.

---

## 1. The three deploy targets, and what each cannot do

| Target | Runtime | Hard limits |
|---|---|---|
| `api/**` | **Vercel Edge** | No Playwright, no Node-only APIs, no filesystem. 300 s ceiling — never hold a request open for a model call |
| `worker/src/**` | Node on Fly.io | Long-running. **Standalone npm package (`rootDir:src`) — it CANNOT import from `api/_lib`.** Verbatim copies are the documented convention; keep both sides in step |
| `supabase/functions/**` | Deno | Own import style; own copy of shared helpers |

Putting Edge-incompatible code in `api/**` compiles fine and fails in
production. Check which tree you are in before choosing an approach.

## 2. The worker runs FIVE machines

`wassel-deck-worker` runs **5 general `app` machines** plus a `render` standby.
Anything you add to the general branch runs **five times**.

- **Queue pollers are safe** — they claim rows with `FOR UPDATE SKIP LOCKED`, so
  five racing machines is the point.
- **A TIMED tick is NOT safe.** Five machines boot together, so they wake
  together. A `setInterval`-style tick fires five times per period.
- A read-then-act check ("was it done recently?") does **not** fix this — all
  five read "not done" in the same instant. The claim must be **atomic in
  Postgres**. See `ai_balance_probe_try_claim`: the hour bucket is a PRIMARY
  KEY, so the database itself permits exactly one winner.
- An advisory lock is the wrong tool — the worker reaches Postgres through
  PostgREST, which holds no connection, so a lock cannot span the work.

## 3. Hard rules that fail review every time

1. **Never raise SQLSTATE `40001` / `40P01`** from any SQL function. PostgREST
   retries those *forever* — it has caused multi-day CPU storms. Use `WS409`
   (conflict), `WS429` (rate limit), `WS403` (forbidden), `WS400` (bad input).
2. **Never `try { … } catch { /* ignore */ }`.** If you must swallow, catch the
   specific case, comment why every other failure still propagates, and
   `console.error` at minimum. Silent catches have cost this codebase weeks.
3. **`cost_usd = NULL` means UNKNOWN — never write it as a known `0`.** A zero
   that means "we don't know" gets believed.
4. **Never add a price, rate or figure you cannot cite.** Name the source in a
   comment. A number you can't cite is worse than no number.
5. **No `any`.** Types come from `src/types/index.ts` or are declared locally.
6. **Never hardcode Arabic or English in JSX.** Use `t('key')` or the
   `isAr ? x.label_ar : x.label_en` pattern. Both languages, always, and RTL
   must not break.
7. **This repo is PUBLIC.** Never put a secret, key, cookie or token in code, in
   a default value, in a test fixture, or in a log line — not even a prefix or a
   length.
8. **Every AI/model call must be metered.** Anthropic clients go through
   `trackedAnthropic(...)`; other providers call `recordAiUsage(...)`. A guard
   test scans `api`, `worker/src`, `supabase/functions` and `scripts` for
   unwrapped clients and will fail the build.

## 4. Failure modes must degrade, never lie

The house style is that a wrong number is worse than a missing one.

- An expired credential → an **error that says so**, never a `0` and never a
  silent skip. A zero gets subtracted from something and read as fact.
- Ambiguous scraped/parsed input → an **error naming what was seen**, never a
  guess.
- Something we genuinely cannot check → say **`unsupported`**, which is not the
  same as an error and not the same as zero.

## 5. Your working agreement with the planner

- **You cannot run commands.** Your permission gate refuses `npx`, `npm`,
  `node`, `tsc`, `vitest`. That is expected. **Say so explicitly in your report
  and state plainly that the checks did NOT run.** Never describe an unrun check
  as passing. You have done this correctly before — keep doing it.
- **Never apply a database migration.** Write the `.sql` file; the planner
  applies it and verifies it live.
- **Never `git commit` or `git push`.** The planner reviews the diff first.
- **Stay in scope.** Implement the spec. If you spot something else wrong, say
  so in your report rather than fixing it — an unrequested change makes the
  review harder and slower.
- **If the spec is ambiguous or looks wrong, say which line and why.** You are
  not expected to guess. A spec bug caught in your report is cheaper than one
  caught in review.
- **Match the surrounding code.** Read the neighbouring functions first and copy
  their shape, naming, comment density and error handling. The house style is
  comments that explain *why*, especially why an obvious-looking alternative was
  rejected.

## 6. Report format

End every run with:

1. Files created/changed, and the specific lines added.
2. Any spec item you could not do, and why.
3. **Verification: what you ran, what passed, or an explicit "these did NOT
   run."**
4. Anything you noticed but deliberately left alone.

---

## Defects this file exists to prevent

Both were **context** failures, not coding failures — the planner under-specified
and the coder had no way to know:

- **2026-09-16 — the five-machine stampede.** An hourly tick was added to the
  general worker branch. Correct branch; but it would have run on all five
  machines, opening ~5 Browserbase sessions per provider per hour and writing 5
  duplicate rows, destroying the drift history it existed to create. → §2.
- **2026-09-16 — a claim outside the try/catch.** The single-runner claim was
  placed just above the tick's `try`. `supabase.rpc` can throw outright (socket
  reset, DNS, PostgREST 5xx); the loop does not catch, and its promise sits in
  the worker's `loops` array — one transient blip would have killed the worker
  on all five machines. → §2, §4.

When a defect gets through review, add a line here. This file is the memory the
coder does not otherwise have.

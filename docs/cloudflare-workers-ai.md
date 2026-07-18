# Cloudflare Workers AI — Qwen provider (standalone)

**Status:** Provisioned + standalone verification only. **NOT integrated** with
translation, listings, copywriting, or any other Wassel flow — that requires a
separate approved plan (user decision, 2026-07-18). Anthropic remains the
production LLM everywhere.

## What this is

An independent, reusable AI provider that calls **Cloudflare-hosted** models
over Cloudflare's OpenAI-compatible REST API. We do not self-host anything and
do not upload model weights — Cloudflare runs the model and GPUs; we call:

```
POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions
Authorization: Bearer <CLOUDFLARE_API_TOKEN>
```

**Selected model:** `@cf/qwen/qwen3-30b-a3b-fp8` — Qwen3 30B (MoE, ~3B active
params, fp8). Strong multilingual (incl. Arabic) chat model. Note it is a
*thinking* model: completions may embed `<think>…</think>` reasoning blocks
that callers should strip before display (the smoke test does).

## Where everything lives

| Piece | Path |
|---|---|
| Provider module (isolated; imported by NOTHING yet) | `api/_lib/cloudflareAi.ts` |
| Smoke tests (EN + AR + auth-mapping) | `scripts/smoke-cloudflare-ai.ts` |
| Env documentation | `.env.example` (Cloudflare section) |

## Cloudflare account

The company already has a Cloudflare account — it serves DNS for `wassel.sa`
(`lakas`/`carioca.ns.cloudflare.com`). Use that account; do **not** create a
second one. Workers AI needs no special activation — any account can call it;
usage on the free Workers plan requires no payment method.

## Credential creation (dashboard, one-time)

1. Log in at <https://dash.cloudflare.com> (the account that manages
   `wassel.sa`). Make sure MFA is enabled on the account
   (My Profile → Authentication).
2. Copy the **Account ID**: pick the account → the Account ID is on the
   right-hand side of the account home (or in the URL:
   `dash.cloudflare.com/<ACCOUNT_ID>`).
3. Create the token: My Profile → **API Tokens** → **Create Token** →
   **Create Custom Token**:
   - **Name:** `wassel-workers-ai-qwen`
   - **Permissions:** `Account` / `Workers AI` / `Read` **and**
     `Account` / `Workers AI` / `Edit` — nothing else. (Both are required for
     REST inference.)
   - **Account Resources:** *Include → the specific Wassel account only* (not
     "All accounts").
   - Leave IP filtering/TTL as desired (a TTL forces rotation; optional).
4. Copy the token **once** at creation. Never use the **Global API Key** — the
   scoped token is the only credential this provider accepts.

## Secret storage (project conventions)

| Variable | Local dev | Production |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `.env.local` (repo root, git-ignored) | Vercel env (when integration is approved) |
| `CLOUDFLARE_API_TOKEN` | `.env.local` | Vercel env / `fly secrets set` (whichever side integrates later) |
| `CLOUDFLARE_AI_MODEL` | optional — defaults to `@cf/qwen/qwen3-30b-a3b-fp8` | same |
| `CLOUDFLARE_AI_BASE_URL` | optional — defaults to the v4 accounts AI base; `{ACCOUNT_ID}` is substituted | same |

Never put the token in source control, docs, logs, screenshots, or chat. The
provider logs model/status/duration/token-counts only — never the credential,
never prompt/completion content.

Since nothing is integrated yet, the token intentionally exists **only** in
`.env.local` on the dev machine. Add it to Vercel/Fly only when an integration
actually ships there.

## Token rotation

1. Dashboard → My Profile → API Tokens → **Create** a new custom token with the
   same name-pattern (`wassel-workers-ai-qwen-2`) and identical scope.
2. Update `CLOUDFLARE_API_TOKEN` in `.env.local` (and Vercel/Fly if it exists
   there by then).
3. Run the smoke test (below) to confirm the new token works.
4. Dashboard → **Roll/Delete** the old token.

Immediate revocation (suspected leak): delete the token in the dashboard —
requests fail with 401 instantly; nothing else references it.

## Testing

```bash
node scripts/smoke-cloudflare-ai.ts      # Node >= 23
npx tsx scripts/smoke-cloudflare-ai.ts   # any Node
```

Three checks, all must PASS:
1. **english** — short factual prompt, expects a non-empty reply.
2. **arabic** — Arabic prompt, expects Arabic-script reply (Unicode path).
3. **auth-mapping** — invalid token must classify as `CloudflareAiError`
   `kind='auth'` (proves failures surface loudly instead of leaking through).

## Error handling contract (`api/_lib/cloudflareAi.ts`)

Every failure throws `CloudflareAiError` with a stable `kind`:

| kind | trigger |
|---|---|
| `auth` | 401/403 (bad/rotated token), or missing env |
| `rate_limit` | 429 request-rate throttling |
| `quota_exhausted` | daily free Neuron allowance spent (429/403/402 with allocation/neuron wording) |
| `timeout` | request exceeded the deadline (default 60 s, per-call override) |
| `api_error` | other 4xx/5xx or malformed body |
| `network` | fetch/DNS/connection failure |

**No automatic retries anywhere.** In particular `quota_exhausted` must never
be retried in a loop — on the free plan it fails until the daily UTC reset.

## Pricing / free allowance (verified 2026-07-18)

- Workers AI free allocation: **10,000 Neurons per day** (no credit card
  needed). Neurons are Cloudflare's cross-model usage unit.
- **When the free allowance runs out on the free plan, further inference
  requests FAIL with an error** until the daily reset — there is no silent
  overage billing. The provider surfaces this as `kind='quota_exhausted'`.
- Paid overage only exists on the **Workers Paid** plan ($5/month): beyond the
  daily 10k Neurons, usage bills at **$0.011 / 1,000 Neurons**. Do **not**
  upgrade the plan or add a payment method without explicit approval.
- `@cf/qwen/qwen3-30b-a3b-fp8` unit pricing: **$0.051 / M input tokens** and
  **$0.335 / M output tokens** (≈4,625 / 30,475 Neurons per M). Rough
  capacity feel: the 10k free Neurons ≈ ~300k output tokens/day on this model.

## Hard rules

1. **Do not import `cloudflareAi.ts` from any app flow** until a separate
   integration plan is approved. It replaces nothing; Anthropic stays.
2. **Scoped token only** — never the Global API Key, never broaden the scope
   beyond Workers AI on the one account.
3. **No plan upgrades / payment methods** without explicit user approval.
4. Loud failures, no token/content in logs (CLAUDE.md silent-failures rules).

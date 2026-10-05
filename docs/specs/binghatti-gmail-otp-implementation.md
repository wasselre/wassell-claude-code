# Binghatti Gmail OTP implementation brief

Implement only this known design. Read `docs/kimi-coder-brief.md` and adjacent
worker portal code. No investigation or live probes are authorized. The planner
will review and run tests. Never run commands, use network/browser/MCP tools,
read private credential files or environment files, apply SQL, deploy, commit,
push, or send messages. Available tools are local Read/Edit/Write/Glob/Grep only.

## Scope and files

- New focused `worker/src/portals/gmailOtp.ts` and meaningful mocked unit tests.
- Integrate `worker/src/runPortalRegistrationJob.ts`, `worker/src/portals/recipe.ts`,
  `worker/src/env.ts`; add optional `BINGHATTI_GMAIL_CLIENT_ID`,
  `BINGHATTI_GMAIL_CLIENT_SECRET`, `BINGHATTI_GMAIL_REFRESH_TOKEN` and load them.
  Optional properties avoid breaking unrelated typed environment fixtures.
- New migration `2026-10-05_14_binghatti_email_otp_claim.sql`: service-only
  claim table/RPC. New migration `2026-10-05_15_binghatti_email_otp_recipe.sql`:
  insert prepare step into the current Binghatti recipe. DO NOT edit migration12.
- Update `scripts/binghatti-recipe.mjs` so regeneration keeps the prepare step;
  change its generated destination to migration15, preserving the complete
  current recipe and false schedule switches. Do not execute the generator.
- Update handwritten `docs/prd/lead-portal-registration.md`,
  `docs/lead-portal-recipes.md`, `docs/binghatti-weekly-updates.md`,
  `docs/binghatti-gmail-oauth.md`, `worker/README.md`. Never edit generated PRDs.

## Restrict activation and verify OAuth before requesting OTP

Only portal UUID `0f828ff1-c3b9-482c-8b1d-215bef4b4d43` with `otp_channel=email`
may use this reader. Missing all three optional env values preserves the current
manual/WhatsApp relay. Partial configuration fails visibly with sanitized errors.
No Gmail access for other portals. No new dependencies or cron/timed global lane.

The newly authorized connection is exact scope
`https://www.googleapis.com/auth/gmail.readonly`. Refresh through Google's token
endpoint using the three env values; require exactly this sole returned scope,
Bearer token and valid access token. Cache access token only in memory until
before expiry. Provider/network/config/auth failures must throw sanitized errors
that contain no response body, mailbox, token, URL query, or credentials.
Read-only Gmail operations are GET profile/list/get-full; no mark-read, modify,
delete, attachments, or send APIs. No secrets/tokens/codes/message bodies in logs,
results, database input_value, recipes, screenshots authored by the mail reader,
test fixtures copied from real mail, or committed files.

Add closed named recipe step `{do:'prepare_email_otp',key:'otp'}` plus optional
`RecipeRuntime.prepareEmailOtp` hook. The Binghatti recipe invokes it immediately
BEFORE `click #sendOtpBtn`, after filling userId. When configured, refresh and GET
`users/me/profile`; its normalized email MUST equal resolved `portal.login_id`.
Then capture a COMPLETE bounded paginated recent Binghatti message-ID baseline
(official-domain query, e.g. `from:(binghatti.com)`, after/before epoch bounds).
One list request at a time. Limit pages/results, reject malformed IDs, duplicate
IDs/page tokens, missing pages or a remaining nextPageToken at the ceiling;
never proceed with a partial baseline. Record requestedAt AFTER the baseline
and a fresh random request nonce. Keep both and baseline IDs only in worker
memory. Fail before GetOTP if preparation fails; no speculative portal requests.

## Fresh authenticated message selection

Poll recent Gmail messages about every5s inside the existing request_input timeout.
Every list must be complete/bounded; GET only new candidate IDs with format=full.
Reject baseline IDs, malformed/internalDate before requestedAt, future dated
beyond a defined5000ms clock-skew allowance, messages outside the current OTP
request's timeout, ambiguous, spoofed, wrong-recipient and reused messages.
Gmail internalDate is authoritative milliseconds. Ignore the untrusted Date
header; its second precision must never reject a legitimate same-second message.

Require one valid From mailbox at `binghatti.com` or its subdomain (boundary,
never display-name matching), and an exact recipient matching the verified
mailbox in delivery/To headers. Require the first Authentication-Results header
to be from `mx.google.com` and contain `dmarc=pass` with header.from aligned with
the actual From domain. Reject missing/duplicate conflicting headers or a
forged lower Authentication-Results pass; no SPF-only shortcut.

Decode only bounded inline MIME `text/plain` / `text/html` base64url data. Traverse
multipart nodes with depth/part/text ceilings; ignore attachmentId, filename,
attachment disposition, images and attachment content. HTML extraction is inert,
strips tags/comments/scripts/styles and decodes common/numeric entities without
evaluating anything. No attachment fetches. Code must be a UNIQUE expected-length
numeric OTP near explicit OTP/verification/login-code context (English and Arabic
terms where practical). Reject wrong length, multiple codes or multiple distinct
matching messages; zero/ambiguous means no auto-code and allows relay fallback.
No guessed sender, subject or template allowlist: actual delivery format is still
unconfirmed, so this generic parser is provisional and must fail safely.

## Atomic message claim and manual input precedence

`portal_email_otp_claim(p_job_id uuid,p_key text,p_mailbox_fingerprint text,
p_message_id text,p_request_nonce text)` returns boolean, service-only. Hash the
normalized verified mailbox with SHA256; never store its address. Table primary
key(mailbox_fingerprint,message_id) stores only opaque IDs, job ID and claimed_at.
Enable RLS, revoke PUBLIC/anon/authenticated privileges, service_role only.
Use SECURITY DEFINER with search_path public,pg_temp. No retryable SQLSTATE.

RPC locks the job row, checks exact Binghatti portal plus current portal's
otp_channel=email, status=awaiting_input, input_request.key=p_key='otp', kind=otp,
input_request.email_otp_nonce=p_request_nonce and input_value null/empty. Insert
unique claim ON CONFLICT DO NOTHING; only winner atomically sets status=running,
clears input_request/input_value and updates heartbeat/updated_at. Return false
without resume/claim if manual input is already present or job/request changed.
Never accept/store/pass the OTP itself to RPC. This prevents cross-job replay and
race with manual submission across five machines. Tests must model claim rejection.
Additionally bind p_mailbox_fingerprint to SHA256(lower(trim(current portal
data.login_id))). Resolve the pgcrypto digest function's schema safely through
pg_catalog.pg_extension/pg_namespace and schema-qualify it (no unsafe search_path
or unqualified digest assumption). Reject absent login_id or hash mismatch.

RequestInput preserves screenshots, request_input row handshake, cancellation,
heartbeats, parking and job terminal semantics. Add nonce to p_request only for
the prepared current OTP key. Check manual input first every existing1.5s loop;
if mail candidate is accepted, call the atomic claim RPC and return code only
if true. If false, re-read row: manual answer wins, cancellation exits, otherwise
continue waiting. Never call the generic resume RPC for auto-email success.
Keep Gmail requests bounded (<=10s) and cancellation/heartbeat checks before/after
each network page. Respect overall request deadline as well as per-fetch bounds.

For configured email flow give Gmail20s first, then queue the existing WhatsApp
code-request exactly once if no code. Other portals retain immediate relay.
Manual modal replies work immediately. Do not accidentally alter origin/relay
rules or retry/parking semantics. Missing prepared context for a configured
Binghatti OTP is a loud recipe error, not reading arbitrary old mail.

## Migration15 and truthful documentation

Migration14 is additive/backward compatible. Migration15 contains prepare step
in the existing validated recipe; explicitly document that it must apply only
AFTER deployment of the new worker. Scope update to exact portal/model/developer
as migration12. Fresh-DB replay must tolerate absent operator rows. Both daily
capture and weekly scheduling stay off; existing activation proofs remain.

Facts at implementation start: Internal OAuth app/client created in existing project
`instant-medium-503214-f9`; Gmail API enabled; sole Gmailreadonly grant/profile
and offline refresh verified; filtered Binghatti message API read worked. Three
Fly secrets are STAGED, not yet active. Private credential files are outside repo.
Never include the actual mailbox address. Current Browserbase login gets
`recaptcha_confirmed_bot_score`, fresh AE same; Verified API403Enterprise.
Gmail cannot fix CAPTCHA rejection. Actual new OTP delivery channel/template
still unverified; do not claim unattended end-to-end login/capture success.

## Required meaningful tests (planner runs commands)

Mock all fetches/RPCs; no live keys/mail/portal requests. Cover exact scope and
mailbox mismatch, partial env, OAuth/provider failures sanitized, readonly GETs,
complete baseline pagination and ceiling failure, stale/future/prebaseline/
reused/ambiguous/spoofed/wrong-recipient/wrong-length rejection, MIMEplain/html
without attachments, parser context/unique code, cancellation, five-second poll
cadence,20-second relay fallback/manual-first race, atomic claim false/cancelled
job handling, and recipe prepare hook immediately before GetOTP. Keep tests
focused on behavior; do not only assert implementation strings.

Report every created/changed file, limitations and explicit checks NOT run.

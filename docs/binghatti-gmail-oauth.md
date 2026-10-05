# Binghatti Gmail OAuth setup

Updated 2026-10-05. Gmail authorization is verified. The reader and its worker
integration are implemented. Fresh OTP delivery remains unverified. The inventory
schedule remains off.

## Current evidence

- Google Cloud project `instant-medium-503214-f9` belongs to the `wassel.re`
  organization. The Console is signed in with a Workspace account from that
  organization. Use the privately saved portal Workspace Login ID / OTP mailbox;
  keep its actual address out of this public repository.
- The Internal Workspace app and dedicated Web application client are created;
  Gmail API is enabled. The sole `gmail.readonly` grant, expected mailbox profile,
  offline refresh and filtered Binghatti message API read have been verified.
- Private `credentials.json` is outside Git. All three `BINGHATTI_GMAIL_*`
  credentials are configured in Fly; the normal release activates staged values.
- Binghatti rejected the current automated login token with
  `recaptcha_confirmed_bot_score`; a fresh AE proxy attempt had the same result.
  Browserbase Verified session creation returned HTTP 403 for Enterprise
  entitlement. Gmail access will not resolve that CAPTCHA rejection.
- Actual new OTP delivery channel, sender, subject, code format and expiry are
  unconfirmed. No unattended login or complete inventory capture is proven.

## 1. Confirm Internal eligibility and scope

Internal requires an organization-owned project and users in that same Google
Workspace or Cloud Identity organization. The verified `wassel.re` project and
account meet the organizational prerequisite, and the mailbox profile has been
verified. A personal `@gmail.com` account cannot authorize this Internal app.
Workspace administrator
approval may still be required. [Google's Internal-use requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#internal-use-only)

Request only `https://www.googleapis.com/auth/gmail.readonly`. This is a
**restricted, mailbox-wide read scope**: it can read messages and settings
throughout the consenting mailbox. A sender, label or time filter in worker
code does not narrow the OAuth grant. `gmail.metadata` cannot read message
bodies; `gmail.modify`, `gmail.send` and `https://mail.google.com/` are unnecessary.
[Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes)

Use a dedicated OAuth client for this worker. Do not extract or reuse tokens
from the connected Gmail connector; its authorization is separate.

## 2. Setup completed in the existing Google Cloud project

The following setup is already complete; retain these steps for reconfiguration.

1. Select `instant-medium-503214-f9` in the Cloud Console and enable **Gmail API**
   under **APIs & Services → Library**. [Enable Gmail API](https://developers.google.com/workspace/gmail/api/quickstart/nodejs#enable_the_api)
2. Open **Google Auth Platform → Branding**. Complete the form with a
   clear app name (for example, `Wassel Binghatti OTP Worker`), support email and
   developer contact. Review and accept the API User Data Policy to finish setup.
3. In **Audience**, confirm **Internal**. In **Data Access**, record only
   `gmail.readonly` if the Console offers scope configuration. Google does not
   require listing scopes for Internal apps; the authorization request must
   still specify the exact scope. [Consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent)
4. Under **Clients → Create Client**, choose **Web application**. Use a dedicated
   name and register a development callback such as
   `http://localhost:8766/oauth2callback` used by the private bootstrap. Keep the
   downloaded client credentials in private local storage outside the repository.
   [Create a web client](https://developers.google.com/workspace/guides/create-credentials#web-application)

If the intended mailbox is outside the organization, reassess the audience and
verification route before authorization. External **Testing** refresh tokens
with Gmail scopes expire after seven days and do not support durable unattended
operation. [Google token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)

## 3. Offline authorization and future reauthorization

The initial grant is verified. If reauthorization is needed, use the private
local bootstrap with the registered callback. Have the intended mailbox owner
sign in and consent. Its
request to `https://accounts.google.com/o/oauth2/v2/auth` must include:

| Parameter | Value |
| --- | --- |
| `client_id` | The dedicated client ID |
| `redirect_uri` | Exactly the registered callback URI |
| `response_type` | `code` |
| `scope` | `https://www.googleapis.com/auth/gmail.readonly` |
| `access_type` | `offline` |
| `prompt` | `consent` |
| `state` | A new random value, validated at callback |
| `login_hint` | Intended mailbox address; verify the selected account |

Exchange the returned code server-side at `https://oauth2.googleapis.com/token`
with `grant_type=authorization_code`, the same `redirect_uri`, `client_id` and
`client_secret`. Verify the granted scope and capture a nonempty `refresh_token`
privately. Do not log the callback URL, code or token response. Localhost HTTP is
allowed for development; production callbacks require HTTPS. If no refresh
token is returned, resolve consent for this client before proceeding.
[Google's authorization-code and offline flow](https://developers.google.com/identity/protocols/oauth2/web-server)

Privately call `users.getProfile` with `userId=me` to confirm the authorized
mailbox matches the OTP recipient. [Profile endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)

## 4. Store credentials in Fly secrets

These three credentials are configured in Fly for `wassel-deck-worker`; the
worker loads them as optional environment variables:

```text
BINGHATTI_GMAIL_CLIENT_ID
BINGHATTI_GMAIL_CLIENT_SECRET
BINGHATTI_GMAIL_REFRESH_TOKEN
```

Supply private `NAME=VALUE` pairs through stdin to
`fly secrets import --stage --app wassel-deck-worker`. Never paste real values
into command arguments, chat, logs, source, recipes, database rows or committed
files. `--stage` defers deployment; `fly secrets list --app wassel-deck-worker`
checks names without exposing values. [Fly import command](https://docs.fly.io/flyctl/cmd/fly_secrets_import)

The normal worker release activates staged values. Changing active Fly secrets
restarts Machines; use the normal release process.
[Fly secret lifecycle](https://docs.fly.io/apps/secrets)

## 5. Implemented reader and release order

Only portal `0f828ff1-c3b9-482c-8b1d-215bef4b4d43` with `otp_channel=email` uses
this optional reader. All three secrets absent preserves the existing
manual/WhatsApp flow; partial configuration must fail visibly.

The `prepare_email_otp` step verifies the sole read-only scope and
mailbox profile, then capture a complete bounded message-ID baseline immediately
before `#sendOtpBtn`. Polling accepts only a unique expected-length code in
bounded inline text/plain or inert text/html, with OTP context, a Binghatti sender
whose first `Authentication-Results` header is from `mx.google.com` and proves
aligned DMARC pass, and a matching recipient. Gmail `internalDate`, the baseline
and the current request window reject old mail; defined future clock skew is
limited to 5 seconds. Attachments and ambiguous messages do not supply a code.

A service-only atomic claim stores opaque message IDs and a mailbox hash,
not email addresses or OTPs. It checks the current job/request nonce and
portal Login ID; an already submitted manual reply wins. Gmail gets
20 seconds before the existing WhatsApp request is queued once. Manual replies,
cancellation, heartbeats and timeout/parking behavior remain available.

The verified rollback fixture `scripts/fixtures/binghatti-gmail-claim-check.sql`
checks claim guards, manual precedence and replay rejection, including retention
of the replay marker after queue-job deletion. It proves the atomic database
path without claiming actual OTP delivery or login success.

Release in this order: additive migration
`2026-10-05_14_binghatti_email_otp_claim.sql`, reviewed worker deployment activating
the staged secrets, then `2026-10-05_15_binghatti_email_otp_recipe.sql` adding the
prepare step. Do not install that recipe on an older worker.

## 6. Evidence needed before unattended operation

Obtain a fresh OTP email after Binghatti accepts an automated CAPTCHA/login
request. Establish the recipient, exact sender and message format from that
delivery before treating the provisional reader as verified. Email bodies,
OTPs and credentials must not appear in logs or committed fixtures. Gmail
authorization cannot establish CAPTCHA acceptance or OTP delivery.

The refresh token supports future access-token renewal, but can be revoked or
invalidated by password changes, inactivity or administrator policy. Surface
authorization failures and require reauthorization rather than retrying
indefinitely. [Google refresh-token lifecycle](https://developers.google.com/identity/protocols/oauth2#expiration)

Keep daily capture and weekly scheduling off until a complete authenticated
inventory capture and the existing dry/live/undo activation proofs pass. See
[the Binghatti operations runbook](binghatti-weekly-updates.md).

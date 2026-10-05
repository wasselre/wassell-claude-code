# Binghatti weekly inventory updates

Updated 2026-10-05. Implementation follows the weekly-update spec with the
operator's change: Browserbase handles CAPTCHA automatically. The operator
only supplies the portal's OTP through the existing WhatsApp relay when needed.

## Configuration

The operator-created portal is `0f828ff1-c3b9-482c-8b1d-215bef4b4d43`, linked to
Binghatti `759fa833-e60e-4775-86ab-292005c8d517`. Credentials remain on that record.
The recipe uses `{{portal.login_id}}`: explicit Login ID, then login email,
then the entered sign-in phone. It opens `/Properties` first and only signs in
when logged out. Each portal may opt into its own Browserbase context; existing
portals retain their session behavior unless the switch is enabled.

There are 43 weekly registry rows covering 45 verified portal phases. Skyflame
and Flare each have two phase IDs in one row. The map was recovered from the
original authenticated July/August captures and checked against the current CRM.
Every fresh inventory is joined to all Binghatti CRM codes to revalidate this
map. Conflicting project identities hold the run. Portal-only IDs are reported.
The area check also holds the run when current evidence conflicts with the
verified net-square-foot import convention or a registry row selects another
convention. Sparse evidence records its explicit historical baseline.

Daily capture and weekly scheduling remain off until the steps below pass.
`project_update_enable_binghatti` enforces the final proof requirements. It does
not relax the safety brake.

The live sign-in probe on 2026-10-05 found an email-validated `userId` field.
The saved phone is rejected before the OTP request is sent. Saudi Arabia (+966)
was selected on the separate registration page; that page was not submitted.
The phone login route must be established before the first complete capture.

## First capture and activation

1. Deploy the worker and API. Enqueue one capture:
   `select portal_status_check_enqueue('0f828ff1-c3b9-482c-8b1d-215bef4b4d43',null);`
   Browserbase solves supported CAPTCHA; relay the code if requested.
2. Confirm the job completed with `inventory_capture` and the private file
   `portal-registrations/inventory/0f828ff1-c3b9-482c-8b1d-215bef4b4d43/units.json`
   contains exactly `totalCount` unique items. A trimmed fixture is never usable
   as a production capture.
3. Enqueue the first dry run:
   `select project_update_enqueue('binghatti_broker','dry1:binghatti_broker','manual',true,'{}');`
   Inspect its per-project summary, mapping/area evidence, matches, sold changes,
   price changes, incomplete units and holds.
4. Report the result before the initial live run. A held stale project needs
   explicit operator confirmation through that run's `params.override_brake`
   list of registry UUIDs. Do not change `brake_share`.
5. Verify a real-unit test run can be reverted with `project_update_revert`.
   After the approved live state is restored, run a second full dry run; it must
   have zero changes, holds, failed projects or unmapped CRM projects.
6. Call `project_update_enable_binghatti(first_dry,live,second_dry,revert_test)`.
   This enables the daily inventory capture and adds only `binghatti_broker` to
   `scheduled_sources`. Existing source settings are preserved.

Subsequent scheduled updates use a complete capture under 36 hours old. A
missing/stale file queues one capture job and defers the update. A parked OTP,
failed capture or 30-minute wait fails visibly without inventory writes. Dry
runs never initiate a login.

## Data rules and undo

Available-only list: missing available CRM units may become sold. CRM reserved
units stay reserved. Identity is the developer code, with numeric-only fallback
(strip leading letters) only when unique on both sides. Newly released units
need area, price, bedrooms and known type; incomplete units are skipped and
reported through the existing notice. Conflicting type evidence remains unknown.

The import used net square feet: `unit_area=round(netArea×0.09290304,2)` m²;
raw source areas stay in square feet. Real Wraith fixture `BWRT-645` verifies
`603.86 sqft → 56.10 m²`. AED prices stay in `source_price`; SAR is
`Math.round(AED×1.021103)`. The source price, SAR price, currency and rate are
saved and logged together. Undo preserves the whole tuple if a human later
changed any of its fields. Registry schedule stamps and project refresh dates
also have change logs. No payment-plan detail pages or public launch prices
are fetched.

## Validation evidence

The repository includes a genuine trimmed inventory row and verified project /
type-filter fixtures with provenance. Tests cover fresh/partial/stale snapshots,
unique identity, phase merges, unknown types, studio zero bedrooms, currency,
CAPTCHA evidence, single-job deferral, persistent contexts and audit boundaries.

`scripts/fixtures/binghatti-revert-check.sql` tests full undo and preservation of
a later price edit in the live database using synthetic Sandbox records inside
`BEGIN`/`ROLLBACK`. It passed without leaving test records. This does not replace
the first real-unit revert proof required for activation.

Operations SQL can be run with `scripts/binghatti-db.mjs` and private environment
credentials. `scripts/binghatti-register.mjs --write` and
`scripts/binghatti-recipe.mjs` reproduce the checked-in configuration migrations;
they contain no login secrets. Replaying configuration never activates scheduling.

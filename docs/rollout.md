# Migration and rollout

## Pre-write gate

1. Build and pass `npm run check`.
2. Validate sanitized fixtures from current Fortuneo responses.
3. Install the extension/native host and configure a Lunch Money test budget.
4. Run read-only snapshots and dry runs. Verify every account assignment, amount sign, lifecycle tag, preserved user field, balance, and settlement total.
5. Disable all Cloudflare/Workflow writes. Do not run both writers.
6. Back up/export relevant Lunch Money data and run one local write in the test budget.
7. Repeat the dry/live comparison against the real budget before regular use.

## v1 transaction migration

The reconciler recognizes Worker-created checking transactions with an `lmft:v1:` external ID. It attaches v2 metadata only when exactly one legacy transaction matches the current provider item by checking account, date, exact amount, and normalized payee. No v1 HMAC key is required. Ambiguous matches stop and appear as `AMBIGUOUS_V1_MIGRATION`; no duplicate is created.

The legacy `Fortuneo deferred cards` synthetic transaction is deleted only on a complete snapshot when itemized deferred card transactions exist, their exact total equals the synthetic amount, and none of those items has an unresolved mapping. Otherwise it remains and requires review.

## Retirement after three successes

Count a success only when the local result is successful, balances and settlement groups are manually verified, and no ambiguous review item remains. After three such live runs:

1. Keep commit `30dddc8` and the relevant exports as the rollback checkpoint.
2. Delete the `api` Worker, Workflow, D1 database, and integration-specific Cloudflare secrets using the reviewed Cloudflare runbook/dashboard.
3. Revoke the unused Enable Banking authorization.
4. Confirm no scheduled Worker or Workflow can still write to Lunch Money.

These remote deletions are intentionally not automated by the local installer or application.

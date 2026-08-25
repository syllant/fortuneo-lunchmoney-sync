# Architecture

## Purpose and boundaries

The Worker connects one user to their own Fortuneo accounts through Enable Banking (read-only AIS/PSD2), then to a Lunch Money v2 budget. Lunch Money is the only persistent destination for financial data. D1 contains only the opaque state required for idempotency and operations.

```text
User ───── HTTP Basic auth ──── Worker ── Enable Banking ── Fortuneo
                                      │
                                      ├── D1 (opaque state)
                                      ├── Cron Trigger → Daily Workflow
                                      ├── Web Push (generic reminder only)
                                      └── Lunch Money v2 (destination)
```

The Enable Banking callback bypasses administrative authentication but requires a random 256-bit `state`, valid for five minutes and consumed atomically. The static `/privacy`, `/terms`, service-worker, manifest, JavaScript, and CSS documents are also public. They contain no credentials or financial data. Every response includes `Cache-Control: no-store`. All administrative routes and the `/notifications` page on the stable `workers.dev` hostname require a secret password; deployment-specific preview URLs are disabled in production.

## Flow

1. `GET /connect` creates a state, stores only its HMAC, calls `POST /auth`, and redirects to SCA.
2. `GET /callback` consumes the state, exchanges the code through `POST /sessions`, and retains only the session and its expiration.
3. `POST /sync?dry_run=true` or the Workflow reads booked transactions from a rolling seven-day window plus the provider's current pending and held sets.
4. Booked transactions and stable pending or held transactions are normalized in memory. Labelled Fortuneo current- and next-month card balances are aggregated into one synthetic pending transaction. The external ID and payload fingerprint are HMAC values.
5. Lunch Money creates or corrects transactions. D1 associates only HMAC values with Lunch Money IDs.
6. The daily Cron also evaluates consent and health. Empty-payload Web Push requests produce a fixed generic browser notification; details are visible only after opening the protected `/notifications` page.

Workflow steps return only opaque IDs, control windows, and counters. Banking data remains in the stack of the step processing it.

## Idempotency

The identity is `lmft:v1:` followed by the base64url HMAC-SHA256 of `identification_hash + NUL + stable_source_transaction_id`. `entry_reference` is preferred; the provider `transaction_id` remains a migration alias for records imported by earlier versions. Lunch Money deduplicates by `(manual_account_id, external_id)`. `sync_index` speeds up correction detection; a Lunch Money lookup repairs the index after a failure between the remote write and the D1 commit.

Enable Banking pending (`PDNG`) and held (`HOLD`) transactions are accepted only with an immutable `entry_reference`. Lunch Money manual accounts cannot use the native pending flag, so these records are unreviewed and labelled in their notes until a later `BOOK` response updates them. The service does not infer cancellation from disappearance and does not delete the corresponding Lunch Money transaction.

Until Fortuneo exposes individual deferred-card operations through AIS, the synchronizer recognizes only balance labels matching card current-month or next-month summaries and adds their signed amounts. A stable virtual source ID updates one aggregate Lunch Money transaction on each run; unrelated and real-time balances are excluded.

`BudgetSink` exposes no delete operation.

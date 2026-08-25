# ADR 005 — Pending and deferred card transactions

Decision: fetch `BOOK` transactions for the requested date range and fetch the current `PDNG` and `HOLD` sets without date filters. Import a pending or held transaction only when Enable Banking supplies an `entry_reference`, because Enable Banking documents that this reference is exposed for pending transactions only when it is immutable through the transition to `BOOK`.

Use `entry_reference` as the primary source identity. Retain `transaction_id` as a migration alias so transactions imported under ADR 004 are updated to the stable identity instead of duplicated. If the same identity is returned in more than one status, prefer `BOOK`.

Lunch Money cannot set `is_pending` on transactions associated with manual accounts. Represent these transactions as `unreviewed`, add `[Pending at Fortuneo]` to their notes, and update the same transaction when it becomes booked. Do not delete a temporary transaction merely because it disappears from a later provider response: absence is not sufficient proof of cancellation, and the application's no-delete boundary remains in force. Operators must therefore reconcile cancelled card authorizations manually.

Fortuneo currently exposes labelled current-month and next-month card balances through AIS but no corresponding transaction rows. As a temporary workaround, aggregate those explicitly labelled card balances into one synthetic pending transaction. Its source identity is stable per account, so each synchronization updates the same Lunch Money record, including to zero when the balance clears. Do not include the checking-account or real-time balance, and remove this workaround when Fortuneo or the provider exposes the individual card transactions.

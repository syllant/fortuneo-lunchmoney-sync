# Local v2 architecture

## Runtime flow

1. The Lunch Money content script renders an isolated inline banner and tells the Manifest V3 service worker that the app is open.
2. The worker compares the local date with `lastSuccessfulLocalDate`. Manual actions bypass this throttle.
3. Chrome starts `com.sylvaindurand.fortuneo_lunchmoney_sync` through native messaging. The helper requests a `snapshot` and remains alive on the native port.
4. The worker reuses a Fortuneo tab or creates an inactive login tab. If the session expired, it retrieves Fortuneo credentials just in time from Keychain and submits the exact current login form once. A failed login or strong-authentication challenge activates the tab for manual completion; a successful login resumes automatically.
5. The isolated Fortuneo adapter converts responses to a bounded canonical snapshot. Raw payloads and the canonical snapshot remain in memory.
6. The helper reads the token, checking-account ID, and HMAC key from Keychain, reads Lunch Money state, plans reconciliation, applies writes, then explicitly updates all account balances. Fortuneo credentials leave Keychain only for the single strict-origin login attempt and are never persisted by Chrome.
7. A sanitized result is sent to the popup and Lunch Money banner. Financial review details and preview snapshots are held in trusted `chrome.storage.session`, not disk-backed `chrome.storage.local`. Only a successful non-dry run advances the stored local date.

## Trust boundaries

- Content-script requests are untrusted. The worker checks extension identity, sender URL, top-level frame, and message permissions; configuration and account-list requests are restricted to the popup. The native host validates allow-listed message types, bounded strings, arrays, counts, and a 2 MiB framing limit.
- The page bridge observes responses already requested by Fortuneo. It contains no remote code and does not initiate bank API requests.
- The extension has only `storage`, `nativeMessaging`, `tabs`, `scripting`, `alarms`, and explicit Lunch Money/Fortuneo host permissions.
- `chrome.storage.local` is restricted to trusted extension contexts and contains no secrets or raw finance data.
- The helper never writes raw snapshots to disk or stdout/stderr. Native stdout is reserved for framed protocol messages.

## Identity and reconciliation

- Accounts: `lmfa:v2:<base64url HMAC-SHA256>`.
- Transactions: `lmft:v2:<base64url HMAC-SHA256>`.
- Metadata keys are limited to schema version, HMAC source identity, lifecycle, HMAC payload fingerprint, last-seen timestamp, miss count, and HMAC aliases.
- A changed provider ID migrates only when exactly one payload fingerprint matches. Two or more matches yield a review item.
- Provider updates change provider-owned date, amount, lifecycle tags, ID, and metadata. Payee, notes, category, and unrelated tags are preserved. Cycle-end confirmations update lifecycle tags and metadata only; they preserve the original account, date, amount, currency, external ID, merchant, category, and notes.
- Checking-history CARD rows are confirmations of purchases already imported on their card accounts. The adapter emits the original purchase reference and card details without importing the checking mirror or manufacturing an offsetting card credit. A unique existing purchase is matched by reference/retained aliases, or an exact source fingerprint. Missing or ambiguous matches require review; confirmation alone cannot create a new historical purchase. A known reference with a different date retains the existing purchase date, while amount or currency mismatches stop resolution or require review without modifying that purchase.
- If the card-detail endpoint returns 404, the original operation reference can resolve a unique managed card purchase. A resolved confirmation clears its deferred status without moving it or creating a checking row. Unresolved checking rows are retained only to show their review context. Genuine non-card checking transactions continue to reconcile normally.
- A purchase present in both checking history and an outgoing deferred list is treated as settled once. Stored aliases also identify outgoing-cycle references; only their previously counted outstanding amounts are subtracted from the captured virtual card balance. Other supplied balances remain authoritative.
- A missing pending transaction is deleted only after two complete, consecutive snapshots for its account. Partial snapshots do not increment misses.

## Settlement invariant

One purchase remains one transaction throughout pending → deferred → settled. Confirming settlement changes only lifecycle tags and integration metadata; it neither creates synthetic transfer offsets nor changes the purchase's financial/user fields. Native snapshots retain the legacy `cardCredits` field for compatibility, but new captures leave it empty and reconciliation never writes those credits.

Checking balances continue to use Fortuneo's captured real-time/projected balance. Virtual card balances represent outstanding activity, independently of the sum of historical purchase transactions. Previous synthetic credits and checking copies are left untouched: their cleanup requires a separate reviewed data migration.

Daily sync warnings for unresolved settled-card bookings are emitted only for new or changed review identities. The extension retains only keyed opaque digests from completed syncs; skipped rows remain visible, and explicit previews always show all review warnings. Failed syncs and previews do not acknowledge review items.

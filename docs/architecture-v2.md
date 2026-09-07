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
- Provider updates change provider-owned date, amount, lifecycle tags, ID, and metadata. Payee, notes, category, and unrelated tags are preserved. Settlement categorization is the explicit exception.
- When deferred purchases appear in checking history after payment, the collector reads their card details. The adapter keeps the original purchase on its card using the original operation reference and purchase date, and represents each checking posting with an opposite card payment credit. Existing checking postings become transfer entries; settled purchases do not contribute to the current card balance. If the detail endpoint returns 404, the native host resolves the original operation reference against a unique managed purchase on an identified card, checks its amount and currency, and retains its purchase date. Missing or ambiguous references use the existing per-transaction review workflow: the checking booking remains unchanged, no card purchase or settlement credit is created for it, and the preview reports that it needs review. Inconsistent amounts, currencies, dates, or missing card mappings stop synchronization before any writes. Other detail errors still stop collection.
- A missing pending transaction is deleted only after two complete, consecutive snapshots for its account. Partial snapshots do not increment misses.

## Settlement invariant

Canonical values use Lunch Money’s sign convention: debits/expenses are positive and credits are negative. Grouping requires:

`checking debit + sum(card credits) = 0`

On mismatch, the recognizable checking debit receives `Payment, Transfer`, no credit/group write is planned, balances are still synchronized, and the run requires review.

Daily sync warnings for unresolved settled-card bookings are emitted only for new or changed review identities. The extension retains only keyed opaque digests from completed syncs; skipped rows remain visible, and explicit previews always show all review warnings. Failed syncs and previews do not acknowledge review items.

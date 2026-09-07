# Fortuneo → Lunch Money (local v2)

A personal, local-first synchronizer for Google Chrome on macOS. Opening [Lunch Money](https://my.lunchmoney.app/) or its [beta application](https://beta.lunchmoney.app/) starts at most one sync per local calendar day. Opening the extension also starts a missing daily sync immediately. Chrome reads authenticated Fortuneo JSON in a same-origin tab and starts a native helper only for the duration of the sync; the helper reconciles manual accounts and transactions through the official Lunch Money v2 API.

> **Safety status:** writes are not ready until the Fortuneo adapter has been verified against sanitized fixtures captured from the actual private endpoints. Fortuneo does not publish those response contracts. Keep the old Cloudflare writer enabled only for read comparison, disable it before the first local write, and begin with a separate Lunch Money test budget.

## Design

- One selected Lunch Money checking account, one `cash`/`savings` account per Fortuneo savings identity, plus one `credit` manual account per stable card identity.
- The checking account uses Fortuneo's projected balance, including pending and deferred payment families; card balances represent their outstanding activity.
- Card purchases stay on the card account through pending → deferred → settled lifecycle changes.
- A monthly checking debit and per-card credits are grouped only when their sum is exactly zero.
- Lunch Money `custom_metadata` is the reconciliation store; Chrome stores only local-date throttling and UI state.
- Fortuneo credentials, discovered account routes, the Lunch Money token, checking-account ID, and a random 256-bit HMAC key are stored in macOS Keychain under `com.sylvaindurand.fortuneo-lunchmoney-sync`.
- When the short Fortuneo browser session expires, the extension makes one automatic sign-in attempt. It stops and requests manual authentication for an invalid login or a strong-authentication challenge.
- Raw Fortuneo identifiers are stored only as protected account routes in macOS Keychain; financial payloads exist only in memory. Logs contain no raw payloads.

## Why the API server was replaced

The previous server ran on Cloudflare Workers and read Fortuneo through Enable Banking. In the observed Fortuneo AIS responses, deferred-card purchases were missing at transaction level: the feed exposed current-month and next-month balance summaries instead. Pending operations also needed a stable `entry_reference` to be imported safely. Successful API requests therefore did not mean that the imported activity was complete.

The server worked around missing deferred purchases with one synthetic aggregate transaction, but that could only represent the outstanding total, without individual merchants or purchases. This data-coverage limitation is why the project moved to a local Chrome extension that reads the authenticated Fortuneo website. The local adapter still requires verification; this change does not guarantee complete or correct imports.

The original server implementation remains on **`feature/cloudflare-worker`** (remote branch `origin/feature/cloudflare-worker`, commit `30dddc8`), also preserved locally as `legacy/cloudflare-worker`. Its README and `docs/adr/005-pending-card-transactions.md` document the limitation and workaround. `main` contains the local implementation with independent Git history. The server branch is retained for reference and ships with placeholder deployment configuration and writes disabled.

## Sharing and confidentiality

Share tracked source files, preferably a source archive (`git archive --format=zip --output=/tmp/fortuneo-source.zip HEAD` after committing the intended changes). Do not share your working-directory copy, Chrome profile, Keychain exports, real bank fixtures, screenshots, or diagnostic captures. Git ignore rules do not protect files copied outside Git. Sharing all branches also publishes the legacy server history. Git commit metadata includes the author's name and email; the source and license identify the author, so this repository is not anonymous.

Tokens, bank credentials, account routes, and the identity key belong in Keychain. Financial review details and preview snapshots use trusted extension session storage; they are cleared when Chrome restarts or the extension reloads. Earlier versions persisted review details in local storage; startup now removes that stored UI data, but cannot erase historical backups. See [Chrome's storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage).

`npm run check` includes a limited pattern-based source audit; `npm audit` checks known dependency advisories. Neither constitutes an independent security audit or a guarantee that secrets or vulnerabilities are absent. One remaining local runtime limitation is that the macOS `security` command receives secrets as process arguments when saving Keychain entries; local process inspection may expose them briefly. Run only on a trusted Mac. Website scripts can observe credentials submitted to their own Fortuneo login form, and the integration necessarily sends financial data to Lunch Money.

## Build and install

Requirements: macOS, Google Chrome, Node.js 22+, and a Lunch Money v2 API token.

```sh
npm install
npm run check
npm run install:local
```

The first installer run prints the unpacked extension directory. Chrome does not allow a normal local installer to silently enable an unpacked extension, so open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the printed `dist/extension` path. Copy the 32-character extension ID and finish native-host registration:

```sh
npm run install:local -- <extension-id>
```

Restart Chrome once. Open the extension popup, enter the Fortuneo identifier and password plus the Lunch Money token, load accounts, select the existing Fortuneo checking account, and save. Secret inputs are cleared after being passed directly to the helper.

For daily use, opening Lunch Money triggers one automatic sync per local calendar day. Every Fortuneo account route previously discovered by the extension is read in a temporary background tab, so the checking account, cards, and savings accounts are reconciled together. A failed automatic attempt may retry after a 15-minute cooldown. If the Fortuneo session has expired, sign in when prompted and the sync resumes. The popup shows whether today has synced successfully and also provides manual **Sync now** and optional **Preview changes** actions.

## Fortuneo adapter rollout

The extension passively captures bounded same-origin JSON responses in memory while the authenticated Fortuneo page loads. Before enabling real writes:

1. Open or reload the authenticated Fortuneo accounts page so the extension can observe the account, card-operation, and checking-operation JSON responses.
2. Sanitize representative responses according to [docs/fixtures.md](docs/fixtures.md); do not commit identifiers, merchants, dates, amounts, cookies, or responses from the real account.
3. Add adapter fixtures and tests for every observed response shape.
4. Run **Preview changes** against the test budget and compare counts, signs, lifecycle state, card assignment, and settlement totals.
5. Follow [docs/rollout.md](docs/rollout.md) before allowing the first local write.

The generic adapter recognizes conservative field aliases, assumes conventional bank signs (provider debits negative; Lunch Money debits positive), and marks a snapshot complete only when the response explicitly says it is complete. A shape that cannot provide a stable operation/account ID is rejected.

## Commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run audit:security
npm run check
npm run uninstall:local
```

The uninstaller removes only this integration’s native registration, installed helper files, and five Keychain entries. Remove the unpacked Chrome extension separately.

## Important warning

This is an unsupported personal integration. Private Fortuneo endpoints and the Lunch Money v2 API can change. Test on a separate budget, keep independent records, inspect dry-run review items, and never infer correctness from a successful HTTP response or automated test alone.

## License

[MIT](LICENSE)

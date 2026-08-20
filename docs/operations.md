# Operations and progressive validation

This is the operator checklist for a new installation. Run terminal commands from the repository root. Every production Wrangler command includes `--env production`; omitting it can target the top-level configuration instead.

## What you will create

| Service | Start here | Result needed by this project |
| --- | --- | --- |
| Cloudflare | [Create an account](https://dash.cloudflare.com/sign-up) | A personal Cloudflare account with a `workers.dev` subdomain, isolated test/live D1 databases, one Worker, and one Workflow |
| Enable Banking | [Sign in or create an account](https://enablebanking.com/sign-in/) | A restricted production API application, its UUID, and its downloaded private key |
| Lunch Money | [Open the web app](https://my.lunchmoney.app/) | A separate test budget and an API access token for that budget |

The code starts with `SYNC_ENABLED=false`. Keep it disabled until every validation gate passes.

## 1. Choose the public URLs

No purchased domain is required. Cloudflare can expose a Worker on an account-specific `workers.dev` hostname. With the default Worker name, the stable production URL has this form:

```text
https://fortuneo-lunchmoney-sync.<YOUR_WORKERS_SUBDOMAIN>.workers.dev
```

The Enable Banking callback becomes:

```text
https://fortuneo-lunchmoney-sync.<YOUR_WORKERS_SUBDOMAIN>.workers.dev/callback
```

The Worker publishes factual privacy and terms pages for the Enable Banking production-application form. No separate website or purchased domain is required. Review their text before deployment; the documents describe this implementation but are not legal advice.

Write down these values before continuing:

```text
WORKERS_SUBDOMAIN=
WORKER_HOSTNAME=fortuneo-lunchmoney-sync.<WORKERS_SUBDOMAIN>.workers.dev
CALLBACK_URL=https://<WORKER_HOSTNAME>/callback
PRIVACY_URL=https://<WORKER_HOSTNAME>/privacy
TERMS_URL=https://<WORKER_HOSTNAME>/terms
DATA_PROTECTION_EMAIL=operator@example.com
```

## 2. Create and secure the personal Cloudflare account

Cloudflare uses two easily confused concepts:

- a **user profile** is the email and password used to sign in;
- a **Cloudflare account** is a resource container holding Workers, D1, billing, members, and any domains you may optionally add.

A user can be a member of several Cloudflare accounts. Use an account you control and do not place personal financial credentials, billing, DNS, or logs in an employer's or client's account. Verify the login email, enable MFA, and check the account switcher before every dashboard action. Cloudflare documents the distinction in [Accounts, zones, and profiles](https://developers.cloudflare.com/fundamentals/concepts/accounts-and-zones/).

### Choose the `workers.dev` subdomain

1. While your intended account is selected, open [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages).
2. Find **Your subdomain** and select **Change** or **Set up**.
3. Choose an account-wide name. It must be unique on Cloudflare.
4. Record only the chosen label as `WORKERS_SUBDOMAIN`, not the full `.workers.dev` hostname.
5. Do not select **Create application** and do not create a Worker manually. The repository deployment creates it later.

Cloudflare documents `workers.dev` as suitable for personal and hobby projects that do not need a custom domain. The final URL format is `<WORKER_NAME>.<WORKERS_SUBDOMAIN>.workers.dev`. See the [`workers.dev` guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Review current Cloudflare limits and pricing before deployment; they can change independently of this repository.

## 3. Administrative authentication—no Zero Trust account

Do not create or enable Cloudflare Zero Trust, and do not provide a payment card for it. This project protects its administrative routes inside the Worker with HTTP Basic authentication:

| Route | Authentication |
| --- | --- |
| `/connect`, `/status`, `/sync`, `/disconnect`, `/notifications` and notification POST routes | username `operator` plus the secret `ADMIN_PASSWORD` |
| `/callback` | no Basic authentication; requires the short-lived, single-use OAuth `state` created by `/connect` |
| `/privacy`, `/terms` | public static information required for Enable Banking registration |

Your browser will show its native username/password prompt. The Worker compares credentials in constant time and refuses administrative access if the configured password is shorter than 32 characters. Basic credentials are protected in transit here because `workers.dev` is HTTPS; never send the password over plain HTTP or place it in a URL. This is deliberately simpler than Zero Trust: it does not provide per-user identity, MFA, or an Access policy, so protect the long password like an API token.

## 4. Install and validate the repository locally

These commands run in a local terminal. They do not create a Cloudflare Worker, database, application, or billable resource. They install the repository's development tools and run local checks; Wrangler authentication is covered separately below.

### 4.1 Check the required programs

Open a terminal and run:

```sh
git --version
node --version
npm --version
```

Continue if `git` prints a version and Node prints `v22` or newer. If `node` or `npm` is missing, or Node is older than 22, install a current LTS release from [Node.js downloads](https://nodejs.org/en/download), close Terminal, reopen it, and run the three checks again.

### 4.2 Download the repository

If the repository is not already present, run:

```sh
mkdir -p ~/projects
cd ~/projects
git clone <YOUR_REPOSITORY_URL>
cd fortuneo-lunchmoney-sync
```

If it is already present, do not clone it again. Change into the existing directory:

```sh
cd /path/to/fortuneo-lunchmoney-sync
```

Confirm that Terminal is in the correct directory:

```sh
pwd
test -f package.json && echo "repository found"
```

The second command must print `repository found`.

### 4.3 Install this repository's exact tool versions

Run:

```sh
npm ci
npx wrangler --version
```

`npm ci` reads `package-lock.json` and installs the project dependencies into the local `node_modules` directory. It includes Wrangler, so do not install Wrangler globally. The second command must print Wrangler `4.x` or newer. Cloudflare also recommends installing Wrangler locally per project; see [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

### 4.4 Connect this Terminal to the personal Cloudflare login

First inspect any existing local Wrangler login:

```sh
npx wrangler whoami
```

- If it shows the expected email and the Cloudflare account chosen in step 2, keep that login and continue to section 4.5.
- If it says you are not authenticated, continue with the login commands below.
- If it shows an employer, client, or otherwise unintended account, replace the local Wrangler login with the intended one using the commands below. `wrangler logout` removes only the local CLI authorization; it does not delete Cloudflare resources.

Before running the login command, open [the Cloudflare dashboard](https://dash.cloudflare.com/), sign out of the work user if necessary, and sign in with the **personal email from step 2**. Then return to Terminal and run:

```sh
npx wrangler logout
npx wrangler login --use-keyring
```

If Wrangler says there was no existing login during `logout`, that is harmless. `login` opens a Cloudflare authorization page in the default browser. On that page:

1. verify that the displayed signed-in email is the personal email;
2. select **Allow** to authorize Wrangler;
3. wait until Terminal reports that login succeeded.

When supported by the operating system, `--use-keyring` stores OAuth credentials in its credential manager. If no browser opens, copy the authorization URL printed in the terminal into the browser. This authorizes the CLI; it does not create a Worker. See Cloudflare's [`wrangler login` documentation](https://developers.cloudflare.com/workers/wrangler/commands/general/#login).

### 4.5 Prove that Wrangler is targeting the right identity

Run:

```sh
npx wrangler whoami
```

Check the output line by line:

- the email must be the one you intend to use for this deployment;
- the account table must contain the personal Cloudflare account from step 2;
- copy the **Account ID** shown on the same row as the personal account name;
- if the output does not show the intended account, stop and repeat section 4.4 with the correct browser login.

Pin every production command in this repository to that Account ID. Open a new ignored local file:

```sh
nano .env.production
```

Type exactly one line, replacing the placeholder with the copied personal Account ID and using no `<` or `>` characters:

```dotenv
CLOUDFLARE_ACCOUNT_ID=PASTE_PERSONAL_ACCOUNT_ID_HERE
```

In `nano`, press **Control-O**, press **Return** to save, then press **Control-X** to close. Confirm the file is ignored by Git and that Wrangler can find the selected account:

```sh
git check-ignore .env.production
npx wrangler whoami --env production --account PASTE_PERSONAL_ACCOUNT_ID_HERE
```

The first command must print `.env.production`. The second must show the personal account's membership information. Replace the placeholder in the command with the actual Account ID; do not edit `wrangler.jsonc` to add the ID. Cloudflare documents `CLOUDFLARE_ACCOUNT_ID` and environment-specific `.env` files in [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

From now on, remote commands use `--env production`, which loads `.env.production` and pins Wrangler to the chosen account. Do not run a D1 or deployment command until this check is correct.

### 4.6 Run the local-only database and code checks

Still in the repository directory, run:

```sh
npm run db:migrate:local
npm run check
```

`db:migrate:local` creates only a simulated D1 database under the repository's ignored `.wrangler` directory. It does not touch Cloudflare. `npm run check` performs type-checking, linting, tests, a deployment dry-run, and the security audit; its deployment phase includes `--dry-run`, so it uploads nothing. Continue only when the command exits successfully with no failed tests or errors.

## 5. Configure the `workers.dev` callback and create D1

Edit `env.production.vars.CALLBACK_URL` in `wrangler.jsonc`, replacing the `.example` placeholder with `CALLBACK_URL`. Replace `DATA_PROTECTION_EMAIL` with an address you monitor. Confirm that production keeps:

```jsonc
"workers_dev": true,
"preview_urls": false,
"SYNC_ENABLED": "false"
```

Do not deploy while `CALLBACK_URL` still uses the reserved `.example` domain or the D1 ID is all zeroes. The stable `workers.dev` URL is enabled; random deployment-specific preview URLs remain disabled.

Create an isolated test D1 database in the same Cloudflare account:

```sh
npx wrangler d1 create fortuneo-lunchmoney-sync-test --env production
```

When Wrangler asks **Would you like Wrangler to add it on your behalf?**, answer `n` because the production binding already exists. If you accidentally answer `yes` and Wrangler asks for a binding name or whether local development should use the remote resource, press **Control-C** before completing the questionnaire. The remote database has already been created and will remain available; do not run `d1 create` again.

In `env.production.d1_databases[0]`, set `database_name` to `fortuneo-lunchmoney-sync-test` and copy the returned UUID into `database_id`; keep the binding name exactly `DB`. Do not use `fortuneo-lunchmoney-sync-test` as the binding name because the Worker code accesses this database as `env.DB`. Then run:

```sh
npm run types:generate
npm run check
npx wrangler d1 migrations list DB --remote --env production
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler d1 migrations list DB --remote --env production
```

The final command must report no pending migrations.

## 6. Make the first disabled deployment and set its password

Deploy before adding provider secrets:

```sh
npm run deploy:production
```

This creates the Cloudflare Worker and Workflow. Its URL is `https://<WORKER_HOSTNAME>`. A Worker Cron Trigger using `17 4 * * *` runs at 04:17 UTC and starts the Workflow only after `SYNC_ENABLED` becomes `true`. With `SYNC_ENABLED=false`, the trigger records a disabled skip and manual non-dry runs stop before any Lunch Money write. Until `ADMIN_PASSWORD` is set, administrative routes fail closed.

Generate a 256-bit password, save a recovery copy in your password manager, upload it, and delete the temporary file:

```sh
openssl rand -base64 32 > /tmp/fortuneo-admin-password.txt
npx wrangler secret put ADMIN_PASSWORD --env production < /tmp/fortuneo-admin-password.txt
rm /tmp/fortuneo-admin-password.txt
```

The fixed username is `operator`. Never put the password in `wrangler.jsonc`, a shell argument, a URL, or this repository.

In a private browser window, open:

```text
https://<WORKER_HOSTNAME>/status
```

It must show a Basic-authentication prompt. Enter username `operator` and the generated password; `/status` should return `connection: "not_authorized"`. Canceling the prompt must produce `401`. Opening `https://<WORKER_HOSTNAME>/callback` without parameters should return an application error without a password prompt.

## 7. Create the Lunch Money test budget and token

1. Create or sign in to [Lunch Money](https://my.lunchmoney.app/).
2. Open the account switcher using the circle next to **Logout**.
3. Select **Create new budget account** and name it `Fortuneo Sync Test`.
4. Choose a blank or fresh setup. Do not connect the real Fortuneo account through Lunch Money's bank-sync provider.
5. While the test budget is selected, open [Settings → Developers](https://my.lunchmoney.app/developers).
6. Under **New Access Token**, use a label such as `fortuneo-lunchmoney-sync test`, state that it is for your personal Cloudflare Worker, request the token, and copy it into a password manager.

Tokens are scoped to the currently selected budget. The service will create its own manual accounts during a non-dry test import; do not pre-create matching Fortuneo accounts. See Lunch Money's [test-budget guidance](https://support.lunchmoney.app/miscellaneous/unlimited-budget-accounts) and [token instructions](https://support.lunchmoney.app/miscellaneous/developer-api).

## 8. Create the Enable Banking production application

1. Go to [Enable Banking sign-in](https://enablebanking.com/sign-in/), enter your email, and use the one-time link. First sign-in creates the account.
2. Enable Enable Banking account MFA from the profile page.
3. In the Control Panel, check **ASPSP status**, select France, and look for the exact brand `Fortuneo`. Stop if Fortuneo is absent or has a major disruption; do not substitute another brand in the configuration.
4. Open [API applications](https://enablebanking.com/cp/applications) and select **Register application**.
5. Choose **Production**, not Sandbox. Sandbox applications cannot be converted to production.
6. Use the default infrastructure relying on Enable Banking authorization unless you are an authorized TPP with dedicated infrastructure.
7. Choose **Generate key in browser**. The browser downloads the private key locally; Enable Banking receives the corresponding public key. Keep the downloaded `.pem` file private.
8. Enter:
   - name: `Personal Fortuneo to Lunch Money sync`;
   - description: an accurate description of this personal, read-only bank-data synchronizer;
   - redirect URL: exactly `CALLBACK_URL`;
   - data-protection email: `DATA_PROTECTION_EMAIL`;
   - privacy URL: `PRIVACY_URL`;
   - terms URL: `TERMS_URL`.
9. Register the application and copy its UUID. The downloaded key is normally named `<APPLICATION_UUID>.pem`.
10. On the inactive application, select **Activate by linking accounts**, choose Fortuneo in France, complete Fortuneo SCA, and link only your own accounts. This activates restricted production mode for personal/non-commercial use.

Restricted activation only whitelists the accounts the application may read. It does not create the API session used by this Worker; `/connect` does that later. Review Enable Banking's [Control Panel guide](https://enablebanking.com/docs/api/control-panel/), [restricted account-linking guide](https://enablebanking.com/docs/api/linked-accounts), and [API authentication reference](https://enablebanking.com/docs/api/reference/).

## 9. Add the remaining Worker secrets

`wrangler secret put` immediately deploys a new Worker version. `ADMIN_PASSWORD` was already set in step 6. The following provider, HMAC, and Web Push secrets bring the total to seven.

Set the application UUID and Lunch Money token through the hidden interactive prompt:

```sh
npx wrangler secret put ENABLE_BANKING_APP_ID --env production
npx wrangler secret put LUNCH_MONEY_TOKEN --env production
```

Load the downloaded Enable Banking PEM without placing it on the command line:

```sh
npx wrangler secret put ENABLE_BANKING_PRIVATE_KEY --env production < /absolute/path/to/APPLICATION_UUID.pem
```

Generate two independent 256-bit HMAC secrets into temporary files, upload them, and then delete the temporary files:

```sh
openssl rand -hex 32 > /tmp/fortuneo-transaction-hmac.txt
openssl rand -hex 32 > /tmp/fortuneo-oauth-state-hmac.txt
npx wrangler secret put TRANSACTION_HMAC_KEY --env production < /tmp/fortuneo-transaction-hmac.txt
npx wrangler secret put OAUTH_STATE_HMAC_KEY --env production < /tmp/fortuneo-oauth-state-hmac.txt
rm /tmp/fortuneo-transaction-hmac.txt /tmp/fortuneo-oauth-state-hmac.txt
```

Generate a P-256 VAPID pair. This command prints only the public key and writes the private key to a mode-`0600` temporary file:

```sh
node --input-type=module -e 'import {createECDH} from "node:crypto"; import {writeFileSync} from "node:fs"; const key=createECDH("prime256v1"); key.generateKeys(); writeFileSync("/tmp/fortuneo-web-push-vapid-private", key.getPrivateKey().toString("base64url"), {mode:0o600}); process.stdout.write(key.getPublicKey().toString("base64url")+"\n")'
```

Copy the printed public value into every `WEB_PUSH_VAPID_PUBLIC_KEY` entry in `wrangler.jsonc`, run `npm run types:generate`, then upload and remove the private file:

```sh
npx wrangler secret put WEB_PUSH_VAPID_PRIVATE_KEY --env production < /tmp/fortuneo-web-push-vapid-private
rm /tmp/fortuneo-web-push-vapid-private
npx wrangler secret list --env production
```

The VAPID private file and matching public value are generated during deployment. `WEB_PUSH_VAPID_PUBLIC_KEY` in `wrangler.jsonc` must match that private key. Never invent or rotate only one side of the pair.

The list must contain all seven names:

```text
ENABLE_BANKING_APP_ID
ENABLE_BANKING_PRIVATE_KEY
LUNCH_MONEY_TOKEN
TRANSACTION_HMAC_KEY
OAUTH_STATE_HMAC_KEY
ADMIN_PASSWORD
WEB_PUSH_VAPID_PRIVATE_KEY
```

Do not commit, paste into chat, or log any secret. Store the Enable Banking PEM and HMAC recovery copies in a password manager or encrypted vault. Treat `TRANSACTION_HMAC_KEY` as durable data: rotating it changes the external IDs used for idempotency.

## 10. Authorize the Worker and perform the read-only gate

1. Open `https://<WORKER_HOSTNAME>/connect` and sign in as `operator` with `ADMIN_PASSWORD` when the browser prompts.
2. Complete the Enable Banking consent screen and Fortuneo SCA.
3. Let Enable Banking redirect to `/callback`, which consumes the single-use state and returns to `/notifications`.
4. Confirm `/status` reports an authorized connection and a consent expiry.
5. Start only a dry run with a Basic-authenticated HTTP client:

```text
POST https://<WORKER_HOSTNAME>/sync?dry_run=true
```

An unauthenticated request must return `401`. With curl, use `curl -u operator -X POST "https://<WORKER_HOSTNAME>/sync?dry_run=true"`; curl prompts for the password so it does not appear in shell history. Record the returned `run_id`, inspect the Workflow instance in [Workers & Pages](https://dash.cloudflare.com/), and inspect sanitized application request logs from the Enable Banking application's context menu.

Verify Fortuneo availability, `identification_hash`, stable transaction IDs, pagination, history depth, booked status, deferred debit card exposure, response sizes, and that Lunch Money remains unchanged. Stop if Fortuneo is unavailable, source IDs are unstable or missing, the identification hash is missing, pagination is incomplete, or the available data is insufficient.

## 11. Required validation order

1. local synthetic fixtures;
2. local mock Worker;
3. real read-only Enable Banking;
4. the Lunch Money test budget;
5. seven consecutive days of dry runs;
6. imports into the test budget;
7. comparison against a Fortuneo export;
8. a one-account live canary;
9. several successful daily cycles;
10. a controlled 90-day backfill;
11. activation of automatic daily writes.

The manual route accepts `POST /sync?dry_run=true` and `POST /sync?dry_run=false`. Optional inclusive bounds use `from=YYYY-MM-DD&to=YYYY-MM-DD`; provide both or neither. A non-dry run refuses to start while `SYNC_ENABLED` is not exactly `true`. `/status` reveals only consent, state, and counters. `/disconnect` closes the Enable Banking session and marks the connection as revoked; it deletes nothing from Lunch Money.

For a controlled write into the test budget after the seven-day dry-run gate:

1. set `env.production.triggers.crons` to `[]` so no automatic run can start;
2. set `env.production.vars.SYNC_ENABLED` to the JSON string `"true"`;
3. run `npm run check`, review the diff, and run `npm run deploy:production`;
4. manually submit a narrow, explicit date range with `POST /sync?dry_run=false&from=YYYY-MM-DD&to=YYYY-MM-DD`;
5. inspect the test budget, Workflow result, and Fortuneo export;
6. immediately restore `SYNC_ENABLED` to `"false"`, restore `env.production.triggers.crons` to `["17 4 * * *"]`, check, and deploy again.

Do not point this installation at another Lunch Money budget after test writes. D1 contains the test budget's Lunch Money account and transaction IDs.

## 12. Cut over to the real Lunch Money budget

Keep writes disabled. Create a fresh live D1 database so no test-budget IDs cross into the real budget:

```sh
npx wrangler d1 create fortuneo-lunchmoney-sync --env production
```

Set `env.production.d1_databases[0].database_name` back to `fortuneo-lunchmoney-sync` and replace its `database_id` with the new UUID. Initialize the fresh database:

```sh
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler d1 migrations list DB --remote --env production
```

In Lunch Money, switch to the real budget, open [Settings → Developers](https://my.lunchmoney.app/developers), create a new token for that budget, and replace only the Worker secret:

```sh
npx wrangler secret put LUNCH_MONEY_TOKEN --env production
```

Deploy with `SYNC_ENABLED=false`, open `/connect` again to create a new Enable Banking session in the live D1 database, and repeat the dry run. The old test D1 remains isolated in Cloudflare for investigation or later removal under the data-retention plan.

## 13. Enable or stop live writes

For a one-account canary, authorize only that account during the new `/connect` consent if Fortuneo offers account selection. Keep the schedule removed, temporarily enable writes, manually import a narrow date range, then disable writes again and compare the result.

Only after every preceding gate passes, restore `env.production.triggers.crons` to `["17 4 * * *"]`, set `SYNC_ENABLED` to `"true"`, run `npm run check`, review the diff, and deploy. Verify the next Workflow instance and `/status` before treating the schedule as operational.

## Native consent and failure notifications

Automatic renewal of an Enable Banking/Fortuneo consent is not possible: PSD2 strong customer authentication requires the account holder to interact with Fortuneo. The system removes the need to remember the date by sending native browser notifications:

- consent reminders at 14, 7, 3, and 1 day before expiry, then once after expiry;
- a notification when a Workflow fails;
- a reminder when no successful live synchronization has completed for more than 48 hours, repeated at most once per 48-hour period until recovery.

The push request has no payload. The service worker always displays the same generic message; amounts, account names, error codes, dates, and provider data are never sent to Apple, Google, Mozilla, or another browser push service. D1 stores the opaque push endpoint and notification deduplication keys, not browser encryption keys or financial data.

One-time activation on a desktop browser:

1. Open `https://<WORKER_HOSTNAME>/notifications` and authenticate as `operator`.
2. Select **Enable notifications** and allow the browser permission prompt.
3. Select **Test notification** and confirm that the generic notification appears.

On iPhone/iPad, first use Safari's **Share → Add to Home Screen**, open the installed app from the Home Screen, and then activate notifications there. This is an iOS Web Push requirement. Keep at least one subscribed browser. If browser data is erased, the browser is replaced, or VAPID keys are rotated, repeat activation. Use **Disable** before intentionally removing a browser when possible; dead endpoints are also removed automatically after a push service returns `404` or `410`.

When a consent reminder arrives, open the notification and select **Renew Fortuneo consent**. Complete Fortuneo SCA; the callback replaces the current session and resets the reminder schedule around the new expiry.

Notification delivery is best effort and cannot block the daily synchronization. If delivery itself fails, the sanitized Worker log records only `PUSH_NOTIFICATION_ERROR` or a generic HTTP status—never the endpoint.

## Inspect history when a problem is suspected

Open `/notifications` for the current consent, last successful synchronization, and latest run status. For execution history, open the Cloudflare dashboard, select **Workers & Pages → fortuneo-lunchmoney-sync → Workflows → fortuneo-lunchmoney-sync-daily → Instances**. Each daily instance has a deterministic `scheduled-...` ID and shows its steps and final state. Under **Workers & Pages → fortuneo-lunchmoney-sync → Logs**, filter sanitized structured logs by `request_failed`, `scheduled_sync_started`, `notification_sent`, or `notification_failed`. Cloudflare log retention depends on the current plan, so Workflow instances are the more durable operational history. No log contains transactions, balances, descriptions, push endpoints, tokens, or account identifiers.

To stop writes, restore `SYNC_ENABLED` to `"false"` and deploy immediately. Existing Workflow steps may already be running, so also inspect active instances in the Cloudflare dashboard. If code rollback is required:

```sh
npx wrangler versions list --env production
npx wrangler rollback --env production
```

A Worker rollback does not reverse a D1 migration or restore changed secrets. Prefer a forward-compatible database migration; use D1 recovery tooling only under a separately reviewed incident plan.

## Deferred debit card

This is a separate gate. If Enable Banking exposes the card as a separate account, validate several cycles before representing settlement as a transfer. Otherwise, import only the current-account settlement. The code must never invent purchases absent from the source.

## Monthly reconciliation

Compare a Fortuneo export with Lunch Money and review consent expiration, technical failures, and duplicate absence. Never import the export into this service.

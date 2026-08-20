# Threat model

## Sensitive assets

RSA, HMAC, and VAPID private keys, the administrative password, the Lunch Money token, authorization codes, banking responses, balances, transactions, bank identifiers, push subscription endpoints, and identity data are sensitive. Secrets remain in Worker Secrets and must never be requested in chat.

## Trust boundaries

- the browser and Worker-level HTTP Basic authentication;
- the Worker and Enable Banking;
- the Worker and Lunch Money;
- the Worker and D1;
- the operator and the Cloudflare dashboard or CLI.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| OAuth callback theft | 256-bit state, stored HMAC, five-minute TTL, atomic consumption | compromised browser |
| Callback replay | conditional update with `consumed_at IS NULL` | no replay accepted by the application |
| Administrative bypass | strong `ADMIN_PASSWORD`, fixed-length digest comparison, only `/callback` and static assets exempted in code, preview URLs disabled | password disclosure, brute force, or no per-user MFA |
| Notification disclosure | empty Web Push payload, fixed generic text, protected details page, endpoint stored only in D1 | browser lock-screen reveals that the sync needs attention |
| Cross-site state mutation | Basic authentication plus origin checks on every POST and exact same-origin validation for notification endpoints | compromised authenticated browser or non-browser client with stolen credentials |
| Log leakage | allowlisted events, internal codes, no external payloads | upstream platform logs |
| D1 compromise | no raw financial data, non-reversible HMAC values | technical timestamps, counters, opaque provider IDs, and push endpoints |
| Failure after Lunch Money write | external ID deduplication in Lunch Money and index repair | manual correction if the remote API is inconsistent |
| Malicious or unexpected source | structural validation, response size limits, rejection of transactions without IDs | availability |
| Accidental live write | `SYNC_ENABLED=false`, explicit dry run, progressive validation | operator error during activation |
| Budget deletion | no Lunch Money DELETE method or request | manual deletion outside the system |
| Payment initiation | no payment endpoint or scope in the code | direct compromise of another tool |

## Secret blast radius

- `ENABLE_BANKING_APP_ID`: identifies the application and is insufficient on its own.
- `ENABLE_BANKING_PRIVATE_KEY`: authenticates the Enable Banking application; revoke the session and key.
- `LUNCH_MONEY_TOKEN`: permits authorized budget API operations; revoke it immediately.
- `TRANSACTION_HMAC_KEY`: links and recalculates external IDs; rotation requires a migration strategy to avoid duplicates.
- `OAUTH_STATE_HMAC_KEY`: protects unconsumed states; immediate rotation is safe, but in-progress flows expire.
- `WEB_PUSH_VAPID_PRIVATE_KEY`: authenticates empty Web Push requests; rotation requires browsers to subscribe again with the new public key.

## Assumptions

The Cloudflare account is protected with MFA, the administrative password is stored only as a Worker secret and in the operator's password manager, the stable `workers.dev` route points only to this Worker, and Enable Banking accounts are explicitly allowlisted.

# Sanitized Fortuneo fixtures

Fortuneo private JSON contracts are not published and were not present in the Worker implementation. Live adapter enablement therefore requires sanitized, read-only fixtures.

## Never commit

- raw responses or screenshots;
- cookies, headers, tokens, URLs containing session/query secrets;
- real account/card IDs or masks;
- real merchants, descriptions, dates, amounts, or balances;
- personal names, addresses, phone numbers, or emails.

## Sanitization procedure

Work from a temporary copy outside the repository. Replace every identity with deterministic synthetic values (`checking-1`, `card-world-1`, `operation-001`), every merchant with synthetic names, dates with a coherent fictional month, and amounts/balances with fictional values that retain the sign and decimal format. Remove all unneeded fields. Search the result for every known real value before placing it under `test/fixtures/sanitized/`.

Each fixture must record only:

- endpoint role (accounts, operations, settlement);
- pagination/completeness flags;
- the minimum structural fields needed by the adapter;
- an expected canonical snapshot containing `accounts`, `transactions`, and `settlements`.

Treat fixtures as code: review diffs, test negative/positive signs, and confirm no source string appears in generated metadata or logs.

## Required cases

Pending → deferred → settled, correction/refund, card replacement, duplicate fingerprint, first/second pending absence, partial response, two-card exact settlement, mismatch settlement, balance signs, expired authentication, and response-size rejection.

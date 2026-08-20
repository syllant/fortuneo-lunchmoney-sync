# Data retention

## Allowed in D1

Opaque Enable Banking sessions, consent expiration, identification hash, opaque provider account ID, Lunch Money manual account ID, HMAC external ID, Lunch Money transaction ID, canonical payload HMAC, push subscription endpoints, notification deduplication keys, counters, technical timestamps, and internal error codes.

## Forbidden everywhere except in memory during a call

Amounts, balances, transaction dates, merchants, labels, descriptions, IBANs, card numbers, account holder names, Enable Banking or Lunch Money responses, OAuth codes, tokens, and keys. These values are also forbidden in logs and Workflow step results.

## Retention periods

- OAuth states: five minutes; expired rows may be purged;
- technical runs: 90-day recommendation;
- idempotency index: while corresponding transactions exist;
- connection and account mappings: until `disconnect`;
- push endpoints: until unsubscribe or removal after a permanent push-service error;
- notification deduplication keys: no automatic purge is currently implemented;
- Workflow state: the minimum Cloudflare retention configured or allowed by the plan.

The service does not archive external responses. Reconciliation exports stay outside this application under the user's responsibility.

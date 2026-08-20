# ADR 002 — HMAC idempotency

Decision: identify a transaction with a versioned HMAC of the account identification hash and stable source ID. A second HMAC of the canonical payload detects corrections. Lunch Money deduplicates the external ID, while D1 indexes only fingerprints and remote IDs.

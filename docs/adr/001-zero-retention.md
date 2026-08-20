# ADR 001 — Zero financial retention

Decision: process banking data only in memory and persist only opaque identifiers, HMAC values, counters, and technical timestamps. Lunch Money is the financial database. This sharply limits the impact of a D1 compromise and rules out payload-based debugging shortcuts.

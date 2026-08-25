# ADR 004 — Booked transactions only

Status: superseded by [ADR 005](005-pending-card-transactions.md).

Original decision: ignore pending transactions. They are unstable, corrected, or replaced, and would increase intermediate retention and duplicate risk. Supporting them requires a new ADR and dedicated tests.

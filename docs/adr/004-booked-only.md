# ADR 004 — Booked transactions only

Decision: ignore pending transactions. They are unstable, corrected, or replaced, and would increase intermediate retention and duplicate risk. Supporting them would require a new ADR and dedicated tests.

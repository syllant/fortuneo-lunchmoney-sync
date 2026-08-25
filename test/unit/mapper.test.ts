import { describe, expect, it } from "vitest";
import { mapAccount, mapBalances, mapTransactionPage } from "../../src/providers/enable-banking/mapper";
import { syntheticAccount, syntheticBookedTransaction, syntheticPendingTransaction } from "../fixtures/synthetic/enable-banking";

describe("Enable Banking mapper", () => {
  it("requires identification_hash", () => {
    expect(mapAccount(syntheticAccount)).toMatchObject({ identificationHash: "synthetic-identification-hash" });
    expect(() => mapAccount({ uid: "x", currency: "EUR" })).toThrow();
  });

  it("rounds provider balance precision to currency minor units", () => {
    expect(mapBalances({ balances: [{ balance_amount: { amount: "1234.565", currency: "EUR" }, balance_type: "CLAV" }] })[0]?.money.minor)
      .toBe(123457n);
  });

  it("maps booked and pending transactions", () => {
    const page = mapTransactionPage({ transactions: [syntheticBookedTransaction, syntheticPendingTransaction] });
    expect(page.transactions).toHaveLength(2);
    expect(page.transactions[0]).toMatchObject({ sourceId: "transaction-opaque-1", direction: "debit", status: "booked" });
    expect(page.transactions[1]).toMatchObject({
      sourceId: "entry-reference-opaque-pending",
      alternateSourceIds: ["transaction-opaque-pending"],
      date: "2026-08-11",
      status: "pending",
    });
    expect(page.transactions[1]?.notes).toContain("Pending at Fortuneo");
  });

  it("ignores pending transactions without a stable entry reference", () => {
    const { entry_reference: _ignored, ...unstablePending } = syntheticPendingTransaction;
    void _ignored;
    const page = mapTransactionPage({ transactions: [unstablePending] });
    expect(page.transactions).toEqual([]);
    expect(page.diagnostics).toEqual({
      received: 1,
      accepted: 0,
      ignoredWithoutStableId: 1,
      ignoredWithoutDate: 0,
      statusCounts: { BOOK: 0, PDNG: 1, HOLD: 0, OTHR: 0, SCHD: 0, CNCL: 0, RJCT: 0, UNKNOWN: 0 },
    });
  });

  it("reports pending transactions ignored without a usable date", () => {
    const { transaction_date: _ignored, ...undatedPending } = syntheticPendingTransaction;
    void _ignored;
    const page = mapTransactionPage({ transactions: [undatedPending] });
    expect(page.transactions).toEqual([]);
    expect(page.diagnostics).toMatchObject({ received: 1, accepted: 0, ignoredWithoutStableId: 0, ignoredWithoutDate: 1 });
  });

  it("rounds provider sub-cent precision for pending and booked transactions", () => {
    const page = mapTransactionPage({
      transactions: [{ ...syntheticPendingTransaction, transaction_amount: { amount: "70.959999", currency: "EUR" } }],
    });
    expect(page.transactions[0]?.money.minor).toBe(7096n);
    const bookedPage = mapTransactionPage({
      transactions: [{ ...syntheticBookedTransaction, transaction_amount: { amount: "70.959999", currency: "EUR" } }],
    });
    expect(bookedPage.transactions[0]?.money.minor).toBe(7096n);
  });

  it("prefers the cross-session entry reference and keeps the transaction id as a migration alias", () => {
    const page = mapTransactionPage({
      transactions: [{ ...syntheticBookedTransaction, entry_reference: "stable-booked-reference" }],
    });
    expect(page.transactions[0]).toMatchObject({
      sourceId: "stable-booked-reference",
      alternateSourceIds: ["transaction-opaque-1"],
    });
  });

  it("rejects a booked transaction without stable source identity", () => {
    const { transaction_id: _ignored, ...missingId } = syntheticBookedTransaction;
    void _ignored;
    expect(() => mapTransactionPage({ transactions: [missingId] })).toThrow("SOURCE_TRANSACTION_ID_MISSING");
  });
});

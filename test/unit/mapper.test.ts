import { describe, expect, it } from "vitest";
import { mapAccount, mapTransactionPage } from "../../src/providers/enable-banking/mapper";
import { syntheticAccount, syntheticBookedTransaction, syntheticPendingTransaction } from "../fixtures/synthetic/enable-banking";

describe("Enable Banking mapper", () => {
  it("requires identification_hash", () => {
    expect(mapAccount(syntheticAccount)).toMatchObject({ identificationHash: "synthetic-identification-hash" });
    expect(() => mapAccount({ uid: "x", currency: "EUR" })).toThrow();
  });

  it("keeps booked and rejects pending", () => {
    const page = mapTransactionPage({ transactions: [syntheticBookedTransaction, syntheticPendingTransaction] });
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0]).toMatchObject({ sourceId: "transaction-opaque-1", direction: "debit", status: "booked" });
  });

  it("rejects a booked transaction without stable source identity", () => {
    const { transaction_id: _ignored, ...missingId } = syntheticBookedTransaction;
    void _ignored;
    expect(() => mapTransactionPage({ transactions: [missingId] })).toThrow("SOURCE_TRANSACTION_ID_MISSING");
  });
});

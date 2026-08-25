import { describe, expect, it } from "vitest";
import { parseMoney } from "../../src/domain/money";
import { balanceLabelCategory, deferredBalanceTransaction } from "../../src/sync/deferred-balance";

describe("deferred card balance workaround", () => {
  it("aggregates only current and next-month card balances", () => {
    const transaction = deferredBalanceTransaction([
      { money: parseMoney("-26.37", "EUR"), status: "OTHR", name: "card 1234 current month balance" },
      { money: parseMoney("-70.96", "EUR"), status: "OTHR", name: "card 1234 next month balance" },
      { money: parseMoney("4000.00", "EUR"), status: "XPCD", name: "Real time balance" },
    ], "EUR", "2026-08-25");

    expect(transaction).toMatchObject({
      sourceId: "virtual:fortuneo:deferred-card-balance:v1",
      date: "2026-08-25",
      direction: "debit",
      payee: "Fortuneo deferred cards",
      status: "pending",
      money: { minor: -9733n, currency: "EUR", minorDigits: 2 },
    });
  });

  it("emits a zero-valued update when the known card balances clear", () => {
    const transaction = deferredBalanceTransaction([
      { money: parseMoney("0.00", "EUR"), status: "OTHR", name: "card 1234 current month balance" },
      { money: parseMoney("0.00", "EUR"), status: "OTHR", name: "card 1234 next month balance" },
    ], "EUR", "2026-08-25");

    expect(transaction).toMatchObject({ direction: "debit", money: { minor: 0n } });
  });

  it("does nothing when Fortuneo provides no recognized card balance", () => {
    expect(deferredBalanceTransaction([
      { money: parseMoney("100.00", "EUR"), status: "XPCD", name: "Real time balance" },
    ], "EUR", "2026-08-25")).toBeNull();
  });

  it("classifies the sanitized labels used by the source probe", () => {
    expect(balanceLabelCategory("card XXXX current month balance")).toBe("CARD_CURRENT");
    expect(balanceLabelCategory("card XXXX next month balance")).toBe("CARD_NEXT");
  });
});

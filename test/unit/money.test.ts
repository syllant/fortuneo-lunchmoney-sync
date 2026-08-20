import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney, toLunchMoneyAmount } from "../../src/domain/money";

describe("money", () => {
  it("preserves all EUR minor units exactly", () => {
    fc.assert(fc.property(fc.bigInt({ min: -1_000_000_00n, max: 1_000_000_00n }), (minor) => {
      const formatted = formatMoney({ minor, currency: "EUR", minorDigits: 2 });
      expect(parseMoney(formatted, "EUR").minor).toBe(minor);
    }));
  });

  it("uses the Lunch Money debit-positive convention", () => {
    const money = parseMoney("12.34", "EUR");
    expect(toLunchMoneyAmount(money, "debit")).toBe("12.34");
    expect(toLunchMoneyAmount(money, "credit")).toBe("-12.34");
  });

  it("rejects precision loss", () => {
    expect(() => parseMoney("1.001", "EUR")).toThrow("AMOUNT_PRECISION_LOSS");
  });
});

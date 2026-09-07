import { describe, expect, it } from "vitest";
import { chooseTransferCategory, type TransferCategoryCandidate } from "../../packages/native-host/src/lunch-money.js";

describe("Lunch Money transfer category selection", () => {
  it("prefers the default category despite punctuation and casing", () => {
    const selected = chooseTransferCategory([
      category(1, "Excluded adjustment"),
      category(2, "PAYMENT & TRANSFER"),
    ]);
    expect(selected?.id).toBe(2);
  });

  it("accepts a uniquely named localized transfer category", () => {
    expect(chooseTransferCategory([category(3, "Paiement, Virement")])?.id).toBe(3);
  });

  it("uses a sole semantically equivalent category but refuses an ambiguous choice", () => {
    expect(chooseTransferCategory([category(4, "Internal movement")])?.id).toBe(4);
    expect(chooseTransferCategory([category(4, "Internal movement"), category(5, "Ignored reimbursement")])).toBeNull();
  });

  it("ignores archived categories and category groups", () => {
    expect(chooseTransferCategory([{ ...category(6, "Payment, Transfer"), archived: true }, { ...category(7, "Payment, Transfer"), isGroup: true }])).toBeNull();
  });
});

function category(id: number, name: string): TransferCategoryCandidate {
  return { id, name, isGroup: false, isIncome: false, excludeFromBudget: true, excludeFromTotals: true, archived: false };
}

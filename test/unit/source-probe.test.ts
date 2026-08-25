import { describe, expect, it } from "vitest";
import type { BankSource } from "../../src/providers/contracts";
import { mapTransactionPage } from "../../src/providers/enable-banking/mapper";
import { probeBankSource } from "../../src/sync/source-probe";

describe("source probe", () => {
  it("returns only aggregate account, balance, and raw transaction status counts", async () => {
    const account = {
      providerAccountId: "provider-account-secret",
      identificationHash: "identification-secret",
      displayHint: "Private account name",
      currency: "EUR",
      cashAccountType: "CACC",
    };
    const source: BankSource = {
      getSession: () => Promise.reject(new Error("not used")),
      listAccounts: () => Promise.resolve([account]),
      getAccountDetails: () => Promise.resolve(account),
      getBalances: () => Promise.resolve([
        { money: { minor: 12345n, currency: "EUR", minorDigits: 2 }, status: "CLAV", name: "card 123456XXXXXX7890 current month balance" },
        { money: { minor: 12000n, currency: "EUR", minorDigits: 2 }, status: "ITAV", name: "Expected balance" },
      ]),
      getTransactions: () => Promise.resolve(mapTransactionPage({
        transactions: [{ status: "OTHR" }, { status: "SCHD" }, { status: "unexpected-provider-value" }],
      })),
    };

    await expect(probeBankSource(source, "session-secret")).resolves.toEqual({
      mode: "source_probe",
      accountCount: 1,
      accountTypes: { CACC: 1 },
      balanceTypes: { CLAV: 1, ITAV: 1 },
      balanceLabelCategories: { CARD_CURRENT: 1, OTHER: 1 },
      transactions: {
        received: 3,
        accepted: 0,
        ignoredWithoutStableId: 0,
        ignoredWithoutDate: 0,
        statusCounts: { BOOK: 0, PDNG: 0, HOLD: 0, OTHR: 1, SCHD: 1, CNCL: 0, RJCT: 0, UNKNOWN: 1 },
      },
    });
  });
});

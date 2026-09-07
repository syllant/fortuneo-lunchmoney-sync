import { describe, expect, it } from "vitest";
import { adaptFortuneo } from "../../packages/extension/src/fortuneo-adapter.js";

describe("Fortuneo adapter", () => {
  it("parses the nested account and transaction API schema", () => {
    const snapshot = adaptFortuneo([
      {
        path: "/api/accounts/123456789/balance",
        data: { balances: [{ amount: { value: 1042.37 } }], currency: "EUR" },
      },
      {
        path: "/api/accounts/123456789/transactions",
        data: [{ bookingDate: "2026-08-24", valueDate: "2026-08-25", amount: { value: -12.5 }, label: { originalLabel: "CARTE 24/08 CAFE", simplifiedLabel: "Cafe" } }],
      },
    ]);

    expect(snapshot.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: "123456789", balance: "1042.37" })]));
    expect(snapshot.transactions).toEqual([
      expect.objectContaining({ accountSourceId: "123456789", amount: "12.5", merchant: "Cafe", date: "2026-08-24" }),
    ]);
  });

  it("parses the deployed new-site account, forecast and transaction contracts", () => {
    const snapshot = adaptFortuneo([
      { path: "/account-api/v2/accounts/account-123", data: { id: "account-123", label: { label: "Compte courant" }, productType: "CAV", maskedAccountNumber: "••1234" } },
      { path: "/account-api/v2/accounts/account-123/forecasted-balance?breakdown=calendar%2Corigin", data: { familyBreakdown: [
        { family: "REAL_TIME_BALANCE", amount: { value: 500.25, currency: "EUR" } },
        { family: "PENDING", amount: { value: -12, currency: "EUR" } },
        { family: "CARTE_DD", amount: { value: -18, currency: "EUR" } },
      ] } },
      { path: "/fto-transaction-api/v1/accounts/account-123/transactions?transactionType=CAV%2CPENDING&metadata=true", data: [{ id: "tx-1", accountingDate: "2026-08-24", transactionDate: "2026-08-23", amount: { value: -20, currency: "EUR" }, label: { simplifiedLabel: "Restaurant" } }] },
      { path: "/fto-transaction-api/v1/accounts/account-123/transactions?transactionType=CARD", data: [{ id: "tx-2", transactionDate: "2026-08-25", amount: { value: -12, currency: "EUR" }, label: { simplifiedLabel: "513269XXXXXX9358000" }, merchant: { name: "Cafe" }, card: { contractId: "card-456", maskedPan: "************4567" }, __fortuneoDetail: { merchant: { name: "513269XXXXXX9358000" } } }] },
      { path: "/account-api/v2/accounts/account-123/upcoming-transactions?family=CARTE&dateFrom=2026-08-31T00%3A00%3A00.000Z&dateTo=2026-08-31T00%3A00%3A00.000Z", data: [{ idtMetEm: "tx-3", amount: { value: -18, currency: "EUR" }, expectedDate: [2026, 8, 31], purchaseDate: "2026-08-26", senderContract: "card-456", label: "CARTE 20260826 BOOKSHOP PARIS", href: "/card-api/v1/cards/card-456/transactions/tx-3", __fortuneoDetail: { merchant: { name: "Bookshop" } } }] },
    ]);

    expect(snapshot.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "account-123", kind: "checking", balance: "500.25" }),
      expect.objectContaining({ sourceId: "card-456", kind: "card", balance: "30", mask: "4567" }),
    ]));
    expect(snapshot.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "tx-1", accountSourceId: "account-123", lifecycle: "settled" }),
      expect.objectContaining({ sourceId: "tx-2", accountSourceId: "card-456", merchant: "Cafe", lifecycle: "pending" }),
      expect.objectContaining({ sourceId: "tx-3", accountSourceId: "card-456", date: "2026-08-26", merchant: "Bookshop", lifecycle: "deferred" }),
    ]));
  });

  it("ignores projected balances and keeps the real checking balance", () => {
    const snapshot = adaptFortuneo([
      { path: "/account-api/v2/accounts/account-123", data: { id: "account-123", productType: "CAV" } },
      { path: "/account-api/v2/accounts/account-123/forecasted-balance", data: {
        forecastedBalance: { value: 450.75, currency: "EUR" },
        familyBreakdown: [{ family: "REAL_TIME_BALANCE", amount: { value: 500.25, currency: "EUR" } }],
      } },
      { path: "/fto-transaction-api/v1/accounts/account-123/transactions?transactionType=CARD", data: [{ id: "pending", transactionDate: "2026-08-25", amount: { value: -3.3 }, merchant: { name: "Bakery" }, card: { contractId: "card-456" } }] },
    ]);

    expect(snapshot.accounts).toContainEqual(expect.objectContaining({ sourceId: "account-123", balance: "500.25" }));
  });

  it("keeps a Livret A separate from the configured checking account", () => {
    const snapshot = adaptFortuneo([
      {
        path: "/account-api/v2/accounts/savings-123",
        data: {
          id: "savings-123",
          __fortuneoAccountKind: "savings",
          label: { label: "Livret A" },
          productType: "LVA",
          balance: { value: 1000, currency: "EUR" },
        },
      },
      {
        path: "/fto-transaction-api/v1/accounts/savings-123/transactions?transactionType=CAV%2CPENDING&metadata=true",
        data: [{ id: "deposit-1", accountingDate: "2026-09-03", amount: { value: 1000, currency: "EUR" }, label: { simplifiedLabel: "Ouverture Livret A" } }],
      },
    ]);

    expect(snapshot.accounts).toEqual([
      expect.objectContaining({ sourceId: "savings-123", kind: "savings", displayName: "Livret A", balance: "1000" }),
    ]);
    expect(snapshot.transactions).toEqual([
      expect.objectContaining({ sourceId: "deposit-1", accountSourceId: "savings-123", amount: "-1000", lifecycle: "settled" }),
    ]);
  });

  it("uses the pending list merchant but never substitutes a deferred left-hand label", () => {
    const snapshot = adaptFortuneo([
      { path: "/account-api/v2/accounts/account-123", data: { id: "account-123", productType: "CAV" } },
      { path: "/account-api/v2/accounts/account-123/forecasted-balance", data: { familyBreakdown: [{ family: "REAL_TIME_BALANCE", amount: { value: 500.25, currency: "EUR" } }] } },
      { path: "/fto-transaction-api/v1/accounts/account-123/transactions?transactionType=CARD", data: [{ id: "pending", transactionDate: "2026-08-25", amount: { value: -3.3 }, label: { simplifiedLabel: "513269XXXXXX9358000" }, merchant: { name: "MARIE BLACHERE" }, card: { contractId: "card-456" } }] },
      { path: "/account-api/v2/accounts/account-123/upcoming-transactions?family=CARTE&dateFrom=2026-08-31T00%3A00%3A00.000Z", data: [{ idtMetEm: "deferred", amount: { value: -3.7 }, purchaseDate: "2026-08-23", senderContract: "card-456", label: "CARTE 20260823 BOULANGERIE VICT BAILLARGUES" }] },
    ]);

    expect(snapshot.transactions).toEqual([expect.objectContaining({ sourceId: "pending", merchant: "MARIE BLACHERE", lifecycle: "pending" })]);
  });
});

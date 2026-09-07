import { describe, expect, it } from "vitest";
import { LunchMoneyError } from "@lunch-money/lunch-money-js-v2";
import { LunchMoneyGateway, lunchMoneyFailureCode } from "../../packages/native-host/src/lunch-money.js";
import { safeErrorCode, safeErrorDiagnostic, SyncPhaseError } from "../../packages/native-host/src/redaction.js";

describe("Lunch Money failure diagnostics", () => {
  it.each([
    "FORTUNEO_SETTLED_CARD_REFERENCE_NOT_UNIQUE",
    "FORTUNEO_SETTLED_CARD_REFERENCE_NOT_FOUND",
    "FORTUNEO_SETTLED_CARD_REFERENCE_MISMATCH",
    "FORTUNEO_SETTLED_CARD_REFERENCE_ACCOUNT_MISSING",
    "INVALID_SETTLEMENT_REFERENCE",
  ])("preserves the safe settled-card diagnostic %s", (code) => {
    expect(safeErrorDiagnostic(new SyncPhaseError("resolving-settled-cards", new Error(code)))).toMatchObject({ code, phase: "resolving-settled-cards" });
  });
  it("preserves the operation and HTTP status without exposing the response body", () => {
    const cause = new LunchMoneyError("sensitive upstream message", 429, { account: "sensitive" });
    const code = lunchMoneyFailureCode("UPDATE_BALANCE", cause);

    expect(code).toBe("LUNCH_MONEY_UPDATE_BALANCE_HTTP_429");
    expect(safeErrorCode(new Error(code, { cause }))).toBe(code);
    expect(code).not.toContain("sensitive");
  });

  it("distinguishes network failures from failures without a status", () => {
    expect(lunchMoneyFailureCode("READ_TRANSACTIONS", new TypeError("fetch failed"))).toBe("LUNCH_MONEY_READ_TRANSACTIONS_NETWORK_FAILED");
    expect(lunchMoneyFailureCode("CREATE_TRANSACTION", new Error("unexpected"))).toBe("LUNCH_MONEY_CREATE_TRANSACTION_FAILED");
  });

  it("classifies transaction update response errors inside the operation boundary", async () => {
    const gateway = new LunchMoneyGateway("test-token");
    Object.defineProperty(gateway, "client", {
      value: {
        rawClient: {
          PUT: async () => ({
            data: undefined,
            error: { errors: [{ errMsg: "sensitive upstream detail" }] },
            response: { status: 400 },
          }),
        },
      },
    });

    await expect(gateway.updateTransaction(123, { payee: "Updated" }))
      .rejects.toThrow("LUNCH_MONEY_UPDATE_TRANSACTION_HTTP_400");
  });

  it("batches transaction updates and retries a rate limit once", async () => {
    const waits: number[] = [];
    const requests: unknown[] = [];
    let attempts = 0;
    let elapsed = 0;
    const activityTimes: number[] = [];
    const gateway = new LunchMoneyGateway("test-token", async (milliseconds) => { waits.push(milliseconds); elapsed += milliseconds; }, () => activityTimes.push(elapsed));
    Object.defineProperty(gateway, "client", {
      value: {
        transactions: {
          updateMany: async (request: unknown) => {
            requests.push(request);
            attempts += 1;
            if (attempts === 1) throw new LunchMoneyError("rate limited", 429);
            return { transactions: [] };
          },
        },
      },
    });

    await gateway.updateTransactions([
      { id: 123, patch: { payee: "Updated", tagIds: [7] } },
      { id: 456, patch: { amount: "12.34" } },
    ]);

    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(60_000);
    expect(activityTimes).toEqual([0, 30_000]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ transactions: [
      { id: 123, payee: "Updated", tag_ids: [7] },
      { id: 456, amount: "12.34" },
    ] });
  });

  it("continues to redact untrusted lookalike codes", () => {
    expect(safeErrorCode(new Error("LUNCH_MONEY_STEAL_TOKEN_HTTP_400"))).toBe("UNEXPECTED_ERROR");
    expect(safeErrorCode(new Error("LUNCH_MONEY_UPDATE_BALANCE_HTTP_999"))).toBe("UNEXPECTED_ERROR");
  });

  it("adds actionable local context without exposing the exception message", () => {
    const sensitive = new TypeError("token sk_live_secret failed for account 123");
    sensitive.stack = `TypeError: token sk_live_secret failed for account 123\n    at finish (/Users/person/app/packages/native-host/src/sync-service.ts:147:19)\n    at async main (/Users/person/app/packages/native-host/src/main.ts:39:7)`;

    const diagnostic = safeErrorDiagnostic(new SyncPhaseError("building-result", sensitive));

    expect(diagnostic).toEqual({
      code: "UNEXPECTED_ERROR",
      phase: "building-result",
      kind: "TypeError",
      location: "packages/native-host/src/sync-service.ts:147:19",
      fingerprint: expect.stringMatching(/^[A-F0-9]{12}$/),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sk_live_secret");
    expect(safeErrorDiagnostic(new SyncPhaseError("building-result", sensitive)).fingerprint).toBe(diagnostic.fingerprint);
  });
});

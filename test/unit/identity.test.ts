import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { transactionExternalId, transactionPayloadHmac } from "../../src/sync/identity";
import { parseMoney } from "../../src/domain/money";

const transaction = {
  sourceId: "source-1", bookedDate: "2026-08-10", money: parseMoney("10.00", "EUR"),
  direction: "debit" as const, payee: "Synthetic", notes: null, status: "booked" as const,
};

describe("HMAC identities", () => {
  it("is deterministic, versioned and opaque", async () => {
    const first = await transactionExternalId("test-secret", "account-hash", "source-1");
    expect(first).toBe(await transactionExternalId("test-secret", "account-hash", "source-1"));
    expect(first).toMatch(/^lmft:v1:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("account-hash");
    expect(first).not.toContain("source-1");
  });

  it("has no collisions for a synthetic sample", async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.uuid(), { minLength: 20, maxLength: 100 }), async (ids) => {
      const values = await Promise.all(ids.map((id) => transactionExternalId("test-secret", "account", id)));
      expect(new Set(values).size).toBe(values.length);
    }));
  });

  it("changes payload HMAC after a correction", async () => {
    const original = await transactionPayloadHmac("test-secret", transaction);
    const corrected = await transactionPayloadHmac("test-secret", { ...transaction, money: parseMoney("10.01", "EUR") });
    expect(corrected).not.toBe(original);
  });
});

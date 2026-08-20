import { describe, expect, it } from "vitest";
import { parseMoney } from "../../src/domain/money";
import type { BudgetSink, BudgetTransaction, DesiredTransaction } from "../../src/providers/contracts";
import { reconcileTransactions } from "../../src/sync/reconcile";
import type { SyncIndexRecord } from "../../src/storage/sync-index-repository";

class MemoryIndex {
  readonly values = new Map<string, SyncIndexRecord>();
  find(id: string) { return Promise.resolve(this.values.get(id) ?? null); }
  save(record: SyncIndexRecord) { this.values.set(record.externalIdHmac, record); return Promise.resolve(); }
  async touch() { return Promise.resolve(); }
}

class MemorySink implements BudgetSink {
  transactions: (DesiredTransaction & { id: number })[] = [];
  nextId = 1;
  writes = { create: 0, update: 0 };
  listAccounts() { return Promise.resolve([]); }
  upsertAccount() { return Promise.resolve({ id: 1, externalId: "account" }); }
  listTransactions() { return Promise.resolve(this.transactions.map(({ id, externalId, accountId }) => ({ id, externalId, manualAccountId: accountId }))); }
  createTransactions(items: readonly DesiredTransaction[]) {
    this.writes.create += items.length;
    const created: BudgetTransaction[] = items.map((item) => {
      const record = { ...item, id: this.nextId++ };
      this.transactions.push(record);
      return { id: record.id, externalId: record.externalId, manualAccountId: record.accountId };
    });
    return Promise.resolve({ created, duplicates: [] });
  }
  updateTransactions(items: readonly (DesiredTransaction & { id: number })[]) {
    this.writes.update += items.length;
    for (const item of items) {
      const index = this.transactions.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) this.transactions[index] = item;
    }
    return Promise.resolve();
  }
  async updateBalance() { return Promise.resolve(); }
}

const baseTransaction = {
  sourceId: "source-1", bookedDate: "2026-08-10", money: parseMoney("12.34", "EUR"),
  direction: "debit" as const, payee: "Synthetic", notes: null, status: "booked" as const,
};
const range = { from: "2026-08-07", to: "2026-08-13" };

describe("reconciliation", () => {
  it("replays three times without duplicates", async () => {
    const sink = new MemorySink();
    const index = new MemoryIndex();
    const input = { transactions: [baseTransaction], identificationHash: "account-hash", lunchMoneyAccountId: 1, range, hmacKey: "secret", dryRun: false, now: "2026-08-13T00:00:00Z" };
    const results = [await reconcileTransactions(input, sink, index), await reconcileTransactions(input, sink, index), await reconcileTransactions(input, sink, index)];
    expect(results.map((result) => result.created)).toEqual([1, 0, 0]);
    expect(sink.transactions).toHaveLength(1);
  });

  it("propagates a source correction", async () => {
    const sink = new MemorySink();
    const index = new MemoryIndex();
    const input = { transactions: [baseTransaction], identificationHash: "account-hash", lunchMoneyAccountId: 1, range, hmacKey: "secret", dryRun: false, now: "2026-08-13T00:00:00Z" };
    await reconcileTransactions(input, sink, index);
    const result = await reconcileTransactions({ ...input, transactions: [{ ...baseTransaction, money: parseMoney("12.35", "EUR") }] }, sink, index);
    expect(result.updated).toBe(1);
    expect(sink.transactions[0]?.amount).toBe("12.35");
  });

  it("repairs D1 index after a remote-only partial write", async () => {
    const sink = new MemorySink();
    const firstIndex = new MemoryIndex();
    const input = { transactions: [baseTransaction], identificationHash: "account-hash", lunchMoneyAccountId: 1, range, hmacKey: "secret", dryRun: false, now: "2026-08-13T00:00:00Z" };
    await reconcileTransactions(input, sink, firstIndex);
    const repairedIndex = new MemoryIndex();
    const result = await reconcileTransactions(input, sink, repairedIndex);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(sink.transactions).toHaveLength(1);
    expect(repairedIndex.values.size).toBe(1);
  });

  it("dry-run performs no writes", async () => {
    const sink = new MemorySink();
    const result = await reconcileTransactions({
      transactions: [baseTransaction], identificationHash: "account-hash", lunchMoneyAccountId: 1,
      range, hmacKey: "secret", dryRun: true, now: "2026-08-13T00:00:00Z",
    }, sink, new MemoryIndex());
    expect(result.created).toBe(1);
    expect(sink.writes).toEqual({ create: 0, update: 0 });
  });
});

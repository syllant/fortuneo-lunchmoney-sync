import { describe, expect, it } from "vitest";
import { IdentityService } from "../../packages/shared/src/identity.js";
import type { ExistingAccount, ExistingTransaction, FortuneoSnapshot, ManagedIds } from "../../packages/shared/src/model.js";
import { planAccounts, planTransactions } from "../../packages/shared/src/reconcile.js";

const identity = new IdentityService(Buffer.alloc(32, 7));
const ids: ManagedIds = { checkingAccountId: 10, pendingTagId: 20, deferredTagId: 21, paymentTransferCategoryId: 30 };
const accounts: ExistingAccount[] = [
  { id: 10, name: "Fortuneo checking", type: "cash", balance: "1000", currency: "eur", externalId: identity.accountExternalId("checking"), metadata: null },
  { id: 11, name: "World Elite", type: "credit", balance: "0", currency: "eur", externalId: identity.accountExternalId("world"), metadata: null },
  { id: 12, name: "Gold", type: "credit", balance: "0", currency: "eur", externalId: identity.accountExternalId("gold"), metadata: null },
];

describe("transaction reconciliation", () => {
  it("keeps one transaction through pending, deferred, and settled while preserving user fields", () => {
    const pending = baseSnapshot();
    pending.transactions = [{ sourceId: "op-1", accountSourceId: "world", date: "2026-08-20", amount: "42.5", currency: "eur", merchant: "Original merchant", lifecycle: "pending" }];
    const created = planTransactions(pending, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    expect(created?.kind).toBe("create-transaction");
    if (created?.kind !== "create-transaction") throw new Error("missing create");
    const existing: ExistingTransaction = {
      id: 100,
      accountId: 11,
      date: created.transaction.date,
      amount: created.transaction.amount,
      currency: "eur",
      payee: "User payee",
      notes: "User note",
      categoryId: 999,
      tagIds: [20, 88],
      externalId: created.transaction.externalId,
      metadata: created.transaction.metadata,
      groupParentId: null,
    };
    const deferred = structuredClone(pending);
    deferred.transactions[0] = { ...deferred.transactions[0]!, lifecycle: "deferred", merchant: "Provider corrected merchant" };
    const deferredUpdate = planTransactions(deferred, accounts, [existing], identity, ids).operations.find((operation) => operation.kind === "update-transaction");
    expect(deferredUpdate).toMatchObject({ kind: "update-transaction", id: 100, patch: { tagIds: [88, 21], payee: "Provider corrected merchant" } });
    if (deferredUpdate?.kind !== "update-transaction") throw new Error("missing update");
    expect(deferredUpdate.patch).not.toHaveProperty("notes");
    expect(deferredUpdate.patch).not.toHaveProperty("categoryId");

    const settledExisting = { ...existing, tagIds: [88, 21], metadata: deferredUpdate.patch.metadata ?? existing.metadata };
    const settled = structuredClone(deferred);
    settled.transactions[0] = { ...settled.transactions[0]!, lifecycle: "settled" };
    const settledUpdate = planTransactions(settled, accounts, [settledExisting], identity, ids).operations.find((operation) => operation.kind === "update-transaction");
    expect(settledUpdate).toMatchObject({ kind: "update-transaction", id: 100, patch: { tagIds: [88] } });
  });

  it("refreshes the payee on every existing pending transaction", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "pending-payee", accountSourceId: "world", date: "2026-08-25", amount: "3.30", currency: "eur", merchant: "MARIE BLACHERE", lifecycle: "pending" }];
    const created = planTransactions(snapshot, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (created?.kind !== "create-transaction") throw new Error("missing create");
    const existing: ExistingTransaction = { id: 101, accountId: 11, date: "2026-08-25", amount: "3.30", currency: "eur", payee: "Any previous payee", notes: "keep", categoryId: 99, tagIds: [20], externalId: created.transaction.externalId, metadata: created.transaction.metadata, groupParentId: null };

    const repair = planTransactions(snapshot, accounts, [existing], identity, ids).operations.find((operation) => operation.kind === "update-transaction");

    expect(repair).toMatchObject({ kind: "update-transaction", id: 101, patch: { payee: "MARIE BLACHERE" } });
    if (repair?.kind !== "update-transaction") throw new Error("missing repair");
    expect(repair.patch).not.toHaveProperty("notes");
    expect(repair.patch).not.toHaveProperty("categoryId");
  });

  it("reuses a consistent category from the same account for a new exact merchant", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "new-bakery", accountSourceId: "world", date: "2026-08-25", amount: "3.30", currency: "eur", merchant: "MARIE BLACHERE", lifecycle: "pending" }];
    const history: ExistingTransaction[] = [
      { id: 201, accountId: 11, date: "2026-08-10", amount: "4.20", currency: "eur", payee: "  Marie   Blachere ", notes: null, categoryId: 41, tagIds: [], externalId: null, metadata: null, groupParentId: null },
      { id: 202, accountId: 12, date: "2026-08-11", amount: "5.10", currency: "eur", payee: "MARIE BLACHERE", notes: null, categoryId: 99, tagIds: [], externalId: null, metadata: null, groupParentId: null },
    ];

    const create = planTransactions(snapshot, accounts, history, identity, ids).operations.find((operation) => operation.kind === "create-transaction");

    expect(create).toMatchObject({ kind: "create-transaction", categorySource: "history", transaction: { categoryId: 41 } });
  });

  it("repairs an imported uncategorized transaction from consistent merchant history", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "existing-bakery", accountSourceId: "world", date: "2026-08-25", amount: "3.30", currency: "eur", merchant: "MARIE BLACHERE", lifecycle: "pending" }];
    const initial = planTransactions(snapshot, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (initial?.kind !== "create-transaction") throw new Error("missing create");
    const existing: ExistingTransaction = { id: 203, accountId: 11, date: initial.transaction.date, amount: initial.transaction.amount, currency: "eur", payee: initial.transaction.payee, notes: null, categoryId: null, tagIds: initial.transaction.tagIds, externalId: initial.transaction.externalId, metadata: initial.transaction.metadata, groupParentId: null };
    const history: ExistingTransaction = { id: 204, accountId: 11, date: "2026-08-01", amount: "2.50", currency: "eur", payee: "Marie Blachere", notes: null, categoryId: 41, tagIds: [], externalId: null, metadata: null, groupParentId: null };

    const update = planTransactions(snapshot, accounts, [existing, history], identity, ids).operations.find((operation) => operation.kind === "update-transaction" && operation.id === existing.id);

    expect(update).toMatchObject({ kind: "update-transaction", categorySource: "history", patch: { categoryId: 41 } });
  });

  it("leaves the category unset when same-account merchant history conflicts", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "new-merchant", accountSourceId: "world", date: "2026-08-25", amount: "10", currency: "eur", merchant: "SAME MERCHANT", lifecycle: "settled" }];
    const history: ExistingTransaction[] = [
      { id: 205, accountId: 11, date: "2026-08-01", amount: "10", currency: "eur", payee: "Same Merchant", notes: null, categoryId: 41, tagIds: [], externalId: null, metadata: null, groupParentId: null },
      { id: 206, accountId: 11, date: "2026-08-02", amount: "10", currency: "eur", payee: "SAME MERCHANT", notes: null, categoryId: 42, tagIds: [], externalId: null, metadata: null, groupParentId: null },
    ];

    const create = planTransactions(snapshot, accounts, history, identity, ids).operations.find((operation) => operation.kind === "create-transaction");

    expect(create?.kind).toBe("create-transaction");
    if (create?.kind !== "create-transaction") throw new Error("missing create");
    expect(create.transaction).not.toHaveProperty("categoryId");
    expect(create).not.toHaveProperty("categorySource");
  });

  it("deletes a missing pending authorization only on the second complete snapshot", () => {
    const pending = managedPending(1);
    const complete = baseSnapshot();
    const second = planTransactions(complete, accounts, [pending], identity, ids);
    expect(second.operations).toContainEqual(expect.objectContaining({ kind: "delete-cancelled-pending", id: pending.id }));
    const partial = structuredClone(complete); partial.complete = false; partial.accounts.forEach((account) => { account.complete = false; });
    expect(planTransactions(partial, accounts, [pending], identity, ids).operations).toHaveLength(0);
  });

  it("stops ambiguous fingerprint migration instead of duplicating", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "new-id", accountSourceId: "world", date: "2026-08-20", amount: "10", currency: "eur", merchant: "Same", lifecycle: "settled" }];
    const initial = structuredClone(snapshot); initial.transactions[0] = { ...initial.transactions[0]!, sourceId: "old-id" };
    const create = planTransactions(initial, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (create?.kind !== "create-transaction") throw new Error("missing create");
    const duplicate = (id: number): ExistingTransaction => ({ id, accountId: 11, date: "2026-08-20", amount: "10", currency: "eur", payee: "Same", notes: null, categoryId: null, tagIds: [], externalId: `${create.transaction.externalId}-${id}`, metadata: create.transaction.metadata, groupParentId: null });
    const plan = planTransactions(snapshot, accounts, [duplicate(1), duplicate(2)], identity, ids);
    expect(plan.warnings).toContain("AMBIGUOUS_FINGERPRINT");
    expect(plan.operations.some((operation) => operation.kind === "create-transaction")).toBe(false);
  });

  it("uses lifecycle to resolve a changed source id with otherwise identical candidates", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "new-id", accountSourceId: "world", date: "2026-08-20", amount: "10", currency: "eur", merchant: "Same", lifecycle: "deferred" }];
    const initial = structuredClone(snapshot); initial.transactions[0] = { ...initial.transactions[0]!, sourceId: "old-id" };
    const create = planTransactions(initial, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (create?.kind !== "create-transaction") throw new Error("missing create");
    const candidate = (id: number, lifecycle: "pending" | "deferred"): ExistingTransaction => ({ id, accountId: 11, date: "2026-08-20", amount: "10", currency: "eur", payee: "Same", notes: null, categoryId: null, tagIds: [], externalId: `${create.transaction.externalId}-${id}`, metadata: { ...create.transaction.metadata, lifecycle }, groupParentId: null });
    const plan = planTransactions(snapshot, accounts, [candidate(1, "pending"), candidate(2, "deferred")], identity, ids);
    expect(plan.warnings).not.toContain("AMBIGUOUS_FINGERPRINT");
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "update-transaction", id: 2 }));
  });

  it("pairs equal-sized groups of indistinguishable transactions without blocking", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [
      { sourceId: "new-b", accountSourceId: "world", date: "2026-08-20", amount: "10", currency: "eur", merchant: "Same", lifecycle: "pending" },
      { sourceId: "new-a", accountSourceId: "world", date: "2026-08-20", amount: "10", currency: "eur", merchant: "Same", lifecycle: "pending" },
    ];
    const initial = structuredClone(snapshot); initial.transactions = initial.transactions.map((transaction, index) => ({ ...transaction, sourceId: `old-${index}` }));
    const creates = planTransactions(initial, accounts, [], identity, ids).operations.filter((operation) => operation.kind === "create-transaction");
    const existing = creates.map((operation, index): ExistingTransaction => ({ id: 10 + index, accountId: 11, date: operation.transaction.date, amount: operation.transaction.amount, currency: "eur", payee: "Same", notes: null, categoryId: null, tagIds: [], externalId: operation.transaction.externalId, metadata: operation.transaction.metadata, groupParentId: null }));

    const plan = planTransactions(snapshot, accounts, existing, identity, ids);

    expect(plan.warnings).not.toContain("AMBIGUOUS_FINGERPRINT");
    expect(plan.operations.filter((operation) => operation.kind === "update-transaction")).toHaveLength(2);
  });

  it("creates card credits and one net-zero group only for an exact settlement", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "settle-1", accountSourceId: "checking", date: "2026-08-25", amount: "150", currency: "eur", merchant: "CARTE DIFFEREE", lifecycle: "settled" }];
    snapshot.settlements = [{ sourceId: "settle-1", checkingAccountSourceId: "checking", date: "2026-08-25", checkingDebit: "150", currency: "eur", cardCredits: [{ cardAccountSourceId: "world", amount: "-100" }, { cardAccountSourceId: "gold", amount: "-50" }] }];
    const plan = planTransactions(snapshot, accounts, [], identity, ids);
    expect(plan.operations.filter((operation) => operation.kind === "create-transaction")).toHaveLength(3);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "group-settlement", memberSourceIds: ["settle-1", "settle-1\0world", "settle-1\0gold"] }));
    expect(plan.warnings).toHaveLength(0);
  });

  it("categorizes a recognizable debit but refuses grouping on mismatch", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "settle-2", accountSourceId: "checking", date: "2026-08-25", amount: "151", currency: "eur", merchant: "CARTE DIFFEREE", lifecycle: "settled" }];
    snapshot.settlements = [{ sourceId: "settle-2", checkingAccountSourceId: "checking", date: "2026-08-25", checkingDebit: "151", currency: "eur", cardCredits: [{ cardAccountSourceId: "world", amount: "-150" }] }];
    const original = planTransactions({ ...snapshot, settlements: [] }, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (original?.kind !== "create-transaction") throw new Error("missing create");
    const existing: ExistingTransaction = { id: 500, accountId: 10, date: "2026-08-25", amount: "151", currency: "eur", payee: "Edited", notes: null, categoryId: null, tagIds: [], externalId: original.transaction.externalId, metadata: original.transaction.metadata, groupParentId: null };
    const plan = planTransactions(snapshot, accounts, [existing], identity, ids);
    expect(plan.warnings).toContain("SETTLEMENT_TOTAL_MISMATCH");
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "update-transaction", id: 500, patch: expect.objectContaining({ categoryId: 30 }) }));
    expect(plan.operations.some((operation) => operation.kind === "group-settlement")).toBe(false);
  });

  it("adopts a uniquely matching v1 checking transaction without the old HMAC key", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [{ sourceId: "new-provider-id", accountSourceId: "checking", date: "2026-08-12", amount: "24.50", currency: "eur", merchant: "Merchant Name", lifecycle: "settled" }];
    const legacy: ExistingTransaction = { id: 601, accountId: 10, date: "2026-08-12", amount: "24.50", currency: "eur", payee: " merchant   name ", notes: "keep", categoryId: 99, tagIds: [77], externalId: "lmft:v1:unknown-old-hmac", metadata: null, groupParentId: null };
    const plan = planTransactions(snapshot, accounts, [legacy], identity, ids);
    const migration = plan.operations.find((operation) => operation.kind === "update-transaction" && operation.id === 601);
    expect(migration).toMatchObject({ kind: "update-transaction", id: 601, patch: { externalId: identity.transactionExternalId("new-provider-id") } });
    if (migration?.kind !== "update-transaction") throw new Error("missing migration");
    expect(migration.patch).not.toHaveProperty("payee");
    expect(migration.patch).not.toHaveProperty("notes");
    expect(migration.patch).not.toHaveProperty("categoryId");
  });

  it("deletes the legacy synthetic deferred total only after exact complete itemization", () => {
    const snapshot = baseSnapshot();
    snapshot.transactions = [
      { sourceId: "d1", accountSourceId: "world", date: "2026-08-20", amount: "60", currency: "eur", merchant: "A", lifecycle: "deferred" },
      { sourceId: "d2", accountSourceId: "gold", date: "2026-08-21", amount: "40", currency: "eur", merchant: "B", lifecycle: "deferred" },
    ];
    const synthetic: ExistingTransaction = { id: 700, accountId: 10, date: "2026-08-25", amount: "100", currency: "eur", payee: "Fortuneo deferred cards", notes: null, categoryId: null, tagIds: [], externalId: "lmft:v1:synthetic", metadata: null, groupParentId: null };
    expect(planTransactions(snapshot, accounts, [synthetic], identity, ids).operations).toContainEqual({ kind: "delete-replaced-synthetic", id: 700 });
    snapshot.complete = false;
    expect(planTransactions(snapshot, accounts, [synthetic], identity, ids).operations.some((operation) => operation.kind === "delete-replaced-synthetic")).toBe(false);
  });
});

describe("account reconciliation", () => {
  it("represents card balances as supplied and migrates a uniquely named replacement with an alias", () => {
    const snapshot = baseSnapshot();
    const first = planAccounts(snapshot, accounts.slice(0, 1), identity, 10);
    const cardCreate = first.operations.find((operation) => operation.kind === "create-account" && operation.sourceAccount.sourceId === "world");
    if (cardCreate?.kind !== "create-account") throw new Error("missing account create");
    expect(cardCreate.sourceAccount.balance).toBe("120.50");
    const old: ExistingAccount = { id: 11, name: "World Elite", type: "credit", balance: "0", currency: "eur", externalId: cardCreate.externalId, metadata: cardCreate.metadata };
    const replacement = structuredClone(snapshot); replacement.accounts[1] = { ...replacement.accounts[1]!, sourceId: "world-new", mask: "9999" };
    const plan = planAccounts(replacement, [accounts[0]!, old], identity, 10);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "mark-account", accountId: 11 }));
    expect(plan.operations.some((operation) => operation.kind === "create-account" && operation.sourceAccount.sourceId === "world-new")).toBe(false);
  });

  it("creates and maps a savings account without touching the configured checking account", () => {
    const snapshot: FortuneoSnapshot = {
      capturedAt: "2026-09-03T10:00:00.000Z",
      complete: false,
      accounts: [{ sourceId: "livret-a", kind: "savings", displayName: "Livret A", currency: "eur", balance: "1000", complete: false }],
      transactions: [{ sourceId: "deposit", accountSourceId: "livret-a", date: "2026-09-03", amount: "-1000", currency: "eur", merchant: "Ouverture Livret A", lifecycle: "settled" }],
      settlements: [],
    };
    const accountPlan = planAccounts(snapshot, accounts.slice(0, 1), identity, 10);
    const create = accountPlan.operations.find((operation) => operation.kind === "create-account");
    expect(create).toEqual(expect.objectContaining({ kind: "create-account", sourceAccount: expect.objectContaining({ kind: "savings" }) }));
    expect(accountPlan.operations.some((operation) => operation.kind === "mark-account" || operation.kind === "update-account-balance")).toBe(false);
    if (create?.kind !== "create-account") throw new Error("missing savings account create");
    const savings: ExistingAccount = { id: 20, name: "Livret A", type: "cash", balance: "1000", currency: "eur", externalId: create.externalId, metadata: create.metadata };
    const transactionPlan = planTransactions(snapshot, [...accounts.slice(0, 1), savings], [], identity, ids);
    expect(transactionPlan.operations).toContainEqual(expect.objectContaining({
      kind: "create-transaction",
      transaction: expect.objectContaining({ accountId: 20, amount: "-1000" }),
    }));
  });
});

function baseSnapshot(): FortuneoSnapshot {
  return {
    capturedAt: "2026-08-25T08:00:00.000Z",
    complete: true,
    accounts: [
      { sourceId: "checking", kind: "checking", displayName: "Fortuneo checking", currency: "eur", balance: "1000", complete: true },
      { sourceId: "world", kind: "card", displayName: "World Elite", currency: "eur", balance: "120.50", mask: "1234", complete: true },
      { sourceId: "gold", kind: "card", displayName: "Gold", currency: "eur", balance: "40", mask: "5678", complete: true },
    ],
    transactions: [],
    settlements: [],
  };
}

function managedPending(missCount: number): ExistingTransaction {
  const snapshot = baseSnapshot();
  snapshot.transactions = [{ sourceId: "pending-gone", accountSourceId: "world", date: "2026-08-20", amount: "12", currency: "eur", merchant: "Merchant", lifecycle: "pending" }];
  const create = planTransactions(snapshot, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
  if (create?.kind !== "create-transaction") throw new Error("missing create");
  return { id: 70, accountId: 11, date: "2026-08-20", amount: "12", currency: "eur", payee: "Merchant", notes: null, categoryId: null, tagIds: [20], externalId: create.transaction.externalId, metadata: { ...create.transaction.metadata, miss_count: missCount }, groupParentId: null };
}

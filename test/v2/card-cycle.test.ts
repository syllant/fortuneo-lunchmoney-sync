import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { adaptFortuneo } from "../../packages/extension/src/fortuneo-adapter.js";
import { IdentityService } from "../../packages/shared/src/identity.js";
import { planTransactions } from "../../packages/shared/src/reconcile.js";
import { parseSnapshot } from "../../packages/shared/src/messages.js";
import { resolveSettledCardReferences } from "../../packages/shared/src/settled-cards.js";
import type { DesiredTransaction, ExistingTransaction } from "../../packages/shared/src/model.js";

const identity = new IdentityService(Buffer.alloc(32, 7));
const ids = { checkingAccountId: 10, pendingTagId: 20, deferredTagId: 21 };
const accounts = ["checking", "world", "gold"].map((sourceId, index) => ({ id: 10 + index, name: sourceId, type: index ? "credit" : "cash", balance: "0", currency: "eur", externalId: identity.accountExternalId(sourceId), metadata: null }));
const asExisting = (transaction: DesiredTransaction, id: number): ExistingTransaction => ({ ...transaction, id, categoryId: 99, notes: "Keep user note", groupParentId: null });
const detail = (card: string, operation: string) => ({ card: { contractId: card, maskedPan: "************1234" }, merchant: { name: "Bookshop" }, transaction: { transactionId: `${operation}001`, date: "2026-09-04" } });
const booking = (card: string, amount: number, operation: string) => ({ id: `booking-${operation}`, originalOperationId: operation, transactionDate: "2026-09-30", amount: { value: amount, currency: "EUR" }, label: { simplifiedLabel: "CARTE 04/09 BOOKSHOP PARIS" }, description: { transactionCategory: "CARD" }, href: `/card-api/v1/accounts/checking/cards-transactions/${operation}?date=2026-09-04`, __fortuneoDetail: detail(card, operation) });
const snapshotFor = (rows: unknown[], extra: Array<{ path: string; data: unknown }> = []) => adaptFortuneo([
  { path: "/account-api/v2/accounts/checking", data: { id: "checking", balance: 500, productType: "CAV" } },
  { path: "/fto-transaction-api/v1/accounts/checking/transactions?transactionType=CAV%2CPENDING", data: rows },
  { path: "/fto-transaction-api/v1/accounts/checking/transactions?transactionType=CARD", data: [{ id: "new-cycle", transactionDate: "2026-10-01", amount: -8, merchant: { name: "Cafe" }, card: { contractId: "world" } }] },
  ...extra,
]);

function previousPurchases(snapshot: ReturnType<typeof snapshotFor>): ExistingTransaction[] {
  const previous = structuredClone(snapshot);
  previous.settlements = [];
  previous.transactions = previous.transactions.filter((transaction) => transaction.accountSourceId !== "checking")
    .map((transaction) => transaction.lifecycle === "settled" ? { ...transaction, lifecycle: "deferred" as const } : transaction);
  return planTransactions(previous, accounts, [], identity, ids).operations.filter((operation) => operation.kind === "create-transaction")
    .map((operation, index) => asExisting(operation.transaction, 100 + index));
}

function applyPlan(existing: ExistingTransaction[], operations: ReturnType<typeof planTransactions>["operations"]): void {
  for (const operation of operations) {
    if (operation.kind === "update-transaction") Object.assign(existing.find((transaction) => transaction.id === operation.id)!, operation.patch);
    if (operation.kind === "create-transaction") existing.push(asExisting(operation.transaction, 300 + existing.length));
  }
}

describe("deferred card cycle rollover", () => {
  it("settles both cards without extra transactions or changes to the original purchases", () => {
    const snapshot = snapshotFor([booking("world", -25, "purchase-world"), booking("gold", -25, "purchase-gold")]);
    expect(snapshot.transactions.some((transaction) => transaction.accountSourceId === "checking")).toBe(false);
    expect(snapshot.settlements.every((settlement) => settlement.cardCredits.length === 0)).toBe(true);
    const existing = previousPurchases(snapshot);
    for (const purchase of existing.filter((transaction) => transaction.metadata?.lifecycle === "deferred")) {
      purchase.payee = "My merchant";
      purchase.tagIds = [21, 88];
    }
    const before = structuredClone(existing);
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations.every((operation) => operation.kind === "update-transaction")).toBe(true);
    for (const purchase of before.filter((transaction) => transaction.metadata?.lifecycle === "deferred")) {
      const update = plan.operations.find((operation) => operation.kind === "update-transaction" && operation.id === purchase.id);
      expect(update).toMatchObject({ patch: { tagIds: [88], metadata: { lifecycle: "settled" } } });
      if (update?.kind !== "update-transaction") throw new Error("missing purchase update");
      expect(Object.keys(update.patch).sort()).toEqual(["metadata", "tagIds"]);
    }
    applyPlan(existing, plan.operations);
    expect(existing).toHaveLength(before.length);
    for (let index = 0; index < existing.length; index += 1) {
      for (const key of ["id", "accountId", "date", "amount", "currency", "payee", "categoryId", "notes", "externalId"] as const) {
        expect(existing[index]![key]).toEqual(before[index]![key]);
      }
    }
    expect(planTransactions(snapshot, accounts, existing, identity, ids).operations.some((operation) => operation.kind === "create-transaction")).toBe(false);
    expect(snapshot.accounts.find((account) => account.sourceId === "world")?.balance).toBe("8");
    expect(snapshot.accounts.find((account) => account.sourceId === "gold")?.balance).toBe("0");
    expect(() => parseSnapshot(snapshot)).not.toThrow();
  });

  it("retains the original purchase identity and date when the provider changes its reference", () => {
    const snapshot = snapshotFor([booking("world", -25, "new-reference")]);
    const previous = structuredClone(snapshot); previous.settlements = [];
    previous.transactions = previous.transactions.map((transaction) => transaction.lifecycle === "settled" ? { ...transaction, sourceId: "old-reference", lifecycle: "deferred" as const } : transaction);
    const existing = previousPurchases(previous);
    const old = existing.find((transaction) => transaction.metadata?.lifecycle === "deferred")!;
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "update-transaction", id: old.id, patch: {
      tagIds: [], metadata: { ...old.metadata, lifecycle: "settled", last_seen_at: snapshot.capturedAt, aliases: [identity.digest("transaction", "new-reference")] },
    } }));
    applyPlan(existing, plan.operations);
    snapshot.transactions.find((transaction) => transaction.lifecycle === "settled")!.date = "2026-09-03";
    expect(planTransactions(snapshot, accounts, existing, identity, ids).operations.some((operation) => operation.kind === "create-transaction")).toBe(false);
    expect(existing.find((transaction) => transaction.id === old.id)?.date).toBe("2026-09-04");
  });

  it.each([false, true])("keeps identical purchases distinct and reviews ambiguous changed references: changed=%s", (changed) => {
    const snapshot = snapshotFor([booking("world", -25, "first"), booking("world", -25, "second")]);
    const existing = previousPurchases(snapshot);
    if (changed) {
      for (const source of snapshot.transactions.filter((transaction) => transaction.lifecycle === "settled")) source.sourceId += "-new";
      for (const settlement of snapshot.settlements) settlement.purchaseSourceId += "-new";
    }
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.operations.some((operation) => operation.kind === "create-transaction")).toBe(false);
    const updates = plan.operations.filter((operation) => operation.kind === "update-transaction" && existing.find((transaction) => transaction.id === operation.id)?.metadata?.lifecycle === "deferred");
    expect(updates).toHaveLength(changed ? 0 : 2);
    expect(plan.warnings).toEqual(changed ? ["SETTLED_CARD_REFERENCE_UNRESOLVED", "SETTLED_CARD_REFERENCE_UNRESOLVED"] : []);
  });

  it("retains purchase fields when a known reference has a different settlement-side date", () => {
    const snapshot = snapshotFor([booking("world", -25, "original")]);
    const existing = previousPurchases(snapshot);
    const original = existing.find((transaction) => transaction.metadata?.lifecycle === "deferred")!;
    original.date = "2026-09-05";
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    const update = plan.operations.find((operation) => operation.kind === "update-transaction" && operation.id === original.id);
    expect(update).toMatchObject({ patch: { metadata: { lifecycle: "settled" } } });
    if (update?.kind !== "update-transaction") throw new Error("missing purchase update");
    expect(update.patch).not.toHaveProperty("date");
  });

  it("does not create offsets when the checking booking reference changes", () => {
    const snapshot = snapshotFor([booking("world", -25, "original")]);
    const existing = previousPurchases(snapshot);
    const first = planTransactions(snapshot, accounts, existing, identity, ids);
    applyPlan(existing, first.operations);
    snapshot.settlements[0]!.sourceId = "changed-checking-reference";
    const repeat = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(repeat.warnings).toEqual([]);
    expect(repeat.operations.every((operation) => operation.kind === "update-transaction")).toBe(true);
  });

  it.each(["missing", "ambiguous", "changed-reference-and-date"])("requires review rather than creating a second purchase: %s", (state) => {
    const snapshot = snapshotFor([booking("world", -25, "original")]);
    let existing = previousPurchases(snapshot);
    if (state === "missing") existing = existing.filter((transaction) => transaction.metadata?.lifecycle !== "deferred");
    if (state === "ambiguous") { const original = existing.find((transaction) => transaction.metadata?.lifecycle === "deferred")!; existing.push({ ...original, id: 999 }); }
    if (state === "changed-reference-and-date") {
      const source = snapshot.transactions.find((transaction) => transaction.lifecycle === "settled")!;
      source.sourceId = "changed-purchase-reference"; source.date = "2026-09-03";
      snapshot.settlements[0]!.purchaseSourceId = source.sourceId;
    }
    const before = structuredClone(existing);
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.warnings).toContain("SETTLED_CARD_REFERENCE_UNRESOLVED");
    expect(plan.operations.some((operation) => operation.kind === "create-transaction" || operation.kind.startsWith("delete"))).toBe(false);
    expect(existing).toEqual(before);
  });

  it("settles a refund without another purchase or transfer", () => {
    const snapshot = snapshotFor([booking("gold", 4, "refund")]);
    expect(snapshot.transactions.find((transaction) => transaction.sourceId === "refund")?.amount).toBe("-4");
    const plan = planTransactions(snapshot, accounts, previousPurchases(snapshot), identity, ids);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations.every((operation) => operation.kind === "update-transaction")).toBe(true);
  });

  it("excludes a confirmed purchase still listed in the outgoing deferred cycle from the card balance", () => {
    const snapshot = snapshotFor([booking("world", -25, "original")], [{
      path: "/account-api/v2/accounts/checking/upcoming-transactions?family=CARTE&dateFrom=2026-09-30T00%3A00%3A00.000Z",
      data: [{ idtMetEm: "original", amount: -25, purchaseDate: "2026-09-04", senderContract: "world", __fortuneoDetail: { merchant: { name: "Bookshop" } } }],
    }]);
    expect(snapshot.transactions.filter((transaction) => transaction.sourceId === "original")).toHaveLength(1);
    expect(snapshot.transactions.find((transaction) => transaction.sourceId === "original")?.lifecycle).toBe("settled");
    expect(snapshot.accounts.find((account) => account.sourceId === "world")?.balance).toBe("8");
  });

  it("settles a retained purchase alias without restoring its outgoing-cycle balance", () => {
    const snapshot = snapshotFor([booking("world", -25, "new-ref")]);
    const existing = previousPurchases(snapshot);
    const purchase = existing.find((transaction) => transaction.metadata?.lifecycle === "deferred")!;
    purchase.metadata!.source_identity = identity.digest("transaction", "old-ref");
    purchase.metadata!.aliases = [identity.digest("transaction", "new-ref")];
    snapshot.transactions.push({ sourceId: "old-ref", accountSourceId: "world", date: purchase.date, amount: "25", currency: "eur", merchant: "Bookshop", lifecycle: "deferred" });
    snapshot.accounts.find((account) => account.sourceId === "world")!.balance = "33";
    const resolved = resolveSettledCardReferences(snapshot, accounts, existing, identity);
    expect(resolved.accounts.find((account) => account.sourceId === "world")?.balance).toBe("8");
    const plan = planTransactions(resolved, accounts, existing, identity, ids);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations.some((operation) => operation.kind === "create-transaction")).toBe(false);
    expect(resolveSettledCardReferences(resolved, accounts, existing, identity).accounts).toEqual(resolved.accounts);
    expect(snapshot.accounts.find((account) => account.sourceId === "world")?.balance).toBe("33");
  });

  it("leaves old synthetic credits and checking copies untouched for a separate data repair", () => {
    const snapshot = snapshotFor([booking("world", -25, "original")]);
    const existing = previousPurchases(snapshot);
    const purchase = existing.find((transaction) => transaction.metadata?.lifecycle === "deferred")!;
    const legacy = [
      { ...purchase, id: 800, accountId: 10, metadata: { ...purchase.metadata!, source_identity: identity.digest("transaction", "booking-original"), lifecycle: "settled" as const } },
      { ...purchase, id: 801, amount: "-25", payee: "Fortuneo card payment", metadata: { ...purchase.metadata!, source_identity: "legacy-credit", lifecycle: "settlement" as const } },
    ];
    const before = structuredClone(legacy);
    const plan = planTransactions(snapshot, accounts, [...existing, ...legacy], identity, ids);
    expect(plan.operations.some((operation) => "id" in operation && [800, 801].includes(operation.id))).toBe(false);
    expect(plan.operations.some((operation) => operation.kind === "create-transaction" || operation.kind.startsWith("delete"))).toBe(false);
    expect(legacy).toEqual(before);
  });

  it.each(["amount", "currency"])("reviews a %s mismatch without changing the original purchase", (field) => {
    const snapshot = snapshotFor([booking("world", -25, "original")]);
    const existing = previousPurchases(snapshot);
    const source = snapshot.transactions.find((transaction) => transaction.lifecycle === "settled")!;
    if (field === "amount") source.amount = "26";
    else source.currency = "usd";
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.warnings).toEqual(["SETTLED_CARD_REFERENCE_MISMATCH"]);
    const purchase = existing.find((transaction) => transaction.metadata?.lifecycle === "deferred")!;
    expect(plan.operations.some((operation) => "id" in operation && operation.id === purchase.id)).toBe(false);
  });

  it.each(["card", "transaction", "merchant"])("refuses to import a settled card debit without %s details", (field) => {
    const row = booking("world", -25, "missing");
    delete (row.__fortuneoDetail as Record<string, unknown>)[field];
    expect(() => snapshotFor([row])).toThrow("FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE");
  });
});

const content = readFileSync(new URL("../../packages/extension/src/fortuneo-content.js", import.meta.url), "utf8");
const enrichment = content.slice(content.indexOf("async function enrichTransactionPayload("), content.indexOf("async function fetchDetailApi("));
const helpers = content.slice(content.indexOf("function deferredDetailPath("), content.indexOf("function accountIdFromUrl("));

describe("settled card detail collection", () => {
  it.each(["MERCHANT_MISSING", "FORTUNEO_API_HTTP_429", "FORTUNEO_API_HTTP_404"])("reports %s without treating missing details as a successful collection", async (code) => {
    const fetchDetailApi = code === "MERCHANT_MISSING"
      ? vi.fn().mockResolvedValue({ text: JSON.stringify({ card: { contractId: "world" } }) })
      : vi.fn().mockRejectedValue(new Error(code));
    const result = await runInNewContext(`${enrichment}\n${helpers}\nenrichTransactionPayload({}, payload, settledCardDetailPath, new Map())`, {
      payload: { path: "history", text: JSON.stringify([booking("world", -25, "op")]) }, fetchDetailApi,
      safeCode: (error: Error) => error.message,
      setTimeout: (callback: () => void) => callback(),
    });
    expect(result).toMatchObject({ requested: 1, enriched: 0, failed: 1, errorCodes: [code] });
    expect(JSON.parse(result.payload.text)[0].__fortuneoDetail).toEqual({ error: code });
    expect(fetchDetailApi).toHaveBeenCalledTimes(2);
  });

  it("keeps only the identifiers and purchase fields needed for reconciliation", async () => {
    const fetchDetailApi = vi.fn().mockResolvedValue({ text: JSON.stringify({ ...detail("world", "op"), privateField: "discard", merchant: { name: "Bookshop", merchantId: "discard" } }) });
    const result = await runInNewContext(`${enrichment}\n${helpers}\nenrichTransactionPayload({}, payload, settledCardDetailPath, new Map())`, {
      payload: { path: "history", text: JSON.stringify([booking("world", -25, "op"), { id: "transfer", amount: -10, href: "/payment-request/v1/payment" }]) }, fetchDetailApi,
    });
    const rows = JSON.parse(result.payload.text);
    expect(rows[0].__fortuneoDetail).toEqual(detail("world", "op"));
    expect(rows[1]).not.toHaveProperty("__fortuneoDetail");
    expect(fetchDetailApi).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ requested: 1, enriched: 1, failed: 0 });
  });
});

describe("unavailable settled card details", () => {
  const unresolved = () => snapshotFor([{ ...booking("world", -25, "original"), __fortuneoDetail: { error: "FORTUNEO_API_HTTP_404" } }]);
  const priorPurchase = () => {
    const prior = snapshotFor([booking("world", -25, "original")]);
    prior.settlements = [];
    prior.transactions = prior.transactions.filter((transaction) => transaction.sourceId === "original");
    const create = planTransactions(prior, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (!create || create.kind !== "create-transaction") throw new Error("TEST_PURCHASE_MISSING");
    return asExisting(create.transaction, 100);
  };

  it("resolves the original reference on the correct card without creating another purchase", () => {
    const input = parseSnapshot(unresolved());
    const purchase = priorPurchase();
    const resolved = resolveSettledCardReferences(input, accounts, [purchase], identity);
    expect(input.settlements[0]).toHaveProperty("purchaseSourceId", "original");
    expect(parseSnapshot(resolved).settlements[0]?.cardCredits).toEqual([]);
    expect(resolved.transactions.find((transaction) => transaction.sourceId === "original")).toMatchObject({ date: purchase.date, merchant: purchase.payee, lifecycle: "settled" });
    const plan = planTransactions(resolved, accounts, [purchase], identity, ids);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations.filter((operation) => operation.kind === "create-transaction").map((operation) => operation.sourceId)).toEqual(["new-cycle"]);
  });

  it("accepts a retained source alias", () => {
    const purchase = priorPurchase();
    purchase.metadata!.aliases = [purchase.metadata!.source_identity];
    purchase.metadata!.source_identity = identity.digest("transaction", "renamed");
    expect(resolveSettledCardReferences(parseSnapshot(unresolved()), accounts, [purchase], identity).transactions).toContainEqual(expect.objectContaining({ sourceId: "original", lifecycle: "settled" }));
  });

  it("reviews absent and ambiguous references without changing the booking or guessing its card", () => {
    const purchase = priorPurchase();
    for (const existing of [[], [purchase, { ...purchase, id: 101, accountId: 12 }]]) {
      const resolved = resolveSettledCardReferences(parseSnapshot(unresolved()), accounts, existing, identity);
      const plan = planTransactions(resolved, accounts, existing, identity, ids);
      expect(plan.warnings).toEqual(["SETTLED_CARD_REFERENCE_UNRESOLVED"]);
      expect(plan.operations.some((operation) => "sourceId" in operation && operation.sourceId === "booking-original")).toBe(false);
      expect(plan.operations.some((operation) => operation.kind === "create-transaction" && operation.transaction.metadata.lifecycle === "settlement")).toBe(false);
    }
  });

  it("reconciles identified purchases while leaving an existing unresolved refund unchanged", () => {
    const input = parseSnapshot(snapshotFor([
      booking("world", -25, "original"),
      { ...booking("world", 0.44, "refund"), __fortuneoDetail: { error: "FORTUNEO_API_HTTP_404" } },
    ]));
    const checkingOnly = { ...input, transactions: [{ sourceId: "booking-refund", accountSourceId: "checking", date: "2026-09-30", amount: "-0.44", currency: "eur", merchant: "Refund", lifecycle: "settled" as const }], settlements: [] };
    const create = planTransactions(checkingOnly, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (!create || create.kind !== "create-transaction") throw new Error("TEST_REFUND_MISSING");
    const refund = asExisting(create.transaction, 201);
    const original = structuredClone(refund);
    const resolved = resolveSettledCardReferences(input, accounts, [priorPurchase(), refund], identity);
    const plan = planTransactions(resolved, accounts, [priorPurchase(), refund], identity, ids);
    expect(plan.warnings).toEqual(["SETTLED_CARD_REFERENCE_UNRESOLVED"]);
    expect(plan.operations.filter((operation) => operation.kind === "create-transaction").map((operation) => operation.sourceId)).toEqual(["new-cycle"]);
    expect(plan.operations.some((operation) => "id" in operation && operation.id === refund.id)).toBe(false);
    expect(plan.operations.some((operation) => "sourceId" in operation && operation.sourceId === "booking-refund")).toBe(false);
    expect(refund).toEqual(original);
  });

  it.each([{ amount: "26" }, { currency: "usd" }, { date: "2026-10-01" }])("blocks an inconsistent purchase %j", (patch) => {
    expect(() => resolveSettledCardReferences(parseSnapshot(unresolved()), accounts, [{ ...priorPurchase(), ...patch }], identity)).toThrow("REFERENCE_MISMATCH");
  });

  it("blocks a reference whose card was not identified in the capture", () => {
    const input = parseSnapshot(unresolved());
    input.accounts = input.accounts.filter((account) => account.kind !== "card");
    expect(() => resolveSettledCardReferences(input, accounts, [priorPurchase()], identity)).toThrow("REFERENCE_ACCOUNT_MISSING");
  });

  it("requires a provider reference when Fortuneo returns 404", () => {
    const row = { ...booking("world", -25, "original"), originalOperationId: undefined, __fortuneoDetail: { error: "FORTUNEO_API_HTTP_404" } };
    expect(() => snapshotFor([row])).toThrow("DETAILS_INCOMPLETE_CARD_ID");
  });
});

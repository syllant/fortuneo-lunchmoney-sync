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
const ids = { checkingAccountId: 10, pendingTagId: 20, deferredTagId: 21, paymentTransferCategoryId: 30 };
const accounts = ["checking", "world", "gold"].map((sourceId, index) => ({ id: 10 + index, name: sourceId, type: index ? "credit" : "cash", balance: "0", currency: "eur", externalId: identity.accountExternalId(sourceId), metadata: null }));
const asExisting = (transaction: DesiredTransaction, id: number): ExistingTransaction => ({ ...transaction, id, categoryId: 99, notes: "Keep user note", groupParentId: null });
const detail = (card: string, operation: string) => ({ card: { contractId: card, maskedPan: "************1234" }, merchant: { name: "Bookshop" }, transaction: { transactionId: `${operation}001`, date: "2026-09-04" } });
const booking = (card: string, amount: number, operation: string) => ({ id: `booking-${operation}`, originalOperationId: operation, transactionDate: "2026-09-30", amount: { value: amount, currency: "EUR" }, label: { simplifiedLabel: "CARTE 04/09 BOOKSHOP PARIS" }, description: { transactionCategory: "CARD" }, href: `/card-api/v1/accounts/checking/cards-transactions/${operation}?date=2026-09-04`, __fortuneoDetail: detail(card, operation) });
const snapshotFor = (rows: unknown[]) => adaptFortuneo([
  { path: "/account-api/v2/accounts/checking", data: { id: "checking", balance: 500, productType: "CAV" } },
  { path: "/fto-transaction-api/v1/accounts/checking/transactions?transactionType=CAV%2CPENDING", data: rows },
  { path: "/fto-transaction-api/v1/accounts/checking/transactions?transactionType=CARD", data: [{ id: "new-cycle", transactionDate: "2026-10-01", amount: -8, merchant: { name: "Cafe" }, card: { contractId: "world" } }] },
]);

describe("deferred card cycle rollover", () => {
  it("reuses purchases on both cards and reclassifies already imported checking debits as transfers", () => {
    const snapshot = snapshotFor([booking("world", -25, "purchase-world"), booking("gold", -25, "purchase-gold")]);
    const previous = structuredClone(snapshot);
    previous.settlements = [];
    previous.transactions = snapshot.transactions.filter((transaction) => transaction.accountSourceId !== "checking").map((transaction) => transaction.sourceId === "new-cycle" ? transaction : { ...transaction, lifecycle: "deferred" as const });
    const purchases = planTransactions(previous, accounts, [], identity, ids).operations.filter((operation) => operation.kind === "create-transaction").map((operation, index) => asExisting(operation.transaction, 100 + index));
    const erroneous = planTransactions({ ...snapshot, transactions: snapshot.transactions.filter((transaction) => transaction.accountSourceId === "checking"), settlements: [] }, accounts, [], identity, ids).operations.filter((operation) => operation.kind === "create-transaction").map((operation, index) => asExisting(operation.transaction, 200 + index));
    const existing = [...purchases, ...erroneous];
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.warnings).toEqual([]);
    const creates = plan.operations.filter((operation) => operation.kind === "create-transaction");
    expect(creates).toHaveLength(2);
    expect(creates.every((operation) => operation.transaction.metadata.lifecycle === "settlement" && operation.transaction.amount === "-25")).toBe(true);
    for (const purchase of purchases.filter((transaction) => transaction.metadata?.lifecycle === "deferred")) {
      const update = plan.operations.find((operation) => operation.kind === "update-transaction" && operation.id === purchase.id);
      expect(update).toMatchObject({ patch: { date: "2026-09-04", tagIds: [], metadata: { lifecycle: "settled" } } });
      if (update?.kind !== "update-transaction") throw new Error("missing purchase update");
      expect(update.patch).not.toHaveProperty("categoryId");
      expect(update.patch).not.toHaveProperty("notes");
      expect(update.patch).not.toHaveProperty("payee");
    }
    for (const debit of erroneous) expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "update-transaction", id: debit.id, patch: expect.objectContaining({ categoryId: 30 }) }));
    expect(plan.operations.filter((operation) => operation.kind === "group-settlement")).toHaveLength(2);
    expect(snapshot.accounts.find((account) => account.sourceId === "world")?.balance).toBe("8");
    expect(snapshot.accounts.find((account) => account.sourceId === "gold")?.balance).toBe("0");

    for (const operation of plan.operations) {
      if (operation.kind === "update-transaction") Object.assign(existing.find((transaction) => transaction.id === operation.id)!, operation.patch);
      if (operation.kind === "create-transaction") existing.push(asExisting(operation.transaction, 300 + existing.length));
    }
    expect(planTransactions(snapshot, accounts, existing, identity, ids).operations.some((operation) => operation.kind === "create-transaction")).toBe(false);
    expect(() => parseSnapshot(snapshot)).not.toThrow();
  });

  it("falls back to purchase fingerprints when the provider changes the operation reference", () => {
    const snapshot = snapshotFor([booking("world", -25, "new-reference")]);
    const previous = structuredClone(snapshot);
    previous.settlements = [];
    previous.transactions = snapshot.transactions.filter((transaction) => transaction.accountSourceId === "world" && transaction.lifecycle === "settled").map((transaction) => ({ ...transaction, sourceId: "old-reference", lifecycle: "deferred" as const }));
    const existing = planTransactions(previous, accounts, [], identity, ids).operations.filter((operation) => operation.kind === "create-transaction").map((operation) => asExisting(operation.transaction, 100));
    const plan = planTransactions(snapshot, accounts, existing, identity, ids);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: "update-transaction", id: 100, patch: expect.objectContaining({ metadata: expect.objectContaining({ aliases: [identity.digest("transaction", "old-reference")] }) }) }));
  });

  it("uses purchase identity even if a legacy deferred date was the settlement date", () => {
    const snapshot = snapshotFor([booking("world", -25, "original")]);
    const purchase = snapshot.transactions.find((transaction) => transaction.sourceId === "original")!;
    const previous = { ...snapshot, transactions: [{ ...purchase, date: "2026-09-30", lifecycle: "deferred" as const }], settlements: [] };
    const existing = planTransactions(previous, accounts, [], identity, ids).operations.filter((operation) => operation.kind === "create-transaction").map((operation) => asExisting(operation.transaction, 100));
    expect(planTransactions(snapshot, accounts, existing, identity, ids).operations).toContainEqual(expect.objectContaining({ kind: "update-transaction", id: 100, patch: expect.objectContaining({ date: "2026-09-04" }) }));
  });

  it("handles card refunds with the opposite transfer signs", () => {
    const snapshot = snapshotFor([booking("gold", 4, "refund")]);
    expect(snapshot.settlements[0]).toMatchObject({ checkingDebit: "-4", cardCredits: [{ cardAccountSourceId: "gold", amount: "4" }] });
    expect(snapshot.transactions.find((transaction) => transaction.sourceId === "refund")?.amount).toBe("-4");
    expect(planTransactions(snapshot, accounts, [], identity, ids).warnings).toEqual([]);
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
    expect(parseSnapshot(resolved).settlements[0]?.cardCredits).toEqual([{ cardAccountSourceId: "world", amount: "-25" }]);
    expect(resolved.transactions.find((transaction) => transaction.sourceId === "original")).toMatchObject({ date: purchase.date, merchant: purchase.payee, lifecycle: "settled" });
    const plan = planTransactions(resolved, accounts, [purchase], identity, ids);
    expect(plan.warnings).toEqual([]);
    expect(plan.operations.flatMap((operation) => operation.kind === "create-transaction" && operation.transaction.metadata.lifecycle === "settled" ? [operation.sourceId] : [])).toEqual(["booking-original"]);
    expect(plan.operations.filter((operation) => operation.kind === "group-settlement")).toHaveLength(1);
  });

  it("accepts a retained source alias", () => {
    const purchase = priorPurchase();
    purchase.metadata!.aliases = [purchase.metadata!.source_identity];
    purchase.metadata!.source_identity = identity.digest("transaction", "renamed");
    expect(resolveSettledCardReferences(parseSnapshot(unresolved()), accounts, [purchase], identity).settlements[0]?.cardCredits).toHaveLength(1);
  });

  it("reviews absent and ambiguous references without changing the booking or guessing its card", () => {
    const purchase = priorPurchase();
    for (const existing of [[], [purchase, { ...purchase, id: 101, accountId: 12 }]]) {
      const resolved = resolveSettledCardReferences(parseSnapshot(unresolved()), accounts, existing, identity);
      const plan = planTransactions(resolved, accounts, existing, identity, ids);
      expect(plan.warnings).toEqual(["SETTLED_CARD_REFERENCE_UNRESOLVED"]);
      expect(plan.operations.filter((operation) => operation.kind === "group-settlement")).toHaveLength(0);
      expect(plan.operations.some((operation) => "sourceId" in operation && operation.sourceId === "booking-original")).toBe(false);
      expect(plan.operations.some((operation) => operation.kind === "create-transaction" && operation.transaction.metadata.lifecycle === "settlement")).toBe(false);
    }
  });

  it("reconciles identified purchases while leaving an existing unresolved refund unchanged", () => {
    const input = parseSnapshot(snapshotFor([
      booking("world", -25, "original"),
      { ...booking("world", 0.44, "refund"), __fortuneoDetail: { error: "FORTUNEO_API_HTTP_404" } },
    ]));
    const checkingOnly = { ...input, transactions: input.transactions.filter((transaction) => transaction.sourceId === "booking-refund"), settlements: [] };
    const create = planTransactions(checkingOnly, accounts, [], identity, ids).operations.find((operation) => operation.kind === "create-transaction");
    if (!create || create.kind !== "create-transaction") throw new Error("TEST_REFUND_MISSING");
    const refund = asExisting(create.transaction, 201);
    const original = structuredClone(refund);
    const resolved = resolveSettledCardReferences(input, accounts, [priorPurchase(), refund], identity);
    const plan = planTransactions(resolved, accounts, [priorPurchase(), refund], identity, ids);
    expect(plan.warnings).toEqual(["SETTLED_CARD_REFERENCE_UNRESOLVED"]);
    expect(plan.operations.filter((operation) => operation.kind === "group-settlement").map((operation) => operation.sourceId)).toEqual(["booking-original"]);
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

import { describe, expect, it } from "vitest";
import { IdentityService } from "../../packages/shared/src/identity.js";
import type { ExistingAccount, ExistingTransaction, FortuneoSnapshot, ReconciliationOperation } from "../../packages/shared/src/model.js";
import type { NativeResponse, ResultSummary } from "../../packages/shared/src/messages.js";
import type { KeychainStore } from "../../packages/native-host/src/keychain.js";
import { buildResultDetails, simulateDryRunAccounts, SyncService, unresolvedCardReviewKeys } from "../../packages/native-host/src/sync-service.js";
import { cardAccountName, type LunchMoneyGateway } from "../../packages/native-host/src/lunch-money.js";

describe("dry-run account simulation", () => {
  it("reports completed writes throughout a sync longer than the idle timeout", async () => {
    const identity = new IdentityService(Buffer.alloc(32, 7));
    let elapsed = 0;
    let nextId = 100;
    const progressTimes: number[] = [];
    const service = new SyncService({} as KeychainStore, (message: NativeResponse) => {
      if (message.type === "progress") progressTimes.push(elapsed);
    });
    const gateway = {
      createTransaction: async () => { elapsed += 40_000; return nextId++; },
      updateTransactions: async () => { elapsed += 40_000; },
      groupTransactions: async () => { elapsed += 40_000; return nextId++; },
    } as unknown as LunchMoneyGateway;
    const snapshot: FortuneoSnapshot = { capturedAt: "2026-10-01T00:00:00.000Z", complete: false, accounts: [], transactions: [], settlements: [] };
    const operations: ReconciliationOperation[] = Array.from({ length: 4 }, (_, index) => ({ kind: "create-transaction", sourceId: `tx-${index}`, transaction: {
      accountId: index % 2 ? 11 : 10, date: "2026-09-30", amount: index % 2 ? "-1" : "1", currency: "eur", payee: "Payment", tagIds: [],
      externalId: identity.transactionExternalId(`tx-${index}`), metadata: { schema_version: 2, source_identity: identity.digest("transaction", `tx-${index}`), lifecycle: "settlement", payload_fingerprint: "test", last_seen_at: snapshot.capturedAt, miss_count: 0, aliases: [] },
    } }));
    operations.push({ kind: "group-settlement", sourceId: "payment", date: "2026-09-30", memberSourceIds: ["tx-0", "tx-1"], categoryId: 30 });
    const summary: ResultSummary = { created: 0, updated: 0, deleted: 0, grouped: 0, warnings: [], message: "test", breakdown: {
      accountsCreated: 0, accountsUpdated: 0, transactionsCreated: 0, transactionsUpdated: 0, transactionsDeleted: 0, settlementsGrouped: 0, fortuneoSettled: 0, fortuneoDeferred: 0, fortuneoPending: 0,
    } };
    const writer = service as unknown as { applyTransactions(gateway: LunchMoneyGateway, operations: ReconciliationOperation[], existing: ExistingTransaction[], snapshot: FortuneoSnapshot, identity: IdentityService, summary: ResultSummary, requestId: string): Promise<void> };
    await writer.applyTransactions(gateway, operations, [], snapshot, identity, summary, "test-request");
    expect(elapsed).toBeGreaterThan(60_000);
    expect(summary).toMatchObject({ created: 4, grouped: 1 });
    expect(progressTimes).toHaveLength(6);
    expect(progressTimes.every((time, index) => time - (progressTimes[index - 1] ?? 0) < 60_000)).toBe(true);
  });
  it("makes planned card accounts available to transaction reconciliation without writing them", () => {
    const accounts: ExistingAccount[] = [{ id: 10, name: "Checking", type: "checking", balance: "100", currency: "eur", externalId: null, metadata: null }];
    const metadata = { schema_version: 2 as const, source_identity: "source", lifecycle: "account" as const, payload_fingerprint: "fingerprint", last_seen_at: "2026-08-25T00:00:00.000Z", miss_count: 0, aliases: [] };
    const operations: ReconciliationOperation[] = [{ kind: "create-account", sourceAccount: { sourceId: "card", kind: "card", displayName: "Fortuneo card", currency: "eur", balance: "25", complete: false }, externalId: "lmfa:v2:card", metadata }];

    const simulated = simulateDryRunAccounts(accounts, operations);

    expect(accounts).toHaveLength(1);
    expect(simulated).toContainEqual(expect.objectContaining({ id: -1, type: "credit", externalId: "lmfa:v2:card", metadata }));
  });

  it("applies a planned replacement marker to the simulated account", () => {
    const metadata = { schema_version: 2 as const, source_identity: "new-source", lifecycle: "account" as const, payload_fingerprint: "fingerprint", last_seen_at: "2026-08-25T00:00:00.000Z", miss_count: 0, aliases: ["old-source"] };
    const accounts: ExistingAccount[] = [{ id: 11, name: "Card", type: "credit", balance: "0", currency: "eur", externalId: "old", metadata: null }];
    const operations: ReconciliationOperation[] = [{ kind: "mark-account", accountId: 11, externalId: "lmfa:v2:new", metadata }];

    expect(simulateDryRunAccounts(accounts, operations)[0]).toMatchObject({ externalId: "lmfa:v2:new", metadata });
  });

  it("simulates a Livret A as a cash account", () => {
    const metadata = { schema_version: 2 as const, source_identity: "savings", lifecycle: "account" as const, payload_fingerprint: "fingerprint", last_seen_at: "2026-09-03T10:00:00.000Z", miss_count: 0, aliases: [] };
    const operations: ReconciliationOperation[] = [{ kind: "create-account", sourceAccount: { sourceId: "livret-a", kind: "savings", displayName: "Livret A", currency: "eur", balance: "1000", complete: false }, externalId: "lmfa:v2:savings", metadata }];

    expect(simulateDryRunAccounts([], operations)).toContainEqual(expect.objectContaining({ name: "Livret A", type: "cash", balance: "1000" }));
  });

  it("shows where every detected transaction would be written", () => {
    const identity = new IdentityService(Buffer.alloc(32, 7));
    const cardExternalId = identity.accountExternalId("card-1");
    const accounts: ExistingAccount[] = [
      { id: 10, name: "Lunch Money checking", type: "checking", balance: "100", currency: "eur", externalId: null, metadata: null },
      { id: -1, name: "Fortuneo card •••• 1234", type: "credit", balance: "25", currency: "eur", externalId: cardExternalId, metadata: null },
    ];
    const snapshot: FortuneoSnapshot = {
      capturedAt: "2026-08-25T00:00:00.000Z",
      complete: false,
      accounts: [
        { sourceId: "checking-1", kind: "checking", displayName: "Compte courant", currency: "eur", balance: "100", complete: false },
        { sourceId: "card-1", kind: "card", displayName: "Fortuneo card •••• 1234", currency: "eur", balance: "25", complete: false },
      ],
      transactions: [{ sourceId: "tx-1", accountSourceId: "card-1", date: "2026-08-24", amount: "-25", currency: "eur", merchant: "Restaurant", lifecycle: "deferred" }],
      settlements: [],
    };
    const operations: ReconciliationOperation[] = [{
      kind: "create-transaction",
      sourceId: "tx-1",
      transaction: { accountId: -1, date: "2026-08-24", amount: "-25", currency: "eur", payee: "Restaurant", tagIds: [], externalId: "tx", metadata: { schema_version: 2, source_identity: "tx", lifecycle: "deferred", payload_fingerprint: "fingerprint", last_seen_at: snapshot.capturedAt, miss_count: 0, aliases: [] } },
    }];

    const accountOperations: ReconciliationOperation[] = [{ kind: "create-account", sourceAccount: snapshot.accounts[1]!, externalId: cardExternalId, metadata: { schema_version: 2, source_identity: "card", lifecycle: "account", payload_fingerprint: "card", last_seen_at: snapshot.capturedAt, miss_count: 0, aliases: [] } }];
    const preview = buildResultDetails(snapshot, accounts, accountOperations, operations, identity, 10);

    expect(preview.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ sourceName: "Fortuneo card •••• 1234", targetName: "Fortuneo card •••• 1234", action: "create" })]));
    expect(preview.transactions).toEqual([expect.objectContaining({ action: "create", lifecycle: "deferred", date: "2026-08-24", merchant: "Restaurant", amount: "-25", targetAccount: "Fortuneo card •••• 1234" })]);
  });

  it("marks the affected transaction row when reconciliation needs review", () => {
    const identity = new IdentityService(Buffer.alloc(32, 7));
    const cardExternalId = identity.accountExternalId("card-1");
    const accounts: ExistingAccount[] = [
      { id: 10, name: "Checking", type: "checking", balance: "100", currency: "eur", externalId: null, metadata: null },
      { id: 11, name: "Card", type: "credit", balance: "25", currency: "eur", externalId: cardExternalId, metadata: null },
    ];
    const snapshot: FortuneoSnapshot = { capturedAt: "2026-08-25T00:00:00.000Z", complete: true, accounts: [{ sourceId: "checking-1", kind: "checking", displayName: "Checking", currency: "eur", balance: "100", complete: true }, { sourceId: "card-1", kind: "card", displayName: "Card", currency: "eur", balance: "25", complete: true }], transactions: [{ sourceId: "tx-review", accountSourceId: "card-1", date: "2026-08-24", amount: "-25", currency: "eur", merchant: "Restaurant", lifecycle: "deferred" }], settlements: [] };
    const review: ReconciliationOperation = { kind: "review", code: "AMBIGUOUS_FINGERPRINT", subject: identity.digest("transaction", "tx-review") };

    const preview = buildResultDetails(snapshot, accounts, [], [review], identity, 10);

    expect(preview.transactions[0]).toMatchObject({ action: "skipped", issue: "Multiple Lunch Money matches", merchant: "Restaurant" });
  });

  it("shows review rows before truncating a long preview", () => {
    const identity = new IdentityService(Buffer.alloc(32, 7));
    const snapshot: FortuneoSnapshot = { capturedAt: "2026-10-01T00:00:00.000Z", complete: false,
      accounts: [{ sourceId: "checking", kind: "checking", displayName: "Checking", currency: "eur", balance: "100", complete: false }],
      settlements: [], transactions: Array.from({ length: 150 }, (_, index) => ({ sourceId: `tx-${index}`, accountSourceId: "checking", date: "2026-09-30", amount: "1", currency: "eur", merchant: `Merchant ${index}`, lifecycle: "settled" })) };
    const review: ReconciliationOperation = { kind: "review", code: "SETTLED_CARD_REFERENCE_UNRESOLVED", subject: identity.digest("transaction", "tx-149") };
    const details = buildResultDetails(snapshot, [], [], [review], identity, 10);
    expect(details.transactions).toHaveLength(100);
    expect(details.truncatedTransactions).toBe(50);
    expect(details.transactions[0]).toMatchObject({ action: "skipped", merchant: "Merchant 149", issue: expect.stringContaining("needs review") });
    expect(details.transactions[1]?.merchant).toBe("Merchant 0");
  });
});

describe("Lunch Money card account naming", () => {
  it("provides a readable unique display name without duplicating the mask", () => {
    expect(cardAccountName({ sourceId: "card", kind: "card", displayName: "Gold card", mask: "1234", currency: "eur", balance: "0", complete: false })).toBe("Gold card •••• 1234");
    expect(cardAccountName({ sourceId: "card", kind: "card", displayName: "Fortuneo card •••• 1234", mask: "1234", currency: "eur", balance: "0", complete: false })).toBe("Fortuneo card •••• 1234");
  });
});

describe("card review identities", () => {
  it("covers every review regardless of UI truncation and changes when financial details change", () => {
    const identity = new IdentityService(Buffer.alloc(32, 7));
    const transactions = Array.from({ length: 150 }, (_, index) => ({ sourceId: `booking-${index}`, accountSourceId: "checking", date: "2026-09-30", amount: "-0.44", currency: "EUR", merchant: "refund", lifecycle: "settled" as const }));
    const snapshot: FortuneoSnapshot = { capturedAt: "2026-10-03T00:00:00Z", complete: true, accounts: [], transactions, settlements: [] };
    const operations: ReconciliationOperation[] = transactions.map((source) => ({ kind: "review", code: "SETTLED_CARD_REFERENCE_UNRESOLVED", subject: identity.digest("transaction", source.sourceId) }));
    const keys = unresolvedCardReviewKeys(snapshot, operations, identity);
    expect(keys).toHaveLength(150);
    expect(keys.every((key) => /^[A-Za-z0-9_-]{43}$/.test(key))).toBe(true);
    expect(unresolvedCardReviewKeys({ ...snapshot, capturedAt: "2026-10-04T00:00:00Z" }, operations, identity)).toEqual(keys);
    transactions[0]!.amount = "-0.45";
    expect(unresolvedCardReviewKeys(snapshot, operations, identity)[0]).not.toBe(keys[0]);
    expect(unresolvedCardReviewKeys(snapshot, [], identity)).toEqual([]);
  });
});

import { IdentityService } from "../../shared/src/identity.js";
import type { NativeRequest, NativeResponse, ResultSummary, SyncResultDetails } from "../../shared/src/messages.js";
import type { ExistingAccount, ExistingTransaction, FortuneoSnapshot, ReconciliationOperation } from "../../shared/src/model.js";
import { planAccounts, planTransactions } from "../../shared/src/reconcile.js";
import { resolveSettledCardReferences } from "../../shared/src/settled-cards.js";
import type { KeychainStore } from "./keychain.js";
import { LunchMoneyGateway } from "./lunch-money.js";
import { SyncPhaseError } from "./redaction.js";

type Send = (response: NativeResponse) => void;
type PendingSync = { dryRun: boolean };

export class SyncService {
  private readonly pending = new Map<string, PendingSync>();

  constructor(private readonly keychain: KeychainStore, private readonly send: Send) {}

  async handle(message: NativeRequest): Promise<void> {
    switch (message.type) {
      case "list-accounts":
        await this.listAccounts(message.requestId, message.token);
        return;
      case "configure":
        await this.configure(message.requestId, message.checkingAccountId, message.token, message.fortuneoAccessCode, message.fortuneoPassword);
        return;
      case "get-fortuneo-credentials":
        await this.getFortuneoCredentials(message.requestId);
        return;
      case "get-fortuneo-account-urls":
        this.send({ version: 2, type: "fortuneo-account-urls", requestId: message.requestId, urls: await this.keychain.getFortuneoAccountUrls() });
        return;
      case "remember-fortuneo-account-url":
        await this.keychain.rememberFortuneoAccountUrl(message.url);
        this.sendResult(message.requestId, false, emptySummary("Fortuneo account remembered"));
        return;
      case "reset":
        await this.keychain.clear();
        this.sendResult(message.requestId, false, emptySummary("Configuration removed"));
        return;
      case "sync-if-due":
      case "sync":
      case "dry-run":
        await this.start(message.requestId, message.type === "dry-run");
        return;
      case "snapshot":
        await this.finish(message.requestId, message.snapshot);
        return;
    }
  }

  private async listAccounts(requestId: string, suppliedToken?: string): Promise<void> {
    const token = suppliedToken ?? await this.keychain.getToken();
    if (!token) {
      this.send({ version: 2, type: "auth-required", requestId, provider: "lunch-money" });
      return;
    }
    const [accounts, checkingAccountId] = await Promise.all([
      new LunchMoneyGateway(token).listSelectableAccounts(),
      this.keychain.getCheckingAccountId(),
    ]);
    this.send({ version: 2, type: "accounts", requestId, checkingAccountId, accounts });
  }

  private async configure(requestId: string, checkingAccountId: number, suppliedToken?: string, fortuneoAccessCode?: string, fortuneoPassword?: string): Promise<void> {
    const token = suppliedToken ?? await this.keychain.getToken();
    if (!token) throw new Error("LUNCH_MONEY_TOKEN_REQUIRED");
    const gateway = new LunchMoneyGateway(token);
    await gateway.verify();
    const accounts = await gateway.listSelectableAccounts();
    if (!accounts.some((account) => account.id === checkingAccountId)) throw new Error("CHECKING_ACCOUNT_NOT_FOUND");
    await this.keychain.setToken(token);
    await this.keychain.setCheckingAccountId(checkingAccountId);
    if (fortuneoAccessCode !== undefined && fortuneoPassword !== undefined) await this.keychain.setFortuneoCredentials(fortuneoAccessCode, fortuneoPassword);
    await this.keychain.getOrCreateHmacKey();
    await gateway.ensureManagedIds(checkingAccountId, true);
    this.sendResult(requestId, false, emptySummary("Configuration saved in macOS Keychain"));
  }

  private async getFortuneoCredentials(requestId: string): Promise<void> {
    const credentials = await this.keychain.getFortuneoCredentials();
    this.send(credentials
      ? { version: 2, type: "fortuneo-credentials", requestId, available: true, accessCode: credentials.accessCode, password: credentials.password }
      : { version: 2, type: "fortuneo-credentials", requestId, available: false });
  }

  private async start(requestId: string, dryRun: boolean): Promise<void> {
    const [token, checkingAccountId] = await Promise.all([this.keychain.getToken(), this.keychain.getCheckingAccountId()]);
    if (!token || !checkingAccountId) {
      this.send({ version: 2, type: "auth-required", requestId, provider: "lunch-money" });
      return;
    }
    if (this.pending.size >= 2) throw new Error("TOO_MANY_PENDING_SYNCS");
    this.pending.set(requestId, { dryRun });
    this.send({ version: 2, type: "snapshot", requestId });
  }

  private async finish(requestId: string, snapshot: FortuneoSnapshot): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("UNEXPECTED_SNAPSHOT");
    this.pending.delete(requestId);
    let phase = "loading-configuration";
    try {
      const [token, checkingAccountId, key] = await Promise.all([this.keychain.getToken(), this.keychain.getCheckingAccountId(), this.keychain.getOrCreateHmacKey()]);
      if (!token || !checkingAccountId) throw new Error("NOT_CONFIGURED");
      const gateway = new LunchMoneyGateway(token, undefined, () => this.progress(requestId, "waiting-lunch-money"));
      const identity = new IdentityService(key);
      this.progress(requestId, "reading-lunch-money");
      phase = "reading-accounts";
      let accounts = await gateway.listAccounts();
      phase = "reading-transactions";
      const existing = await gateway.listTransactions(snapshot.capturedAt);
      phase = "resolving-settled-cards";
      snapshot = resolveSettledCardReferences(snapshot, accounts, existing, identity);
      phase = "planning-accounts";
      const accountPlan = planAccounts(snapshot, accounts, identity, checkingAccountId);
      const balanceOps = accountPlan.operations.filter((operation) => operation.kind === "update-account-balance");
      const accountMutations = accountPlan.operations.filter((operation) => operation.kind !== "update-account-balance" && operation.kind !== "review");
      const summary = emptySummary(pending.dryRun ? "Dry run complete" : "Sync complete");
      summary.breakdown.fortuneoSettled = snapshot.transactions.filter((transaction) => transaction.lifecycle === "settled").length;
      summary.breakdown.fortuneoDeferred = snapshot.transactions.filter((transaction) => transaction.lifecycle === "deferred").length;
      summary.breakdown.fortuneoPending = snapshot.transactions.filter((transaction) => transaction.lifecycle === "pending").length;
      summary.warnings.push(...accountPlan.warnings);
      phase = "reading-managed-settings";
      const ids = await gateway.ensureManagedIds(checkingAccountId, false);
      phase = "planning-transactions";
      const previewAccounts = simulateDryRunAccounts(accounts, accountMutations);
      const previewTransactionPlan = planTransactions(snapshot, previewAccounts, existing, identity, ids);
      summary.warnings.push(...previewTransactionPlan.warnings);
      summary.unresolvedCardReviewKeys = unresolvedCardReviewKeys(snapshot, previewTransactionPlan.operations, identity);
      phase = "building-preview";
      const previewDetails = buildResultDetails(snapshot, previewAccounts, accountMutations, previewTransactionPlan.operations, identity, checkingAccountId);

      if (pending.dryRun) {
        summary.created += accountMutations.filter((operation) => operation.kind === "create-account").length;
        summary.updated += accountMutations.filter((operation) => operation.kind === "mark-account").length;
        summary.breakdown.accountsCreated += accountMutations.filter((operation) => operation.kind === "create-account").length;
        summary.breakdown.accountsUpdated += accountMutations.filter((operation) => operation.kind === "mark-account").length;
        countDryRun(previewTransactionPlan.operations, summary);
        summary.details = previewDetails;
      } else {
        this.send({ version: 2, type: "details", requestId, details: previewDetails });
        this.progress(requestId, "reconciling-accounts");
        phase = "writing-accounts";
        for (const operation of accountMutations) {
          await this.applyAccountOperation(gateway, operation, summary);
          this.progress(requestId, "reconciling-accounts");
        }
        if (accountMutations.length > 0) accounts = await gateway.listAccounts();
        phase = "planning-final-transactions";
        const transactionPlan = planTransactions(snapshot, accounts, existing, identity, ids);
        summary.warnings.push(...transactionPlan.warnings);
        this.progress(requestId, "writing-transactions");
        phase = "writing-transactions";
        await this.applyTransactions(gateway, transactionPlan.operations, existing, snapshot, identity, summary, requestId);
        this.progress(requestId, "updating-balances");
        phase = "updating-balances";
        for (const operation of balanceOps) {
          await gateway.updateBalance(operation.accountId, operation.balance, operation.currency, snapshot.capturedAt);
          this.progress(requestId, "updating-balances");
        }
        phase = "building-result";
        summary.details = buildResultDetails(snapshot, accounts, accountMutations, transactionPlan.operations, identity, checkingAccountId);
      }
      summary.warnings = [...new Set(summary.warnings)];
      phase = "sending-result";
      this.sendResult(requestId, pending.dryRun, summary);
    } catch (error) {
      throw new SyncPhaseError(phase, error);
    }
  }

  private async applyAccountOperation(gateway: LunchMoneyGateway, operation: ReconciliationOperation, summary: ResultSummary): Promise<void> {
    if (operation.kind === "create-account") {
      await gateway.createManagedAccount(operation.sourceAccount, operation.externalId, operation.metadata);
      summary.created += 1;
      summary.breakdown.accountsCreated += 1;
    } else if (operation.kind === "mark-account") {
      await gateway.markCheckingAccount(operation.accountId, operation.externalId, operation.metadata);
      summary.updated += 1;
      summary.breakdown.accountsUpdated += 1;
    }
  }

  private async applyTransactions(
    gateway: LunchMoneyGateway,
    operations: readonly ReconciliationOperation[],
    existing: readonly ExistingTransaction[],
    snapshot: FortuneoSnapshot,
    identity: IdentityService,
    summary: ResultSummary,
    requestId: string,
  ): Promise<void> {
    const sourceToId = existingSourceMap(existing, snapshot, identity);
    const updates = operations.filter((operation) => operation.kind === "update-transaction");
    for (const operation of operations) {
      if (operation.kind === "create-transaction") {
        const id = await gateway.createTransaction(operation.transaction);
        sourceToId.set(operation.sourceId, id);
        summary.created += 1;
        summary.breakdown.transactionsCreated += 1;
        this.progress(requestId, "writing-transactions");
      } else if (operation.kind === "delete-cancelled-pending" || operation.kind === "delete-replaced-synthetic") {
        await gateway.deleteTransaction(operation.id);
        summary.deleted += 1;
        summary.breakdown.transactionsDeleted += 1;
        this.progress(requestId, "writing-transactions");
      }
    }
    await gateway.updateTransactions(updates.map((operation) => ({ id: operation.id, patch: operation.patch })));
    this.progress(requestId, "writing-transactions");
    for (const operation of updates) {
      sourceToId.set(operation.sourceId, operation.id);
      summary.updated += 1;
      summary.breakdown.transactionsUpdated += 1;
    }
    for (const operation of operations) {
      if (operation.kind !== "group-settlement") continue;
      const memberIds = operation.memberSourceIds.map((sourceId) => sourceToId.get(sourceId));
      if (memberIds.some((id) => id === undefined)) {
        summary.warnings.push("SETTLEMENT_GROUP_MEMBER_MISSING");
        continue;
      }
      const ids = memberIds as number[];
      const groupParents = ids.map((id) => existing.find((transaction) => transaction.id === id)?.groupParentId).filter((id): id is number => id !== null && id !== undefined);
      if (groupParents.length === ids.length && new Set(groupParents).size === 1) continue;
      await gateway.groupTransactions(ids, operation.date, operation.categoryId);
      summary.grouped += 1;
      summary.breakdown.settlementsGrouped += 1;
      this.progress(requestId, "writing-transactions");
    }
  }

  private progress(requestId: string, phase: string): void {
    this.send({ version: 2, type: "progress", requestId, phase });
  }

  private sendResult(requestId: string, dryRun: boolean, summary: ResultSummary): void {
    this.send({ version: 2, type: "result", requestId, ok: summary.warnings.length === 0, dryRun, summary });
  }
}

export function buildResultDetails(
  snapshot: FortuneoSnapshot,
  accounts: readonly ExistingAccount[],
  accountOperations: readonly ReconciliationOperation[],
  transactionOperations: readonly ReconciliationOperation[],
  identity: IdentityService,
  checkingAccountId: number,
): SyncResultDetails {
  const sourceTargets = new Map<string, ExistingAccount>();
  const checkingSource = snapshot.accounts.find((account) => account.kind === "checking");
  const checkingTarget = accounts.find((account) => account.id === checkingAccountId);
  if (checkingSource && checkingTarget) sourceTargets.set(checkingSource.sourceId, checkingTarget);
  for (const source of snapshot.accounts.filter((account) => account.kind !== "checking")) {
    const externalId = identity.accountExternalId(source.sourceId);
    const target = accounts.find((account) => account.externalId === externalId || account.metadata?.source_identity === externalId.slice("lmfa:v2:".length));
    if (target) sourceTargets.set(source.sourceId, target);
  }

  const accountPreview = snapshot.accounts.map((source) => {
    const target = sourceTargets.get(source.sourceId);
    const isCreated = accountOperations.some((operation) => operation.kind === "create-account" && operation.sourceAccount.sourceId === source.sourceId);
    const isConnected = source.kind === "checking" && accountOperations.some((operation) => operation.kind === "mark-account" && operation.accountId === checkingAccountId);
    return {
      sourceName: source.displayName,
      targetName: target?.name ?? "No Lunch Money account mapping",
      action: target ? (isCreated ? "create" as const : isConnected ? "connect" as const : "existing" as const) : "review" as const,
      balance: source.balance,
      currency: source.currency,
    };
  });

  const operationBySource = new Map<string, ReconciliationOperation>();
  for (const operation of transactionOperations) {
    if ((operation.kind === "create-transaction" || operation.kind === "update-transaction") && !operationBySource.has(operation.sourceId)) operationBySource.set(operation.sourceId, operation);
  }
  const limit = 100;
  const reviewSubjects = new Set(transactionOperations.filter((operation) => operation.kind === "review").map((operation) => operation.subject));
  const previewSources = snapshot.transactions.map((source) => ({ source, needsReview: reviewSubjects.has(identity.digest("transaction", source.sourceId)) }))
    .sort((left, right) => Number(right.needsReview) - Number(left.needsReview));
  const transactionPreview = previewSources.slice(0, limit).map(({ source }) => {
    const operation = operationBySource.get(source.sourceId);
    const sourceIdentity = identity.digest("transaction", source.sourceId);
    const review = transactionOperations.find((candidate): candidate is Extract<ReconciliationOperation, { kind: "review" }> => candidate.kind === "review" && candidate.subject === sourceIdentity);
    const action = operation?.kind === "create-transaction" ? "create" as const : operation?.kind === "update-transaction" ? "update" as const : review || !sourceTargets.has(source.accountSourceId) ? "skipped" as const : "unchanged" as const;
    return {
      action,
      ...(review ? { issue: reviewIssue(review.code) } : (!sourceTargets.has(source.accountSourceId) ? { issue: "No Lunch Money account mapping" } : {})),
      lifecycle: source.lifecycle,
      date: source.date,
      merchant: source.merchant,
      ...(operation && "categorySource" in operation && operation.categorySource === "history" ? { category: "Reused from history" } : {}),
      amount: source.amount,
      currency: source.currency,
      targetAccount: sourceTargets.get(source.accountSourceId)?.name ?? "No account mapping",
    };
  });
  return { accounts: accountPreview, transactions: transactionPreview, truncatedTransactions: Math.max(0, snapshot.transactions.length - limit) };
}

function reviewIssue(code: string): string {
  return ({ AMBIGUOUS_FINGERPRINT: "Multiple Lunch Money matches", ACCOUNT_MAPPING_MISSING: "No Lunch Money account mapping", SETTLED_CARD_REFERENCE_UNRESOLVED: "Card detail unavailable; no unique original purchase. This booking is unchanged and needs review." } as Record<string, string>)[code] ?? "Could not reconcile safely";
}

export function simulateDryRunAccounts(accounts: readonly ExistingAccount[], operations: readonly ReconciliationOperation[]): ExistingAccount[] {
  const simulated = accounts.map((account) => ({ ...account }));
  let nextId = -1;
  for (const operation of operations) {
    if (operation.kind === "mark-account") {
      const index = simulated.findIndex((account) => account.id === operation.accountId);
      if (index >= 0) simulated[index] = { ...simulated[index]!, externalId: operation.externalId, metadata: operation.metadata };
    } else if (operation.kind === "create-account") {
      simulated.push({
        id: nextId--,
        name: operation.sourceAccount.displayName,
        type: operation.sourceAccount.kind === "card" ? "credit" : "cash",
        balance: operation.sourceAccount.balance,
        currency: operation.sourceAccount.currency,
        externalId: operation.externalId,
        metadata: operation.metadata,
      });
    }
  }
  return simulated;
}

function existingSourceMap(existing: readonly ExistingTransaction[], snapshot: FortuneoSnapshot, identity: IdentityService): Map<string, number> {
  const map = new Map<string, number>();
  const sourceIds = [
    ...snapshot.transactions.map((transaction) => transaction.sourceId),
    ...snapshot.settlements.flatMap((settlement) => [settlement.sourceId, ...settlement.cardCredits.map((credit) => `${settlement.sourceId}\0${credit.cardAccountSourceId}`)]),
  ];
  for (const sourceId of sourceIds) {
    const sourceIdentity = identity.digest("transaction", sourceId);
    const found = existing.find((transaction) => transaction.metadata?.source_identity === sourceIdentity || transaction.metadata?.aliases.includes(sourceIdentity));
    if (found) map.set(sourceId, found.id);
  }
  return map;
}

function countDryRun(operations: readonly ReconciliationOperation[], summary: ResultSummary): void {
  for (const operation of operations) {
    if (operation.kind === "create-transaction") {
      summary.created += 1;
      summary.breakdown.transactionsCreated += 1;
    } else if (operation.kind === "create-account") {
      summary.created += 1;
      summary.breakdown.accountsCreated += 1;
    } else if (operation.kind === "update-transaction") {
      summary.updated += 1;
      summary.breakdown.transactionsUpdated += 1;
    } else if (operation.kind === "mark-account" || operation.kind === "update-account-balance") {
      summary.updated += 1;
      summary.breakdown.accountsUpdated += 1;
    } else if (operation.kind === "delete-cancelled-pending" || operation.kind === "delete-replaced-synthetic") {
      summary.deleted += 1;
      summary.breakdown.transactionsDeleted += 1;
    } else if (operation.kind === "group-settlement") {
      summary.grouped += 1;
      summary.breakdown.settlementsGrouped += 1;
    }
  }
}

function emptySummary(message: string): ResultSummary {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    grouped: 0,
    warnings: [],
    message,
    breakdown: {
      accountsCreated: 0,
      accountsUpdated: 0,
      transactionsCreated: 0,
      transactionsUpdated: 0,
      transactionsDeleted: 0,
      settlementsGrouped: 0,
      fortuneoSettled: 0,
      fortuneoDeferred: 0,
      fortuneoPending: 0,
    },
  };
}

// Only opaque keyed digests leave the helper; no financial review data is persisted.
export function unresolvedCardReviewKeys(snapshot: FortuneoSnapshot, operations: ReconciliationOperation[], identity: IdentityService): string[] {
  const subjects = new Set(operations.filter((operation): operation is Extract<ReconciliationOperation, { kind: "review" }> => operation.kind === "review" && operation.code === "SETTLED_CARD_REFERENCE_UNRESOLVED").map((operation) => operation.subject));
  return snapshot.transactions.filter((source) => subjects.has(identity.digest("transaction", source.sourceId)))
    .map((source) => identity.digest("card-review", source.sourceId, source.accountSourceId, source.date, source.amount, source.currency, source.merchant));
}

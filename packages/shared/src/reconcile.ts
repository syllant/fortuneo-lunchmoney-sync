import type { IdentityService } from "./identity.js";
import { negateMoney, parseMinor } from "./money.js";
import type {
  DesiredTransaction,
  ExistingAccount,
  ExistingTransaction,
  FortuneoAccountSnapshot,
  FortuneoSnapshot,
  FortuneoTransactionSnapshot,
  IntegrationMetadata,
  ManagedIds,
  ReconciliationOperation,
  ReconciliationPlan,
} from "./model.js";

export function planAccounts(
  snapshot: FortuneoSnapshot,
  accounts: readonly ExistingAccount[],
  identity: IdentityService,
  checkingAccountId: number,
): ReconciliationPlan {
  const operations: ReconciliationOperation[] = [];
  const warnings: string[] = [];
  const checking = accounts.find((account) => account.id === checkingAccountId);
  if (!checking) return reviewOnly("CHECKING_ACCOUNT_NOT_FOUND", String(checkingAccountId));

  for (const source of snapshot.accounts) {
    const externalId = identity.accountExternalId(source.sourceId);
    const sourceIdentity = externalId.slice("lmfa:v2:".length);
    if (source.kind === "checking") {
      if (checking.externalId !== externalId || checking.metadata?.source_identity !== sourceIdentity) {
        operations.push({ kind: "mark-account", accountId: checking.id, externalId, metadata: metadata(sourceIdentity, "account", accountFingerprint(source, identity), snapshot.capturedAt) });
      }
      operations.push({ kind: "update-account-balance", accountId: checking.id, balance: source.balance, currency: source.currency });
      continue;
    }
    let existing = accounts.find((account) => account.externalId === externalId || account.metadata?.aliases.includes(sourceIdentity));
    if (!existing && source.kind === "card") {
      const fingerprint = accountFingerprint(source, identity);
      const candidates = accounts.filter((account) => account.type === "credit" && account.metadata?.payload_fingerprint === fingerprint);
      if (candidates.length > 1) {
        addReview(operations, warnings, "AMBIGUOUS_CARD_REPLACEMENT", sourceIdentity);
        continue;
      }
      existing = candidates[0];
      if (existing?.metadata) {
        const aliases = unique([...existing.metadata.aliases, existing.metadata.source_identity]);
        operations.push({ kind: "mark-account", accountId: existing.id, externalId, metadata: metadata(sourceIdentity, "account", fingerprint, snapshot.capturedAt, 0, aliases) });
      }
    }
    if (!existing) {
      operations.push({ kind: "create-account", sourceAccount: source, externalId, metadata: metadata(sourceIdentity, "account", accountFingerprint(source, identity), snapshot.capturedAt) });
    } else {
      operations.push({ kind: "update-account-balance", accountId: existing.id, balance: source.balance, currency: source.currency });
    }
  }
  return { operations, warnings };
}

export function planTransactions(
  snapshot: FortuneoSnapshot,
  accounts: readonly ExistingAccount[],
  transactions: readonly ExistingTransaction[],
  identity: IdentityService,
  ids: ManagedIds,
): ReconciliationPlan {
  const operations: ReconciliationOperation[] = [];
  const warnings: string[] = [];
  const sourceAccountToBudget = new Map<string, number>();
  const checkingSource = snapshot.accounts.find((account) => account.kind === "checking");
  if (checkingSource) sourceAccountToBudget.set(checkingSource.sourceId, ids.checkingAccountId);
  for (const source of snapshot.accounts.filter((account) => account.kind !== "checking")) {
    const externalId = identity.accountExternalId(source.sourceId);
    const match = accounts.find((account) => account.externalId === externalId || account.metadata?.source_identity === externalId.slice("lmfa:v2:".length));
    if (match) sourceAccountToBudget.set(source.sourceId, match.id);
  }

  const managed = transactions.filter((transaction) => transaction.metadata?.schema_version === 2);
  const legacyChecking = transactions.filter((transaction) => transaction.accountId === ids.checkingAccountId && transaction.externalId?.startsWith("lmft:v1:") === true);
  const matchedIds = new Set<number>();
  const sourceIdToTransactionId = new Map<string, number>();
  const unresolvedCardBookings = new Set(snapshot.settlements.filter((settlement) => settlement.purchaseSourceId).map((settlement) => `${settlement.checkingAccountSourceId}\0${settlement.sourceId}`));

  for (let sourceIndex = 0; sourceIndex < snapshot.transactions.length; sourceIndex += 1) {
    const source = snapshot.transactions[sourceIndex]!;
    if (unresolvedCardBookings.has(`${source.accountSourceId}\0${source.sourceId}`)) {
      addReview(operations, warnings, "SETTLED_CARD_REFERENCE_UNRESOLVED", identity.digest("transaction", source.sourceId));
      continue;
    }
    const accountId = sourceAccountToBudget.get(source.accountSourceId);
    if (!accountId) {
      addReview(operations, warnings, "ACCOUNT_MAPPING_MISSING", source.accountSourceId);
      continue;
    }
    const sourceIdentity = identity.digest("transaction", source.sourceId);
    const fingerprint = transactionFingerprint(source, identity);
    let match = managed.find((candidate) => !matchedIds.has(candidate.id) && candidate.accountId === accountId
      && (candidate.metadata?.source_identity === sourceIdentity || candidate.metadata?.aliases.includes(sourceIdentity)));
    if (!match && accountId === ids.checkingAccountId) {
      const legacyCandidates = legacyChecking.filter((candidate) => !matchedIds.has(candidate.id) && candidate.date === source.date && candidate.amount === source.amount && normalizeMerchant(candidate.payee) === normalizeMerchant(source.merchant));
      if (legacyCandidates.length > 1) {
        addReview(operations, warnings, "AMBIGUOUS_V1_MIGRATION", sourceIdentity);
        continue;
      }
      match = legacyCandidates[0];
    }
    if (!match) {
      const candidates = managed.filter((candidate) => !matchedIds.has(candidate.id) && candidate.accountId === accountId && candidate.metadata?.payload_fingerprint === fingerprint);
      if (candidates.length > 1) {
        match = lifecycleCandidate(candidates, source.lifecycle)
          ?? groupedFingerprintCandidate(snapshot.transactions, sourceIndex, sourceAccountToBudget, managed, matchedIds, candidates, source, accountId, fingerprint, identity);
        if (!match) {
          addReview(operations, warnings, "AMBIGUOUS_FINGERPRINT", sourceIdentity);
          continue;
        }
      } else {
        match = candidates[0];
      }
    }
    const tagIds = lifecycleTags(source.lifecycle, match?.tagIds ?? [], ids);
    const externalId = identity.transactionExternalId(source.sourceId);
    const aliases = match?.metadata && match.metadata.source_identity !== sourceIdentity
      ? unique([...match.metadata.aliases, match.metadata.source_identity])
      : (match?.metadata?.aliases ?? []);
    const nextMetadata = metadata(sourceIdentity, source.lifecycle, fingerprint, snapshot.capturedAt, 0, aliases);
    const historicalCategoryId = match?.categoryId == null
      ? inferHistoricalCategory(source.merchant, accountId, transactions)
      : undefined;
    if (!match) {
      operations.push({
        kind: "create-transaction",
        sourceId: source.sourceId,
        transaction: {
          accountId,
          date: source.date,
          amount: source.amount,
          currency: source.currency,
          payee: source.merchant,
          ...(historicalCategoryId === undefined ? {} : { categoryId: historicalCategoryId }),
          tagIds,
          externalId,
          metadata: nextMetadata,
        },
        ...(historicalCategoryId === undefined ? {} : { categorySource: "history" as const }),
      });
    } else {
      matchedIds.add(match.id);
      sourceIdToTransactionId.set(source.sourceId, match.id);
      if (match.groupParentId !== null) continue;
      const patch: Partial<DesiredTransaction> = { date: source.date, amount: source.amount, currency: source.currency, tagIds, externalId, metadata: nextMetadata };
      if (source.lifecycle === "pending" || source.lifecycle === "deferred") patch.payee = source.merchant;
      if (historicalCategoryId !== undefined) patch.categoryId = historicalCategoryId;
      operations.push({
        kind: "update-transaction",
        id: match.id,
        patch,
        sourceId: source.sourceId,
        ...(historicalCategoryId === undefined ? {} : { categorySource: "history" as const }),
      });
    }
  }

  for (const existing of managed) {
    if (matchedIds.has(existing.id) || existing.metadata?.lifecycle !== "pending") continue;
    const accountWasComplete = accountCompletenessFor(existing.accountId, snapshot, sourceAccountToBudget);
    if (!snapshot.complete || !accountWasComplete) continue;
    const misses = existing.metadata.miss_count + 1;
    if (misses >= 2) {
      operations.push({ kind: "delete-cancelled-pending", id: existing.id, sourceIdentity: existing.metadata.source_identity });
    } else {
      operations.push({ kind: "update-transaction", id: existing.id, sourceId: existing.metadata.source_identity, patch: { metadata: { ...existing.metadata, miss_count: misses, last_seen_at: snapshot.capturedAt } } });
    }
  }

  planSettlements(snapshot, sourceAccountToBudget, transactions, sourceIdToTransactionId, identity, ids, operations, warnings);
  planSyntheticDeletion(snapshot, transactions, operations, warnings);
  return { operations, warnings };
}

function groupedFingerprintCandidate(
  sources: readonly FortuneoTransactionSnapshot[],
  sourceIndex: number,
  accountMap: ReadonlyMap<string, number>,
  managed: readonly ExistingTransaction[],
  matchedIds: ReadonlySet<number>,
  candidates: readonly ExistingTransaction[],
  source: FortuneoTransactionSnapshot,
  accountId: number,
  fingerprint: string,
  identity: IdentityService,
): ExistingTransaction | undefined {
  const peers = sources.slice(sourceIndex).filter((peer) => {
    if (peer.lifecycle !== source.lifecycle || accountMap.get(peer.accountSourceId) !== accountId || transactionFingerprint(peer, identity) !== fingerprint) return false;
    const peerIdentity = identity.digest("transaction", peer.sourceId);
    return !managed.some((candidate) => !matchedIds.has(candidate.id) && (candidate.metadata?.source_identity === peerIdentity || candidate.metadata?.aliases.includes(peerIdentity)));
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  for (const candidateLifecycle of lifecycleOrder(source.lifecycle)) {
    const sameStage = candidates.filter((candidate) => candidate.metadata?.lifecycle === candidateLifecycle).sort((left, right) => left.id - right.id);
    if (sameStage.length === 0) continue;
    if (sameStage.length !== peers.length || peers.length < 2) return undefined;
    const index = peers.findIndex((peer) => peer.sourceId === source.sourceId);
    return index >= 0 ? sameStage[index] : undefined;
  }
  return undefined;
}

function lifecycleCandidate(candidates: readonly ExistingTransaction[], lifecycle: FortuneoTransactionSnapshot["lifecycle"]): ExistingTransaction | undefined {
  for (const candidateLifecycle of lifecycleOrder(lifecycle)) {
    const matches = candidates.filter((candidate) => candidate.metadata?.lifecycle === candidateLifecycle);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

function lifecycleOrder(lifecycle: FortuneoTransactionSnapshot["lifecycle"]): readonly IntegrationMetadata["lifecycle"][] {
  return ({ pending: ["pending"], deferred: ["deferred", "pending"], settled: ["settled", "deferred", "pending"] } as const)[lifecycle];
}

function planSyntheticDeletion(
  snapshot: FortuneoSnapshot,
  existing: readonly ExistingTransaction[],
  operations: ReconciliationOperation[],
  warnings: string[],
): void {
  const synthetic = existing.filter((transaction) => transaction.payee.trim().toLocaleLowerCase("en") === "fortuneo deferred cards");
  if (synthetic.length === 0) return;
  if (synthetic.length > 1) {
    addReview(operations, warnings, "AMBIGUOUS_SYNTHETIC_DEFERRED", "multiple");
    return;
  }
  const deferred = snapshot.transactions.filter((transaction) => transaction.lifecycle === "deferred");
  if (!snapshot.complete || deferred.length === 0) return;
  const replacementTotal = deferred.reduce((sum, transaction) => sum + parseMinor(transaction.amount), 0n);
  if (replacementTotal !== parseMinor(synthetic[0]!.amount)) {
    addReview(operations, warnings, "SYNTHETIC_DEFERRED_TOTAL_MISMATCH", String(synthetic[0]!.id));
    return;
  }
  const unresolved = operations.some((operation) => operation.kind === "review" && ["AMBIGUOUS_FINGERPRINT", "ACCOUNT_MAPPING_MISSING"].includes(operation.code));
  if (!unresolved) operations.push({ kind: "delete-replaced-synthetic", id: synthetic[0]!.id });
}

function planSettlements(
  snapshot: FortuneoSnapshot,
  accountMap: ReadonlyMap<string, number>,
  existing: readonly ExistingTransaction[],
  sourceIdToTransactionId: ReadonlyMap<string, number>,
  identity: IdentityService,
  ids: ManagedIds,
  operations: ReconciliationOperation[],
  warnings: string[],
): void {
  for (const settlement of snapshot.settlements) {
    if (settlement.purchaseSourceId) continue;
    const checkingAmount = parseMinor(settlement.checkingDebit);
    const creditTotal = settlement.cardCredits.reduce((sum, credit) => sum + parseMinor(credit.amount), 0n);
    const exact = checkingAmount + creditTotal === 0n;
    const checkingSourceId = settlement.sourceId;
    const checkingExistingId = sourceIdToTransactionId.get(checkingSourceId);
    if (!exact) {
      categorizeCheckingSide(operations, checkingExistingId, checkingSourceId, ids.paymentTransferCategoryId);
      addReview(operations, warnings, "SETTLEMENT_TOTAL_MISMATCH", identity.digest("settlement", settlement.sourceId));
      continue;
    }
    const memberSourceIds = [checkingSourceId];
    for (const credit of settlement.cardCredits) {
      const accountId = accountMap.get(credit.cardAccountSourceId);
      if (!accountId) {
        addReview(operations, warnings, "SETTLEMENT_CARD_MAPPING_MISSING", credit.cardAccountSourceId);
        continue;
      }
      const creditSourceId = `${settlement.sourceId}\0${credit.cardAccountSourceId}`;
      memberSourceIds.push(creditSourceId);
      const sourceIdentity = identity.digest("transaction", creditSourceId);
      const externalId = `lmft:v2:${sourceIdentity}`;
      const old = existing.find((candidate) => candidate.externalId === externalId);
      if (!old) {
        operations.push({
          kind: "create-transaction",
          sourceId: creditSourceId,
          transaction: {
            accountId,
            date: settlement.date,
            amount: credit.amount,
            currency: settlement.currency,
            payee: "Fortuneo card payment",
            categoryId: ids.paymentTransferCategoryId,
            tagIds: [],
            externalId,
            metadata: metadata(sourceIdentity, "settlement", identity.digest("payload", settlement.date, credit.amount, credit.cardAccountSourceId), snapshot.capturedAt),
          },
        });
      }
    }
    categorizeCheckingSide(operations, checkingExistingId, checkingSourceId, ids.paymentTransferCategoryId);
    operations.push({ kind: "group-settlement", sourceId: settlement.sourceId, date: settlement.date, memberSourceIds, categoryId: ids.paymentTransferCategoryId });
  }
}

function categorizeCheckingSide(operations: ReconciliationOperation[], existingId: number | undefined, sourceId: string, categoryId: number): void {
  if (existingId !== undefined) {
    const update = operations.find((operation) => operation.kind === "update-transaction" && operation.id === existingId);
    if (update?.kind === "update-transaction") {
      update.patch.categoryId = categoryId;
      delete update.categorySource;
      return;
    }
    operations.push({ kind: "update-transaction", id: existingId, sourceId, patch: { categoryId } });
    return;
  }
  const create = operations.find((operation) => operation.kind === "create-transaction" && operation.sourceId === sourceId);
  if (create?.kind === "create-transaction") {
    create.transaction.categoryId = categoryId;
    delete create.categorySource;
  }
}

function inferHistoricalCategory(merchant: string, accountId: number, existing: readonly ExistingTransaction[]): number | undefined {
  const normalizedMerchant = normalizeMerchant(merchant);
  const matches = existing.filter((transaction) =>
    transaction.groupParentId === null
    && transaction.categoryId !== null
    && normalizeMerchant(transaction.payee) === normalizedMerchant,
  );
  const sameAccount = matches.filter((transaction) => transaction.accountId === accountId);
  const candidates = sameAccount.length > 0 ? sameAccount : matches;
  const categoryIds = unique(candidates.map((transaction) => transaction.categoryId).filter((categoryId): categoryId is number => categoryId !== null));
  return categoryIds.length === 1 ? categoryIds[0] : undefined;
}

function lifecycleTags(lifecycle: FortuneoTransactionSnapshot["lifecycle"], existing: readonly number[], ids: ManagedIds): number[] {
  const unrelated = existing.filter((id) => id !== ids.pendingTagId && id !== ids.deferredTagId);
  if (lifecycle === "pending") return unique([...unrelated, ids.pendingTagId]);
  if (lifecycle === "deferred") return unique([...unrelated, ids.deferredTagId]);
  return unrelated;
}

function transactionFingerprint(source: FortuneoTransactionSnapshot, identity: IdentityService): string {
  return identity.digest("payload", source.accountSourceId, source.date, source.amount, normalizeMerchant(source.merchant));
}

function accountFingerprint(source: FortuneoAccountSnapshot, identity: IdentityService): string {
  return identity.digest("account-payload", source.kind, source.currency, normalizeMerchant(source.displayName));
}

function normalizeMerchant(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("fr-FR").replace(/\s+/g, " ").trim();
}

function metadata(
  sourceIdentity: string,
  lifecycle: IntegrationMetadata["lifecycle"],
  fingerprint: string,
  lastSeenAt: string,
  missCount = 0,
  aliases: string[] = [],
): IntegrationMetadata {
  return { schema_version: 2, source_identity: sourceIdentity, lifecycle, payload_fingerprint: fingerprint, last_seen_at: lastSeenAt, miss_count: missCount, aliases };
}

function unique(values: readonly number[]): number[];
function unique(values: readonly string[]): string[];
function unique(values: readonly (number | string)[]): (number | string)[] {
  return [...new Set(values)];
}

function accountCompletenessFor(accountId: number, snapshot: FortuneoSnapshot, mapping: ReadonlyMap<string, number>): boolean {
  const sourceId = [...mapping].find(([, id]) => id === accountId)?.[0];
  return snapshot.accounts.find((account) => account.sourceId === sourceId)?.complete === true;
}

function addReview(operations: ReconciliationOperation[], warnings: string[], code: string, subject: string): void {
  operations.push({ kind: "review", code, subject });
  warnings.push(code);
}

function reviewOnly(code: string, subject: string): ReconciliationPlan {
  return { operations: [{ kind: "review", code, subject }], warnings: [code] };
}

export function settlementBalances(checkingDebit: string): string {
  return negateMoney(checkingDebit);
}

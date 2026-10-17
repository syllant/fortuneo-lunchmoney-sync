import type { IdentityService } from "./identity.js";
import { parseMinor } from "./money.js";
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
  const checkingBookings = new Map(snapshot.settlements.map((settlement) => [`${settlement.checkingAccountSourceId}\0${settlement.sourceId}`, settlement]));
  const purchaseReferences = new Set(snapshot.settlements.flatMap((settlement) => settlement.purchaseSourceId ? [settlement.purchaseSourceId] : []));
  // Older extension snapshots identify the affected card through cardCredits.
  // Accept them as confirmations too, without creating their former offsets.
  const legacyCards = new Set(snapshot.settlements.flatMap((settlement) => settlement.cardCredits.map((credit) => credit.cardAccountSourceId)));
  const isConfirmation = (source: FortuneoTransactionSnapshot): boolean => source.lifecycle === "settled"
    && snapshot.accounts.some((account) => account.sourceId === source.accountSourceId && account.kind === "card")
    && (purchaseReferences.has(source.sourceId) || legacyCards.has(source.accountSourceId));
  const confirmedIds = new Set<number>();
  for (const source of snapshot.transactions.filter(isConfirmation)) {
    const accountId = sourceAccountToBudget.get(source.accountSourceId);
    if (!accountId) {
      addReview(operations, warnings, "ACCOUNT_MAPPING_MISSING", identity.digest("transaction", source.sourceId));
      continue;
    }
    const sourceIdentity = identity.digest("transaction", source.sourceId);
    const candidates = managed.filter((candidate) => candidate.accountId === accountId && ["pending", "deferred", "settled"].includes(candidate.metadata!.lifecycle)
      && (candidate.metadata?.source_identity === sourceIdentity || candidate.metadata?.aliases.includes(sourceIdentity)));
    const matches = candidates.length > 0 ? candidates : managed.filter((candidate) => candidate.accountId === accountId
      && ["pending", "deferred", "settled"].includes(candidate.metadata!.lifecycle)
      && candidate.metadata?.payload_fingerprint === transactionFingerprint(source, identity));
    if (matches.length !== 1) {
      addReview(operations, warnings, "SETTLED_CARD_REFERENCE_UNRESOLVED", sourceIdentity);
      continue;
    }
    const match = matches[0]!;
    matchedIds.add(match.id);
    if (parseMinor(match.amount) !== parseMinor(source.amount) || match.currency !== source.currency) {
      addReview(operations, warnings, "SETTLED_CARD_REFERENCE_MISMATCH", sourceIdentity);
      continue;
    }
    confirmedIds.add(match.id);
    if (match.groupParentId !== null) {
      addReview(operations, warnings, "SETTLED_CARD_PURCHASE_GROUPED", sourceIdentity);
      continue;
    }
    const previousConfirmation = operations.find((operation) => operation.kind === "update-transaction" && operation.id === match.id);
    if (previousConfirmation?.kind === "update-transaction" && previousConfirmation.patch.metadata) {
      const aliases = previousConfirmation.patch.metadata.aliases;
      previousConfirmation.patch.metadata.aliases = unique([...aliases, ...(match.metadata!.source_identity === sourceIdentity ? [] : [sourceIdentity])]);
      continue;
    }
    operations.push({ kind: "update-transaction", id: match.id, sourceId: source.sourceId, patch: {
      tagIds: lifecycleTags("settled", match.tagIds, ids),
      metadata: { ...match.metadata!, lifecycle: "settled", last_seen_at: snapshot.capturedAt, miss_count: 0,
        aliases: unique([...match.metadata!.aliases, ...(match.metadata!.source_identity === sourceIdentity ? [] : [sourceIdentity])]) },
    } });
  }

  for (let sourceIndex = 0; sourceIndex < snapshot.transactions.length; sourceIndex += 1) {
    const source = snapshot.transactions[sourceIndex]!;
    const booking = checkingBookings.get(`${source.accountSourceId}\0${source.sourceId}`);
    if (booking) {
      if (!booking.purchaseSourceId || !snapshot.transactions.some((candidate) => candidate.sourceId === booking.purchaseSourceId && isConfirmation(candidate))) {
        addReview(operations, warnings, "SETTLED_CARD_REFERENCE_UNRESOLVED", identity.digest("transaction", source.sourceId));
      }
      continue;
    }
    if (isConfirmation(source)) continue;
    const accountId = sourceAccountToBudget.get(source.accountSourceId);
    if (!accountId) {
      addReview(operations, warnings, "ACCOUNT_MAPPING_MISSING", source.accountSourceId);
      continue;
    }
    const sourceIdentity = identity.digest("transaction", source.sourceId);
    const fingerprint = transactionFingerprint(source, identity);
    if (managed.some((candidate) => confirmedIds.has(candidate.id) && candidate.accountId === accountId
      && (candidate.metadata?.source_identity === sourceIdentity || candidate.metadata?.aliases.includes(sourceIdentity)))) continue;
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

export function transactionFingerprint(source: FortuneoTransactionSnapshot, identity: IdentityService): string {
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

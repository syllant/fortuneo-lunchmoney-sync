import type { IdentityService } from "./identity.js";
import type { ExistingAccount, ExistingTransaction, FortuneoSnapshot } from "./model.js";
import { formatMinor, parseMinor } from "./money.js";
import { transactionFingerprint } from "./reconcile.js";

// Fortuneo may retain a booking after its card-detail endpoint stops serving it.
// Its original operation reference still identifies the previously imported purchase.
export function resolveSettledCardReferences(
  snapshot: FortuneoSnapshot,
  accounts: readonly ExistingAccount[],
  existing: readonly ExistingTransaction[],
  identity: IdentityService,
): FortuneoSnapshot {
  const transactions = snapshot.transactions.map((transaction) => ({ ...transaction }));
  const settledAmounts = new Map<string, bigint>();
  const settlements = snapshot.settlements.map((settlement) => {
    if (!settlement.purchaseSourceId) return settlement;
    const reference = settlement.purchaseSourceId;
    const digest = identity.digest("transaction", reference);
    let matches = existing.filter((transaction) => transaction.metadata?.schema_version === 2
      && ["pending", "deferred", "settled"].includes(transaction.metadata.lifecycle)
      && (transaction.metadata.source_identity === digest || transaction.metadata.aliases.includes(digest))
      && accounts.some((account) => account.id === transaction.accountId && account.type === "credit"));
    const captured = transactions.find((transaction) => transaction.sourceId === reference && transaction.lifecycle === "settled"
      && snapshot.accounts.some((account) => account.sourceId === transaction.accountSourceId && account.kind === "card"));
    if (matches.length === 0 && captured) {
      const card = accounts.find((account) => account.externalId === identity.accountExternalId(captured.accountSourceId)
        || account.metadata?.source_identity === identity.digest("account", captured.accountSourceId));
      matches = existing.filter((transaction) => transaction.accountId === card?.id
        && transaction.metadata && ["pending", "deferred", "settled"].includes(transaction.metadata.lifecycle)
        && transaction.metadata.payload_fingerprint === transactionFingerprint(captured, identity));
    }
    if (matches.length !== 1) return settlement;
    const purchase = matches[0]!;
    if (parseMinor(purchase.amount) !== parseMinor(settlement.checkingDebit)
      || purchase.currency !== settlement.currency || purchase.date > settlement.date) {
      throw new Error("FORTUNEO_SETTLED_CARD_REFERENCE_MISMATCH");
    }
    const cardSources = snapshot.accounts.filter((source) => source.kind === "card"
      && accounts.some((account) => account.id === purchase.accountId
        && (account.externalId === identity.accountExternalId(source.sourceId)
          || account.metadata?.source_identity === identity.digest("account", source.sourceId)
          || account.metadata?.aliases.includes(identity.digest("account", source.sourceId)))));
    if (cardSources.length !== 1) throw new Error("FORTUNEO_SETTLED_CARD_REFERENCE_ACCOUNT_MISSING");
    const cardId = cardSources[0]!.sourceId;
    const references = new Set([digest, purchase.metadata!.source_identity, ...purchase.metadata!.aliases]);
    const sameReference = transactions.filter((transaction) => transaction.accountSourceId === cardId && references.has(identity.digest("transaction", transaction.sourceId)));
    if (sameReference.some((transaction) => parseMinor(transaction.amount) !== parseMinor(purchase.amount) || transaction.currency !== purchase.currency)) {
      throw new Error("FORTUNEO_SETTLED_CARD_REFERENCE_MISMATCH");
    }
    if (!transactions.some((transaction) => transaction.sourceId === reference && transaction.accountSourceId === cardId)) transactions.push({ sourceId: reference, accountSourceId: cardId,
      date: purchase.date, amount: purchase.amount, currency: purchase.currency,
      merchant: purchase.payee, lifecycle: "settled" });
    for (const transaction of sameReference) {
      if (transaction.lifecycle !== "settled") {
        settledAmounts.set(cardId, (settledAmounts.get(cardId) ?? 0n) + parseMinor(transaction.amount));
        transaction.lifecycle = "settled";
      }
    }
    return settlement;
  });
  const confirmedBookings = new Set(settlements.filter((settlement) => settlement.purchaseSourceId
    && transactions.some((transaction) => transaction.sourceId === settlement.purchaseSourceId && transaction.lifecycle === "settled"
      && snapshot.accounts.some((account) => account.sourceId === transaction.accountSourceId && account.kind === "card")))
    .map((settlement) => `${settlement.checkingAccountSourceId}\0${settlement.sourceId}`));
  return { ...snapshot, accounts: snapshot.accounts.map((account) => !settledAmounts.has(account.sourceId) ? account : {
    ...account, balance: formatMinor(parseMinor(account.balance) - settledAmounts.get(account.sourceId)!),
  }), transactions: transactions.filter((transaction) => !confirmedBookings.has(`${transaction.accountSourceId}\0${transaction.sourceId}`)), settlements };
}

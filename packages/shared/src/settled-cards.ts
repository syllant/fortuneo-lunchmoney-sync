import type { IdentityService } from "./identity.js";
import type { ExistingAccount, ExistingTransaction, FortuneoSnapshot } from "./model.js";
import { negateMoney, parseMinor } from "./money.js";

// Fortuneo may retain a booking after its card-detail endpoint stops serving it.
// Its original operation reference still identifies the previously imported purchase.
export function resolveSettledCardReferences(
  snapshot: FortuneoSnapshot,
  accounts: readonly ExistingAccount[],
  existing: readonly ExistingTransaction[],
  identity: IdentityService,
): FortuneoSnapshot {
  const transactions = snapshot.transactions.map((transaction) => ({ ...transaction }));
  const settlements = snapshot.settlements.map((settlement) => {
    if (!settlement.purchaseSourceId) return settlement;
    const reference = settlement.purchaseSourceId;
    const digest = identity.digest("transaction", reference);
    const matches = existing.filter((transaction) => transaction.metadata?.schema_version === 2
      && ["pending", "deferred", "settled"].includes(transaction.metadata.lifecycle)
      && (transaction.metadata.source_identity === digest || transaction.metadata.aliases.includes(digest))
      && accounts.some((account) => account.id === transaction.accountId && account.type === "credit"));
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
    const sameReference = transactions.filter((transaction) => transaction.sourceId === reference && transaction.accountSourceId === cardId);
    if (sameReference.some((transaction) => parseMinor(transaction.amount) !== parseMinor(purchase.amount) || transaction.currency !== purchase.currency)) {
      throw new Error("FORTUNEO_SETTLED_CARD_REFERENCE_MISMATCH");
    }
    if (sameReference.length === 0) transactions.push({ sourceId: reference, accountSourceId: cardId,
      date: purchase.date, amount: purchase.amount, currency: purchase.currency,
      merchant: purchase.payee, lifecycle: "settled" });
    else for (const transaction of sameReference) transaction.lifecycle = "settled";
    const resolved = { ...settlement };
    delete resolved.purchaseSourceId;
    return { ...resolved, cardCredits: [{ cardAccountSourceId: cardId, amount: negateMoney(settlement.checkingDebit) }] };
  });
  return { ...snapshot, transactions, settlements };
}

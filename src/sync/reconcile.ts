import { toLunchMoneyAmount } from "../domain/money";
import type { DateRange, NormalizedTransaction } from "../domain/transaction";
import type { BudgetSink, DesiredTransaction } from "../providers/contracts";
import type { SyncCounts } from "../storage/sync-run-repository";
import type { SyncIndexRecord } from "../storage/sync-index-repository";
import { transactionExternalId, transactionPayloadHmac } from "./identity";

type ReconcileInput = Readonly<{
  transactions: readonly NormalizedTransaction[];
  identificationHash: string;
  lunchMoneyAccountId: number;
  range: DateRange;
  hmacKey: string;
  dryRun: boolean;
  now: string;
}>;

type Prepared = Readonly<{ desired: DesiredTransaction; payloadHmac: string }>;

function reconciliationRange(range: DateRange, transactions: readonly NormalizedTransaction[]): DateRange {
  return transactions.reduce((output, transaction) => ({
    from: transaction.date < output.from ? transaction.date : output.from,
    to: transaction.date > output.to ? transaction.date : output.to,
  }), range);
}

export async function reconcileTransactions(
  input: ReconcileInput,
  sink: BudgetSink,
  index: {
    find(externalIdHmac: string): Promise<SyncIndexRecord | null>;
    save(record: SyncIndexRecord, now: string): Promise<void>;
    touch(externalIdHmac: string, now: string): Promise<void>;
  },
): Promise<SyncCounts> {
  const remote = await sink.listTransactions(input.lunchMoneyAccountId, reconciliationRange(input.range, input.transactions));
  const remoteByExternalId = new Map(remote.map((transaction) => [transaction.externalId, transaction]));
  const creates: Prepared[] = [];
  const updates: (Prepared & { id: number })[] = [];
  let skipped = 0;

  for (const transaction of input.transactions) {
    const externalId = await transactionExternalId(input.hmacKey, input.identificationHash, transaction.sourceId);
    const alternateExternalIds = await Promise.all(transaction.alternateSourceIds.map((sourceId) =>
      transactionExternalId(input.hmacKey, input.identificationHash, sourceId)));
    const candidateExternalIds = [externalId, ...alternateExternalIds];
    const payloadHmac = await transactionPayloadHmac(input.hmacKey, transaction);
    const desired: DesiredTransaction = {
      externalId,
      accountId: input.lunchMoneyAccountId,
      date: transaction.date,
      amount: toLunchMoneyAmount(transaction.money, transaction.direction),
      currency: transaction.money.currency,
      payee: transaction.payee,
      notes: transaction.notes,
    };
    const indexedCandidates = await Promise.all(candidateExternalIds.map((candidate) => index.find(candidate)));
    const indexed = indexedCandidates.find((candidate) => candidate !== null) ?? null;
    const existing = candidateExternalIds.map((candidate) => remoteByExternalId.get(candidate)).find((candidate) => candidate !== undefined);
    const matchedIds = new Set([
      ...indexedCandidates.filter((candidate): candidate is SyncIndexRecord => candidate !== null).map((candidate) => candidate.lunchMoneyTransactionId),
      ...candidateExternalIds.map((candidate) => remoteByExternalId.get(candidate)?.id).filter((id): id is number => id !== undefined),
    ]);
    if (matchedIds.size > 1) throw new Error("TRANSACTION_IDENTITY_CONFLICT");
    if (indexed?.externalIdHmac === externalId && indexed.payloadHmac === payloadHmac) {
      skipped += 1;
      if (!input.dryRun) await index.touch(externalId, input.now);
      continue;
    }
    if (indexed || existing) {
      updates.push({ desired, payloadHmac, id: indexed?.lunchMoneyTransactionId ?? existing!.id });
    } else {
      creates.push({ desired, payloadHmac });
    }
  }

  if (input.dryRun) {
    return { fetched: input.transactions.length, created: creates.length, updated: updates.length, skipped };
  }

  if (updates.length > 0) {
    await sink.updateTransactions(updates.map(({ desired, id }) => ({ ...desired, id })));
    for (const update of updates) {
      await index.save({ externalIdHmac: update.desired.externalId, lunchMoneyTransactionId: update.id, payloadHmac: update.payloadHmac }, input.now);
    }
  }

  const result = await sink.createTransactions(creates.map((item) => item.desired));
  const createdOrDuplicate = [...result.created, ...result.duplicates];
  const byExternalId = new Map(createdOrDuplicate.map((transaction) => [transaction.externalId, transaction]));
  for (const create of creates) {
    const transaction = byExternalId.get(create.desired.externalId);
    if (!transaction) throw new Error("LUNCH_MONEY_CREATE_RESULT_MISSING");
    await index.save({
      externalIdHmac: create.desired.externalId,
      lunchMoneyTransactionId: transaction.id,
      payloadHmac: create.payloadHmac,
    }, input.now);
  }
  return { fetched: input.transactions.length, created: result.created.length, updated: updates.length, skipped: skipped + result.duplicates.length };
}

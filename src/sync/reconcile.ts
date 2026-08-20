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

export async function reconcileTransactions(
  input: ReconcileInput,
  sink: BudgetSink,
  index: {
    find(externalIdHmac: string): Promise<SyncIndexRecord | null>;
    save(record: SyncIndexRecord, now: string): Promise<void>;
    touch(externalIdHmac: string, now: string): Promise<void>;
  },
): Promise<SyncCounts> {
  const remote = await sink.listTransactions(input.lunchMoneyAccountId, input.range);
  const remoteByExternalId = new Map(remote.map((transaction) => [transaction.externalId, transaction]));
  const creates: Prepared[] = [];
  const updates: (Prepared & { id: number })[] = [];
  let skipped = 0;

  for (const transaction of input.transactions) {
    const externalId = await transactionExternalId(input.hmacKey, input.identificationHash, transaction.sourceId);
    const payloadHmac = await transactionPayloadHmac(input.hmacKey, transaction);
    const desired: DesiredTransaction = {
      externalId,
      accountId: input.lunchMoneyAccountId,
      date: transaction.bookedDate,
      amount: toLunchMoneyAmount(transaction.money, transaction.direction),
      currency: transaction.money.currency,
      payee: transaction.payee,
      notes: transaction.notes,
    };
    const indexed = await index.find(externalId);
    if (indexed?.payloadHmac === payloadHmac) {
      skipped += 1;
      if (!input.dryRun) await index.touch(externalId, input.now);
      continue;
    }
    const existing = remoteByExternalId.get(externalId);
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

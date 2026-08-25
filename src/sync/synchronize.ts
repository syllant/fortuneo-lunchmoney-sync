import type { BankAccount, NormalizedAccount } from "../domain/account";
import { DomainError, errorCode } from "../domain/errors";
import type { DateRange, NormalizedTransaction, TransactionPageDiagnostics } from "../domain/transaction";
import type { BankSource, BudgetSink } from "../providers/contracts";
import { accountExternalId } from "./identity";
import { AccountRepository } from "../storage/account-repository";
import { ConnectionRepository } from "../storage/connection-repository";
import { SyncIndexRepository } from "../storage/sync-index-repository";
import { SyncLockRepository } from "../storage/sync-lock-repository";
import { SyncRunRepository, type SyncCounts } from "../storage/sync-run-repository";
import { reconcileTransactions } from "./reconcile";
import { deferredBalanceTransaction } from "./deferred-balance";

export type SynchronizeOptions = Readonly<{ dryRun: boolean; range: DateRange; runId?: string }>;

type TransactionStatus = "BOOK" | "PDNG" | "HOLD";
export type SourceDiagnostics = Readonly<Record<TransactionStatus, TransactionPageDiagnostics>>;
export type SynchronizeResult = SyncCounts & Readonly<{ sourceDiagnostics: SourceDiagnostics }>;

const ZERO_DIAGNOSTICS: TransactionPageDiagnostics = {
  received: 0,
  accepted: 0,
  ignoredWithoutStableId: 0,
  ignoredWithoutDate: 0,
};

function addDiagnostics(left: TransactionPageDiagnostics, right: TransactionPageDiagnostics): TransactionPageDiagnostics {
  return {
    received: left.received + right.received,
    accepted: left.accepted + right.accepted,
    ignoredWithoutStableId: left.ignoredWithoutStableId + right.ignoredWithoutStableId,
    ignoredWithoutDate: left.ignoredWithoutDate + right.ignoredWithoutDate,
  };
}

function emptyResult(): SynchronizeResult {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    sourceDiagnostics: { BOOK: ZERO_DIAGNOSTICS, PDNG: ZERO_DIAGNOSTICS, HOLD: ZERO_DIAGNOSTICS },
  };
}

function add(left: SynchronizeResult, right: SynchronizeResult): SynchronizeResult {
  return {
    fetched: left.fetched + right.fetched,
    created: left.created + right.created,
    updated: left.updated + right.updated,
    skipped: left.skipped + right.skipped,
    sourceDiagnostics: {
      BOOK: addDiagnostics(left.sourceDiagnostics.BOOK, right.sourceDiagnostics.BOOK),
      PDNG: addDiagnostics(left.sourceDiagnostics.PDNG, right.sourceDiagnostics.PDNG),
      HOLD: addDiagnostics(left.sourceDiagnostics.HOLD, right.sourceDiagnostics.HOLD),
    },
  };
}

function chooseBalance(balances: Awaited<ReturnType<BankSource["getBalances"]>>) {
  return balances.find((balance) => balance.status === "CLAV") ?? balances[0];
}

function preferTransaction(left: NormalizedTransaction, right: NormalizedTransaction): NormalizedTransaction {
  if (left.status === right.status) return left;
  return left.status === "booked" ? left : right;
}

function mergeTransactions(transactions: readonly NormalizedTransaction[]): readonly NormalizedTransaction[] {
  const bySourceId = new Map<string, NormalizedTransaction>();
  for (const transaction of transactions) {
    const current = bySourceId.get(transaction.sourceId);
    bySourceId.set(transaction.sourceId, current ? preferTransaction(current, transaction) : transaction);
  }
  return [...bySourceId.values()];
}

export class Synchronizer {
  private readonly connections: ConnectionRepository;
  private readonly accounts: AccountRepository;
  private readonly index: SyncIndexRepository;
  private readonly runs: SyncRunRepository;
  private readonly locks: SyncLockRepository;

  constructor(
    db: D1Database,
    private readonly source: BankSource,
    private readonly sink: BudgetSink,
    private readonly hmacKey: string,
  ) {
    this.connections = new ConnectionRepository(db);
    this.accounts = new AccountRepository(db);
    this.index = new SyncIndexRepository(db);
    this.runs = new SyncRunRepository(db);
    this.locks = new SyncLockRepository(db);
  }

  async synchronize(options: SynchronizeOptions): Promise<SynchronizeResult> {
    const runId = options.runId ?? crypto.randomUUID();
    const started = new Date();
    if (!(await this.locks.acquire(runId, started))) throw new DomainError("SYNC_ALREADY_RUNNING");
    await this.runs.start(runId, started.toISOString());
    const connection = await this.connections.latest();
    if (!connection || connection.status === "revoked") {
      await this.locks.release(runId);
      throw new DomainError("CONNECTION_NOT_AUTHORIZED");
    }
    if (Date.parse(connection.validUntil) <= started.getTime()) {
      await this.connections.markError(connection.id, "CONSENT_EXPIRED", true);
      await this.runs.fail(runId, new Date().toISOString(), "CONSENT_EXPIRED");
      await this.locks.release(runId);
      throw new DomainError("CONSENT_EXPIRED");
    }

    try {
      const bankAccounts = await this.source.listAccounts(connection.sessionId);
      let total = emptyResult();
      for (const bankAccount of bankAccounts) {
        total = add(total, await this.synchronizeAccount(connection.id, bankAccount, options));
      }
      const completed = new Date().toISOString();
      await this.runs.complete(runId, completed, total, options.dryRun);
      if (!options.dryRun) await this.connections.markSuccess(connection.id, completed);
      return total;
    } catch (error) {
      const code = errorCode(error);
      await this.runs.fail(runId, new Date().toISOString(), code);
      await this.connections.markError(connection.id, code, code === "CONSENT_EXPIRED");
      throw error;
    } finally {
      await this.locks.release(runId);
    }
  }

  private async synchronizeAccount(connectionId: string, bankAccount: BankAccount, options: SynchronizeOptions): Promise<SynchronizeResult> {
    const now = new Date().toISOString();
    const stored = await this.accounts.upsert(connectionId, bankAccount, now);
    const balances = await this.source.getBalances(bankAccount);
    const balance = chooseBalance(balances);
    if (!balance) throw new DomainError("BANK_BALANCE_MISSING");
    let lunchMoneyAccountId = stored.lunchMoneyAccountId;
    if (!lunchMoneyAccountId && !options.dryRun) {
      const externalId = await accountExternalId(this.hmacKey, bankAccount.identificationHash);
      const normalized: NormalizedAccount = {
        identificationHash: bankAccount.identificationHash,
        displayName: `Fortuneo ${externalId.slice(-8)}`,
        type: "cash",
        balance: balance.money,
      };
      const account = await this.sink.upsertAccount(normalized, externalId);
      lunchMoneyAccountId = account.id;
      await this.accounts.linkLunchMoney(stored.id, account.id, now);
    }

    const fetched = await this.fetchAll(bankAccount, options.range);
    const virtualDeferredBalance = deferredBalanceTransaction(balances, bankAccount.currency, now.slice(0, 10));
    const transactions = virtualDeferredBalance ? [...fetched.transactions, virtualDeferredBalance] : fetched.transactions;
    if (!lunchMoneyAccountId) {
      return { fetched: transactions.length, created: transactions.length, updated: 0, skipped: 0, sourceDiagnostics: fetched.sourceDiagnostics };
    }
    const counts = await reconcileTransactions({
      transactions,
      identificationHash: bankAccount.identificationHash,
      lunchMoneyAccountId,
      range: options.range,
      hmacKey: this.hmacKey,
      dryRun: options.dryRun,
      now,
    }, this.sink, this.index);
    if (!options.dryRun) await this.sink.updateBalance(lunchMoneyAccountId, balance.money);
    return { ...counts, sourceDiagnostics: fetched.sourceDiagnostics };
  }

  private async fetchAll(account: BankAccount, range: DateRange): Promise<Readonly<{
    transactions: readonly NormalizedTransaction[];
    sourceDiagnostics: SourceDiagnostics;
  }>> {
    const pages = await Promise.all([
      this.fetchAllForStatus(account, "BOOK", range),
      this.fetchAllForStatus(account, "PDNG"),
      this.fetchAllForStatus(account, "HOLD"),
    ]);
    return {
      transactions: mergeTransactions(pages.flatMap((page) => page.transactions)),
      sourceDiagnostics: { BOOK: pages[0].diagnostics, PDNG: pages[1].diagnostics, HOLD: pages[2].diagnostics },
    };
  }

  private async fetchAllForStatus(
    account: BankAccount,
    status: "BOOK" | "PDNG" | "HOLD",
    range?: DateRange,
  ): Promise<Readonly<{ transactions: readonly NormalizedTransaction[]; diagnostics: TransactionPageDiagnostics }>> {
    const output: NormalizedTransaction[] = [];
    let diagnostics = ZERO_DIAGNOSTICS;
    let continuation: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.source.getTransactions(account, status, range, continuation);
      output.push(...page.transactions);
      diagnostics = addDiagnostics(diagnostics, page.diagnostics ?? {
        received: page.transactions.length,
        accepted: page.transactions.length,
        ignoredWithoutStableId: 0,
        ignoredWithoutDate: 0,
      });
      if (!page.continuationKey) return { transactions: output, diagnostics };
      continuation = page.continuationKey;
    }
    throw new DomainError("ENABLE_BANKING_PAGINATION_LIMIT");
  }
}

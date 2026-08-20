import type { BankAccount, Balance, NormalizedAccount } from "../domain/account";
import type { DateRange, TransactionPage } from "../domain/transaction";

export type BankSession = Readonly<{
  sessionId: string;
  validUntil: string;
  accounts: readonly BankAccount[];
}>;

export interface BankSource {
  getSession(sessionId: string): Promise<BankSession>;
  listAccounts(sessionId: string): Promise<readonly BankAccount[]>;
  getBalances(account: BankAccount): Promise<readonly Balance[]>;
  getBookedTransactions(account: BankAccount, range: DateRange, continuationKey?: string): Promise<TransactionPage>;
}

export type BudgetAccount = Readonly<{ id: number; externalId: string | null }>;
export type BudgetTransaction = Readonly<{ id: number; externalId: string; manualAccountId: number }>;
export type DesiredTransaction = Readonly<{
  externalId: string;
  accountId: number;
  date: string;
  amount: string;
  currency: string;
  payee: string;
  notes: string | null;
}>;

export type CreateResult = Readonly<{
  created: readonly BudgetTransaction[];
  duplicates: readonly BudgetTransaction[];
}>;

export interface BudgetSink {
  listAccounts(): Promise<readonly BudgetAccount[]>;
  upsertAccount(account: NormalizedAccount, externalId: string): Promise<BudgetAccount>;
  listTransactions(accountId: number, range: DateRange): Promise<readonly BudgetTransaction[]>;
  createTransactions(transactions: readonly DesiredTransaction[]): Promise<CreateResult>;
  updateTransactions(transactions: readonly (DesiredTransaction & { id: number })[]): Promise<void>;
  updateBalance(accountId: number, balance: NormalizedAccount["balance"]): Promise<void>;
}

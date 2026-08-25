import { DomainError } from "../domain/errors";
import type { TransactionPageDiagnostics, TransactionStatusCounts } from "../domain/transaction";
import type { BankSource } from "../providers/contracts";
import { balanceLabelCategory } from "./deferred-balance";

export type SourceProbeResult = Readonly<{
  mode: "source_probe";
  accountCount: number;
  accountTypes: Readonly<Record<string, number>>;
  balanceTypes: Readonly<Record<string, number>>;
  balanceLabelCategories: Readonly<Record<string, number>>;
  transactions: TransactionPageDiagnostics;
}>;

const ZERO_STATUS_COUNTS: TransactionStatusCounts = {
  BOOK: 0, PDNG: 0, HOLD: 0, OTHR: 0, SCHD: 0, CNCL: 0, RJCT: 0, UNKNOWN: 0,
};

function increment(output: Record<string, number>, rawKey: string | undefined): void {
  const key = rawKey && /^[A-Z0-9_]{1,16}$/u.test(rawKey) ? rawKey : "UNKNOWN";
  output[key] = (output[key] ?? 0) + 1;
}

function addStatusCounts(left: TransactionStatusCounts, right?: TransactionStatusCounts): TransactionStatusCounts {
  return {
    BOOK: left.BOOK + (right?.BOOK ?? 0),
    PDNG: left.PDNG + (right?.PDNG ?? 0),
    HOLD: left.HOLD + (right?.HOLD ?? 0),
    OTHR: left.OTHR + (right?.OTHR ?? 0),
    SCHD: left.SCHD + (right?.SCHD ?? 0),
    CNCL: left.CNCL + (right?.CNCL ?? 0),
    RJCT: left.RJCT + (right?.RJCT ?? 0),
    UNKNOWN: left.UNKNOWN + (right?.UNKNOWN ?? 0),
  };
}

export async function probeBankSource(source: BankSource, sessionId: string): Promise<SourceProbeResult> {
  const accounts = await source.listAccounts(sessionId);
  const accountTypes: Record<string, number> = {};
  const balanceTypes: Record<string, number> = {};
  const balanceLabelCategories: Record<string, number> = {};
  let received = 0;
  let accepted = 0;
  let ignoredWithoutStableId = 0;
  let ignoredWithoutDate = 0;
  let statusCounts = ZERO_STATUS_COUNTS;

  for (const account of accounts) {
    const details = await source.getAccountDetails(account);
    increment(accountTypes, details.cashAccountType);
    const balances = await source.getBalances(account);
    for (const balance of balances) {
      increment(balanceTypes, balance.status);
      if (balance.name) increment(balanceLabelCategories, balanceLabelCategory(balance.name));
    }

    let continuation: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await source.getTransactions(account, undefined, undefined, continuation);
      const diagnostics = page.diagnostics;
      received += diagnostics?.received ?? page.transactions.length;
      accepted += diagnostics?.accepted ?? page.transactions.length;
      ignoredWithoutStableId += diagnostics?.ignoredWithoutStableId ?? 0;
      ignoredWithoutDate += diagnostics?.ignoredWithoutDate ?? 0;
      statusCounts = addStatusCounts(statusCounts, diagnostics?.statusCounts);
      if (!page.continuationKey) break;
      continuation = page.continuationKey;
      if (pageNumber === 99) throw new DomainError("ENABLE_BANKING_PAGINATION_LIMIT");
    }
  }

  return {
    mode: "source_probe",
    accountCount: accounts.length,
    accountTypes,
    balanceTypes,
    balanceLabelCategories,
    transactions: { received, accepted, ignoredWithoutStableId, ignoredWithoutDate, statusCounts },
  };
}

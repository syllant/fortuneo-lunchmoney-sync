import type { NormalizedAccount } from "../../domain/account";
import { DomainError } from "../../domain/errors";
import { formatMoney } from "../../domain/money";
import type { DateRange } from "../../domain/transaction";
import type { BudgetAccount, BudgetSink, BudgetTransaction, CreateResult, DesiredTransaction } from "../contracts";
import { readBoundedJsonObject } from "../json-response";
import { isObject, objectArray, optionalString, requiredString, type JsonObject } from "../enable-banking/schemas";

function requiredNumber(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DomainError(`LUNCH_MONEY_INVALID_${key.toUpperCase()}`);
  return value;
}

function mapAccount(raw: JsonObject): BudgetAccount {
  return { id: requiredNumber(raw, "id"), externalId: optionalString(raw, "external_id") ?? null };
}

function mapTransaction(raw: JsonObject): BudgetTransaction | null {
  const externalId = optionalString(raw, "external_id");
  const accountId = raw.manual_account_id;
  if (!externalId || typeof accountId !== "number") return null;
  return { id: requiredNumber(raw, "id"), externalId, manualAccountId: accountId };
}

export class LunchMoneyClient implements BudgetSink {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<JsonObject> {
    if (init.method === "DELETE") throw new DomainError("LUNCH_MONEY_DELETE_FORBIDDEN");
    const fetcher = this.fetcher;
    const response = await fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new DomainError("LUNCH_MONEY_AUTH_ERROR");
      if (response.status === 429 || response.status >= 500) throw new DomainError("LUNCH_MONEY_TEMPORARY_ERROR");
      throw new DomainError(`LUNCH_MONEY_HTTP_${response.status}`);
    }
    return readBoundedJsonObject(response, "LUNCH_MONEY_RESPONSE_TOO_LARGE", "LUNCH_MONEY_INVALID_RESPONSE");
  }

  async listAccounts(): Promise<readonly BudgetAccount[]> {
    return objectArray(await this.request("/manual_accounts"), "manual_accounts").map(mapAccount);
  }

  async upsertAccount(account: NormalizedAccount, externalId: string): Promise<BudgetAccount> {
    const existing = (await this.listAccounts()).find((candidate) => candidate.externalId === externalId);
    if (existing) return existing;
    const raw = await this.request("/manual_accounts", {
      method: "POST",
      body: JSON.stringify({
        name: account.displayName,
        institution_name: "Fortuneo",
        type: account.type,
        balance: formatMoney(account.balance),
        currency: account.balance.currency.toLowerCase(),
        balance_as_of: new Date().toISOString(),
        external_id: externalId,
        status: "active",
      }),
    });
    return mapAccount(raw);
  }

  async listTransactions(accountId: number, range: DateRange): Promise<readonly BudgetTransaction[]> {
    const output: BudgetTransaction[] = [];
    let offset = 0;
    for (;;) {
      const query = new URLSearchParams({
        manual_account_id: accountId.toString(), start_date: range.from, end_date: range.to,
        include_pending: "false", limit: "500", offset: offset.toString(),
      });
      const payload = await this.request(`/transactions?${query}`);
      output.push(...objectArray(payload, "transactions").map(mapTransaction).filter((item): item is BudgetTransaction => item !== null));
      if (payload.has_more !== true) return output;
      offset += 500;
    }
  }

  async createTransactions(transactions: readonly DesiredTransaction[]): Promise<CreateResult> {
    if (transactions.length === 0) return { created: [], duplicates: [] };
    const payload = await this.request("/transactions", {
      method: "POST",
      body: JSON.stringify({ transactions: transactions.map(toRequest), skip_duplicates: false, skip_balance_update: true }),
    });
    const created = objectArray(payload, "transactions").map(mapTransaction).filter((item): item is BudgetTransaction => item !== null);
    const duplicates = objectArray(payload, "skipped_duplicates").map((raw) => {
      const request = raw.request_transaction;
      const accountId = isObject(request) && typeof request.manual_account_id === "number" ? request.manual_account_id : 0;
      const externalId = isObject(request) ? requiredString(request, "external_id") : "";
      return { id: requiredNumber(raw, "existing_transaction_id"), externalId, manualAccountId: accountId };
    });
    return { created, duplicates };
  }

  async updateTransactions(transactions: readonly (DesiredTransaction & { id: number })[]): Promise<void> {
    if (transactions.length === 0) return;
    await this.request("/transactions", {
      method: "PUT",
      body: JSON.stringify({ transactions: transactions.map((transaction) => ({ id: transaction.id, ...toRequest(transaction) })) }),
    });
  }

  async updateBalance(accountId: number, balance: NormalizedAccount["balance"]): Promise<void> {
    await this.request(`/manual_accounts/${accountId}`, {
      method: "PUT",
      body: JSON.stringify({ balance: formatMoney(balance), currency: balance.currency.toLowerCase(), balance_as_of: new Date().toISOString() }),
    });
  }
}

function toRequest(transaction: DesiredTransaction): JsonObject {
  return {
    date: transaction.date,
    amount: transaction.amount,
    currency: transaction.currency.toLowerCase(),
    payee: transaction.payee,
    notes: transaction.notes,
    manual_account_id: transaction.accountId,
    external_id: transaction.externalId,
    status: "unreviewed",
  };
}

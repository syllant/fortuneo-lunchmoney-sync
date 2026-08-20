import type { BankAccount, Balance } from "../../domain/account";
import { DomainError } from "../../domain/errors";
import type { DateRange, TransactionPage } from "../../domain/transaction";
import type { BankSession, BankSource } from "../contracts";
import { readBoundedJsonObject } from "../json-response";
import { authorizationHeader, type EnableBankingCredentials } from "./authentication";
import { mapAccount, mapBalances, mapTransactionPage } from "./mapper";
import { objectArray, optionalString, requiredObject, requiredString, type JsonObject } from "./schemas";

export type StartAuthorization = Readonly<{
  redirectUrl: string;
  state: string;
  validUntil: string;
  bankName: string;
  bankCountry: string;
}>;

export class EnableBankingClient implements BankSource {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: EnableBankingCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<JsonObject> {
    let authorization: string;
    try {
      authorization = await authorizationHeader(this.credentials);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("ENABLE_BANKING_JWT_ERROR", { cause: error });
    }
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new DomainError("ENABLE_BANKING_NETWORK_ERROR", { cause: error });
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new DomainError("ENABLE_BANKING_AUTH_ERROR");
      if (response.status === 429 || response.status >= 500) throw new DomainError("ENABLE_BANKING_TEMPORARY_ERROR");
      throw new DomainError(`ENABLE_BANKING_HTTP_${response.status}`);
    }
    return readBoundedJsonObject(response, "ENABLE_BANKING_RESPONSE_TOO_LARGE", "ENABLE_BANKING_INVALID_RESPONSE");
  }

  async startAuthorization(input: StartAuthorization): Promise<string> {
    const payload = await this.request("/auth", {
      method: "POST",
      body: JSON.stringify({
        access: { valid_until: input.validUntil },
        aspsp: { name: input.bankName, country: input.bankCountry },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: "personal",
        language: "en",
      }),
    });
    return requiredString(payload, "url");
  }

  async authorizeSession(code: string): Promise<BankSession> {
    return this.mapSession(await this.request("/sessions", { method: "POST", body: JSON.stringify({ code }) }));
  }

  async getSession(sessionId: string): Promise<BankSession> {
    return this.mapSession(await this.request(`/sessions/${encodeURIComponent(sessionId)}`), sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async listAccounts(sessionId: string): Promise<readonly BankAccount[]> {
    return (await this.getSession(sessionId)).accounts;
  }

  async getBalances(account: BankAccount): Promise<readonly Balance[]> {
    return mapBalances(await this.request(`/accounts/${encodeURIComponent(account.providerAccountId)}/balances`));
  }

  async getBookedTransactions(account: BankAccount, range: DateRange, continuationKey?: string): Promise<TransactionPage> {
    const query = new URLSearchParams({ date_from: range.from, date_to: range.to, transaction_status: "BOOK" });
    if (continuationKey) query.set("continuation_key", continuationKey);
    return mapTransactionPage(await this.request(`/accounts/${encodeURIComponent(account.providerAccountId)}/transactions?${query}`));
  }

  private mapSession(payload: JsonObject, fallbackSessionId?: string): BankSession {
    const access = requiredObject(payload, "access");
    const sessionId = optionalString(payload, "session_id") ?? fallbackSessionId;
    if (!sessionId) throw new DomainError("ENABLE_BANKING_INVALID_RESPONSE");
    const accountKey = payload.accounts_data === undefined ? "accounts" : "accounts_data";
    return {
      sessionId,
      validUntil: requiredString(access, "valid_until"),
      accounts: objectArray(payload, accountKey).map(mapAccount),
    };
  }
}

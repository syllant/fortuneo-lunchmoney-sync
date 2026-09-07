import {
  LunchMoneyClient,
  LunchMoneyError,
  type Currency,
  type ManualAccount,
  type Transaction,
  type UpdateTransactionBody,
  type UpdateTransactionsBody,
} from "@lunch-money/lunch-money-js-v2";
import type {
  DesiredTransaction,
  ExistingAccount,
  ExistingTransaction,
  FortuneoAccountSnapshot,
  IntegrationMetadata,
  ManagedIds,
} from "../../shared/src/model.js";

export type LunchMoneyOperation =
  | "VERIFY"
  | "READ_ACCOUNTS"
  | "WRITE_ACCOUNT"
  | "UPDATE_BALANCE"
  | "READ_TAGS"
  | "WRITE_TAG"
  | "READ_CATEGORIES"
  | "WRITE_CATEGORY"
  | "READ_TRANSACTIONS"
  | "CREATE_TRANSACTION"
  | "UPDATE_TRANSACTION"
  | "DELETE_TRANSACTION"
  | "GROUP_TRANSACTIONS";

export class LunchMoneyGateway {
  private readonly client: LunchMoneyClient;

  constructor(token: string, private readonly sleep: (milliseconds: number) => Promise<void> = delay, private readonly reportRetryWait?: () => void) {
    this.client = new LunchMoneyClient({ apiKey: token, baseUrl: "https://api.lunchmoney.dev/v2" });
  }

  async verify(): Promise<void> {
    await this.call("VERIFY", () => this.client.user.getMe());
  }

  async listSelectableAccounts(): Promise<Array<{ id: number; name: string; institution: string | null; type: string }>> {
    const accounts = await this.call("READ_ACCOUNTS", () => this.client.manualAccounts.getAll());
    return accounts.filter((account) => account.status === "active").map((account) => ({ id: account.id, name: account.display_name ?? account.name, institution: account.institution_name, type: account.type }));
  }

  async listAccounts(): Promise<ExistingAccount[]> {
    return (await this.call("READ_ACCOUNTS", () => this.client.manualAccounts.getAll())).map(mapAccount);
  }

  async createManagedAccount(source: FortuneoAccountSnapshot, externalId: string, metadata: IntegrationMetadata): Promise<ManualAccount> {
    const accountName = managedAccountName(source);
    const isCard = source.kind === "card";
    return this.call("WRITE_ACCOUNT", () => this.client.manualAccounts.create({
      name: accountName,
      display_name: accountName,
      institution_name: "Fortuneo",
      type: isCard ? "credit" : "cash",
      subtype: isCard ? "credit card" : "savings",
      balance: source.balance,
      currency: source.currency as Currency,
      balance_as_of: new Date().toISOString(),
      external_id: externalId,
      custom_metadata: metadataRecord(metadata),
      status: "active",
    }));
  }

  async markCheckingAccount(accountId: number, externalId: string, metadata: IntegrationMetadata): Promise<void> {
    await this.call("WRITE_ACCOUNT", () => this.client.manualAccounts.update(accountId, { external_id: externalId, custom_metadata: metadataRecord(metadata) }));
  }

  async updateBalance(accountId: number, balance: string, currency: string, asOf: string): Promise<void> {
    await this.call("UPDATE_BALANCE", () => this.client.manualAccounts.update(accountId, { balance, currency: currency as Currency, balance_as_of: asOf }));
  }

  async ensureManagedIds(checkingAccountId: number, createMissing = true): Promise<ManagedIds> {
    const [tags, categories] = await Promise.all([
      this.call("READ_TAGS", () => this.client.tags.getAll()),
      this.call("READ_CATEGORIES", () => this.client.categories.getAll({ format: "nested" })),
    ]);
    let pending = tags.find((tag) => tag.name === "Fortuneo pending" && !tag.archived);
    let deferred = tags.find((tag) => tag.name === "Fortuneo deferred" && !tag.archived);
    if (createMissing) {
      pending ??= await this.call("WRITE_TAG", () => this.client.tags.create({ name: "Fortuneo pending", description: "Managed by Fortuneo Lunch Money Sync" }));
      deferred ??= await this.call("WRITE_TAG", () => this.client.tags.create({ name: "Fortuneo deferred", description: "Managed by Fortuneo Lunch Money Sync" }));
    }
    if (!pending || !deferred) throw new Error("MANAGED_TAGS_NOT_CONFIGURED");
    const categoryCandidates = flattenCategories(categories);
    let transfer = chooseTransferCategory(categoryCandidates);
    const archivedDefault = categoryCandidates.find((category) => !category.isGroup && category.archived && normalizeCategoryName(category.name) === "payment transfer");
    if (!transfer && createMissing && archivedDefault) {
      const restored = await this.call("WRITE_CATEGORY", () => this.client.categories.update(archivedDefault.id, { archived: false, is_income: false, exclude_from_budget: true, exclude_from_totals: true }));
      transfer = toTransferCandidate(restored);
    }
    if (!transfer && createMissing) {
      const name = categoryCandidates.some((category) => normalizeCategoryName(category.name) === "payment transfer") ? "Fortuneo transfers" : "Payment, Transfer";
      const created = await this.call("WRITE_CATEGORY", () => this.client.categories.create({
        name,
        description: "Transfers between accounts",
        is_income: false,
        exclude_from_budget: true,
        exclude_from_totals: true,
        is_group: false,
        archived: false,
      }));
      transfer = toTransferCandidate(created);
    }
    if (!transfer) throw new Error("PAYMENT_TRANSFER_CATEGORY_NOT_FOUND");
    if (createMissing && (transfer.isIncome || !transfer.excludeFromBudget || !transfer.excludeFromTotals)) {
      const transferId = transfer.id;
      const corrected = await this.call("WRITE_CATEGORY", () => this.client.categories.update(transferId, { is_income: false, exclude_from_budget: true, exclude_from_totals: true }));
      transfer = toTransferCandidate(corrected);
    }
    return { checkingAccountId, pendingTagId: pending.id, deferredTagId: deferred.id, paymentTransferCategoryId: transfer.id };
  }

  async listTransactions(snapshotDate: string): Promise<ExistingTransaction[]> {
    const center = new Date(`${snapshotDate.slice(0, 10)}T00:00:00Z`);
    const start = new Date(center); start.setUTCFullYear(start.getUTCFullYear() - 2);
    const end = new Date(center); end.setUTCMonth(end.getUTCMonth() + 2);
    const output: Transaction[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.call("READ_TRANSACTIONS", () => this.client.transactions.getAll({
        start_date: start.toISOString().slice(0, 10),
        end_date: end.toISOString().slice(0, 10),
        include_pending: true,
        include_metadata: true,
        include_group_children: true,
        limit: 500,
        offset,
      }));
      output.push(...page.transactions);
      if (!page.hasMore) break;
      offset += 500;
    }
    return output.map(mapTransaction);
  }

  async createTransaction(transaction: DesiredTransaction): Promise<number> {
    const result = await this.call("CREATE_TRANSACTION", () => this.client.transactions.create({
      transactions: [{
        date: transaction.date,
        amount: transaction.amount,
        currency: transaction.currency as Currency,
        payee: transaction.payee,
        manual_account_id: transaction.accountId,
        ...(transaction.categoryId === undefined ? {} : { category_id: transaction.categoryId }),
        tag_ids: transaction.tagIds,
        external_id: transaction.externalId,
        custom_metadata: metadataRecord(transaction.metadata),
        status: "unreviewed",
      }],
      skip_duplicates: false,
      skip_balance_update: true,
      apply_rules: true,
    }));
    const id = result.transactions[0]?.id ?? result.skipped_duplicates[0]?.existing_transaction_id;
    if (!id) throw new Error("LUNCH_MONEY_CREATE_RESULT_INVALID");
    return id;
  }

  async updateTransaction(id: number, patch: Partial<DesiredTransaction>): Promise<void> {
    const body = transactionUpdateBody(patch);
    await this.call("UPDATE_TRANSACTION", async () => {
      const response = await this.client.rawClient.PUT("/transactions/{id}", { params: { path: { id }, query: { update_balance: false } }, body });
      if (response.error) throw new LunchMoneyError("Transaction update failed", response.response.status, response.error);
      return response.data;
    });
  }

  async updateTransactions(updates: readonly { id: number; patch: Partial<DesiredTransaction> }[]): Promise<void> {
    for (let offset = 0; offset < updates.length; offset += 500) {
      const transactions: UpdateTransactionsBody["transactions"] = updates.slice(offset, offset + 500)
        .map(({ id, patch }) => ({ id, ...transactionUpdateBody(patch) }));
      await this.call("UPDATE_TRANSACTION", () => this.client.transactions.updateMany({ transactions }));
    }
  }

  async deleteTransaction(id: number): Promise<void> {
    await this.call("DELETE_TRANSACTION", () => this.client.transactions.delete(id));
  }

  async groupTransactions(ids: number[], date: string, categoryId: number): Promise<number> {
    const group = await this.call("GROUP_TRANSACTIONS", () => this.client.transactions.group({ ids, date, payee: "Fortuneo card payment", category_id: categoryId, status: "reviewed", tag_ids: [] }));
    return group.id;
  }

  private async call<T>(operation: LunchMoneyOperation, request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        if (error instanceof LunchMoneyError && error.status === 429 && attempt === 0) {
          // Report the bounded provider backoff so an active sync stays observable.
          this.reportRetryWait?.();
          await this.sleep(30_000);
          this.reportRetryWait?.();
          await this.sleep(30_000);
          continue;
        }
        if (error instanceof LunchMoneyError && (error.status === 401 || error.status === 403)) throw new Error("LUNCH_MONEY_AUTH_REQUIRED", { cause: error });
        throw new Error(lunchMoneyFailureCode(operation, error), { cause: error });
      }
    }
  }
}

function transactionUpdateBody(patch: Partial<DesiredTransaction>): UpdateTransactionBody {
  const body: UpdateTransactionBody = {};
  if (patch.date !== undefined) body.date = patch.date;
  if (patch.amount !== undefined) body.amount = patch.amount;
  if (patch.currency !== undefined) body.currency = patch.currency as Currency;
  if (patch.payee !== undefined) body.payee = patch.payee;
  if (patch.categoryId !== undefined) body.category_id = patch.categoryId;
  if (patch.tagIds !== undefined) body.tag_ids = patch.tagIds;
  if (patch.externalId !== undefined) body.external_id = patch.externalId;
  if (patch.metadata !== undefined) body.custom_metadata = metadataRecord(patch.metadata) as NonNullable<UpdateTransactionBody["custom_metadata"]>;
  return body;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function lunchMoneyFailureCode(operation: LunchMoneyOperation, error: unknown): string {
  if (error instanceof LunchMoneyError && Number.isInteger(error.status) && Number(error.status) >= 100 && Number(error.status) <= 599) {
    return `LUNCH_MONEY_${operation}_HTTP_${error.status}`;
  }
  if (error instanceof TypeError) return `LUNCH_MONEY_${operation}_NETWORK_FAILED`;
  return `LUNCH_MONEY_${operation}_FAILED`;
}

export function managedAccountName(source: FortuneoAccountSnapshot): string {
  if (source.kind !== "card") return source.displayName;
  if (!source.mask || source.displayName.includes(source.mask)) return source.displayName;
  return `${source.displayName} •••• ${source.mask}`;
}

export const cardAccountName = managedAccountName;

function mapAccount(account: ManualAccount): ExistingAccount {
  return { id: account.id, name: account.display_name ?? account.name, type: account.type, balance: account.balance, currency: account.currency, externalId: account.external_id, metadata: parseMetadata(account.custom_metadata) };
}

function mapTransaction(transaction: Transaction): ExistingTransaction {
  return {
    id: transaction.id,
    accountId: transaction.manual_account_id ?? 0,
    date: transaction.date,
    amount: transaction.amount,
    currency: transaction.currency,
    payee: transaction.payee,
    notes: transaction.notes,
    categoryId: transaction.category_id,
    tagIds: transaction.tag_ids,
    externalId: transaction.external_id,
    metadata: parseMetadata(transaction.custom_metadata),
    groupParentId: transaction.group_parent_id ?? null,
  };
}

function parseMetadata(value: unknown): IntegrationMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 2 || typeof item.source_identity !== "string" || !["pending", "deferred", "settled", "account", "settlement"].includes(String(item.lifecycle)) || typeof item.payload_fingerprint !== "string" || typeof item.last_seen_at !== "string" || !Number.isSafeInteger(item.miss_count) || !Array.isArray(item.aliases) || !item.aliases.every((alias) => typeof alias === "string")) return null;
  return item as unknown as IntegrationMetadata;
}

function metadataRecord(metadata: IntegrationMetadata): Record<string, unknown> {
  return { ...metadata };
}

export interface TransferCategoryCandidate {
  id: number;
  name: string;
  isGroup: boolean;
  isIncome: boolean;
  excludeFromBudget: boolean;
  excludeFromTotals: boolean;
  archived: boolean;
}

export function chooseTransferCategory(categories: readonly TransferCategoryCandidate[]): TransferCategoryCandidate | null {
  const assignable = categories.filter((category) => !category.isGroup && !category.archived);
  const exact = assignable.find((category) => normalizeCategoryName(category.name) === "payment transfer");
  if (exact) return exact;
  const semantic = assignable.filter((category) => !category.isIncome && category.excludeFromBudget && category.excludeFromTotals);
  const named = semantic.filter((category) => /\b(payment|transfer|paiement|virement)\b/u.test(normalizeCategoryName(category.name)));
  if (named.length === 1) return named[0] ?? null;
  return semantic.length === 1 ? semantic[0] ?? null : null;
}

function flattenCategories(categories: readonly unknown[]): TransferCategoryCandidate[] {
  const output: TransferCategoryCandidate[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const category = value as Record<string, unknown>;
    if (typeof category.id === "number" && typeof category.name === "string") {
      output.push({
        id: category.id,
        name: category.name,
        isGroup: category.is_group === true,
        isIncome: category.is_income === true,
        excludeFromBudget: category.exclude_from_budget === true,
        excludeFromTotals: category.exclude_from_totals === true,
        archived: category.archived === true,
      });
    }
    if (Array.isArray(category.children)) category.children.forEach(visit);
  };
  categories.forEach(visit);
  return output;
}

function normalizeCategoryName(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim();
}

function toTransferCandidate(category: { id: number; name: string; is_group: boolean; is_income: boolean; exclude_from_budget: boolean; exclude_from_totals: boolean; archived: boolean }): TransferCategoryCandidate {
  return { id: category.id, name: category.name, isGroup: category.is_group, isIncome: category.is_income, excludeFromBudget: category.exclude_from_budget, excludeFromTotals: category.exclude_from_totals, archived: category.archived };
}

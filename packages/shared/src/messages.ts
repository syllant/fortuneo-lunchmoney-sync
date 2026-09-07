import { SCHEMA_VERSION, type FortuneoSnapshot } from "./model.js";

export const MAX_NATIVE_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 512;

export type NativeRequest =
  | { version: 2; type: "sync-if-due" | "sync" | "dry-run"; requestId: string }
  | { version: 2; type: "get-fortuneo-credentials"; requestId: string }
  | { version: 2; type: "get-fortuneo-account-urls"; requestId: string }
  | { version: 2; type: "remember-fortuneo-account-url"; requestId: string; url: string }
  | { version: 2; type: "snapshot"; requestId: string; snapshot: FortuneoSnapshot }
  | { version: 2; type: "list-accounts"; requestId: string; token?: string }
  | { version: 2; type: "configure"; requestId: string; token?: string; checkingAccountId: number; fortuneoAccessCode?: string; fortuneoPassword?: string }
  | { version: 2; type: "reset"; requestId: string };

export type NativeResponse =
  | { version: 2; type: "snapshot"; requestId: string }
  | { version: 2; type: "progress"; requestId: string; phase: string }
  | { version: 2; type: "details"; requestId: string; details: SyncResultDetails }
  | { version: 2; type: "auth-required"; requestId: string; provider: "fortuneo" | "lunch-money" }
  | { version: 2; type: "fortuneo-credentials"; requestId: string; available: false }
  | { version: 2; type: "fortuneo-credentials"; requestId: string; available: true; accessCode: string; password: string }
  | { version: 2; type: "fortuneo-account-urls"; requestId: string; urls: string[] }
  | { version: 2; type: "accounts"; requestId: string; checkingAccountId: number | null; accounts: Array<{ id: number; name: string; institution: string | null; type: string }> }
  | { version: 2; type: "result"; requestId: string; ok: boolean; dryRun: boolean; summary: ResultSummary };

export interface ResultSummary {
  created: number;
  updated: number;
  deleted: number;
  grouped: number;
  warnings: string[];
  unresolvedCardReviewKeys?: string[];
  message: string;
  breakdown: {
    accountsCreated: number;
    accountsUpdated: number;
    transactionsCreated: number;
    transactionsUpdated: number;
    transactionsDeleted: number;
    settlementsGrouped: number;
    fortuneoSettled: number;
    fortuneoDeferred: number;
    fortuneoPending: number;
  };
  details?: SyncResultDetails;
  diagnostic?: SafeErrorDiagnostic;
}

export interface SafeErrorDiagnostic {
  code: string;
  phase?: string;
  kind: string;
  location?: string;
  fingerprint: string;
}

export interface SyncResultDetails {
  accounts: Array<{
    sourceName: string;
    targetName: string;
    action: "create" | "connect" | "existing" | "review";
    balance: string;
    currency: string;
  }>;
  transactions: Array<{
    action: "create" | "update" | "unchanged" | "skipped";
    issue?: string;
    lifecycle: "settled" | "deferred" | "pending";
    date: string;
    merchant: string;
    category?: string;
    amount: string;
    currency: string;
    targetAccount: string;
  }>;
  truncatedTransactions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseNativeRequest(value: unknown): NativeRequest {
  if (!isRecord(value) || value.version !== SCHEMA_VERSION || !isShortString(value.requestId, 128) || !isShortString(value.type, 32)) {
    throw new Error("INVALID_MESSAGE_ENVELOPE");
  }
  switch (value.type) {
    case "sync-if-due":
    case "sync":
    case "dry-run":
    case "get-fortuneo-credentials":
    case "get-fortuneo-account-urls":
    case "reset":
      assertKeys(value, ["version", "type", "requestId"]);
      return { version: 2, type: value.type, requestId: value.requestId };
    case "remember-fortuneo-account-url":
      assertKeys(value, ["version", "type", "requestId", "url"]);
      if (!isShortString(value.url, 512) || !isFortuneoAccountUrl(value.url)) throw new Error("INVALID_FORTUNEO_ACCOUNT_URL");
      return { version: 2, type: "remember-fortuneo-account-url", requestId: value.requestId, url: value.url };
    case "list-accounts":
      assertKeys(value, ["version", "type", "requestId", "token"]);
      if (value.token !== undefined && !isShortString(value.token, 4096)) throw new Error("INVALID_TOKEN");
      return value.token === undefined
        ? { version: 2, type: "list-accounts", requestId: value.requestId }
        : { version: 2, type: "list-accounts", requestId: value.requestId, token: value.token };
    case "configure":
      assertKeys(value, ["version", "type", "requestId", "token", "checkingAccountId", "fortuneoAccessCode", "fortuneoPassword"]);
      if ((value.token !== undefined && (!isShortString(value.token, 4096) || value.token.length < 11)) || !Number.isSafeInteger(value.checkingAccountId) || Number(value.checkingAccountId) <= 0
        || (value.fortuneoAccessCode !== undefined && (!isShortString(value.fortuneoAccessCode, 128) || !/^[A-Za-z0-9]+$/.test(value.fortuneoAccessCode)))
        || (value.fortuneoPassword !== undefined && (!isShortString(value.fortuneoPassword, 128) || /[\r\n\0]/.test(value.fortuneoPassword)))
        || ((value.fortuneoAccessCode === undefined) !== (value.fortuneoPassword === undefined))) {
        throw new Error("INVALID_CONFIGURATION");
      }
      return {
        version: 2,
        type: "configure",
        requestId: value.requestId,
        checkingAccountId: Number(value.checkingAccountId),
        ...(value.token === undefined ? {} : { token: value.token }),
        ...(value.fortuneoAccessCode === undefined ? {} : { fortuneoAccessCode: value.fortuneoAccessCode, fortuneoPassword: value.fortuneoPassword as string }),
      };
    case "snapshot":
      assertKeys(value, ["version", "type", "requestId", "snapshot"]);
      return { version: 2, type: "snapshot", requestId: value.requestId, snapshot: parseSnapshot(value.snapshot) };
    default:
      throw new Error("UNKNOWN_MESSAGE_TYPE");
  }
}

export function parseSnapshot(value: unknown): FortuneoSnapshot {
  if (!isRecord(value) || !isShortString(value.capturedAt, 64) || !Number.isFinite(Date.parse(value.capturedAt)) || typeof value.complete !== "boolean") throw new Error("INVALID_SNAPSHOT");
  assertKeys(value, ["capturedAt", "complete", "accounts", "transactions", "settlements"]);
  if (!Array.isArray(value.accounts) || value.accounts.length > 20 || !Array.isArray(value.transactions) || value.transactions.length > 10_000 || !Array.isArray(value.settlements) || value.settlements.length > 1000) {
    throw new Error("SNAPSHOT_LIMIT_EXCEEDED");
  }
  const accounts = value.accounts.map((item) => {
    if (!isRecord(item) || !isShortString(item.sourceId) || !["checking", "savings", "card"].includes(String(item.kind)) || !isShortString(item.displayName) || !isCurrency(item.currency) || !isMoney(item.balance) || typeof item.complete !== "boolean") throw new Error("INVALID_ACCOUNT_SNAPSHOT");
    assertKeys(item, ["sourceId", "kind", "displayName", "currency", "balance", "mask", "complete"]);
    if (item.mask !== undefined && !isShortString(item.mask, 32)) throw new Error("INVALID_ACCOUNT_MASK");
    return { sourceId: item.sourceId, kind: item.kind as "checking" | "savings" | "card", displayName: item.displayName, currency: item.currency.toLowerCase(), balance: item.balance, complete: item.complete, ...(item.mask === undefined ? {} : { mask: item.mask }) };
  });
  const transactions = value.transactions.map((item) => {
    if (!isRecord(item) || !isShortString(item.sourceId) || !isShortString(item.accountSourceId) || !isDate(item.date) || !isMoney(item.amount) || !isCurrency(item.currency) || !isShortString(item.merchant) || !["pending", "deferred", "settled"].includes(String(item.lifecycle))) throw new Error("INVALID_TRANSACTION_SNAPSHOT");
    assertKeys(item, ["sourceId", "accountSourceId", "date", "amount", "currency", "merchant", "lifecycle"]);
    return { sourceId: item.sourceId, accountSourceId: item.accountSourceId, date: item.date, amount: item.amount, currency: item.currency.toLowerCase(), merchant: item.merchant, lifecycle: item.lifecycle as "pending" | "deferred" | "settled" };
  });
  const settlements = value.settlements.map((item) => {
    if (!isRecord(item) || !isShortString(item.sourceId) || !isShortString(item.checkingAccountSourceId) || !isDate(item.date) || !isMoney(item.checkingDebit) || !isCurrency(item.currency) || !Array.isArray(item.cardCredits) || item.cardCredits.length > 20) throw new Error("INVALID_SETTLEMENT_SNAPSHOT");
    assertKeys(item, ["sourceId", "purchaseSourceId", "checkingAccountSourceId", "date", "checkingDebit", "currency", "cardCredits"]);
    if (item.purchaseSourceId !== undefined && (!isShortString(item.purchaseSourceId) || item.cardCredits.length !== 0)) throw new Error("INVALID_SETTLEMENT_REFERENCE");
    const cardCredits = item.cardCredits.map((credit) => {
      if (!isRecord(credit) || !isShortString(credit.cardAccountSourceId) || !isMoney(credit.amount)) throw new Error("INVALID_SETTLEMENT_CREDIT");
      assertKeys(credit, ["cardAccountSourceId", "amount"]);
      return { cardAccountSourceId: credit.cardAccountSourceId, amount: credit.amount };
    });
    return { sourceId: item.sourceId, ...(item.purchaseSourceId === undefined ? {} : { purchaseSourceId: item.purchaseSourceId }), checkingAccountSourceId: item.checkingAccountSourceId, date: item.date, checkingDebit: item.checkingDebit, currency: item.currency.toLowerCase(), cardCredits };
  });
  validateSnapshotRelations(value.complete, accounts, transactions, settlements);
  return { capturedAt: value.capturedAt, complete: value.complete, accounts, transactions, settlements };
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isMoney(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+(?:\.\d{1,4})?$/.test(value) && value.length <= 32;
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value);
}

function isFortuneoAccountUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://mabanque.fortuneo.fr" && /^\/mon-espace\/banque\/[^/]+\/[^/?#]+(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function validateSnapshotRelations(
  complete: boolean,
  accounts: FortuneoSnapshot["accounts"],
  transactions: FortuneoSnapshot["transactions"],
  settlements: FortuneoSnapshot["settlements"],
): void {
  const accountIds = new Set(accounts.map((account) => account.sourceId));
  if (accountIds.size !== accounts.length || accounts.filter((account) => account.kind === "checking").length > 1) throw new Error("INVALID_ACCOUNT_RELATIONSHIP");
  if (complete && accounts.some((account) => !account.complete)) throw new Error("INCONSISTENT_SNAPSHOT_COMPLETENESS");
  if (transactions.some((transaction) => !accountIds.has(transaction.accountSourceId))) throw new Error("INVALID_TRANSACTION_ACCOUNT");
  for (const settlement of settlements) {
    if (!accountIds.has(settlement.checkingAccountSourceId) || settlement.cardCredits.some((credit) => !accountIds.has(credit.cardAccountSourceId))) throw new Error("INVALID_SETTLEMENT_ACCOUNT");
  }
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("UNEXPECTED_MESSAGE_PROPERTY");
}

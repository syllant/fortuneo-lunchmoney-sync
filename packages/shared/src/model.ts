export const SCHEMA_VERSION = 2 as const;

export type Lifecycle = "pending" | "deferred" | "settled";
export type AccountKind = "checking" | "savings" | "card";

export interface FortuneoAccountSnapshot {
  sourceId: string;
  kind: AccountKind;
  displayName: string;
  currency: string;
  balance: string;
  mask?: string;
  complete: boolean;
}

export interface FortuneoTransactionSnapshot {
  sourceId: string;
  accountSourceId: string;
  date: string;
  amount: string;
  currency: string;
  merchant: string;
  lifecycle: Lifecycle;
}

export interface FortuneoSettlementSnapshot {
  sourceId: string;
  purchaseSourceId?: string;
  checkingAccountSourceId: string;
  date: string;
  checkingDebit: string;
  currency: string;
  cardCredits: ReadonlyArray<{ cardAccountSourceId: string; amount: string }>;
}

export interface FortuneoSnapshot {
  capturedAt: string;
  complete: boolean;
  accounts: FortuneoAccountSnapshot[];
  transactions: FortuneoTransactionSnapshot[];
  settlements: FortuneoSettlementSnapshot[];
}

export interface IntegrationMetadata {
  schema_version: 2;
  source_identity: string;
  lifecycle: Lifecycle | "account" | "settlement";
  payload_fingerprint: string;
  last_seen_at: string;
  miss_count: number;
  aliases: string[];
}

export interface ExistingAccount {
  id: number;
  name: string;
  type: string;
  balance: string;
  currency: string;
  externalId: string | null;
  metadata: IntegrationMetadata | null;
}

export interface ExistingTransaction {
  id: number;
  accountId: number;
  date: string;
  amount: string;
  currency: string;
  payee: string;
  notes: string | null;
  categoryId: number | null;
  tagIds: number[];
  externalId: string | null;
  metadata: IntegrationMetadata | null;
  groupParentId: number | null;
}

export interface DesiredTransaction {
  accountId: number;
  date: string;
  amount: string;
  currency: string;
  payee: string;
  categoryId?: number | null;
  tagIds: number[];
  externalId: string;
  metadata: IntegrationMetadata;
}

export type ReconciliationOperation =
  | { kind: "create-account"; sourceAccount: FortuneoAccountSnapshot; externalId: string; metadata: IntegrationMetadata }
  | { kind: "mark-account"; accountId: number; externalId: string; metadata: IntegrationMetadata }
  | { kind: "update-account-balance"; accountId: number; balance: string; currency: string }
  | { kind: "create-transaction"; transaction: DesiredTransaction; sourceId: string; categorySource?: "history" }
  | { kind: "update-transaction"; id: number; patch: Partial<DesiredTransaction>; sourceId: string; categorySource?: "history" }
  | { kind: "delete-cancelled-pending"; id: number; sourceIdentity: string }
  | { kind: "delete-replaced-synthetic"; id: number }
  | { kind: "group-settlement"; sourceId: string; date: string; memberSourceIds: string[]; categoryId: number }
  | { kind: "review"; code: string; subject: string };

export interface ReconciliationPlan {
  operations: ReconciliationOperation[];
  warnings: string[];
}

export interface ManagedIds {
  checkingAccountId: number;
  pendingTagId: number;
  deferredTagId: number;
  paymentTransferCategoryId: number;
}

import type { Money } from "./money";

export type DateRange = Readonly<{ from: string; to: string }>;

export type NormalizedTransaction = Readonly<{
  sourceId: string;
  alternateSourceIds: readonly string[];
  date: string;
  money: Money;
  direction: "credit" | "debit";
  payee: string;
  notes: string | null;
  status: "booked" | "pending";
}>;

export type TransactionPageDiagnostics = Readonly<{
  received: number;
  accepted: number;
  ignoredWithoutStableId: number;
  ignoredWithoutDate: number;
  statusCounts?: TransactionStatusCounts;
}>;

export type TransactionStatusCounts = Readonly<{
  BOOK: number;
  PDNG: number;
  HOLD: number;
  OTHR: number;
  SCHD: number;
  CNCL: number;
  RJCT: number;
  UNKNOWN: number;
}>;

export type TransactionPage = Readonly<{
  transactions: readonly NormalizedTransaction[];
  continuationKey: string | null;
  diagnostics?: TransactionPageDiagnostics;
}>;

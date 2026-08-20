import type { Money } from "./money";

export type DateRange = Readonly<{ from: string; to: string }>;

export type NormalizedTransaction = Readonly<{
  sourceId: string;
  bookedDate: string;
  money: Money;
  direction: "credit" | "debit";
  payee: string;
  notes: string | null;
  status: "booked";
}>;

export type TransactionPage = Readonly<{
  transactions: readonly NormalizedTransaction[];
  continuationKey: string | null;
}>;

import type { Money } from "./money";

export type BankAccount = Readonly<{
  providerAccountId: string;
  identificationHash: string;
  displayHint: string;
  currency: string;
}>;

export type Balance = Readonly<{ money: Money; status: string }>;

export type NormalizedAccount = Readonly<{
  identificationHash: string;
  displayName: string;
  type: "cash" | "credit";
  balance: Money;
}>;

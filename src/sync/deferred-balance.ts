import type { Balance } from "../domain/account";
import type { NormalizedTransaction } from "../domain/transaction";

export type BalanceLabelCategory = "CARD_CURRENT" | "CARD_NEXT" | "REAL_TIME" | "OTHER";

export function balanceLabelCategory(name: string): BalanceLabelCategory {
  const normalized = name.toLowerCase();
  if (normalized.includes("card") && normalized.includes("current month balance")) return "CARD_CURRENT";
  if (normalized.includes("card") && normalized.includes("next month balance")) return "CARD_NEXT";
  if (normalized.includes("real time balance")) return "REAL_TIME";
  return "OTHER";
}

export function deferredBalanceTransaction(
  balances: readonly Balance[],
  accountCurrency: string,
  date: string,
): NormalizedTransaction | null {
  const currency = accountCurrency.toUpperCase();
  const deferred = balances.filter((balance) =>
    balance.name !== undefined
    && balance.money.currency === currency
    && (balanceLabelCategory(balance.name) === "CARD_CURRENT" || balanceLabelCategory(balance.name) === "CARD_NEXT"));
  if (deferred.length === 0) return null;

  const first = deferred[0]!;
  const minor = deferred.reduce((sum, balance) => {
    if (balance.money.minorDigits !== first.money.minorDigits) return sum;
    return sum + balance.money.minor;
  }, 0n);

  return {
    sourceId: "virtual:fortuneo:deferred-card-balance:v1",
    alternateSourceIds: [],
    date,
    money: { minor, currency, minorDigits: first.money.minorDigits },
    direction: minor <= 0n ? "debit" : "credit",
    payee: "Fortuneo deferred cards",
    notes: "[Pending at Fortuneo] Synthetic aggregate from card balances; individual card operations are unavailable through PSD2.",
    status: "pending",
  };
}

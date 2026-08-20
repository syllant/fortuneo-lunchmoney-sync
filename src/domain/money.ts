import { DomainError } from "./errors";

const MINOR_DIGITS: Readonly<Record<string, number>> = {
  BHD: 3, CLF: 4, IQD: 3, JOD: 3, JPY: 0, KWD: 3, LYD: 3,
  OMR: 3, TND: 3, UYW: 4, VND: 0, XAF: 0, XOF: 0, XPF: 0,
};

export type Money = Readonly<{
  minor: bigint;
  currency: string;
  minorDigits: number;
}>;

export function parseMoney(value: string, currencyInput: string): Money {
  const currency = currencyInput.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError("INVALID_CURRENCY");
  const minorDigits = MINOR_DIGITS[currency] ?? 2;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new DomainError("INVALID_AMOUNT");
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > minorDigits && /[1-9]/.test(fraction.slice(minorDigits))) {
    throw new DomainError("AMOUNT_PRECISION_LOSS");
  }
  const padded = fraction.padEnd(minorDigits, "0").slice(0, minorDigits);
  return { minor: sign * BigInt(`${whole}${padded}`), currency, minorDigits };
}

export function formatMoney(money: Money): string {
  const negative = money.minor < 0n;
  const absolute = negative ? -money.minor : money.minor;
  if (money.minorDigits === 0) return `${negative ? "-" : ""}${absolute}`;
  const digits = absolute.toString().padStart(money.minorDigits + 1, "0");
  const split = digits.length - money.minorDigits;
  return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
}

export function toLunchMoneyAmount(money: Money, direction: "credit" | "debit"): string {
  const magnitude: Money = { ...money, minor: money.minor < 0n ? -money.minor : money.minor };
  return formatMoney({ ...magnitude, minor: direction === "debit" ? magnitude.minor : -magnitude.minor });
}

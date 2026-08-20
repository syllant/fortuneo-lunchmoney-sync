import type { BankAccount, Balance } from "../../domain/account";
import { DomainError } from "../../domain/errors";
import { parseMoney } from "../../domain/money";
import type { NormalizedTransaction, TransactionPage } from "../../domain/transaction";
import { isObject, objectArray, optionalString, requiredObject, requiredString, type JsonObject } from "./schemas";

function cleanText(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

export function mapAccount(raw: JsonObject): BankAccount {
  const providerAccountId = requiredString(raw, "uid");
  const identificationHash = requiredString(raw, "identification_hash");
  const name = optionalString(raw, "name") ?? "Fortuneo account";
  const currency = (optionalString(raw, "currency") ?? "EUR").toUpperCase();
  return { providerAccountId, identificationHash, displayHint: cleanText(name, 100), currency };
}

export function mapBalances(payload: JsonObject): Balance[] {
  return objectArray(payload, "balances").map((raw) => {
    const amount = requiredObject(raw, "balance_amount");
    return {
      money: parseMoney(requiredString(amount, "amount"), requiredString(amount, "currency")),
      status: optionalString(raw, "balance_type") ?? "unknown",
    };
  });
}

function mapTransaction(raw: JsonObject): NormalizedTransaction | null {
  const status = optionalString(raw, "status");
  if (status !== "BOOK") return null;
  const sourceId = optionalString(raw, "transaction_id") ?? optionalString(raw, "entry_reference");
  if (!sourceId) throw new DomainError("SOURCE_TRANSACTION_ID_MISSING");
  const amount = requiredObject(raw, "transaction_amount");
  const indicator = requiredString(raw, "credit_debit_indicator");
  if (indicator !== "CRDT" && indicator !== "DBIT") throw new DomainError("INVALID_CREDIT_DEBIT_INDICATOR");
  const partyKey = indicator === "DBIT" ? "creditor" : "debtor";
  const party = raw[partyKey];
  const partyName = isObject(party) ? optionalString(party, "name") : undefined;
  const remittance = raw.remittance_information;
  const remittanceText = Array.isArray(remittance)
    ? remittance.filter((part): part is string => typeof part === "string").join(" · ")
    : "";
  const note = optionalString(raw, "note");
  const notes = cleanText([remittanceText, note].filter(Boolean).join(" · "), 350);
  return {
    sourceId,
    bookedDate: requiredString(raw, "booking_date"),
    money: parseMoney(requiredString(amount, "amount"), requiredString(amount, "currency")),
    direction: indicator === "DBIT" ? "debit" : "credit",
    payee: cleanText((partyName ?? remittanceText) || "Fortuneo transaction", 140),
    notes: notes.length > 0 ? notes : null,
    status: "booked",
  };
}

export function mapTransactionPage(payload: JsonObject): TransactionPage {
  const transactions = objectArray(payload, "transactions").map(mapTransaction).filter((item): item is NormalizedTransaction => item !== null);
  return { transactions, continuationKey: optionalString(payload, "continuation_key") ?? null };
}

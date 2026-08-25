import type { BankAccount, Balance } from "../../domain/account";
import { DomainError } from "../../domain/errors";
import { parseMoneyRounded } from "../../domain/money";
import type { NormalizedTransaction, TransactionPage, TransactionStatusCounts } from "../../domain/transaction";
import { isObject, objectArray, optionalString, requiredObject, requiredString, type JsonObject } from "./schemas";

function cleanText(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

export function mapAccount(raw: JsonObject): BankAccount {
  const providerAccountId = requiredString(raw, "uid");
  const identificationHash = requiredString(raw, "identification_hash");
  const name = optionalString(raw, "name") ?? "Fortuneo account";
  const currency = (optionalString(raw, "currency") ?? "EUR").toUpperCase();
  const cashAccountType = optionalString(raw, "cash_account_type");
  return { providerAccountId, identificationHash, displayHint: cleanText(name, 100), currency, ...(cashAccountType ? { cashAccountType } : {}) };
}

export function mapBalances(payload: JsonObject): Balance[] {
  return objectArray(payload, "balances").map((raw) => {
    const amount = requiredObject(raw, "balance_amount");
    return {
      money: parseMoneyRounded(requiredString(amount, "amount"), requiredString(amount, "currency")),
      status: optionalString(raw, "balance_type") ?? "unknown",
      ...(optionalString(raw, "name") ? { name: cleanText(requiredString(raw, "name"), 80) } : {}),
    };
  });
}

function mapTransaction(raw: JsonObject): NormalizedTransaction | null {
  const status = optionalString(raw, "status");
  if (status !== "BOOK" && status !== "PDNG" && status !== "HOLD") return null;
  const entryReference = optionalString(raw, "entry_reference");
  const transactionId = optionalString(raw, "transaction_id");
  // Enable Banking only considers pending references safe for matching when an
  // immutable entry_reference is present and survives the BOOK transition.
  if (status !== "BOOK" && !entryReference) return null;
  const sourceId = entryReference ?? transactionId;
  if (!sourceId) throw new DomainError("SOURCE_TRANSACTION_ID_MISSING");
  const date = status === "BOOK"
    ? optionalString(raw, "booking_date")
    : optionalString(raw, "transaction_date") ?? optionalString(raw, "booking_date") ?? optionalString(raw, "value_date");
  if (!date) {
    if (status !== "BOOK") return null;
    throw new DomainError("ENABLE_BANKING_INVALID_RESPONSE");
  }
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
  const pendingLabel = status === "BOOK" ? "" : "[Pending at Fortuneo]";
  const notes = cleanText([pendingLabel, remittanceText, note].filter(Boolean).join(" · "), 350);
  const amountValue = requiredString(amount, "amount");
  const amountCurrency = requiredString(amount, "currency");
  return {
    sourceId,
    alternateSourceIds: transactionId && transactionId !== sourceId ? [transactionId] : [],
    date,
    money: parseMoneyRounded(amountValue, amountCurrency),
    direction: indicator === "DBIT" ? "debit" : "credit",
    payee: cleanText((partyName ?? remittanceText) || "Fortuneo transaction", 140),
    notes: notes.length > 0 ? notes : null,
    status: status === "BOOK" ? "booked" : "pending",
  };
}

export function mapTransactionPage(payload: JsonObject): TransactionPage {
  const rawTransactions = objectArray(payload, "transactions");
  const transactions = rawTransactions.map(mapTransaction).filter((item): item is NormalizedTransaction => item !== null);
  const ignoredWithoutStableId = rawTransactions.filter((raw) => {
    const status = optionalString(raw, "status");
    return (status === "PDNG" || status === "HOLD") && !optionalString(raw, "entry_reference");
  }).length;
  const ignoredWithoutDate = rawTransactions.filter((raw) => {
    const status = optionalString(raw, "status");
    return (status === "PDNG" || status === "HOLD")
      && Boolean(optionalString(raw, "entry_reference"))
      && !optionalString(raw, "transaction_date")
      && !optionalString(raw, "booking_date")
      && !optionalString(raw, "value_date");
  }).length;
  const statusCounts: Record<keyof TransactionStatusCounts, number> = {
    BOOK: 0, PDNG: 0, HOLD: 0, OTHR: 0, SCHD: 0, CNCL: 0, RJCT: 0, UNKNOWN: 0,
  };
  for (const raw of rawTransactions) {
    const status = optionalString(raw, "status");
    switch (status) {
      case "BOOK": case "PDNG": case "HOLD": case "OTHR": case "SCHD": case "CNCL": case "RJCT":
        statusCounts[status] += 1;
        break;
      default:
        statusCounts.UNKNOWN += 1;
    }
  }
  return {
    transactions,
    continuationKey: optionalString(payload, "continuation_key") ?? null,
    diagnostics: {
      received: rawTransactions.length,
      accepted: transactions.length,
      ignoredWithoutStableId,
      ignoredWithoutDate,
      statusCounts,
    },
  };
}

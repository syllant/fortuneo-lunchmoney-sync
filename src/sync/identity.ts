import type { NormalizedTransaction } from "../domain/transaction";
import { hmacSha256 } from "../security/hmac";
import { canonicalJson } from "./normalize";

export async function transactionExternalId(secret: string, identificationHash: string, sourceId: string): Promise<string> {
  return `lmft:v1:${await hmacSha256(secret, `${identificationHash}\0${sourceId}`)}`;
}

export async function accountExternalId(secret: string, identificationHash: string): Promise<string> {
  return `lmfa:v1:${await hmacSha256(secret, identificationHash)}`;
}

export async function transactionPayloadHmac(secret: string, transaction: NormalizedTransaction): Promise<string> {
  return hmacSha256(secret, canonicalJson({
    amount_minor: transaction.money.minor.toString(),
    minor_digits: transaction.money.minorDigits,
    currency: transaction.money.currency,
    direction: transaction.direction,
    booked_date: transaction.bookedDate,
    payee: transaction.payee,
    notes: transaction.notes,
    status: transaction.status,
  }));
}

import { createHash } from "node:crypto";
import type { SafeErrorDiagnostic } from "../../shared/src/messages.js";

const SAFE_CODES = new Set([
  "INVALID_MESSAGE_ENVELOPE", "UNKNOWN_MESSAGE_TYPE", "INVALID_CONFIGURATION", "INVALID_TOKEN",
  "INVALID_SNAPSHOT", "SNAPSHOT_LIMIT_EXCEEDED", "NATIVE_MESSAGE_SIZE_INVALID", "NATIVE_MESSAGE_JSON_INVALID",
  "NATIVE_MESSAGE_TRUNCATED", "KEYCHAIN_READ_FAILED", "KEYCHAIN_WRITE_FAILED", "KEYCHAIN_DELETE_FAILED",
  "KEYCHAIN_HMAC_KEY_INVALID", "LUNCH_MONEY_AUTH_REQUIRED", "LUNCH_MONEY_REQUEST_FAILED", "NOT_CONFIGURED",
  "PAYMENT_TRANSFER_CATEGORY_NOT_FOUND", "MANAGED_TAGS_NOT_CONFIGURED", "CHECKING_ACCOUNT_NOT_FOUND",
  "TOO_MANY_PENDING_SYNCS", "UNEXPECTED_SNAPSHOT", "LUNCH_MONEY_CREATE_RESULT_INVALID",
  "UNEXPECTED_MESSAGE_PROPERTY",
  "INVALID_ACCOUNT_RELATIONSHIP", "INCONSISTENT_SNAPSHOT_COMPLETENESS", "INVALID_TRANSACTION_ACCOUNT",
  "INVALID_SETTLEMENT_ACCOUNT",
  "INVALID_FORTUNEO_ACCOUNT_URL", "KEYCHAIN_FORTUNEO_ACCOUNT_URLS_INVALID",
  "LUNCH_MONEY_TOKEN_REQUIRED",
  "INVALID_SETTLEMENT_REFERENCE",
  "FORTUNEO_SETTLED_CARD_REFERENCE_NOT_UNIQUE",
  "FORTUNEO_SETTLED_CARD_REFERENCE_NOT_FOUND",
  "FORTUNEO_SETTLED_CARD_REFERENCE_MISMATCH",
  "FORTUNEO_SETTLED_CARD_REFERENCE_ACCOUNT_MISSING",
]);

const SAFE_LUNCH_MONEY_FAILURE = /^LUNCH_MONEY_(?:VERIFY|READ_ACCOUNTS|WRITE_ACCOUNT|UPDATE_BALANCE|READ_TAGS|WRITE_TAG|READ_CATEGORIES|WRITE_CATEGORY|READ_TRANSACTIONS|CREATE_TRANSACTION|UPDATE_TRANSACTION|DELETE_TRANSACTION|GROUP_TRANSACTIONS)_(?:HTTP_[1-5][0-9]{2}|NETWORK_FAILED|FAILED)$/;

export function safeErrorCode(error: unknown): string {
  if (error instanceof Error && (SAFE_CODES.has(error.message) || SAFE_LUNCH_MONEY_FAILURE.test(error.message))) return error.message;
  return "UNEXPECTED_ERROR";
}

export class SyncPhaseError extends Error {
  constructor(readonly phase: string, readonly original: unknown) {
    super("SYNC_PHASE_FAILED", { cause: original });
    this.name = "SyncPhaseError";
  }
}

export function safeErrorDiagnostic(error: unknown): SafeErrorDiagnostic {
  const phase = error instanceof SyncPhaseError ? safePhase(error.phase) : undefined;
  const original = error instanceof SyncPhaseError ? error.original : error;
  const code = safeErrorCode(original);
  const kind = safeErrorKind(original);
  const location = safeErrorLocation(original);
  const fingerprintSource = [code, phase ?? "unknown-phase", kind, location ?? "unknown-location", safeStackShape(original)].join("\0");
  const fingerprint = createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 12).toUpperCase();
  return { code, ...(phase ? { phase } : {}), kind, ...(location ? { location } : {}), fingerprint };
}

function safePhase(value: string): string | undefined {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : undefined;
}

function safeErrorKind(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof AggregateError) return "AggregateError";
  return error instanceof Error ? "Error" : "NonErrorThrow";
}

function safeErrorLocation(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
  const match = error.stack.match(/(?:^|[/\\])(packages[/\\](?:native-host|shared)[/\\]src[/\\][A-Za-z0-9._/\\-]+\.(?:js|ts)):(\d+):(\d+)/m);
  if (!match) return undefined;
  return `${match[1]!.replaceAll("\\", "/")}:${match[2]}:${match[3]}`;
}

function safeStackShape(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") return "";
  return [...error.stack.matchAll(/(?:^|[/\\])(packages[/\\](?:native-host|shared)[/\\]src[/\\][A-Za-z0-9._/\\-]+\.(?:js|ts)):(\d+):(\d+)/gm)]
    .slice(0, 5)
    .map((match) => `${match[1]!.replaceAll("\\", "/")}:${match[2]}:${match[3]}`)
    .join("|");
}

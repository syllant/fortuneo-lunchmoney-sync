import type { ConnectionRecord } from "../storage/connection-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CONSENT_DURATION_MS = 90 * DAY_MS;
const STALE_AFTER_MS = 48 * 60 * 60 * 1_000;

export type NotificationEvent = Readonly<{
  eventKey: string;
  kind: "consent_14_days" | "consent_7_days" | "consent_3_days" | "consent_1_day" | "consent_expired" | "sync_error" | "sync_stale" | "test";
}>;

function consentEvent(connection: ConnectionRecord, now: Date): NotificationEvent | null {
  const remaining = Date.parse(connection.validUntil) - now.getTime();
  const prefix = `consent:${connection.id}:${connection.validUntil}`;
  if (remaining <= 0) return { eventKey: `${prefix}:expired`, kind: "consent_expired" };
  if (remaining <= DAY_MS) return { eventKey: `${prefix}:1`, kind: "consent_1_day" };
  if (remaining <= 3 * DAY_MS) return { eventKey: `${prefix}:3`, kind: "consent_3_days" };
  if (remaining <= 7 * DAY_MS) return { eventKey: `${prefix}:7`, kind: "consent_7_days" };
  if (remaining <= 14 * DAY_MS) return { eventKey: `${prefix}:14`, kind: "consent_14_days" };
  return null;
}

function staleEvent(connection: ConnectionRecord, now: Date): NotificationEvent | null {
  if (connection.status !== "authorized" || Date.parse(connection.validUntil) <= now.getTime()) return null;
  const authorizedAt = Date.parse(connection.validUntil) - CONSENT_DURATION_MS;
  const reference = connection.lastSuccessAt ? Date.parse(connection.lastSuccessAt) : authorizedAt;
  const staleFor = now.getTime() - reference;
  if (staleFor < STALE_AFTER_MS) return null;
  const period = Math.floor(staleFor / STALE_AFTER_MS);
  return { eventKey: `stale:${connection.id}:${period}`, kind: "sync_stale" };
}

export function dueNotifications(connection: ConnectionRecord | null, now: Date): readonly NotificationEvent[] {
  if (!connection || connection.status === "revoked") return [];
  const output: NotificationEvent[] = [];
  const consent = consentEvent(connection, now);
  if (consent) output.push(consent);
  if (connection.status === "error" && connection.lastErrorCode) {
    output.push({ eventKey: `connection-error:${connection.id}:${connection.lastErrorCode}`, kind: "sync_error" });
  }
  const stale = staleEvent(connection, now);
  if (stale) output.push(stale);
  return output;
}

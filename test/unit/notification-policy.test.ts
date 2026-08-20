import { describe, expect, it } from "vitest";
import { dueNotifications } from "../../src/notifications/policy";
import type { ConnectionRecord } from "../../src/storage/connection-repository";

function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "connection-1",
    sessionId: "session-1",
    validUntil: "2026-11-18T10:36:35.322Z",
    status: "authorized",
    lastSuccessAt: "2026-08-19T04:17:00.000Z",
    lastErrorCode: null,
    ...overrides,
  };
}

describe("notification policy", () => {
  it.each([
    ["2026-11-04T11:00:00.000Z", "consent_14_days"],
    ["2026-11-11T11:00:00.000Z", "consent_7_days"],
    ["2026-11-15T11:00:00.000Z", "consent_3_days"],
    ["2026-11-17T11:00:00.000Z", "consent_1_day"],
    ["2026-11-18T11:00:00.000Z", "consent_expired"],
  ])("selects the closest consent reminder at %s", (now, kind) => {
    expect(dueNotifications(connection(), new Date(now)).map((event) => event.kind)).toContain(kind);
  });

  it("reports a stale authorized connection once per 48-hour period", () => {
    const events = dueNotifications(connection({ lastSuccessAt: "2026-08-17T04:17:00.000Z" }), new Date("2026-08-20T04:17:00.000Z"));
    expect(events).toContainEqual({ eventKey: "stale:connection-1:1", kind: "sync_stale" });
  });

  it("reports connection errors and ignores revoked connections", () => {
    expect(dueNotifications(connection({ status: "error", lastErrorCode: "PROVIDER_ERROR" }), new Date("2026-08-20T04:17:00.000Z")))
      .toContainEqual({ eventKey: "connection-error:connection-1:PROVIDER_ERROR", kind: "sync_error" });
    expect(dueNotifications(connection({ status: "revoked" }), new Date("2026-08-20T04:17:00.000Z"))).toEqual([]);
  });
});

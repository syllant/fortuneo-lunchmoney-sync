import { describe, expect, it, vi } from "vitest";
import { startScheduledSync } from "../src/scheduling";

describe("free-plan scheduling", () => {
  it("does not create a Workflow while writes are disabled", async () => {
    const create = vi.fn(() => Promise.resolve({ id: "unexpected" }));
    const runId = await startScheduledSync(
      { scheduledTime: Date.parse("2026-08-14T04:17:00Z") },
      { SYNC_ENABLED: "false", SYNC_WORKFLOW: { create } },
    );
    expect(runId).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates one deterministic Workflow instance when writes are enabled", async () => {
    const create = vi.fn(() => Promise.resolve({ id: "scheduled-1786681020000" }));
    const runId = await startScheduledSync(
      { scheduledTime: 1_786_681_020_000 },
      { SYNC_ENABLED: "true", SYNC_WORKFLOW: { create } },
    );
    expect(runId).toBe("scheduled-1786681020000");
    expect(create).toHaveBeenCalledWith({
      id: "scheduled-1786681020000",
      params: { dryRun: false },
      retention: { successRetention: "1 day", errorRetention: "1 day" },
    });
  });
});

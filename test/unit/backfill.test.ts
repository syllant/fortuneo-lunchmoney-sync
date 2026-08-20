import { describe, expect, it } from "vitest";
import { backfillWindows, rollingWindow } from "../../src/sync/backfill";

describe("windows", () => {
  it("uses an inclusive rolling seven-day window", () => {
    expect(rollingWindow(new Date("2026-08-13T12:00:00Z"))).toEqual({ from: "2026-08-07", to: "2026-08-13" });
  });

  it("splits 90 days into resumable windows", () => {
    const windows = backfillWindows(new Date("2026-08-13T12:00:00Z"));
    expect(windows).toHaveLength(13);
    expect(windows.at(-1)).toEqual({ from: "2026-05-16", to: "2026-05-21" });
  });
});

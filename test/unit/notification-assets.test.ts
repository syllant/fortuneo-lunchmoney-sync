import { describe, expect, it } from "vitest";
import { NOTIFICATION_SERVICE_WORKER, NOTIFICATIONS_HTML, NOTIFICATIONS_JS } from "../../src/notifications/assets";

describe("notification assets", () => {
  it("publishes an English-only operator interface", () => {
    expect(NOTIFICATIONS_HTML).toContain('<html lang="en">');
    expect(NOTIFICATIONS_HTML).toContain("Enable notifications");
    expect(NOTIFICATIONS_JS).toContain('toLocaleString("en-GB")');
    expect(NOTIFICATION_SERVICE_WORKER).toContain("An action or review is required.");
  });
});

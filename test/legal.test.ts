import { describe, expect, it } from "vitest";
import { renderLegalPage } from "../src/legal";

describe("public legal pages", () => {
  it("publishes the approved contact and an accurate privacy scope", () => {
    const page = renderLegalPage("privacy", "operator@example.com");
    expect(page).toContain("operator@example.com");
    expect(page).toContain("personal, non-commercial application");
    expect(page).toContain("not stored in the application's Cloudflare D1 database");
    expect(page).not.toContain("ADMIN_PASSWORD");
  });

  it("states that the application is private and cannot initiate bank payments", () => {
    const page = renderLegalPage("terms", "operator@example.com");
    expect(page).toContain("not offered as a service to the public");
    expect(page).toContain("does not initiate bank payments or transfers");
    expect(page).toContain("operator@example.com");
  });

  it("escapes the deployment-specific contact value", () => {
    expect(renderLegalPage("privacy", '<script>alert("x")</script>')).not.toContain("<script>");
  });
});

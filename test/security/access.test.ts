import { describe, expect, it } from "vitest";
import { isPublicRequest, requireAccess, requireTrustedOrigin } from "../../src/security/access";

describe("administrative access", () => {
  const configuredPassword = "correct horse battery staple with extra entropy";

  it("fails closed without valid basic authentication in production", () => {
    expect(() => requireAccess(new Request("https://sync.example/status"), "production", configuredPassword)).toThrow("ACCESS_REQUIRED");
    const wrong = new Request("https://sync.example/status", { headers: { Authorization: `Basic ${btoa("operator:wrong")}` } });
    expect(() => requireAccess(wrong, "production", configuredPassword)).toThrow("ACCESS_REQUIRED");
  });

  it("fails closed when the password secret is missing or too short", () => {
    const request = new Request("https://sync.example/status", {
      headers: { Authorization: `Basic ${btoa("operator:undefined")}` },
    });
    expect(() => requireAccess(request, "production", undefined)).toThrow("ACCESS_REQUIRED");
    expect(() => requireAccess(request, "production", "too-short")).toThrow("ACCESS_REQUIRED");
  });

  it("allows the operator with the configured password", () => {
    const request = new Request("https://sync.example/status", {
      headers: { Authorization: `Basic ${btoa(`operator:${configuredPassword}`)}` },
    });
    expect(() => requireAccess(request, "production", configuredPassword)).not.toThrow();
  });

  it("allows local mock mode", () => {
    expect(() => requireAccess(new Request("http://localhost/status"), "mock", "")).not.toThrow();
  });

  it("exposes only GET callback, legal documents, and static notification assets without administrative authentication", () => {
    for (const pathname of ["/callback", "/privacy", "/terms", "/notifications.js", "/notifications.css", "/notification-sw.js", "/manifest.webmanifest"]) {
      expect(isPublicRequest(new Request(`https://sync.example${pathname}`))).toBe(true);
      expect(isPublicRequest(new Request(`https://sync.example${pathname}`, { method: "POST" }))).toBe(false);
    }
    expect(isPublicRequest(new Request("https://sync.example/status"))).toBe(false);
  });

  it("rejects explicit cross-site state-changing requests", () => {
    const crossOrigin = new Request("https://sync.example/disconnect", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    expect(() => requireTrustedOrigin(crossOrigin)).toThrow("INVALID_ORIGIN");
    expect(() => requireTrustedOrigin(new Request("https://sync.example/sync", { method: "POST" }))).not.toThrow();
  });
});

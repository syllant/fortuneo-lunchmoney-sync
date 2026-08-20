import { describe, expect, it } from "vitest";
import { hashOAuthState, newOAuthState } from "../../src/security/oauth-state";
import { constantTimeEqual } from "../../src/security/hmac";

describe("OAuth state", () => {
  it("contains 256 random bits and only stores a deterministic HMAC", async () => {
    const state = newOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const hash = await hashOAuthState("state-secret", state);
    expect(hash).toHaveLength(43);
    expect(hash).not.toContain(state);
    expect(await constantTimeEqual(hash, await hashOAuthState("state-secret", state))).toBe(true);
  });
});

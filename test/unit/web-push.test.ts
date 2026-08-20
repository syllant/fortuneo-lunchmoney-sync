import { createECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sendEmptyWebPush } from "../../src/notifications/web-push";

function decodeJson(part: string): unknown {
  const padded = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}

function encodeKey(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("VAPID Web Push", () => {
  it("sends an empty, short-lived, origin-bound VAPID request", async () => {
    const key = createECDH("prime256v1");
    key.generateKeys();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 201 })));
    const now = new Date("2026-08-20T10:00:00.000Z");
    const response = await sendEmptyWebPush("https://push.example.test/subscription/opaque", {
      publicKey: encodeKey(key.getPublicKey()),
      privateKey: encodeKey(key.getPrivateKey()),
      subject: "mailto:operator@example.test",
    }, now, fetcher);

    expect(response.status).toBe(201);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("TTL")).toBe("86400");
    const authorization = headers.get("Authorization") ?? "";
    const token = authorization.match(/^vapid t=([^,]+), k=/u)?.[1] ?? "";
    const parts = token.split(".");
    expect(decodeJson(parts[0] ?? "")).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decodeJson(parts[1] ?? "")).toEqual({
      aud: "https://push.example.test",
      exp: Math.floor(now.getTime() / 1_000) + 12 * 60 * 60,
      sub: "mailto:operator@example.test",
    });
    expect(parts[2]).toBeTruthy();
  });
});

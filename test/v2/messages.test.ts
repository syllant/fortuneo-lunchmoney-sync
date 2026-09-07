import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readNativeMessages, writeNativeMessage } from "../../packages/native-host/src/framing.js";
import { MAX_NATIVE_MESSAGE_BYTES, parseNativeRequest, parseSnapshot } from "../../packages/shared/src/messages.js";

describe("native messaging", () => {
  it("round trips little-endian framed JSON split across chunks", async () => {
    const stream = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    writeNativeMessage(output, { version: 2, type: "sync", requestId: "abc" });
    const framed = Buffer.concat(chunks);
    stream.write(framed.subarray(0, 3));
    stream.end(framed.subarray(3));
    const values = [];
    for await (const value of readNativeMessages(stream)) values.push(value);
    expect(values).toEqual([{ version: 2, type: "sync", requestId: "abc" }]);
  });

  it("rejects oversized frames and malformed schemas", async () => {
    const stream = new PassThrough();
    const header = Buffer.alloc(4); header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1);
    stream.end(header);
    await expect(async () => { for await (const _value of readNativeMessages(stream)) void _value; }).rejects.toThrow("NATIVE_MESSAGE_SIZE_INVALID");
    expect(() => parseNativeRequest({ version: 2, type: "configure", requestId: "x", token: "short", checkingAccountId: 1 })).toThrow("INVALID_CONFIGURATION");
    expect(parseNativeRequest({ version: 2, type: "configure", requestId: "x", checkingAccountId: 1 })).toEqual({ version: 2, type: "configure", requestId: "x", checkingAccountId: 1 });
    expect(parseNativeRequest({ version: 2, type: "configure", requestId: "x", checkingAccountId: 1, fortuneoAccessCode: "ABC123", fortuneoPassword: "secret" })).toEqual({ version: 2, type: "configure", requestId: "x", checkingAccountId: 1, fortuneoAccessCode: "ABC123", fortuneoPassword: "secret" });
    expect(() => parseNativeRequest({ version: 2, type: "configure", requestId: "x", checkingAccountId: 1, fortuneoAccessCode: "ABC123" })).toThrow("INVALID_CONFIGURATION");
    expect(() => parseNativeRequest({ version: 2, type: "sync", requestId: "x", unexpected: true })).toThrow("UNEXPECTED_MESSAGE_PROPERTY");
    expect(parseNativeRequest({ version: 2, type: "get-fortuneo-account-urls", requestId: "x" })).toEqual({ version: 2, type: "get-fortuneo-account-urls", requestId: "x" });
    expect(parseNativeRequest({ version: 2, type: "remember-fortuneo-account-url", requestId: "x", url: "https://mabanque.fortuneo.fr/mon-espace/banque/livret-a/account-id/solde" })).toMatchObject({ type: "remember-fortuneo-account-url" });
    expect(() => parseNativeRequest({ version: 2, type: "remember-fortuneo-account-url", requestId: "x", url: "https://example.com/account-id" })).toThrow("INVALID_FORTUNEO_ACCOUNT_URL");
  });

  it("accepts a savings-only snapshot", () => {
    expect(parseSnapshot({
      capturedAt: "2026-09-03T10:00:00.000Z",
      complete: false,
      accounts: [{ sourceId: "livret-a", kind: "savings", displayName: "Livret A", currency: "eur", balance: "1000", complete: false }],
      transactions: [],
      settlements: [],
    }).accounts[0]).toMatchObject({ kind: "savings", displayName: "Livret A" });
  });
});

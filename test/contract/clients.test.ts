import { describe, expect, it, vi } from "vitest";
import { EnableBankingClient } from "../../src/providers/enable-banking/client";
import { LunchMoneyClient } from "../../src/providers/lunch-money/client";
import { syntheticAccount } from "../fixtures/synthetic/enable-banking";

async function syntheticPrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/gu)?.join("\n");
  if (!body) throw new Error("Failed to encode synthetic private key");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

describe("Enable Banking contract", () => {
  it("invokes the platform fetch function without an object receiver", async () => {
    const receivers: unknown[] = [];
    const requests: RequestInit[] = [];
    const fetcher: typeof fetch = function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      receivers.push(this);
      requests.push(init ?? {});
      return Promise.resolve(Response.json({ url: "https://auth.enablebanking.test/start" }));
    };
    const client = new EnableBankingClient("https://api.enablebanking.test", {
      applicationId: "00000000-0000-4000-8000-000000000000",
      privateKey: await syntheticPrivateKey(),
    }, fetcher);

    await expect(client.startAuthorization({
      redirectUrl: "https://worker.test/callback",
      state: "synthetic-state",
      validUntil: "2026-11-12T00:00:00.000Z",
      bankName: "Synthetic Bank",
      bankCountry: "FR",
    })).resolves.toBe("https://auth.enablebanking.test/start");
    expect(receivers).toEqual([undefined]);
    const init = requests[0];
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(init.body)).toMatchObject({ language: "en" });
  });

  it("maps account details from the documented GET session response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access: { valid_until: "2026-11-12T00:00:00.000Z" },
      accounts: [syntheticAccount.uid],
      accounts_data: [syntheticAccount],
      status: "AUTHORIZED",
    }));
    const client = new EnableBankingClient("https://api.enablebanking.test", {
      applicationId: "00000000-0000-4000-8000-000000000000",
      privateKey: await syntheticPrivateKey(),
    }, fetcher);

    const session = await client.getSession("session-opaque-1");

    expect(session.sessionId).toBe("session-opaque-1");
    expect(session.accounts).toHaveLength(1);
    expect(session.accounts[0]).toMatchObject({
      providerAccountId: syntheticAccount.uid,
      identificationHash: syntheticAccount.identification_hash,
    });
  });
});

describe("Lunch Money v2 contract", () => {
  it("invokes the platform fetch function without an object receiver", async () => {
    const receivers: unknown[] = [];
    const fetcher: typeof fetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(Response.json({ manual_accounts: [] }));
    };
    const client = new LunchMoneyClient("https://api.lunchmoney.dev/v2", "synthetic-token", fetcher);

    await client.listAccounts();

    expect(receivers).toEqual([undefined]);
  });

  it("uses manual_accounts and never changes balance during transaction insert", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ transactions: [], skipped_duplicates: [] }), {
      status: 201, headers: { "Content-Type": "application/json" },
    }));
    const client = new LunchMoneyClient("https://api.lunchmoney.dev/v2", "synthetic-token", fetcher);
    await client.createTransactions([{ externalId: "opaque", accountId: 1, date: "2026-08-10", amount: "1.00", currency: "EUR", payee: "Synthetic", notes: null }]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.lunchmoney.dev/v2/transactions");
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(init.body)).toMatchObject({ skip_balance_update: true });
  });

  it("rejects oversized chunked responses without trusting Content-Length", async () => {
    const oversized = `{"manual_accounts":[],"padding":"${"x".repeat(2_000_000)}"}`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(oversized));
    const client = new LunchMoneyClient("https://api.lunchmoney.dev/v2", "synthetic-token", fetcher);

    await expect(client.listAccounts()).rejects.toThrow("LUNCH_MONEY_RESPONSE_TOO_LARGE");
  });
});

import { describe, expect, it } from "vitest";
import { KeychainStore } from "../../packages/native-host/src/keychain.js";

describe("KeychainStore", () => {
  it("treats security exit 44 as a missing item", async () => {
    const store = new KeychainStore(async () => { throw Object.assign(new Error("not found"), { code: 44 }); });
    await expect(store.getToken()).resolves.toBeNull();
  });

  it("maps other read failures to a non-sensitive code", async () => {
    const store = new KeychainStore(async () => { throw Object.assign(new Error("sensitive diagnostic"), { code: 1 }); });
    await expect(store.getToken()).rejects.toThrow("KEYCHAIN_READ_FAILED");
  });

  it("generates and stores a 256-bit key when none exists", async () => {
    const calls: string[][] = [];
    const store = new KeychainStore(async (args) => {
      calls.push(args);
      if (args[0] === "find-generic-password") throw Object.assign(new Error("not found"), { code: 44 });
      return "";
    });
    const key = await store.getOrCreateHmacKey();
    expect(key).toHaveLength(32);
    expect(calls.some((args) => args[0] === "add-generic-password" && Buffer.from(args.at(-1) ?? "", "base64").byteLength === 32)).toBe(true);
  });

  it("stores Fortuneo credentials as one Keychain item and reads them back", async () => {
    let stored: string | null = null;
    const store = new KeychainStore(async (args) => {
      if (args[0] === "add-generic-password") {
        stored = args.at(-1) ?? null;
        return "";
      }
      if (args[0] === "find-generic-password" && stored !== null) return stored;
      throw Object.assign(new Error("not found"), { code: 44 });
    });
    await store.setFortuneoCredentials("ABC123", "local-secret");
    await expect(store.getFortuneoCredentials()).resolves.toEqual({ accessCode: "ABC123", password: "local-secret" });
  });

  it("stores distinct Fortuneo account routes in Keychain", async () => {
    const values = new Map<string, string>();
    const store = new KeychainStore(async (args) => {
      const account = args[args.indexOf("-a") + 1] ?? "";
      if (args[0] === "add-generic-password") {
        values.set(account, args.at(-1) ?? "");
        return "";
      }
      if (args[0] === "find-generic-password" && values.has(account)) return values.get(account) ?? "";
      throw Object.assign(new Error("not found"), { code: 44 });
    });
    await store.rememberFortuneoAccountUrl("https://mabanque.fortuneo.fr/mon-espace/banque/courant/checking-id/solde");
    await store.rememberFortuneoAccountUrl("https://mabanque.fortuneo.fr/mon-espace/banque/livret-a/savings-id/solde");

    await expect(store.getFortuneoAccountUrls()).resolves.toEqual([
      "https://mabanque.fortuneo.fr/mon-espace/banque/courant/checking-id/solde",
      "https://mabanque.fortuneo.fr/mon-espace/banque/livret-a/savings-id/solde",
    ]);
  });
});

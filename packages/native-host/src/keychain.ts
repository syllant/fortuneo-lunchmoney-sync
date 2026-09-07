import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "com.sylvaindurand.fortuneo-lunchmoney-sync";
const TOKEN_ACCOUNT = "lunch-money-api-token";
const HMAC_ACCOUNT = "identity-hmac-key";
const CHECKING_ACCOUNT = "lunch-money-checking-account-id";
const FORTUNEO_CREDENTIALS_ACCOUNT = "fortuneo-login-credentials";
const FORTUNEO_ACCOUNT_URLS_ACCOUNT = "fortuneo-account-urls";
export type SecurityRunner = (args: string[]) => Promise<string>;

export class KeychainStore {
  constructor(private readonly run: SecurityRunner = runSecurity) {}

  async getToken(): Promise<string | null> {
    return this.find(TOKEN_ACCOUNT);
  }

  async setToken(token: string): Promise<void> {
    await this.store(TOKEN_ACCOUNT, token);
  }

  async getCheckingAccountId(): Promise<number | null> {
    const value = await this.find(CHECKING_ACCOUNT);
    if (value === null || !/^\d+$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  async setCheckingAccountId(id: number): Promise<void> {
    await this.store(CHECKING_ACCOUNT, String(id));
  }

  async getFortuneoCredentials(): Promise<{ accessCode: string; password: string } | null> {
    const value = await this.find(FORTUNEO_CREDENTIALS_ACCOUNT);
    if (value === null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || !("accessCode" in parsed) || !("password" in parsed)) throw new Error("invalid");
      const { accessCode, password } = parsed as Record<string, unknown>;
      if (typeof accessCode !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(accessCode) || typeof password !== "string" || password.length < 1 || password.length > 128 || /[\r\n\0]/.test(password)) throw new Error("invalid");
      return { accessCode, password };
    } catch {
      throw new Error("KEYCHAIN_FORTUNEO_CREDENTIALS_INVALID");
    }
  }

  async setFortuneoCredentials(accessCode: string, password: string): Promise<void> {
    await this.store(FORTUNEO_CREDENTIALS_ACCOUNT, JSON.stringify({ accessCode, password }));
  }

  async getFortuneoAccountUrls(): Promise<string[]> {
    const value = await this.find(FORTUNEO_ACCOUNT_URLS_ACCOUNT);
    if (value === null) return [];
    try {
      const urls: unknown = JSON.parse(value);
      if (!Array.isArray(urls) || urls.length > 10 || !urls.every((url) => typeof url === "string" && isFortuneoAccountUrl(url))) throw new Error("invalid");
      return urls;
    } catch {
      throw new Error("KEYCHAIN_FORTUNEO_ACCOUNT_URLS_INVALID");
    }
  }

  async rememberFortuneoAccountUrl(url: string): Promise<void> {
    if (!isFortuneoAccountUrl(url)) throw new Error("INVALID_FORTUNEO_ACCOUNT_URL");
    const current = await this.getFortuneoAccountUrls();
    const identity = fortuneoAccountIdentity(url);
    const next = [...current.filter((candidate) => fortuneoAccountIdentity(candidate) !== identity), url].slice(-10);
    await this.store(FORTUNEO_ACCOUNT_URLS_ACCOUNT, JSON.stringify(next));
  }

  async getOrCreateHmacKey(): Promise<Buffer> {
    const current = await this.find(HMAC_ACCOUNT);
    if (current !== null) {
      const key = Buffer.from(current, "base64");
      if (key.byteLength >= 32) return key;
      throw new Error("KEYCHAIN_HMAC_KEY_INVALID");
    }
    const key = randomBytes(32);
    await this.store(HMAC_ACCOUNT, key.toString("base64"));
    return key;
  }

  async clear(): Promise<void> {
    for (const account of [TOKEN_ACCOUNT, HMAC_ACCOUNT, CHECKING_ACCOUNT, FORTUNEO_CREDENTIALS_ACCOUNT, FORTUNEO_ACCOUNT_URLS_ACCOUNT]) await this.remove(account);
  }

  private async find(account: string): Promise<string | null> {
    try {
      return (await this.run(["find-generic-password", "-s", SERVICE, "-a", account, "-w"])).trim();
    } catch (error) {
      if (hasExitCode(error, 44)) return null;
      throw new Error("KEYCHAIN_READ_FAILED", { cause: error });
    }
  }

  private async store(account: string, value: string): Promise<void> {
    try {
      await this.run(["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value]);
    } catch (error) {
      throw new Error("KEYCHAIN_WRITE_FAILED", { cause: error });
    }
  }

  private async remove(account: string): Promise<void> {
    try {
      await this.run(["delete-generic-password", "-s", SERVICE, "-a", account]);
    } catch (error) {
      if (!hasExitCode(error, 44)) throw new Error("KEYCHAIN_DELETE_FAILED", { cause: error });
    }
  }
}

function hasExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export const KEYCHAIN_SERVICE = SERVICE;

async function runSecurity(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/security", args, { encoding: "utf8", maxBuffer: 8192 });
  return stdout;
}

function isFortuneoAccountUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://mabanque.fortuneo.fr" && /^\/mon-espace\/banque\/[^/]+\/[^/?#]+(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function fortuneoAccountIdentity(value: string): string | null {
  try {
    return new URL(value).pathname.match(/^\/mon-espace\/banque\/[^/]+\/([^/?#]+)(?:\/|$)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

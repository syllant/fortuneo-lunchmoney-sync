import { createHmac, timingSafeEqual } from "node:crypto";

export class IdentityService {
  constructor(private readonly key: Buffer) {
    if (key.byteLength < 32) throw new Error("HMAC_KEY_TOO_SHORT");
  }

  digest(namespace: string, ...parts: string[]): string {
    const hmac = createHmac("sha256", this.key);
    hmac.update(namespace);
    for (const part of parts) {
      hmac.update("\0");
      hmac.update(part.normalize("NFKC"));
    }
    return hmac.digest("base64url");
  }

  accountExternalId(sourceId: string): string {
    return `lmfa:v2:${this.digest("account", sourceId)}`;
  }

  transactionExternalId(sourceId: string): string {
    return `lmft:v2:${this.digest("transaction", sourceId)}`;
  }

  equals(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  }
}

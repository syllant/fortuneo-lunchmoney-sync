import { DomainError } from "../domain/errors";
import { base64url } from "./hmac";

const encoder = new TextEncoder();

function decodePem(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/u, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/u, "").replace(/\s/gu, "");
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
  } catch (error) {
    throw new DomainError("INVALID_ENABLE_BANKING_PRIVATE_KEY", { cause: error });
  }
}

export async function createEnableBankingJwt(
  applicationId: string,
  privateKeyPem: string,
  now = new Date(),
): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "RS256", kid: applicationId })));
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = base64url(encoder.encode(JSON.stringify({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: issuedAt,
    exp: issuedAt + 300,
  })));
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8", decodePem(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
    const unsigned = `${header}.${payload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
    return `${unsigned}.${base64url(signature)}`;
  } catch (error) {
    throw new DomainError("INVALID_ENABLE_BANKING_PRIVATE_KEY", { cause: error });
  }
}

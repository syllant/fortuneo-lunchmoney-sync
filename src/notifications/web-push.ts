const encoder = new TextEncoder();

export type VapidConfiguration = Readonly<{
  publicKey: string;
  privateKey: string;
  subject: string;
}>;

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("INVALID_VAPID_KEY");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

async function authorization(endpoint: string, config: VapidConfiguration, now: Date): Promise<string> {
  const publicBytes = decodeBase64Url(config.publicKey);
  const privateBytes = decodeBase64Url(config.privateKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) throw new Error("INVALID_VAPID_KEY");
  const x = encodeBase64Url(publicBytes.slice(1, 33));
  const y = encodeBase64Url(publicBytes.slice(33, 65));
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d: config.privateKey, ext: false, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1_000) + 12 * 60 * 60,
    sub: config.subject,
  })));
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${config.publicKey}`;
}

export async function sendEmptyWebPush(
  endpoint: string,
  config: VapidConfiguration,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return fetcher(endpoint, {
    method: "POST",
    headers: {
      Authorization: await authorization(endpoint, config, now),
      TTL: "86400",
      Urgency: "normal",
    },
  });
}

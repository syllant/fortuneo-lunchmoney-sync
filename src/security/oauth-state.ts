import { hmacSha256, base64url } from "./hmac";

export function newOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function hashOAuthState(secret: string, state: string): Promise<string> {
  return hmacSha256(secret, `oauth-state:v1\0${state}`);
}

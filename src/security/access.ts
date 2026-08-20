import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors";

export function isPublicRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const pathname = new URL(request.url).pathname;
  return pathname === "/callback" || pathname === "/privacy" || pathname === "/terms"
    || pathname === "/notifications.js" || pathname === "/notifications.css"
    || pathname === "/notification-sw.js" || pathname === "/manifest.webmanifest";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function requireTrustedOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== new URL(request.url).origin) || fetchSite === "cross-site") {
    throw new DomainError("INVALID_ORIGIN");
  }
}

export function requireAccess(request: Request, environment: string, adminPassword: string | undefined): void {
  if (environment === "mock") return;
  if (typeof adminPassword !== "string" || adminPassword.length < 32) {
    throw new DomainError("ACCESS_REQUIRED");
  }
  const authorization = request.headers.get("Authorization") ?? "";
  const prefix = "Basic ";
  let credentials: string;
  try {
    credentials = authorization.startsWith(prefix) ? atob(authorization.slice(prefix.length)) : "";
  } catch {
    credentials = "";
  }
  const separator = credentials.indexOf(":");
  const username = separator >= 0 ? credentials.slice(0, separator) : "";
  const password = separator >= 0 ? credentials.slice(separator + 1) : "";
  const usernameMatches = constantTimeEqual(username, "operator");
  const passwordMatches = constantTimeEqual(password, adminPassword);
  if (!usernameMatches || !passwordMatches) {
    throw new DomainError("ACCESS_REQUIRED");
  }
}

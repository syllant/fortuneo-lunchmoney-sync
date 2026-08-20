import { DomainError, errorCode } from "./domain/errors";
import type { AppEnv } from "./env";
import { enableBanking } from "./factories";
import { renderLegalPage } from "./legal";
import {
  NOTIFICATION_MANIFEST,
  NOTIFICATION_SERVICE_WORKER,
  NOTIFICATIONS_CSS,
  NOTIFICATIONS_HTML,
  NOTIFICATIONS_JS,
  notificationsPageHeaders,
} from "./notifications/assets";
import { deliverNotification, notifyDueConditions } from "./notifications/service";
import { logError, logEvent } from "./observability/events";
import { startScheduledSync } from "./scheduling";
import { isPublicRequest, requireAccess, requireTrustedOrigin } from "./security/access";
import { hashOAuthState, newOAuthState } from "./security/oauth-state";
import { ConnectionRepository } from "./storage/connection-repository";
import { OAuthStateRepository } from "./storage/oauth-state-repository";
import { PushSubscriptionRepository } from "./storage/push-subscription-repository";
import { SyncRunRepository } from "./storage/sync-run-repository";

export { DailySyncWorkflow } from "./workflow";

const SECURITY_HEADERS: HeadersInit = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: SECURITY_HEADERS });
}

function legalPage(kind: "privacy" | "terms", contactEmail: string): Response {
  return new Response(renderLegalPage(kind, contactEmail), {
    headers: { ...SECURITY_HEADERS, "Content-Language": "en", "Content-Type": "text/html; charset=utf-8" },
  });
}

function textAsset(body: string, contentType: string, extraHeaders: HeadersInit = {}): Response {
  return new Response(body, {
    headers: { ...SECURITY_HEADERS, ...extraHeaders, "Content-Type": contentType },
  });
}

function requireSameOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin) throw new DomainError("INVALID_ORIGIN");
}

async function readEndpoint(request: Request): Promise<string> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
  }
  if (!request.body) throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 8_192) {
      await reader.cancel();
      throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  let endpoint: unknown;
  try {
    endpoint = (JSON.parse(body) as { endpoint?: unknown }).endpoint;
  } catch {
    throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
  }
  if (typeof endpoint !== "string" || endpoint.length > 4_096) throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new DomainError("INVALID_NOTIFICATION_SUBSCRIPTION");
  return url.href;
}

function validateDate(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new DomainError("INVALID_DATE_RANGE");
  return value;
}

async function connect(env: AppEnv): Promise<Response> {
  const state = newOAuthState();
  const stateHmac = await hashOAuthState(env.OAUTH_STATE_HMAC_KEY, state);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  await new OAuthStateRepository(env.DB).create(stateHmac, expiresAt);
  const validUntil = new Date(now.getTime() + 90 * 24 * 60 * 60_000).toISOString();
  const redirect = await enableBanking(env).startAuthorization({
    redirectUrl: env.CALLBACK_URL,
    state,
    validUntil,
    bankName: env.BANK_NAME,
    bankCountry: env.BANK_COUNTRY,
  });
  return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: redirect } });
}

async function callback(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || state.length > 512 || code.length > 4096) throw new DomainError("INVALID_OAUTH_CALLBACK");
  const stateHmac = await hashOAuthState(env.OAUTH_STATE_HMAC_KEY, state);
  const now = new Date().toISOString();
  if (!(await new OAuthStateRepository(env.DB).consume(stateHmac, now))) throw new DomainError("INVALID_OR_REPLAYED_OAUTH_STATE");
  const session = await enableBanking(env).authorizeSession(code);
  await new ConnectionRepository(env.DB).saveAuthorized(session.sessionId, session.validUntil);
  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/notifications" } });
}

async function startSync(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") !== "false";
  if (!dryRun && env.SYNC_ENABLED !== "true") throw new DomainError("SYNC_DISABLED");
  const from = validateDate(url.searchParams.get("from"));
  const to = validateDate(url.searchParams.get("to"));
  if ((from && !to) || (!from && to) || (from && to && from > to)) throw new DomainError("INVALID_DATE_RANGE");
  const params: { dryRun: boolean; from?: string; to?: string } = { dryRun };
  if (from && to) { params.from = from; params.to = to; }
  const instance = await env.SYNC_WORKFLOW.create({
    id: crypto.randomUUID(),
    params,
    retention: { successRetention: "1 day", errorRetention: "1 day" },
  });
  return json({ accepted: true, dry_run: dryRun, run_id: instance.id }, 202);
}

async function status(env: AppEnv): Promise<Response> {
  const [connection, lastRun] = await Promise.all([
    new ConnectionRepository(env.DB).latest(),
    new SyncRunRepository(env.DB).last(),
  ]);
  const expired = connection !== null && connection.status !== "revoked" && Date.parse(connection.validUntil) <= Date.now();
  const connectionStatus = expired ? "expired" : connection?.status ?? "not_authorized";
  return json({
    connection: connectionStatus,
    consent_expires_at: connection?.validUntil ?? null,
    renewal_required: connectionStatus === "expired",
    last_success_at: connection?.lastSuccessAt ?? null,
    last_run_status: lastRun?.status ?? null,
    created_count: lastRun?.createdCount ?? 0,
    updated_count: lastRun?.updatedCount ?? 0,
  });
}

async function subscribeNotifications(request: Request, env: AppEnv): Promise<Response> {
  requireSameOrigin(request);
  const endpoint = await readEndpoint(request);
  await new PushSubscriptionRepository(env.DB).upsert(endpoint, new Date().toISOString());
  return json({ subscribed: true });
}

async function unsubscribeNotifications(request: Request, env: AppEnv): Promise<Response> {
  requireSameOrigin(request);
  const endpoint = await readEndpoint(request);
  await new PushSubscriptionRepository(env.DB).remove(endpoint);
  return json({ subscribed: false });
}

async function testNotification(request: Request, env: AppEnv): Promise<Response> {
  requireSameOrigin(request);
  const delivered = await deliverNotification(env, {
    eventKey: `test:${crypto.randomUUID()}`,
    kind: "test",
  });
  return json({ delivered }, delivered > 0 ? 202 : 409);
}

async function disconnect(env: AppEnv): Promise<Response> {
  const repository = new ConnectionRepository(env.DB);
  const connection = await repository.latest();
  if (!connection) return json({ disconnected: true });
  await enableBanking(env).closeSession(connection.sessionId);
  await repository.markRevoked(connection.id);
  return json({ disconnected: true });
}

async function route(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!isPublicRequest(request)) requireAccess(request, env.ENVIRONMENT, env.ADMIN_PASSWORD);
  if (request.method === "POST") requireTrustedOrigin(request);
  if (request.method === "GET" && url.pathname === "/privacy") return legalPage("privacy", env.DATA_PROTECTION_EMAIL);
  if (request.method === "GET" && url.pathname === "/terms") return legalPage("terms", env.DATA_PROTECTION_EMAIL);
  if (request.method === "GET" && url.pathname === "/notifications.css") return textAsset(NOTIFICATIONS_CSS, "text/css; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/notifications.js") {
    const script = NOTIFICATIONS_JS.replace(JSON.stringify("__VAPID_PUBLIC_KEY__"), JSON.stringify(env.WEB_PUSH_VAPID_PUBLIC_KEY));
    return textAsset(script, "text/javascript; charset=utf-8");
  }
  if (request.method === "GET" && url.pathname === "/notification-sw.js") {
    return textAsset(NOTIFICATION_SERVICE_WORKER, "text/javascript; charset=utf-8", { "Service-Worker-Allowed": "/" });
  }
  if (request.method === "GET" && url.pathname === "/manifest.webmanifest") return textAsset(NOTIFICATION_MANIFEST, "application/manifest+json; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/connect") return connect(env);
  if (request.method === "GET" && url.pathname === "/callback") return callback(request, env);
  if (request.method === "POST" && url.pathname === "/sync") return startSync(request, env);
  if (request.method === "GET" && url.pathname === "/status") return status(env);
  if (request.method === "GET" && url.pathname === "/notifications") {
    return new Response(NOTIFICATIONS_HTML, { headers: { ...notificationsPageHeaders(), "Content-Language": "en", "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method === "POST" && url.pathname === "/notifications/subscribe") return subscribeNotifications(request, env);
  if (request.method === "POST" && url.pathname === "/notifications/unsubscribe") return unsubscribeNotifications(request, env);
  if (request.method === "POST" && url.pathname === "/notifications/test") return testNotification(request, env);
  if (request.method === "POST" && url.pathname === "/disconnect") return disconnect(env);
  return json({ error: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      const response = await route(request, env);
      logEvent({ event: "request_completed", status: response.status.toString() });
      return response;
    } catch (error) {
      const code = errorCode(error);
      logError({ event: "request_failed", error_code: code });
      const statusCode = code === "ACCESS_REQUIRED" ? 401
        : code.includes("INVALID") || code.includes("REPLAYED") ? 400
          : code === "SYNC_DISABLED" || code === "SYNC_ALREADY_RUNNING" ? 409
            : code === "CONNECTION_NOT_AUTHORIZED" || code === "CONSENT_EXPIRED" ? 428
              : 502;
      const response = json({ error: code }, statusCode);
      if (code === "ACCESS_REQUIRED") response.headers.set("WWW-Authenticate", 'Basic realm="Fortuneo sync", charset="UTF-8"');
      return response;
    }
  },
  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    try {
      await notifyDueConditions(env, new Date(controller.scheduledTime));
    } catch {
      logError({ event: "notification_failed", error_code: "PUSH_NOTIFICATION_ERROR" });
    }
    await startScheduledSync(controller, env);
  },
} satisfies ExportedHandler<AppEnv>;

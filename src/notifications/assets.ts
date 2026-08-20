const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export const NOTIFICATIONS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#12372a">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/notifications.css">
  <title>Fortuneo → Lunch Money</title>
</head>
<body>
  <main>
    <h1>Fortuneo → Lunch Money</h1>
    <p id="summary">Loading status…</p>
    <dl>
      <dt>Consent</dt><dd id="consent">—</dd>
      <dt>Last successful sync</dt><dd id="last-success">—</dd>
      <dt>Last run</dt><dd id="last-run">—</dd>
      <dt>Notifications</dt><dd id="notification-state">—</dd>
    </dl>
    <div class="actions">
      <button id="subscribe" type="button">Enable notifications</button>
      <button id="test" type="button">Test notification</button>
      <button id="unsubscribe" type="button" class="secondary">Disable</button>
      <a href="/connect">Renew Fortuneo consent</a>
    </div>
    <p id="message" role="status" aria-live="polite"></p>
    <p class="note">Notifications are generic and contain no banking data. This page remains protected by operator authentication.</p>
  </main>
  <script src="/notifications.js" defer></script>
</body>
</html>`;

export const NOTIFICATIONS_CSS = `:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f6f7f3;color:#17201b}body{margin:0}main{max-width:42rem;margin:3rem auto;padding:2rem;background:white;border-radius:1rem;box-shadow:0 .5rem 2rem #12372a18}h1{margin-top:0;color:#12372a}dl{display:grid;grid-template-columns:minmax(10rem,1fr) 1.5fr;gap:.75rem 1.5rem;padding:1rem 0}dt{font-weight:650}dd{margin:0}.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}button,a{font:inherit;border:0;border-radius:.5rem;padding:.7rem 1rem;background:#176b4d;color:white;text-decoration:none;cursor:pointer}.secondary{background:#5e6963}button:disabled{opacity:.5;cursor:not-allowed}.note{margin-top:2rem;color:#5e6963;font-size:.9rem}#message{min-height:1.5rem;font-weight:600}@media(max-width:35rem){main{margin:0;padding:1.25rem;min-height:100vh;border-radius:0}dl{grid-template-columns:1fr}dt{margin-top:.5rem}}`;

export const NOTIFICATIONS_JS = `const publicKey = ${JSON.stringify("__VAPID_PUBLIC_KEY__")};
const byId = (id) => document.getElementById(id);
const decodeKey = (value) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return bytes;
};
const show = (message) => { byId("message").textContent = message; };
const registration = () => navigator.serviceWorker.register("/notification-sw.js", { scope: "/" });
const currentSubscription = async () => (await registration()).pushManager.getSubscription();
const postEndpoint = async (path, endpoint) => {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
  if (!response.ok) throw new Error("The request failed.");
};
const refreshNotificationState = async () => {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) {
    byId("notification-state").textContent = "Not supported by this browser";
    for (const id of ["subscribe", "test", "unsubscribe"]) byId(id).disabled = true;
    return;
  }
  const subscription = await currentSubscription();
  byId("notification-state").textContent = subscription ? "Enabled" : Notification.permission === "denied" ? "Blocked by the browser" : "Disabled";
  byId("test").disabled = !subscription;
  byId("unsubscribe").disabled = !subscription;
};
const refreshStatus = async () => {
  const response = await fetch("/status", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Unable to load status.");
  const status = await response.json();
  byId("summary").textContent = status.renewal_required ? "Fortuneo consent must be renewed." : status.connection === "authorized" ? "Daily synchronization is active." : "The Fortuneo connection needs attention.";
  byId("consent").textContent = status.consent_expires_at ? new Date(status.consent_expires_at).toLocaleString("en-GB") : "Not authorized";
  byId("last-success").textContent = status.last_success_at ? new Date(status.last_success_at).toLocaleString("en-GB") : "Never";
  byId("last-run").textContent = status.last_run_status || "None";
};
byId("subscribe").addEventListener("click", async () => {
  try {
    if (!publicKey) throw new Error("Notifications are not configured.");
    const worker = await registration();
    const existing = await worker.pushManager.getSubscription();
    const subscription = existing || await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
    await postEndpoint("/notifications/subscribe", subscription.endpoint);
    show("Notifications enabled.");
    await refreshNotificationState();
  } catch (error) { show(error instanceof Error ? error.message : "Unable to enable notifications."); }
});
byId("unsubscribe").addEventListener("click", async () => {
  try {
    const subscription = await currentSubscription();
    if (subscription) {
      await postEndpoint("/notifications/unsubscribe", subscription.endpoint);
      await subscription.unsubscribe();
    }
    show("Notifications disabled.");
    await refreshNotificationState();
  } catch { show("Unable to disable notifications."); }
});
byId("test").addEventListener("click", async () => {
  try {
    const response = await fetch("/notifications/test", { method: "POST" });
    if (!response.ok) throw new Error();
    show("Test notification sent.");
  } catch { show("Unable to send the test notification."); }
});
Promise.all([refreshStatus(), refreshNotificationState()]).catch(() => show("Unable to load the complete page."));`;

export const NOTIFICATION_SERVICE_WORKER = `self.addEventListener("push", (event) => {
  event.waitUntil(self.registration.showNotification("Fortuneo → Lunch Money", {
    body: "An action or review is required.",
    tag: "fortuneo-lunchmoney-sync",
    renotify: true,
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/notifications"));
});`;

export const NOTIFICATION_MANIFEST = JSON.stringify({
  name: "Fortuneo → Lunch Money",
  short_name: "Fortuneo Sync",
  start_url: "/notifications",
  display: "standalone",
  background_color: "#f6f7f3",
  theme_color: "#12372a",
});

export function notificationsPageHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": PAGE_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

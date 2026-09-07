const existing = document.getElementById("lmft-banner-host");
const host = existing ?? document.createElement("div");
host.id = "lmft-banner-host";
if (!existing) document.documentElement.append(host);
const root = host.shadowRoot ?? host.attachShadow({ mode: "closed" });
root.innerHTML = `
  <style>
    :host{all:initial}[hidden]{display:none!important}.bar{position:fixed;z-index:2147483647;right:20px;bottom:20px;width:min(390px,calc(100vw - 40px));box-sizing:border-box;padding:14px 16px;border-radius:12px;background:#102820;color:#f7fbf9;box-shadow:0 12px 35px #0004;font:13px/1.4 system-ui,sans-serif}.title{font-weight:700;margin-bottom:3px}.message{color:#dcebe5}.progress{height:7px;margin-top:10px;overflow:hidden;border-radius:999px;background:#355249}.progress span{display:block;width:2%;height:100%;border-radius:inherit;background:#d7f26b;transition:width .25s linear}.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}button{border:0;border-radius:7px;padding:7px 10px;background:#d7f26b;color:#173028;font:600 12px system-ui;cursor:pointer}button.secondary{background:#e8efec}.warnings{margin-top:7px;color:#ffd28a;font-size:11px}.success{border:1px solid #72ca9a}.warning,.review{border:1px solid #f2ad57}.error{border:1px solid #d96a6a}.running{border:1px solid #77aee8}
  </style>
  <section class="bar idle" role="status" aria-live="polite"><div class="title">Fortuneo sync</div><div class="message">Ready</div><div class="progress" hidden><span></span></div><div class="warnings"></div><div class="actions"><button data-action="dismiss">Close</button><button class="secondary" data-action="cancel-sync" hidden>Stop</button><button class="secondary" data-action="reconnect-fortuneo" hidden>Sign in to Fortuneo</button></div></section>`;
const bar = root.querySelector(".bar");
const titleNode = root.querySelector(".title");
const messageNode = root.querySelector(".message");
const warningsNode = root.querySelector(".warnings");
const progressNode = root.querySelector(".progress");
const progressBar = progressNode.querySelector("span");
const closeButton = root.querySelector('[data-action="dismiss"]');
const stopButton = root.querySelector('[data-action="cancel-sync"]');
const reconnectButton = root.querySelector('[data-action="reconnect-fortuneo"]');
root.querySelector(".actions").addEventListener("click", (event) => {
  const action = event.target?.dataset?.action;
  if (action === "dismiss") {
    dismissedUpdatedAt = renderedState?.updatedAt ?? null;
    bar.hidden = true;
    return;
  }
  if (action) void chrome.runtime.sendMessage({ type: action });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "ui-state") render(message.uiState);
});

void chrome.runtime.sendMessage({ type: "get-state" }).then((state) => render(state.uiState));
void chrome.runtime.sendMessage({ type: "lunch-money-ready" });
watchLunchMoneyNavigation();
setInterval(() => renderProgress(), 250);

let renderedState;
let dismissedUpdatedAt = null;
let progressRunStartedAt = null;
let displayedProgressPercent = 2;

function render(state) {
  if (!state) return;
  const runStartedAt = Number(state.startedAt);
  if (Number.isFinite(runStartedAt) && runStartedAt !== progressRunStartedAt) {
    progressRunStartedAt = runStartedAt;
    displayedProgressPercent = 2;
  }
  renderedState = state;
  const needsAuth = state.status === "needs-auth" && !["prepare", "write"].includes(state.progressStep);
  const running = state.status === "running" || (state.status === "needs-auth" && !needsAuth);
  const relevant = state.status === "running" || state.status === "needs-auth" || state.status === "warning" || state.status === "review" || state.status === "error" || (state.status === "success" && state.operation === "preview");
  bar.hidden = !relevant || (dismissedUpdatedAt !== null && dismissedUpdatedAt === state.updatedAt);
  bar.className = `bar ${running ? "running" : state.status ?? "idle"}`;
  const details = state.details ?? state.preview;
  titleNode.textContent = running ? "Fortuneo sync in progress" : "Fortuneo sync";
  messageNode.textContent = running
    ? progressMessage(state.message, state.progressStep, state.operation, state.fortuneoReadStep)
    : (details && state.operation === "preview" ? "Changes ready — open the extension to review and confirm." : state.message ?? "Ready");
  progressNode.hidden = !running;
  closeButton.hidden = running || needsAuth;
  stopButton.hidden = !["running", "needs-auth"].includes(state.status);
  reconnectButton.hidden = !needsAuth || !/sign in|security check|connect Fortuneo|login form/i.test(state.message ?? "");
  warningsNode.textContent = Array.isArray(state.warnings) && state.warnings.length ? `Warning: ${state.warnings.join(", ")}` : "";
  renderProgress();
}

function progressMessage(message, step, operation, fortuneoReadStep) {
  const readLabel = ({ account: "account and balance", transactions: "recent and pending transactions", deferred: "deferred cards", details: "merchant details" })[fortuneoReadStep] ?? "Fortuneo";
  const labels = { setup: "Step 1 of 4 · Checking setup…", connection: "Step 2 of 4 · Connecting to Fortuneo…", fortuneo: `Step 3 of 4 · Reading ${readLabel}…`, prepare: operation === "preview" ? "Step 4 of 4 · Preparing setup preview…" : "Step 4 of 4 · Syncing Lunch Money…", write: "Step 4 of 4 · Syncing Lunch Money…" };
  if (labels[step]) return labels[step];
  if (/Fortuneo/i.test(message ?? "")) return "Connecting and reading Fortuneo…";
  if (/Lunch Money|Reconciling|transactions|balances|planned changes/i.test(message ?? "")) return "Updating Lunch Money…";
  return "Preparing the sync…";
}

function renderProgress() {
  const readFloor = ({ account: 45, transactions: 55, deferred: 65, details: 72 })[renderedState?.fortuneoReadStep] ?? 42;
  const phaseFloor = ({ setup: 5, connection: 25, fortuneo: readFloor, prepare: 82, write: 92 })[renderedState?.progressStep] ?? 2;
  const updatedAt = Date.parse(renderedState?.updatedAt ?? "");
  const gentleAdvance = Number.isFinite(updatedAt) ? Math.min(5, Math.max(0, (Date.now() - updatedAt) / 2_000)) : 0;
  displayedProgressPercent = Math.max(displayedProgressPercent, Math.min(97, phaseFloor + gentleAdvance));
  progressBar.style.width = `${displayedProgressPercent}%`;
}

function watchLunchMoneyNavigation() {
  let previousUrl = location.href;
  let wasOverview = isOverviewUrl(previousUrl);

  const checkRoute = () => {
    const currentUrl = location.href;
    if (currentUrl === previousUrl) return;
    previousUrl = currentUrl;
    const isOverview = isOverviewUrl(currentUrl);
    if (isOverview && !wasOverview) void chrome.runtime.sendMessage({ type: "sync-if-due" });
    wasOverview = isOverview;
  };

  // Lunch Money is a single-page app, so its internal navigation does not
  // reload this content script. Route events cover browser navigation while
  // the lightweight URL check covers client-side pushState navigation.
  addEventListener("popstate", checkRoute);
  addEventListener("hashchange", checkRoute);
  addEventListener("pageshow", checkRoute);
  setInterval(checkRoute, 750);

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target) return;
    const destination = new URL(target.href, location.href);
    if (destination.origin === location.origin && isOverviewUrl(destination.href)) {
      void chrome.runtime.sendMessage({ type: "sync-if-due" });
    }
  }, { capture: true });
}

function isOverviewUrl(value) {
  const path = new URL(value).pathname.replace(/\/+$/, "") || "/";
  return path === "/" || path === "/overview" || path.startsWith("/overview/");
}

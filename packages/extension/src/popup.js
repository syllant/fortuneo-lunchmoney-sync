const elements = Object.fromEntries(["message", "daily-title", "daily-detail", "daily-sync", "sync", "stop", "reconnect", "fortuneo-access-code", "fortuneo-password", "token", "load-accounts", "account", "configure", "warnings", "preview", "preview-title", "preview-count", "preview-progress", "progress-bar", "progress-steps", "preview-results", "account-details", "account-count", "account-summary-count", "accounts-empty", "account-preview", "transaction-details", "transaction-count", "transaction-preview", "preview-truncated", "sync-suggestion", "auth-debug", "auth-debug-log", "copy-debug"].map((id) => [id, document.getElementById(id)]));

elements["daily-sync"].addEventListener("click", () => action("sync-now"));
const previewButton = document.getElementById("dry-run");
previewButton.addEventListener("click", () => action("dry-run"));
elements.sync.addEventListener("click", () => action("confirm-sync"));
elements.stop.addEventListener("click", () => action("cancel-sync"));
elements.reconnect.addEventListener("click", () => action("reconnect-fortuneo"));
elements["load-accounts"].addEventListener("click", loadAccounts);
elements.configure.addEventListener("click", configure);
elements["copy-debug"].addEventListener("click", copyDebugTrace);
for (const tab of document.querySelectorAll("[data-tab]")) tab.addEventListener("click", () => selectTab(tab.dataset.tab));
chrome.storage.onChanged.addListener((changes) => {
  if (!appState) return;
  for (const [key, change] of Object.entries(changes)) appState[key] = change.newValue;
  render(appState.uiState, appState);
});

let renderedState;
let appState;
let progressRunStartedAt = null;
let displayedProgressPercent = 2;
setInterval(() => { if (renderedState?.deadlineAt) renderProgress(renderedState); }, 250);

void initializePopup();

async function initializePopup() {
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  appState = state;
  render(state.uiState, state);
  void loadAccounts(true);
}

async function action(type) {
  setBusy(true);
  const response = await chrome.runtime.sendMessage({ type });
  setBusy(false);
  if (!response?.ok) showError(response?.error ?? "ACTION_FAILED");
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  appState = state;
  render(state.uiState, state);
}

async function loadAccounts(silent = false) {
  setBusy(true);
  const response = await chrome.runtime.sendMessage({ type: "list-accounts", token: elements.token.value || undefined });
  setBusy(false);
  if (response?.type !== "accounts") {
    if (!silent) showError(response?.error ?? "ACCOUNT_LIST_FAILED");
    return;
  }
  elements.account.replaceChildren(new Option("Choose an account", ""), ...response.accounts.map((account) => new Option(`${account.name}${account.institution ? ` — ${account.institution}` : ""}`, String(account.id))));
  if (response.checkingAccountId) elements.account.value = String(response.checkingAccountId);
}

async function configure() {
  const token = elements.token.value;
  const fortuneoAccessCode = elements["fortuneo-access-code"].value.trim();
  const fortuneoPassword = elements["fortuneo-password"].value;
  if (Boolean(fortuneoAccessCode) !== Boolean(fortuneoPassword)) return showError("FORTUNEO_IDENTIFIER_AND_PASSWORD_REQUIRED");
  const checkingAccountId = Number(elements.account.value);
  if (!checkingAccountId) return showError("CHECKING_ACCOUNT_REQUIRED");
  setBusy(true);
  const response = await chrome.runtime.sendMessage({ type: "configure", ...(token ? { token } : {}), ...(fortuneoAccessCode ? { fortuneoAccessCode, fortuneoPassword } : {}), checkingAccountId });
  setBusy(false);
  if (response?.type !== "result" || !response.ok) return showError(response?.summary?.message ?? response?.error ?? "CONFIGURATION_FAILED");
  elements.token.value = "";
  elements["fortuneo-access-code"].value = "";
  elements["fortuneo-password"].value = "";
  elements.message.hidden = false;
  elements.message.textContent = response.summary.message;
}

function render(state, storageState = appState) {
  if (!state) return;
  const runStartedAt = Number(state.startedAt);
  if (Number.isFinite(runStartedAt) && runStartedAt !== progressRunStartedAt) {
    progressRunStartedAt = runStartedAt;
    displayedProgressPercent = 2;
  }
  renderedState = state;
  renderMessage(state);
  const active = ["running", "needs-auth"].includes(state.status);
  previewButton.disabled = active;
  elements.stop.disabled = !active;
  elements.sync.disabled = !["success", "warning"].includes(state.status) || state.operation !== "preview";
  renderDailyStatus(state, storageState);
  elements.reconnect.hidden = !fortuneoSignInRequired(state);
  elements.warnings.replaceChildren(...(state.warnings ?? []).map((warning) => Object.assign(document.createElement("li"), { textContent: warning })));
  renderDebugTrace(state.authTrace);
  renderPreview(state);
}

function renderDebugTrace(trace) {
  const visible = Array.isArray(trace) && trace.length > 0;
  elements["auth-debug"].hidden = !visible;
  elements["auth-debug-log"].textContent = visible ? trace.map(formatTraceEntry).join("\n") : "";
}

function formatTraceEntry(entry) {
  const details = Object.entries(entry ?? {}).filter(([key]) => !["at", "event"].includes(key)).map(([key, value]) => `${key}=${String(value)}`).join(" ");
  return `+${(Number(entry?.at ?? 0) / 1000).toFixed(1)}s ${entry?.event ?? "unknown"}${details ? ` ${details}` : ""}`;
}

async function copyDebugTrace() {
  await navigator.clipboard.writeText(elements["auth-debug-log"].textContent ?? "");
  elements["copy-debug"].textContent = "Copied";
  setTimeout(() => { elements["copy-debug"].textContent = "Copy diagnostics"; }, 1200);
}

function renderDailyStatus(state, storageState) {
  const needsAuth = authenticationRequired(state);
  const effectivelyRunning = state.status === "running" || (state.status === "needs-auth" && !needsAuth);
  const syncing = effectivelyRunning && state.operation === "sync";
  const previewing = effectivelyRunning && state.operation === "preview";
  const syncedToday = storageState?.lastSuccessfulLocalDate === localDate();
  if (syncing) {
    elements["daily-title"].textContent = "Syncing today";
    elements["daily-detail"].textContent = "Automatic sync is in progress.";
  } else if (previewing) {
    elements["daily-title"].textContent = "Preparing sync";
    elements["daily-detail"].textContent = "Review the changes before confirming.";
  } else if (needsAuth) {
    elements["daily-title"].textContent = "Action required";
    elements["daily-detail"].textContent = state.message ?? "Sign in to continue.";
  } else if (state.status === "success" && state.operation === "preview") {
    elements["daily-title"].textContent = "Ready to sync";
    elements["daily-detail"].textContent = "Review the transactions and confirm below.";
  } else if (state.status === "warning" && state.operation === "preview") {
    const count = state.warnings?.length ?? 1;
    elements["daily-title"].textContent = `Preview ready with ${count} warning${count === 1 ? "" : "s"}`;
    elements["daily-detail"].textContent = state.message ?? "Review the warning and proposed changes below.";
  } else if (state.status === "warning") {
    const count = state.warnings?.length ?? 1;
    elements["daily-title"].textContent = `Completed with ${count} warning${count === 1 ? "" : "s"}`;
    elements["daily-detail"].textContent = state.message ?? "Review the warning below.";
  } else if (["review", "error"].includes(state.status)) {
    elements["daily-title"].textContent = "Needs attention";
    elements["daily-detail"].textContent = state.message ?? "Review the error below.";
  } else if (syncedToday) {
    elements["daily-title"].textContent = "Synced today";
    elements["daily-detail"].textContent = storageState?.lastSuccessfulAt ? `Last successful sync at ${formatTime(storageState.lastSuccessfulAt)}.` : "Today’s automatic sync completed.";
  } else {
    elements["daily-title"].textContent = "Not synced today";
    elements["daily-detail"].textContent = storageState?.lastSuccessfulAt
      ? `Last successful sync: ${formatDateTime(storageState.lastSuccessfulAt)}.`
      : "No successful sync yet.";
  }
  elements["daily-sync"].textContent = ["success", "warning"].includes(state.status) && state.operation === "preview" ? "Start over" : (syncedToday ? "Sync again" : "Sync now");
  elements["daily-sync"].disabled = effectivelyRunning || needsAuth;
}

function authenticationRequired(state) {
  return state.status === "needs-auth" && !["prepare", "write"].includes(state.progressStep);
}

function fortuneoSignInRequired(state) {
  return authenticationRequired(state) && /sign in|security check|connect Fortuneo|login form/i.test(state.message ?? "");
}

function renderPreview(state) {
  const preview = state.details ?? state.preview;
  const running = ["running", "needs-auth"].includes(state.status);
  const visible = preview && Array.isArray(preview.accounts) && Array.isArray(preview.transactions);
  elements.preview.hidden = !visible && !running;
  elements["preview-progress"].hidden = !running;
  elements["preview-results"].hidden = !visible;
  elements["preview-title"].textContent = running ? (state.operation === "sync" ? "Syncing" : "Preparing sync") : (state.operation === "sync" ? "Last sync details" : "Proposed changes");
  document.body.classList.toggle("has-preview", Boolean(visible));
  elements["accounts-empty"].hidden = Boolean(visible);
  elements["account-details"].hidden = !visible;
  renderProgress(state);
  if (!visible) return;
  elements["preview-count"].textContent = `${preview.transactions.length} transaction${preview.transactions.length === 1 ? "" : "s"}`;
  elements["account-count"].textContent = String(preview.accounts.length);
  elements["account-summary-count"].textContent = String(preview.accounts.length);
  elements["transaction-count"].textContent = String(preview.transactions.length);
  const completed = state.operation === "sync" && !running;
  elements["account-preview"].replaceChildren(...preview.accounts.map((account) => {
    const row = document.createElement("tr");
    const values = [text(account.sourceName), badge(accountActionLabel(account.action, completed), account.action), text(account.targetName), text(formatMoney(account.balance, account.currency))];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 3) cell.className = "amount";
      cell.append(value);
      row.append(cell);
    });
    return row;
  }));
  elements["transaction-preview"].replaceChildren(...preview.transactions.map((transaction) => {
    const row = document.createElement("tr");
    const values = [badge(transactionActionLabel(transaction.action, completed), transaction.action), text(transaction.issue ?? "—"), badge(transaction.lifecycle), text(transaction.date), text(transaction.merchant), text(transaction.category ?? "—"), text(formatMoney(transaction.amount, transaction.currency)), text(transaction.targetAccount)];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 6) cell.className = "amount";
      cell.append(value);
      row.append(cell);
    });
    return row;
  }));
  elements["preview-truncated"].textContent = preview.truncatedTransactions > 0 ? `${preview.truncatedTransactions} additional transactions are not shown.` : "";
  elements["sync-suggestion"].hidden = !["success", "warning"].includes(state.status) || state.operation !== "preview";
}

function renderProgress(state) {
  displayedProgressPercent = progressPercent(state, displayedProgressPercent);
  elements["progress-bar"].style.width = `${displayedProgressPercent}%`;
  const steps = [
    ["setup", "Check setup"],
    ["connection", "Connection"],
    ["fortuneo", "Read Fortuneo"],
    ["lunch-money", state.operation === "preview" ? "Prepare setup preview" : "Sync Lunch Money"],
  ];
  const progressStep = ["prepare", "write"].includes(state.progressStep) ? "lunch-money" : (state.progressStep ?? (state.status === "needs-auth" ? "connection" : "setup"));
  const current = Math.max(0, steps.findIndex(([key]) => key === progressStep));
  elements["progress-steps"].replaceChildren(...steps.map(([key, label], index) => {
    const item = document.createElement("li");
    item.className = index < current ? "complete" : (index === current ? "current" : "pending");
    item.dataset.step = key;
    item.append(document.createTextNode(label));
    if (key === "fortuneo" && state.fortuneoReadStep) {
      const detail = document.createElement("small");
      detail.textContent = fortuneoReadStepLabel(state.fortuneoReadStep);
      item.append(detail);
    }
    return item;
  }));
}

function progressPercent(state, previousPercent, now = Date.now()) {
  const readFloor = ({ account: 45, transactions: 55, deferred: 65, details: 72 })[state?.fortuneoReadStep] ?? 42;
  const phaseFloor = ({ setup: 5, connection: 25, fortuneo: readFloor, prepare: 82, write: 92 })[state?.progressStep] ?? 2;
  const updatedAt = Date.parse(state?.updatedAt ?? "");
  const gentleAdvance = Number.isFinite(updatedAt) ? Math.min(5, Math.max(0, (now - updatedAt) / 2_000)) : 0;
  return Math.max(previousPercent, Math.min(97, phaseFloor + gentleAdvance));
}

function fortuneoReadStepLabel(step) {
  return ({ account: "Account & balance", transactions: "Recent & pending", deferred: "Deferred cards", details: "Merchant details" })[step] ?? "";
}

function accountActionLabel(action, completed) {
  const labels = completed
    ? { create: "Created", connect: "Connected", existing: "Already linked", review: "Needs review" }
    : { create: "Will create", connect: "Will connect", existing: "Already linked", review: "Needs review" };
  return labels[action] ?? action;
}

function transactionActionLabel(action, completed) {
  const labels = completed
    ? { create: "Created", update: "Updated", unchanged: "Unchanged", skipped: "Skipped" }
    : { create: "Will create", update: "Will update", unchanged: "Unchanged", skipped: "Skipped" };
  return labels[action] ?? action;
}

function badge(value, style = value) {
  const span = document.createElement("span");
  span.className = `preview-badge ${String(style).toLowerCase()}`;
  span.textContent = value;
  return span;
}

function text(value) {
  return document.createTextNode(String(value ?? ""));
}

function formatMoney(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${String(currency).toUpperCase()}`;
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: String(currency).toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${String(currency).toUpperCase()}`;
  }
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date) : "unknown time";
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "unknown time";
}

function localDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function renderMessage(state) {
  const visible = false;
  elements.message.hidden = !visible;
  elements.message.textContent = visible ? (state.message ?? "Action required") : "";
}

function showError(code) {
  elements.message.hidden = false;
  elements.message.textContent = code;
  elements["daily-title"].textContent = "Needs attention";
  elements["daily-detail"].textContent = code;
}

function selectTab(name) {
  for (const tab of document.querySelectorAll("[data-tab]")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".tab-panel")) panel.hidden = panel.id !== `tab-${name}`;
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
}

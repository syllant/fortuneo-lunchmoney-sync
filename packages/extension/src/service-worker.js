import { adaptFortuneo } from "./fortuneo-adapter.js";

const NATIVE_HOST = "com.sylvaindurand.fortuneo_lunchmoney_sync";
const FORTUNEO_LOGIN = "https://mabanque.fortuneo.fr/mon-espace";
const FORTUNEO_TAB_URL = "https://mabanque.fortuneo.fr/*";
const FORTUNEO_COLLECTOR_VERSION = 15;
const FORTUNEO_COLLECT_MESSAGE = `collect-snapshot-v${FORTUNEO_COLLECTOR_VERSION}`;
const LUNCH_MONEY_URLS = ["https://my.lunchmoney.app/*", "https://beta.lunchmoney.app/*"];
const DAILY_STATUS_ALARM = "refresh-daily-status";
const SYNC_RETRY_ALARM = "retry-daily-sync";
const SYNC_IDLE_TIMEOUT_MS = 60_000;
const SYNC_RETRY_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_SETTINGS = { lastSuccessfulLocalDate: null, lastSuccessfulAt: null, lastSyncAttemptLocalDate: null, lastSyncAttemptAt: null, setupPreviewConfirmed: false, uiState: { status: "idle", message: "Ready", warnings: [] } };

let activeSync = null;
let syncStartPending = false;
const initialized = initializeStorage();

chrome.runtime.onInstalled.addListener(() => {
  void initialized.then(async () => {
    const tabs = await chrome.tabs.query({ url: LUNCH_MONEY_URLS });
    if (tabs.length > 0) await syncIfDue();
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_STATUS_ALARM) {
    void refreshActionIndicator();
    scheduleDailyStatusRefresh();
  } else if (alarm.name === SYNC_RETRY_ALARM) {
    void initialized.then(() => syncIfDue());
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const observedUrl = changeInfo.url ?? tab.url;
  if (changeInfo.status === "complete" && isLunchMoneyUrl(observedUrl)) void initialized.then(() => syncIfDue());
  if (!activeSync?.waitingForFortuneo) return;
  if (tabId === activeSync.fortuneoTabId) traceAuth(activeSync, "tab-update", { status: changeInfo.status ?? "url", page: fortuneoPageKind(changeInfo.url ?? tab.url) });
  if (tabId === activeSync.fortuneoTabId && changeInfo.status === "complete") void collectAndForwardSnapshot(activeSync.requestId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncForLunchMoneyTab(tabId);
});

async function syncForLunchMoneyTab(tabId) {
  await initialized;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (isLunchMoneyUrl(tab?.url)) await syncIfDue();
}

function isLunchMoneyUrl(value) {
  try {
    return ["https://my.lunchmoney.app", "https://beta.lunchmoney.app"].includes(new URL(value).origin);
  } catch {
    return false;
  }
}

async function initializeStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const persisted = await chrome.storage.local.get(["setupPreviewConfirmed", "lastSuccessfulAt"]);
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  // Remove financial review data persisted by earlier versions.
  current.uiState = DEFAULT_SETTINGS.uiState;
  if (persisted.setupPreviewConfirmed === undefined && persisted.lastSuccessfulAt) current.setupPreviewConfirmed = true;
  await chrome.storage.local.set(current);
  const session = await chrome.storage.session.get({ uiState: DEFAULT_SETTINGS.uiState });
  // A restarted worker no longer owns the native port from the previous run.
  if (["running", "needs-auth"].includes(session.uiState?.status)) {
    session.uiState = DEFAULT_SETTINGS.uiState;
    await chrome.storage.session.set(session);
  }
  const fortuneoTabs = await chrome.tabs.query({ url: [FORTUNEO_TAB_URL] });
  for (const tab of fortuneoTabs) if (isFortuneoAccountUrl(tab.url)) await rememberFortuneoAccountUrl(tab.url);
  await chrome.storage.local.remove(["endpointPaths", "fortuneoAutoAuthBlocked", "fortuneoAutoAuthRevision"]);
  await updateActionIndicator(session.uiState?.status ?? "idle", session.uiState?.operation ?? null, current.lastSuccessfulLocalDate, session.uiState?.warnings?.length ?? 0);
  scheduleDailyStatusRefresh();
  await scheduleSyncRetries();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: safeCode(error) }));
  return true;
});

function isAllowedSender(type, sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (!sender.tab && sender.url === chrome.runtime.getURL("popup.html")) return true;
  if (sender.frameId !== 0) return false;
  if (isLunchMoneyUrl(sender.url)) return ["lunch-money-ready", "sync-if-due", "sync-now", "cancel-sync", "reconnect-fortuneo", "get-state"].includes(type);
  try {
    return new URL(sender.url).origin === "https://mabanque.fortuneo.fr"
      && ["fortuneo-ready", "fortuneo-read-progress"].includes(type);
  } catch {
    return false;
  }
}

async function readSettings() {
  const state = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const { uiState } = await chrome.storage.session.get({ uiState: DEFAULT_SETTINGS.uiState });
  return { ...state, uiState };
}

async function handleMessage(message, _sender) {
  await initialized;
  if (!message || typeof message !== "object" || typeof message.type !== "string") return { ok: false, error: "INVALID_MESSAGE" };
  if (!isAllowedSender(message.type, _sender)) return { ok: false, error: "UNAUTHORIZED_MESSAGE" };
  switch (message.type) {
    case "lunch-money-ready":
      await syncIfDue();
      return { ok: true };
    case "sync-if-due":
      return { ok: true, started: await syncIfDue() };
    case "sync-now":
    {
      const { setupPreviewConfirmed } = await readSettings();
      await startSync(setupPreviewConfirmed ? "sync" : "dry-run");
      return { ok: true };
    }
    case "confirm-sync": {
      const { uiState } = await readSettings();
      const { confirmedPreviewSnapshot } = await chrome.storage.session.get("confirmedPreviewSnapshot");
      const previewAge = Date.now() - Date.parse(uiState?.updatedAt ?? "");
      if (!["success", "warning"].includes(uiState?.status) || uiState?.operation !== "preview" || !Number.isFinite(previewAge) || previewAge > 10 * 60_000 || !confirmedPreviewSnapshot) return { ok: false, error: "SYNC_REVIEW_REQUIRED" };
      await startSync("sync", confirmedPreviewSnapshot);
      return { ok: true };
    }
    case "dry-run":
      await startSync("dry-run");
      return { ok: true };
    case "cancel-sync":
      await cancelSync();
      return { ok: true };
    case "reconnect-fortuneo":
      await chrome.tabs.create({ url: FORTUNEO_LOGIN, active: true });
      return { ok: true };
    case "get-state": {
      const state = await readSettings();
      await updateActionIndicator(state.uiState?.status ?? "idle", state.uiState?.operation ?? null, state.lastSuccessfulLocalDate, state.uiState?.warnings?.length ?? 0);
      return state;
    }
    case "list-accounts":
      return nativeOneShot({ version: 2, type: "list-accounts", requestId: crypto.randomUUID(), ...(message.token ? { token: validateToken(message.token) } : {}) }, "accounts");
    case "configure":
    {
      const hasFortuneoCredentials = message.fortuneoAccessCode !== undefined || message.fortuneoPassword !== undefined;
      const request = {
        version: 2,
        type: "configure",
        requestId: crypto.randomUUID(),
        ...(message.token ? { token: validateToken(message.token) } : {}),
        checkingAccountId: validateId(message.checkingAccountId),
        ...(hasFortuneoCredentials ? { fortuneoAccessCode: validateFortuneoAccessCode(message.fortuneoAccessCode), fortuneoPassword: validateFortuneoPassword(message.fortuneoPassword) } : {}),
      };
      const response = await nativeOneShot(request, "result");
      if (hasFortuneoCredentials && response?.type === "result" && response.ok) {
        if (activeSync?.waitingForAuthentication) {
          activeSync.authIssue = null;
          await collectAndForwardSnapshot(activeSync.requestId);
        }
      }
      if (response?.type === "result" && response.ok) await chrome.storage.local.set({ setupPreviewConfirmed: false });
      return response;
    }
    case "fortuneo-ready":
      if (typeof _sender.url === "string" && isFortuneoAccountUrl(_sender.url)) await rememberFortuneoAccountUrl(_sender.url);
      if (activeSync?.waitingForFortuneo) await collectAndForwardSnapshot(activeSync.requestId);
      return { ok: true };
    case "fortuneo-read-progress": {
      const step = ["account", "transactions", "deferred", "details"].includes(message.step) ? message.step : null;
      const fromActiveFortuneoTab = activeSync && _sender.tab?.id === activeSync.fortuneoTabId && typeof _sender.url === "string" && _sender.url.startsWith("https://mabanque.fortuneo.fr/");
      if (!step || !fromActiveFortuneoTab || activeSync.progressStep !== "fortuneo") return { ok: false };
      activeSync.fortuneoReadStep = step;
      refreshSyncTimeout(activeSync);
      traceAuth(activeSync, "fortuneo-read", { step });
      await setUi("running", `[3/4] ${fortuneoReadLabel(step)}…`, []);
      return { ok: true };
    }
    default:
      return { ok: false, error: "UNKNOWN_MESSAGE" };
  }
}

async function syncIfDue() {
  const { lastSuccessfulLocalDate, lastSyncAttemptAt, lastSyncAttemptVersion, setupPreviewConfirmed } = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, lastSyncAttemptVersion: null });
  const lastAttemptAge = Date.now() - Date.parse(lastSyncAttemptAt ?? "");
  const attemptedRecently = lastSyncAttemptVersion === chrome.runtime.getManifest().version
    && Number.isFinite(lastAttemptAge) && lastAttemptAge >= 0 && lastAttemptAge < SYNC_RETRY_COOLDOWN_MS;
  if (!setupPreviewConfirmed || lastSuccessfulLocalDate === localDate() || attemptedRecently || activeSync || syncStartPending) return false;
  return startSync("sync-if-due");
}

async function startSync(type, confirmedSnapshot = null) {
  if (activeSync || syncStartPending) return false;
  syncStartPending = true;
  let startupStage = "initializing";
  let startedSync = null;
  try {
    startupStage = "recording-attempt";
    if (type !== "dry-run") await chrome.storage.local.set({ lastSyncAttemptLocalDate: localDate(), lastSyncAttemptAt: new Date().toISOString(), lastSyncAttemptVersion: chrome.runtime.getManifest().version });
    if (!confirmedSnapshot) {
      startupStage = "checking-credentials";
      const credentials = await nativeOneShot({ version: 2, type: "get-fortuneo-credentials", requestId: crypto.randomUUID() }, "fortuneo-credentials");
      if (credentials?.type !== "fortuneo-credentials") {
        const code = credentials?.error ?? "NATIVE_HOST_UNAVAILABLE";
        await setUi("error", code, [code], null, type === "dry-run" ? "preview" : "sync");
        return false;
      }
      if (!credentials.available) {
        await setUi("needs-auth", "No Fortuneo credentials are stored. Add them in Setup before syncing.", ["FORTUNEO_CREDENTIALS_REQUIRED"], null, type === "dry-run" ? "preview" : "sync");
        return false;
      }
    }
    startupStage = "reading-account-routes";
    const [knownAccountsResponse, [focusedTab]] = await Promise.all([
      nativeOneShot({ version: 2, type: "get-fortuneo-account-urls", requestId: crypto.randomUUID() }, "fortuneo-account-urls"),
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
    const requestedFortuneoUrl = canonicalFortuneoAccountUrl(focusedTab?.url);
    const requestedFortuneoTabId = requestedFortuneoUrl && focusedTab?.id !== undefined ? focusedTab.id : null;
    const knownFortuneoAccountUrls = knownAccountsResponse?.type === "fortuneo-account-urls" ? knownAccountsResponse.urls : [];
    const accountTargets = uniqueFortuneoAccountUrls([requestedFortuneoUrl, ...knownFortuneoAccountUrls]);
    const requestId = crypto.randomUUID();
    startupStage = "opening-native-host";
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    const startedAt = Date.now();
    const { uiState } = await readSettings();
    const previewIsRecent = Number.isFinite(Date.parse(uiState?.updatedAt ?? "")) && startedAt - Date.parse(uiState.updatedAt) < 10 * 60_000;
    const retainedDetails = type === "sync" && uiState?.operation === "preview" && previewIsRecent ? uiState.details ?? uiState.preview ?? null : null;
    if (type === "dry-run") await chrome.storage.session.remove("confirmedPreviewSnapshot");
    activeSync = { requestId, port, dryRun: type === "dry-run", confirmedSnapshot, snapshot: null, snapshots: [], waitingForFortuneo: false, waitingForAuthentication: false, autoAuthAttempted: false, authIssue: null, collecting: false, loginProbeId: null, payloads: [], observedPages: new Set(), resourceCandidates: 0, fortuneoDiagnostics: null, retainedDetails, startedAt, timeoutStartedAt: startedAt, deadlineAt: startedAt + SYNC_IDLE_TIMEOUT_MS, waitTimer: null, handshakeTimer: null, authFallbackTimer: null, fortuneoTabId: null, fortuneoTabCreated: false, requestedFortuneoUrl: accountTargets[0] ?? requestedFortuneoUrl, requestedFortuneoTabId, accountTargets, accountTargetIndex: 0, dedicatedFortuneoTab: accountTargets.length > 1 || (accountTargets.length === 1 && requestedFortuneoTabId === null), targetNavigationAttempted: false, progressStep: "setup", fortuneoReadStep: null, authTrace: [], nativeMessageQueue: Promise.resolve() };
    startedSync = activeSync;
    traceAuth(activeSync, "sync-start", { operation: type });
    startupStage = "publishing-start-state";
    await setUi("running", "[1/4] Checking local setup…", [], retainedDetails);
    scheduleSyncTimeout(activeSync);
    activeSync.handshakeTimer = setTimeout(() => {
      if (activeSync?.requestId !== requestId) return;
      const stalled = activeSync;
      activeSync = null;
      clearFortuneoWait(stalled);
      stalled.port.disconnect();
      void stopFortuneoCapture(stalled, true);
      void setUi("error", "The native helper did not respond", ["NATIVE_HOST_NO_RESPONSE"], null, stalled.dryRun ? "preview" : "sync");
    }, 10_000);
    port.onMessage.addListener((message) => {
      const sync = activeSync;
      if (!sync || sync.requestId !== requestId) return;
      if (sync.handshakeTimer) {
        clearTimeout(sync.handshakeTimer);
        sync.handshakeTimer = null;
      }
      // Chrome delivers native messages in order, but an async listener does
      // not await the previous handler. Preserve that order through setUi so
      // a slow progress update cannot overwrite the terminal result state.
      void enqueueNativeMessage(sync, message);
    });
    port.onDisconnect.addListener(() => {
      if (!activeSync || activeSync.requestId !== requestId) return;
      const error = chrome.runtime.lastError?.message ? "NATIVE_HOST_DISCONNECTED" : "NATIVE_HOST_STOPPED";
      void setUi("error", error, [error]);
      const stopped = activeSync;
      clearFortuneoWait(stopped);
      activeSync = null;
      void stopFortuneoCapture(stopped, true);
    });
    startupStage = "starting-native-sync";
    port.postMessage({ version: 2, type, requestId });
    return true;
  } catch (error) {
    if (startedSync && activeSync === startedSync) {
      activeSync = null;
      clearFortuneoWait(startedSync);
      startedSync.port.disconnect();
    }
    await reportStartupFailure(type, startupStage, error);
    return false;
  } finally {
    syncStartPending = false;
  }
}

async function reportStartupFailure(type, stage, error) {
  const code = chromeErrorCode(error);
  const kind = internalErrorKind(error);
  const location = internalErrorLocation(error);
  const trace = [{ at: 0, event: "startup-error", stage, result: code, kind, location }];
  const phase = startupStageLabel(stage);
  await setUi("error", `Sync could not start during ${phase}: ${code} (${kind} at ${location}).`, [code], null, type === "dry-run" ? "preview" : "sync", trace);
}

function startupStageLabel(stage) {
  return ({
    initializing: "initialization",
    "recording-attempt": "retry-state recording",
    "checking-credentials": "the native credential check",
    "reading-account-routes": "the saved Fortuneo account read",
    "opening-native-host": "native helper startup",
    "publishing-start-state": "status publication",
    "starting-native-sync": "native sync startup",
  })[stage] ?? String(stage).replaceAll("-", " ");
}

function enqueueNativeMessage(sync, message) {
  sync.nativeMessageQueue = sync.nativeMessageQueue
    .then(() => handleNativeMessage(message))
    .catch((error) => failActiveSync(sync.requestId, error));
  return sync.nativeMessageQueue;
}

async function handleNativeMessage(message) {
  if (!activeSync || message?.requestId !== activeSync.requestId || message?.version !== 2) return;
  refreshSyncTimeout(activeSync);
  const resultCode = message.type === "result" && typeof message.summary?.message === "string" && /^[A-Z0-9_]+$/.test(message.summary.message)
    ? message.summary.message
    : null;
  traceAuth(activeSync, "native-message", { type: message.type ?? "unknown", ...(typeof message.phase === "string" ? { phase: message.phase } : {}), ...(resultCode ? { result: resultCode } : {}) });
  if (message.type === "snapshot") {
    if (activeSync.confirmedSnapshot) {
      activeSync.progressStep = "prepare";
      await setUi("running", "[4/4] Using the confirmed changes…", []);
      activeSync.port.postMessage({ version: 2, type: "snapshot", requestId: message.requestId, snapshot: activeSync.confirmedSnapshot });
    } else {
      activeSync.progressStep = "connection";
      await setUi("running", "[2/4] Connecting to Fortuneo…", []);
      await collectAndForwardSnapshot(message.requestId);
    }
  } else if (message.type === "progress") {
    activeSync.progressStep = progressStepForPhase(message.phase);
    await setUi("running", phaseLabel(message.phase), []);
  } else if (message.type === "details") {
    activeSync.progressStep = "write";
    activeSync.retainedDetails = message.details;
    await setUi("running", "[4/4] Applying the planned changes…", [], message.details);
  } else if (message.type === "auth-required") {
    await setUi("needs-auth", `Connect ${message.provider === "fortuneo" ? "Fortuneo" : "Lunch Money"}`, []);
    if (message.provider === "lunch-money") {
      const stopped = activeSync;
      const port = stopped.port;
      clearFortuneoWait(stopped);
      activeSync = null;
      port.disconnect();
      await stopFortuneoCapture(stopped, true);
    }
  } else if (message.type === "result") {
    // Claim the sync synchronously before the first await. The native host may
    // close its port immediately after writing the result; onDisconnect must
    // not turn an already completed sync back into an error (or leave the UI
    // on its last running state while both handlers race).
    const completed = activeSync;
    clearFortuneoWait(completed);
    activeSync = null;
    const deferredDetailFailures = Number(completed.fortuneoDiagnostics?.deferredDetailFailures ?? 0);
    const details = message.summary?.details ?? message.summary?.preview ?? null;
    const nativeWarnings = Array.isArray(message.summary?.warnings) ? message.summary.warnings : [];
    const { reportedCardReviewKeys = [] } = await chrome.storage.local.get("reportedCardReviewKeys");
    const reviewNotification = cardReviewNotification(nativeWarnings, message.summary?.unresolvedCardReviewKeys, reportedCardReviewKeys, message.dryRun);
    const warnings = reviewNotification.warnings;
    const completedOk = message.ok || (Boolean(details) && nativeWarnings.length > 0 && warnings.length === 0);
    const completedWithWarnings = Boolean(details) && warnings.length > 0;
    const status = completedWithWarnings ? "warning" : completedOk ? "success" : "review";
    const warningCount = new Set(warnings).size;
    const automaticRetryNote = deferredDetailFailures > 0
      ? ` ${deferredDetailFailures} deferred transaction detail${deferredDetailFailures === 1 ? "" : "s"} will be retried automatically during the next daily sync.`
      : "";
    const resultMessage = !message.ok && !details
      ? syncFailureLabel(message.summary)
      : message.dryRun
        ? (details ? (completedWithWarnings ? `Preview ready with ${warningCount} warning${warningCount === 1 ? "" : "s"}.` : `Review the changes below.${automaticRetryNote}`) : summaryLabel(message.summary, true, completed.fortuneoDiagnostics))
        : (completedWithWarnings ? `Sync complete with ${warningCount} warning${warningCount === 1 ? "" : "s"}.` : completedOk ? `${syncCompletionLabel(details)}${automaticRetryNote}` : syncFailureLabel(message.summary));
    if (message.dryRun && Boolean(details) && completed.snapshot) await chrome.storage.session.set({ confirmedPreviewSnapshot: completed.snapshot });
    else if (!message.dryRun || !message.ok) await chrome.storage.session.remove("confirmedPreviewSnapshot");
    if (Boolean(details) && !message.dryRun) await chrome.storage.local.set({ ...(reviewNotification.keys ? { reportedCardReviewKeys: reviewNotification.keys } : {}), lastSuccessfulLocalDate: localDate(), lastSuccessfulAt: new Date().toISOString(), setupPreviewConfirmed: true });
    await setUi(status, resultMessage, warnings, details, message.dryRun ? "preview" : "sync");
    const port = completed.port;
    port.disconnect();
    await stopFortuneoCapture(completed, true);
  }
}

async function collectAndForwardSnapshot(requestId) {
  if (!activeSync || activeSync.requestId !== requestId) return;
  if (activeSync.collecting) return;
  activeSync.collecting = true;
  const fortuneoTab = await getOrCreateFortuneoTab();
  const tab = fortuneoTab.tab;
  if (fortuneoTab.created) activeSync.fortuneoTabCreated = true;
  activeSync.fortuneoTabId = tab.id ?? null;
  traceAuth(activeSync, "tab-selected", { page: fortuneoPageKind(tab.url) });
  if (tab.id === undefined) throw new Error("FORTUNEO_TAB_UNAVAILABLE");
  await waitForFortuneoTabReady(tab.id, fortuneoTab.created);
  if (!activeSync || activeSync.requestId !== requestId) return;
  const readyTab = await chrome.tabs.get(tab.id);
  if (readyTab.status === "loading") {
    activeSync.collecting = false;
    activeSync.waitingForFortuneo = true;
    return;
  }
  tab.url = readyTab.url;
  if (isFortuneoAccountUrl(tab.url)) clearAuthFallback(activeSync);
  const currentAccountIdentity = fortuneoAccountIdentity(tab.url);
  const requestedAccountIdentity = fortuneoAccountIdentity(activeSync.requestedFortuneoUrl);
  if (requestedAccountIdentity && currentAccountIdentity && requestedAccountIdentity !== currentAccountIdentity && !activeSync.targetNavigationAttempted) {
    activeSync.targetNavigationAttempted = true;
    activeSync.collecting = false;
    activeSync.waitingForFortuneo = true;
    traceAuth(activeSync, "target-account-restore", { result: "navigate" });
    await chrome.tabs.update(tab.id, { url: activeSync.requestedFortuneoUrl });
    await setUi("running", "Returning to the selected Fortuneo account…", []);
    return;
  }
  if (!isFortuneoAccountUrl(tab.url)) {
    activeSync.collecting = false;
    activeSync.waitingForFortuneo = true;
    const loginProbeId = crypto.randomUUID();
    activeSync.loginProbeId = loginProbeId;
    const loginState = await prepareFortuneoAutoLogin(tab.id);
    traceAuth(activeSync, "login-probe", { ready: Boolean(loginState?.ok && loginState.ready), result: loginState?.error ?? "ready" });
    if (activeSync?.requestId !== requestId || activeSync.loginProbeId !== loginProbeId) {
      traceAuth(activeSync, "login-probe-ignored", { reason: "superseded" });
      return;
    }
    const sync = activeSync;
    if (loginState?.ok && loginState.navigating) {
      sync.waitingForAuthentication = false;
      traceAuth(sync, "customer-space-transition", { result: "waiting-for-account" });
      await setUi("running", "Opening your new Fortuneo customer space…", []);
      return;
    }
    if (loginState?.ok && loginState.ready) {
      await authenticateFortuneoOrPrompt(sync, tab, true);
    } else if (isFortuneoLogin(tab.url)) {
      sync.waitingForAuthentication = true;
      await promptForFortuneoAuthentication(sync, tab, "Sign in to Fortuneo; the login form could not be detected");
    } else {
      sync.waitingForAuthentication = false;
      await chrome.tabs.update(tab.id, { active: true });
      await setUi("running", "Open your Fortuneo checking account; sync will resume automatically.", []);
    }
    return;
  }
  let response;
  activeSync.loginProbeId = null;
  activeSync.waitingForAuthentication = false;
  activeSync.progressStep = "fortuneo";
  activeSync.fortuneoReadStep = "account";
  activeSync.stage = "collecting-fortuneo";
  await setUi("running", "[3/4] Reading Fortuneo…", []);
  if (!activeSync || activeSync.requestId !== requestId) return;
  traceAuth(activeSync, "collection-start", { page: fortuneoPageKind(tab.url) });
  try {
    response = await sendFortuneoMessage(tab.id, { type: FORTUNEO_COLLECT_MESSAGE });
  } catch (error) {
    response = { ok: false, error: chromeErrorCode(error) };
  }
  traceAuth(activeSync, "collection-response", { ok: Boolean(response?.ok), payloads: Array.isArray(response?.payloads) ? response.payloads.length : 0, result: response?.error ?? "ok" });
  for (const pageKind of Array.isArray(response?.pageKinds) ? response.pageKinds : []) {
    if (["checking", "deferred", "pending"].includes(pageKind)) activeSync.observedPages.add(pageKind);
  }
  if (Number.isSafeInteger(response?.resourceCandidates)) activeSync.resourceCandidates = Math.max(activeSync.resourceCandidates, response.resourceCandidates);
  if (response?.collectorVersion !== FORTUNEO_COLLECTOR_VERSION) response = { ok: false, error: response?.error ?? "FORTUNEO_CONTENT_UNAVAILABLE" };
  if (!response?.ok) {
    activeSync.collecting = false;
    const code = response?.error ?? "FORTUNEO_READ_FAILED";
    if (code === "NO_FORTUNEO_DATA_CAPTURED") {
      activeSync.waitingForFortuneo = true;
      await setUi("running", fortuneoProgressLabel(activeSync), []);
      return;
    }
    if (code === "UNSUPPORTED_FORTUNEO_RESPONSE") {
      activeSync.waitingForFortuneo = true;
      await setUi("running", "[3/4] Fortuneo data detected but incomplete. Open the checking-account transactions, Deferred cards, and Pending card operations.", []);
      return;
    }
    if (code === "FORTUNEO_ACCOUNT_PAGE_REQUIRED") {
      activeSync.waitingForFortuneo = true;
      activeSync.waitingForAuthentication = false;
      await chrome.tabs.update(tab.id, { active: true });
      await setUi("running", "Open your Fortuneo checking account; sync will resume automatically.", []);
      return;
    }
    if (code === "FORTUNEO_SESSION_EXPIRED") {
      const reconnecting = activeSync;
      reconnecting.waitingForFortuneo = true;
      reconnecting.waitingForAuthentication = true;
      reconnecting.targetNavigationAttempted = false;
      await setUi("running", "Fortuneo session expired; signing in again…", []);
      await chrome.tabs.update(tab.id, { url: FORTUNEO_LOGIN });
      await waitForFortuneoTabReady(tab.id).catch(() => {});
      if (activeSync === reconnecting) await collectAndForwardSnapshot(requestId);
      return;
    }
    const failed = activeSync;
    const port = failed.port;
    clearFortuneoWait(failed);
    activeSync = null;
    port.disconnect();
    await stopFortuneoCapture(failed, true);
    await setUi("review", code === "NO_FORTUNEO_DATA_CAPTURED" ? "Open the Fortuneo accounts page, then retry the sync" : code, [code], null, failed.dryRun ? "preview" : "sync");
    return;
  }
  activeSync.stage = "preparing-snapshot";
  activeSync.fortuneoDiagnostics = response.diagnostics ?? null;
  activeSync.waitingForFortuneo = false;
  activeSync.waitingForAuthentication = false;
  activeSync.collecting = false;
  activeSync.payloads = mergePayloads(activeSync.payloads, response.payloads);
  traceAuth(activeSync, "snapshot-parse", { payloads: activeSync.payloads.length });
  const payloads = activeSync.payloads.map((payload) => ({ path: payload.path, data: JSON.parse(payload.text) }));
  const snapshot = adaptFortuneo(payloads);
  const collectingSync = activeSync;
  traceAuth(collectingSync, "snapshot-ready", { accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts.length : 0, transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions.length : 0 });
  collectingSync.snapshots.push(snapshot);
  if (collectingSync.requestedFortuneoUrl) await rememberFortuneoAccountUrl(collectingSync.requestedFortuneoUrl);
  if (advanceFortuneoAccount(collectingSync)) {
    traceAuth(collectingSync, "next-account", { index: collectingSync.accountTargetIndex + 1, total: collectingSync.accountTargets.length });
    await setUi("running", `[3/4] Reading Fortuneo account ${collectingSync.accountTargetIndex + 1}/${collectingSync.accountTargets.length}…`, []);
    await chrome.tabs.update(tab.id, { url: collectingSync.requestedFortuneoUrl });
    return;
  }
  const combinedSnapshot = combineFortuneoSnapshots(collectingSync.snapshots);
  collectingSync.stage = "native-handoff";
  collectingSync.progressStep = "prepare";
  collectingSync.snapshot = combinedSnapshot;
  collectingSync.port.postMessage({ version: 2, type: "snapshot", requestId, snapshot: combinedSnapshot });
  traceAuth(collectingSync, "snapshot-sent");
}

function advanceFortuneoAccount(sync) {
  if (sync.accountTargetIndex + 1 >= sync.accountTargets.length) return false;
  clearAuthFallback(sync);
  sync.accountTargetIndex += 1;
  sync.requestedFortuneoUrl = sync.accountTargets[sync.accountTargetIndex];
  sync.requestedFortuneoTabId = null;
  sync.targetNavigationAttempted = true;
  sync.payloads = [];
  sync.collecting = false;
  sync.autoAuthAttempted = false;
  sync.waitingForFortuneo = true;
  sync.fortuneoReadStep = "account";
  return true;
}

async function sendFortuneoMessage(tabId, message) {
  let response = await tryFortuneoMessage(tabId, message);
  if (response?.collectorVersion === FORTUNEO_COLLECTOR_VERSION) return response;
  await injectFortuneoContent(tabId);
  response = await tryFortuneoMessage(tabId, message);
  if (response?.collectorVersion === FORTUNEO_COLLECTOR_VERSION) return response;
  await reloadFortuneoTab(tabId);
  await injectFortuneoContent(tabId);
  return tryFortuneoMessage(tabId, message);
}

async function injectFortuneoContent(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForFortuneoTabReady(tabId);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["fortuneo-content.js"] });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError ?? new Error("FORTUNEO_CONTENT_UNAVAILABLE");
}

async function waitForFortuneoTabReady(tabId, requireFortuneoNavigation = false) {
  const isReady = (tab) => tab.status !== "loading"
    && (!requireFortuneoNavigation || (typeof tab.url === "string" && tab.url.startsWith("https://mabanque.fortuneo.fr/")));
  const tab = await chrome.tabs.get(tabId);
  if (isReady(tab)) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error("FORTUNEO_TAB_LOAD_TIMEOUT")), 12_000);
    const listener = (updatedTabId) => {
      if (updatedTabId !== tabId) return;
      void chrome.tabs.get(tabId).then((current) => {
        if (isReady(current)) finish(resolve);
      }, (error) => finish(reject, error));
    };
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      settle(value);
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((current) => {
      if (isReady(current)) finish(resolve);
    }, (error) => finish(reject, error));
  });
}

async function tryFortuneoMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection|message port closed/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return null;
  }
}

async function reloadFortuneoTab(tabId) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error("FORTUNEO_TAB_RELOAD_TIMEOUT")), 12_000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(resolve);
    };
    const finish = (settle, value) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      settle(value);
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.reload(tabId).catch((error) => finish(reject, error));
  });
}

function mergePayloads(existing, incoming) {
  const merged = [];
  const seen = new Set();
  let bytes = 0;
  for (const payload of [...existing, ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!payload || typeof payload.path !== "string" || typeof payload.text !== "string") continue;
    const size = new TextEncoder().encode(payload.text).byteLength;
    const key = `${payload.path}\0${payload.text}`;
    if (size <= 0 || size > 900_000 || bytes + size > 900_000 || seen.has(key)) continue;
    seen.add(key);
    merged.push({ path: payload.path, text: payload.text });
    bytes += size;
    if (merged.length >= 16) break;
  }
  return merged;
}

async function getOrCreateFortuneoTab() {
  const tabs = await chrome.tabs.query({ url: [FORTUNEO_TAB_URL] });
  if (activeSync?.dedicatedFortuneoTab) {
    const dedicated = tabs.find((tab) => tab.id === activeSync.fortuneoTabId);
    if (dedicated) return { tab: dedicated, created: true };
    const target = activeSync.requestedFortuneoUrl ?? FORTUNEO_LOGIN;
    return { tab: await chrome.tabs.create({ url: target, active: false }), created: true };
  }
  const requested = activeSync?.requestedFortuneoTabId === null ? null : tabs.find((tab) => tab.id === activeSync?.requestedFortuneoTabId && isFortuneoAccountUrl(tab.url));
  const usable = requested
    ?? tabs.find((tab) => tab.active && tab.id !== undefined && isFortuneoAccountUrl(tab.url))
    ?? tabs.find((tab) => tab.id !== undefined && isFortuneoAccountUrl(tab.url))
    ?? tabs.find((tab) => tab.id !== undefined && !isFortuneoLogin(tab.url));
  if (usable) return { tab: usable, created: false };
  const existingLogin = tabs.find((tab) => tab.id !== undefined);
  if (existingLogin?.id !== undefined) return { tab: existingLogin, created: false };
  return { tab: await chrome.tabs.create({ url: FORTUNEO_LOGIN, active: false }), created: true };
}

function isFortuneoLogin(url) {
  return typeof url === "string" && (/identification|connexion|login/i.test(url) || /\/mon-espace\/?(?:[?#]|$)/i.test(url));
}

function isFortuneoAccountUrl(url) {
  return typeof url === "string" && (/\/mon-espace\/banque\/[^/?#]+\/[^/?#]+(?:\/|$)/i.test(url) || /\/account-summary\/[^/?#]+(?:\/|$)/i.test(url));
}

function canonicalFortuneoAccountUrl(url) {
  if (!isFortuneoAccountUrl(url)) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function fortuneoAccountIdentity(url) {
  if (typeof url !== "string") return null;
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\/mon-espace\/banque\/[^/]+\/([^/?#]+)(?:\/|$)/i)
      ?? path.match(/\/account-summary\/([^/?#]+)(?:\/|$)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function uniqueFortuneoAccountUrls(urls) {
  const byIdentity = new Map();
  for (const value of urls) {
    const url = canonicalFortuneoAccountUrl(value);
    const identity = fortuneoAccountIdentity(url);
    if (url && identity && !byIdentity.has(identity)) byIdentity.set(identity, url);
  }
  return [...byIdentity.values()].slice(0, 10);
}

async function rememberFortuneoAccountUrl(value) {
  const url = canonicalFortuneoAccountUrl(value);
  if (!url) return;
  await nativeOneShot({ version: 2, type: "remember-fortuneo-account-url", requestId: crypto.randomUUID(), url }, "result");
}

function combineFortuneoSnapshots(snapshots) {
  const accounts = deduplicateSnapshotItems(snapshots.flatMap((snapshot) => snapshot.accounts), (account) => account.sourceId);
  const transactions = deduplicateSnapshotItems(snapshots.flatMap((snapshot) => snapshot.transactions), (transaction) => `${transaction.accountSourceId}\0${transaction.sourceId}`);
  const settlements = deduplicateSnapshotItems(snapshots.flatMap((snapshot) => snapshot.settlements), (settlement) => settlement.sourceId);
  return {
    capturedAt: new Date().toISOString(),
    complete: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.complete),
    accounts,
    transactions,
    settlements,
  };
}

function deduplicateSnapshotItems(items, keyFor) {
  const output = new Map();
  for (const item of items) output.set(keyFor(item), item);
  return [...output.values()];
}

function scheduleSyncTimeout(sync) {
  if (sync.waitTimer) return;
  const remaining = Math.max(0, sync.deadlineAt - Date.now());
  sync.waitTimer = setTimeout(() => {
    if (activeSync !== sync) return;
    const port = sync.port;
    activeSync = null;
    clearFortuneoWait(sync);
    port.disconnect();
    void stopFortuneoCapture(sync, true);
    const message = sync.authIssue === "credentials-unavailable"
      ? "No Fortuneo credentials are stored. Add them in Setup, then sync again."
      : sync.waitingForAuthentication
        ? (sync.authenticationMessage ?? "Fortuneo sign-in was not completed. Sign in, then sync again.").replace(/(?:this )?sync will resume automatically\.?/i, "then sync again.")
      : sync.confirmedSnapshot || sync.progressStep === "write"
        ? "Sync stopped after 60 seconds without progress while processing Lunch Money. Some changes may already have been applied. Preview again before resuming."
        : `Sync stopped after 60 seconds without progress. ${fortuneoDetectionSummary(sync)}`;
    traceAuth(sync, "sync-timeout", { waitingForAuthentication: sync.waitingForAuthentication });
    void setUi("review", message, sync.waitingForAuthentication ? [] : ["SYNC_TIMEOUT"], null, sync.dryRun ? "preview" : "sync", sync.authTrace);
  }, remaining);
}

function refreshSyncTimeout(sync) {
  if (activeSync !== sync) return;
  if (sync.waitTimer) clearTimeout(sync.waitTimer);
  sync.waitTimer = null;
  sync.timeoutStartedAt = Date.now();
  sync.deadlineAt = sync.timeoutStartedAt + SYNC_IDLE_TIMEOUT_MS;
  scheduleSyncTimeout(sync);
}

function fortuneoProgressLabel(sync) {
  const labels = [["checking", "Checking"], ["deferred", "Deferred"], ["pending", "Pending"]];
  const checklist = labels.map(([key, label]) => `${label} ${sync.observedPages.has(key) ? "✓" : "○"}`).join(" · ");
  const missing = labels.find(([key]) => !sync.observedPages.has(key))?.[1];
  const next = missing ? ` Next: open ${missing}.` : " All requested pages were seen; waiting for usable account responses.";
  return `[3/4] Pages seen: ${checklist}. Fortuneo resources observed: ${sync.resourceCandidates}; usable responses: ${sync.payloads.length}.${next}`;
}

function fortuneoDetectionSummary(sync) {
  const seen = ["checking", "deferred", "pending"].filter((key) => sync.observedPages.has(key));
  return `Pages seen: ${seen.length ? seen.join(", ") : "none"}; Fortuneo resources observed: ${sync.resourceCandidates}; usable responses: ${sync.payloads.length}.`;
}

function clearFortuneoWait(sync) {
  if (sync?.waitTimer) clearTimeout(sync.waitTimer);
  if (sync?.handshakeTimer) clearTimeout(sync.handshakeTimer);
  clearAuthFallback(sync);
  if (sync) sync.waitTimer = null;
  if (sync) sync.handshakeTimer = null;
}

function clearAuthFallback(sync) {
  if (sync?.authFallbackTimer) clearTimeout(sync.authFallbackTimer);
  if (sync) sync.authFallbackTimer = null;
}

async function authenticateFortuneoOrPrompt(sync, tab, loginPrepared = false) {
  sync.progressStep = "connection";
  sync.waitingForAuthentication = true;
  if (sync.autoAuthAttempted) {
    traceAuth(sync, "auto-auth-skipped", { reason: "already-attempted" });
    await promptForFortuneoAuthentication(sync, tab, "Automatic sign-in did not open this account. Sign in manually; sync will resume automatically.");
    return;
  }
  await setUi("running", "Preparing Fortuneo sign-in…", []);
  const credentials = await nativeOneShot({ version: 2, type: "get-fortuneo-credentials", requestId: crypto.randomUUID() }, "fortuneo-credentials");
  if (activeSync !== sync) return;
  traceAuth(sync, "credentials-read", { available: credentials?.type === "fortuneo-credentials" && credentials.available === true });
  if (credentials?.type !== "fortuneo-credentials" || !credentials.available) {
    sync.authIssue = "credentials-unavailable";
    await promptForFortuneoAuthentication(sync, tab, "No Fortuneo credentials are stored. Add them in Setup; this sync will resume automatically.");
    return;
  }
  sync.authIssue = null;
  let response;
  try {
    response = loginPrepared ? { ok: true, ready: true } : await prepareFortuneoAutoLogin(tab.id);
  } catch {
    response = { ok: false };
  }
  if (activeSync !== sync) return;
  if (!response?.ok || !response.ready) {
    traceAuth(sync, "login-probe-failed", { result: response?.error ?? "unknown" });
    await promptForFortuneoAuthentication(sync, tab, "Sign in to Fortuneo; automatic sign-in was unavailable");
    return;
  }
  sync.autoAuthAttempted = true;
  let submitted = false;
  try {
    submitted = await submitFortuneoCredentials(tab.id, credentials.accessCode, credentials.password);
  } catch (error) {
    traceAuth(sync, "credential-handoff-error", { result: chromeErrorCode(error) });
  }
  traceAuth(sync, "credential-handoff", { acknowledged: submitted });
  if (!submitted) {
    await promptForFortuneoAuthentication(sync, tab, "Sign in to Fortuneo; automatic sign-in could not start");
    return;
  }
  await setUi("running", "Signing in to Fortuneo…", []);
  clearAuthFallback(sync);
  const accountTargetIndex = sync.accountTargetIndex;
  const fallbackTimer = setTimeout(async () => {
    if (sync.authFallbackTimer !== fallbackTimer) return;
    sync.authFallbackTimer = null;
    if (!authenticationIsPending(sync) || sync.accountTargetIndex !== accountTargetIndex) return;
    const status = await inspectFortuneoAuthentication(tab.id);
    if (!authenticationIsPending(sync) || sync.accountTargetIndex !== accountTargetIndex) return;
    traceAuth(sync, "auth-status", status);
    const message = authenticationStatusMessage(status);
    await promptForFortuneoAuthentication(sync, tab, message);
  }, 15_000);
  sync.authFallbackTimer = fallbackTimer;
}

async function prepareFortuneoAutoLogin(tabId) {
  const message = { type: "fortuneo-auto-login-ready" };
  let response = await tryFortuneoMessage(tabId, message);
  if (response?.autoLoginVersion === 4) return response;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["fortuneo-content.js"] });
  response = await tryFortuneoMessage(tabId, message);
  return response?.autoLoginVersion === 4 ? response : { ok: false, error: "FORTUNEO_AUTO_LOGIN_UNAVAILABLE" };
}

async function inspectFortuneoAuthentication(tabId) {
  try {
    const response = await tryFortuneoMessage(tabId, { type: "fortuneo-auth-diagnostics" });
    return response?.autoLoginVersion === 4
      ? { page: response.page, form: response.form, error: response.error, busy: response.busy }
      : { page: "unknown", form: "unknown", error: "diagnostics-unavailable", busy: false };
  } catch (error) {
    return { page: "unknown", form: "unknown", error: chromeErrorCode(error), busy: false };
  }
}

function authenticationStatusMessage(status) {
  if (status?.error === "invalid-credentials") return "Fortuneo rejected the stored identifier or password. Update them in Setup, then sync again.";
  if (status?.error === "account-blocked") return "Fortuneo reports that access is blocked. Complete sign-in manually before syncing again.";
  if (status?.error === "security-challenge") return "Complete the Fortuneo security check; sync will resume automatically.";
  if (status?.error === "technical-error") return "Fortuneo could not complete automatic sign-in. Sign in manually, then sync again.";
  if (status?.busy) return "Fortuneo is still processing sign-in. Complete any prompt shown; sync will resume automatically.";
  return "Automatic sign-in reached Fortuneo but did not open the account. Sign in manually, then sync again.";
}

async function submitFortuneoCredentials(tabId, accessCode, password) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (user, secret) => {
      if (location.origin !== "https://mabanque.fortuneo.fr" || typeof user !== "string" || typeof secret !== "string") return false;
      const deadline = Date.now() + 10_000;
      let accountSwitchAttempted = false;
      while (Date.now() < deadline) {
        const passwordInput = document.querySelector('input[name="PASSWD"], input[type="password"]');
        const form = passwordInput?.closest("form");
        const inputs = form ? [...form.querySelectorAll("input")] : [];
        const userInput = form?.querySelector('input[name="LOGIN"], input[name="USER"], input[autocomplete="username"]')
          ?? inputs.find((input) => !["hidden", "password", "checkbox", "submit", "button"].includes(input.type));
        if (!userInput && passwordInput instanceof HTMLInputElement && !accountSwitchAttempted) {
          const switches = [...document.querySelectorAll('button, a, [role="button"]')].filter((element) =>
            (element.innerText ?? "").replace(/\s+/g, " ").trim() === "Changer de compte"
            && !element.disabled && element.getAttribute("aria-disabled") !== "true" && element.getClientRects().length > 0);
          if (switches.length === 1) {
            accountSwitchAttempted = true;
            switches[0].click();
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
        }
        const submit = form?.querySelector('#valider_login') ?? form?.querySelector('button[type="submit"], input[type="submit"]');
        if (userInput instanceof HTMLInputElement && passwordInput instanceof HTMLInputElement && submit instanceof HTMLElement
          && !userInput.disabled && !passwordInput.disabled) {
          const setValue = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(input, value);
            else input.value = value;
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          };
          setValue(userInput, user);
          setValue(passwordInput, secret);
          if (userInput.value !== user || passwordInput.value !== secret) return false;
          // Background tabs can suspend animation frames indefinitely. Yield to
          // form handlers without depending on the tab being visible.
          await new Promise((resolve) => setTimeout(resolve, 100));
          submit.click();
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    },
    args: [accessCode, password],
  });
  return results.length === 1 && results[0]?.result === true;
}

async function promptForFortuneoAuthentication(sync, tab, message) {
  if (!authenticationIsPending(sync)) return;
  const currentTab = tab.id === undefined ? tab : await chrome.tabs.get(tab.id).catch(() => null);
  if (!authenticationIsPending(sync)) return;
  if (isFortuneoAccountUrl(currentTab?.url)) {
    sync.waitingForAuthentication = false;
    await collectAndForwardSnapshot(sync.requestId);
    return;
  }
  if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
  if (!authenticationIsPending(sync)) return;
  sync.authenticationMessage = message;
  await setUi("needs-auth", message, []);
}

function authenticationIsPending(sync) {
  return activeSync === sync
    && sync.waitingForFortuneo
    && sync.waitingForAuthentication
    && !["preparing-snapshot", "native-handoff"].includes(sync.stage)
    && !["prepare", "write"].includes(sync.progressStep);
}

async function failActiveSync(requestId, error) {
  if (!activeSync || activeSync.requestId !== requestId) return;
  const failed = activeSync;
  activeSync = null;
  clearFortuneoWait(failed);
  failed.port.disconnect();
  await stopFortuneoCapture(failed, true);
  const code = chromeErrorCode(error);
  traceAuth(failed, "sync-error", { result: code, stage: failed.stage ?? "unknown", kind: internalErrorKind(error), location: internalErrorLocation(error) });
  await setUi("error", code, [code], null, failed.dryRun ? "preview" : "sync", failed.authTrace);
}

async function cancelSync() {
  if (!activeSync) {
    await stopFortuneoCapture();
    await setUi("idle", "No sync is running", []);
    return;
  }
  const cancelled = activeSync;
  activeSync = null;
  clearFortuneoWait(cancelled);
  cancelled.port.disconnect();
  await stopFortuneoCapture(cancelled, true);
  await setUi("idle", "Sync stopped", []);
}

async function stopFortuneoCapture(sync = null, closeCreated = false) {
  const tabs = await chrome.tabs.query({ url: [FORTUNEO_TAB_URL] });
  await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) => chrome.tabs.sendMessage(tab.id, { type: "stop-capture" })));
  if (closeCreated && sync?.fortuneoTabCreated && sync.fortuneoTabId !== null) {
    await chrome.tabs.remove(sync.fortuneoTabId).catch(() => {});
  }
}

function chromeErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/No tab with id|Invalid tab/i.test(message)) return "FORTUNEO_TAB_CLOSED";
  if (/Frame with ID .* was removed|frame.*removed|navigation|TAB_LOAD_TIMEOUT/i.test(message)) return "FORTUNEO_TAB_NAVIGATING";
  if (/Cannot access|permission|host permission/i.test(message)) return "FORTUNEO_TAB_ACCESS_DENIED";
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) return "FORTUNEO_CONTENT_UNAVAILABLE";
  return safeCode(error);
}

function internalErrorKind(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot (?:read|set) properties of (?:null|undefined)/i.test(message)) return "state-race";
  if (/JSON|Unexpected token|parse/i.test(message)) return "invalid-json";
  if (/No tab|tab.*closed|frame.*removed/i.test(message)) return "tab-lifecycle";
  if (/port|disconnected/i.test(message)) return "native-port";
  return error instanceof Error ? error.name : "unknown";
}

function internalErrorLocation(error) {
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const match = stack.match(/service-worker\.js:(\d+):\d+/);
  return match ? `service-worker:${match[1]}` : "unavailable";
}

async function nativeOneShot(request, expectedType) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    const timer = setTimeout(() => { port.disconnect(); resolve({ ok: false, error: "NATIVE_HOST_TIMEOUT" }); }, 30_000);
    port.onMessage.addListener((message) => {
      if (message?.requestId !== request.requestId) return;
      if (message.type === expectedType || message.type === "auth-required" || message.type === "result") {
        clearTimeout(timer);
        port.disconnect();
        resolve(message);
      }
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        resolve({ ok: false, error: "NATIVE_HOST_UNAVAILABLE" });
      }
    });
    port.postMessage(request);
  });
}

async function setUi(status, message, warnings, details = null, resultOperation = null, authTrace = null) {
  if (status === "needs-auth" && /Fortuneo/i.test(String(message)) && activeSync && !authenticationIsPending(activeSync)) {
    status = "running";
    message = phaseLabelForProgress(activeSync.progressStep, activeSync.dryRun);
  }
  const operation = resultOperation ?? ((status === "running" || status === "needs-auth") && activeSync ? (activeSync.dryRun ? "preview" : "sync") : null);
  const retainedDetails = details ?? ((status === "running" || status === "needs-auth") ? activeSync?.retainedDetails ?? null : null);
  const trace = authTrace ?? activeSync?.authTrace ?? null;
  const formattedWarnings = formatUiWarnings(warnings, retainedDetails);
  const uiState = { status, message: String(message).slice(0, 500), warnings: formattedWarnings, ...(retainedDetails ? { details: retainedDetails } : {}), ...(operation ? { operation } : {}), ...((status === "running" || status === "needs-auth") && activeSync?.progressStep ? { progressStep: activeSync.progressStep } : {}), ...((status === "running" || status === "needs-auth") && activeSync?.progressStep === "fortuneo" && activeSync.fortuneoReadStep ? { fortuneoReadStep: activeSync.fortuneoReadStep } : {}), ...(Array.isArray(trace) && trace.length > 0 && ["review", "error", "needs-auth"].includes(status) ? { authTrace: trace.slice(-30) } : {}), updatedAt: new Date().toISOString(), ...((status === "running" || status === "needs-auth") && activeSync?.deadlineAt ? { startedAt: activeSync.startedAt, timeoutStartedAt: activeSync.timeoutStartedAt, deadlineAt: activeSync.deadlineAt } : {}) };
  await chrome.storage.session.set({ uiState });
  await updateActionIndicator(status, operation, undefined, formattedWarnings.length);
  const tabs = await chrome.tabs.query({ url: LUNCH_MONEY_URLS });
  await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) => chrome.tabs.sendMessage(tab.id, { type: "ui-state", uiState })));
}

function phaseLabelForProgress(step, dryRun) {
  if (step === "connection") return "[2/4] Connecting to Fortuneo…";
  if (step === "fortuneo") return "[3/4] Reading Fortuneo…";
  if (["prepare", "write"].includes(step)) return dryRun ? "[4/4] Preparing the setup preview…" : "[4/4] Syncing Lunch Money…";
  return "[1/4] Checking local setup…";
}

function fortuneoReadLabel(step) {
  return ({ account: "Reading account and balance", transactions: "Reading recent and pending transactions", deferred: "Reading deferred cards", details: "Reading merchant details" })[step] ?? "Reading Fortuneo";
}

function formatUiWarnings(warnings, details) {
  if (!Array.isArray(warnings)) return [];
  const ambiguousCount = Array.isArray(details?.transactions) ? details.transactions.filter((transaction) => transaction?.issue === "Multiple Lunch Money matches").length : 0;
  return warnings.slice(0, 20).map((warning) => warning === "AMBIGUOUS_FINGERPRINT"
    ? `${ambiguousCount || "Some"} transaction${ambiguousCount === 1 ? " was" : "s were"} skipped because the extension found multiple matching Lunch Money records. No change was made to those rows.`
    : warning === "SETTLED_CARD_REFERENCE_UNRESOLVED"
      ? "Some card bookings need review: Fortuneo no longer provides their details and their original purchase could not be identified uniquely. Those bookings were left unchanged."
      : formatLunchMoneyFailure(warning));
}

function formatLunchMoneyFailure(warning) {
  const code = String(warning);
  const match = /^LUNCH_MONEY_([A-Z_]+)_(HTTP_([1-5][0-9]{2})|NETWORK_FAILED|FAILED)$/.exec(code);
  if (!match) return code;
  const operation = ({
    VERIFY: "authentication check",
    READ_ACCOUNTS: "account read",
    WRITE_ACCOUNT: "account update",
    UPDATE_BALANCE: "balance update",
    READ_TAGS: "tag read",
    WRITE_TAG: "tag update",
    READ_CATEGORIES: "category read",
    WRITE_CATEGORY: "category update",
    READ_TRANSACTIONS: "transaction read",
    CREATE_TRANSACTION: "transaction creation",
    UPDATE_TRANSACTION: "transaction update",
    DELETE_TRANSACTION: "transaction deletion",
    GROUP_TRANSACTIONS: "transaction grouping",
  })[match[1]] ?? "request";
  if (match[2] === "NETWORK_FAILED") return `Lunch Money ${operation} failed because of a network error. Try the sync again.`;
  if (match[2] === "FAILED") return `Lunch Money ${operation} failed before an HTTP response was available. Try the sync again.`;
  const status = Number(match[3]);
  if (status === 429) return `Lunch Money rate-limited the ${operation} (HTTP 429). Wait a minute, then try the sync again.`;
  if (status >= 500) return `Lunch Money could not complete the ${operation} because its service returned HTTP ${status}. Try again later.`;
  return `Lunch Money rejected the ${operation} (HTTP ${status}). Copy the diagnostics when reporting this error.`;
}

function traceAuth(sync, event, details = {}) {
  if (!sync || !Array.isArray(sync.authTrace)) return;
  const entry = { at: Math.max(0, Date.now() - sync.startedAt), event, ...details };
  sync.authTrace.push(entry);
  if (sync.authTrace.length > 30) sync.authTrace.shift();
}

function fortuneoPageKind(url) {
  if (isFortuneoAccountUrl(url)) return "account";
  if (isFortuneoLogin(url)) return "login";
  if (typeof url === "string" && url.startsWith("https://mabanque.fortuneo.fr/")) return "fortuneo-other";
  return "other";
}

async function updateActionIndicator(status, operation, lastSuccessfulLocalDate, warningCount = 0) {
  if (lastSuccessfulLocalDate === undefined) {
    ({ lastSuccessfulLocalDate } = await chrome.storage.local.get("lastSuccessfulLocalDate"));
  }
  let text;
  let color = "#2b8066";
  let title;
  if (status === "running") {
    text = "…";
    color = "#3677b5";
    title = operation === "preview" ? "Preparing the Fortuneo setup preview" : "Fortuneo sync in progress";
  } else if (status === "success" && operation === "preview") {
    text = "!";
    color = "#a45b16";
    title = "Fortuneo preview ready to confirm";
  } else if (status === "warning") {
    const count = Math.min(99, Math.max(1, warningCount));
    text = String(count);
    color = "#b87816";
    title = `Fortuneo sync complete with ${count} warning${count === 1 ? "" : "s"}`;
  } else if (["review", "error", "needs-auth"].includes(status)) {
    text = "!";
    color = status === "error" ? "#9b2f2f" : "#a45b16";
    title = status === "needs-auth" ? "Fortuneo sync needs sign-in" : "Fortuneo sync needs attention";
  } else if (lastSuccessfulLocalDate === localDate()) {
    text = "✓";
    title = "Fortuneo synced today";
  } else {
    text = "↻";
    color = "#61776f";
    title = "Fortuneo sync due today";
  }
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title }),
  ]);
}

async function refreshActionIndicator() {
  const state = await readSettings();
  await updateActionIndicator(state.uiState?.status ?? "idle", state.uiState?.operation ?? null, state.lastSuccessfulLocalDate, state.uiState?.warnings?.length ?? 0);
}

function scheduleDailyStatusRefresh() {
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 1, 0);
  void chrome.alarms.create(DAILY_STATUS_ALARM, { when: nextMidnight.getTime() });
}

async function scheduleSyncRetries() {
  // Service-worker wakeups must not postpone an already scheduled retry.
  const existing = await chrome.alarms.get(SYNC_RETRY_ALARM);
  if (!existing) await chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: 15, periodInMinutes: 15 });
}

function validateToken(value) {
  if (typeof value !== "string" || value.length < 11 || value.length > 4096) throw new Error("INVALID_TOKEN");
  return value;
}

function validateId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("INVALID_ACCOUNT_ID");
  return id;
}

function validateFortuneoAccessCode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(value)) throw new Error("INVALID_FORTUNEO_IDENTIFIER");
  return value;
}

function validateFortuneoPassword(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error("INVALID_FORTUNEO_PASSWORD");
  return value;
}

function localDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function summaryLabel(summary, dryRun, diagnostics = null) {
  if (!summary) return "Sync ended without a summary";
  const prefix = dryRun ? "Review" : "Sync";
  const breakdown = summary.breakdown;
  if (!breakdown) return `${prefix}: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} removed, ${summary.grouped} grouped`;
  const accountChanges = dryRun
    ? `${breakdown.accountsCreated} to create, ${breakdown.accountsUpdated} to update`
    : `${breakdown.accountsCreated} created, ${breakdown.accountsUpdated} updated`;
  const transactionChanges = dryRun
    ? `${breakdown.transactionsCreated} to create, ${breakdown.transactionsUpdated} to update, ${breakdown.transactionsDeleted} to remove`
    : `${breakdown.transactionsCreated} created, ${breakdown.transactionsUpdated} updated, ${breakdown.transactionsDeleted} removed`;
  const grouping = dryRun ? `${breakdown.settlementsGrouped} to group` : `${breakdown.settlementsGrouped} grouped`;
  const deferredDiagnostic = breakdown.fortuneoDeferred === 0 && diagnostics
    ? ` Deferred read: ${diagnostics.deferredDateCandidates} dates, ${diagnostics.deferredResponses} responses, ${diagnostics.deferredRows} rows; amount ${diagnostics.deferredRowsWithAmount}, label ${diagnostics.deferredRowsWithLabel}, date ${diagnostics.deferredRowsWithDate}; fields ${Array.isArray(diagnostics.deferredFields) ? diagnostics.deferredFields.join(",") : "unknown"}.`
    : "";
  return `${prefix}: accounts ${accountChanges}; transactions ${transactionChanges}; settlements ${grouping}. Fortuneo detected ${breakdown.fortuneoSettled} settled, ${breakdown.fortuneoDeferred} deferred, ${breakdown.fortuneoPending} pending.${deferredDiagnostic}`;
}

function phaseLabel(phase) {
  return ({ "reading-lunch-money": "[4/4] Reading Lunch Money…", "waiting-lunch-money": "[4/4] Waiting for Lunch Money rate limit; retry scheduled…", "reconciling-accounts": "[4/4] Reconciling accounts…", "writing-transactions": "[4/4] Writing transactions…", "updating-balances": "[4/4] Updating balances…" })[phase] ?? "[4/4] Syncing…";
}

function progressStepForPhase(phase) {
  return ["reconciling-accounts", "writing-transactions", "updating-balances"].includes(phase) ? "write" : "prepare";
}

function syncCompletionLabel(details) {
  const transactions = Array.isArray(details?.transactions) ? details.transactions : [];
  const created = transactions.filter((transaction) => transaction?.action === "create");
  const deferred = created.filter((transaction) => transaction.lifecycle === "deferred").length;
  const pending = created.filter((transaction) => transaction.lifecycle === "pending").length;
  if (deferred === 0 && pending === 0) return "Sync complete. No new deferred or pending transactions.";
  return `Sync complete. New transactions: ${deferred} deferred, ${pending} pending.`;
}

function syncFailureLabel(summary) {
  const diagnostic = summary?.diagnostic;
  const code = typeof diagnostic?.code === "string" ? diagnostic.code : (typeof summary?.message === "string" ? summary.message : "UNEXPECTED_ERROR");
  if (!diagnostic || typeof diagnostic.fingerprint !== "string") return `Sync failed: ${code}.`;
  const phase = typeof diagnostic.phase === "string" ? diagnosticPhaseLabel(diagnostic.phase) : "an unknown phase";
  const kind = typeof diagnostic.kind === "string" ? diagnostic.kind : "Error";
  const location = typeof diagnostic.location === "string" ? ` at ${diagnostic.location}` : "";
  return `Sync failed during ${phase}: ${code} (${kind}${location}; diagnostic ${diagnostic.fingerprint}).`;
}

function diagnosticPhaseLabel(phase) {
  return ({
    "loading-configuration": "configuration loading",
    "reading-accounts": "the Lunch Money account read",
    "planning-accounts": "account reconciliation planning",
    "reading-managed-settings": "the managed tag/category read",
    "reading-transactions": "the Lunch Money transaction read",
    "planning-transactions": "transaction reconciliation planning",
    "building-preview": "preview construction",
    "writing-accounts": "account writes",
    "planning-final-transactions": "final transaction planning",
    "writing-transactions": "transaction writes",
    "updating-balances": "account balance updates",
    "building-result": "final result construction",
    "sending-result": "final result delivery",
  })[phase] ?? phase.replaceAll("-", " ");
}

function safeCode(error) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "UNEXPECTED_ERROR";
}

function cardReviewNotification(warnings, keys, reportedKeys, dryRun) {
  // Missing/invalid identities must never silence a warning from an older helper.
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key))) return { warnings: [...warnings] };
  const previous = new Set(Array.isArray(reportedKeys) ? reportedKeys : []);
  const hasNewReview = keys.some((key) => !previous.has(key));
  return {
    warnings: warnings.filter((warning) => dryRun || warning !== "SETTLED_CARD_REFERENCE_UNRESOLVED" || hasNewReview || keys.length === 0),
    keys: [...new Set(keys)],
  };
}

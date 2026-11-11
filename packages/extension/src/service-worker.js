import { adaptFortuneo } from "./fortuneo-adapter.js";

const NATIVE_HOST = "com.sylvaindurand.fortuneo_lunchmoney_sync";
const FORTUNEO_LOGIN = "https://mabanque.fortuneo.fr/mon-espace";
const FORTUNEO_TAB_URL = "https://mabanque.fortuneo.fr/*";
const FORTUNEO_COLLECTOR_VERSION = 18;
const FORTUNEO_COLLECT_MESSAGE = `collect-snapshot-v${FORTUNEO_COLLECTOR_VERSION}`;
const LUNCH_MONEY_URLS = ["https://my.lunchmoney.app/*", "https://beta.lunchmoney.app/*"];
const DAILY_STATUS_ALARM = "refresh-daily-status";
const SYNC_RETRY_ALARM = "retry-daily-sync";
const SYNC_IDLE_TIMEOUT_MS = 60_000;
const SYNC_RETRY_COOLDOWN_MS = 15 * 60_000;
// Leave time to receive and type a Fortuneo SMS code before abandoning the sync.
const FORTUNEO_CHALLENGE_TIMEOUT_MS = 5 * 60_000;
const FORTUNEO_CHALLENGE_KINDS = ["sms-code", "security-challenge"];
const POST_CHALLENGE_SETTLE_MS = 4_000;
const MAX_READ_INTERRUPTIONS = 2;
// Fortuneo may ask for an SMS code at sign-in, so automatic syncs start only while someone is at the computer.
const USER_IDLE_THRESHOLD_SECONDS = 120;
const STARTUP_RECHECK_DELAYS_MS = [3_000, 10_000, 25_000];
const DEFAULT_SETTINGS = { lastSuccessfulLocalDate: null, fortuneoChallengeLocalDate: null, fortuneoChallengeKind: null, lastSuccessfulAt: null, lastSyncAttemptLocalDate: null, lastSyncAttemptAt: null, setupPreviewConfirmed: false, uiState: { status: "idle", message: "Ready", warnings: [] } };

let activeSync = null;
let syncStartPending = false;
const initialized = initializeStorage();

chrome.runtime.onInstalled.addListener(() => {
  void initialized.then(() => syncIfDue());
});
// At launch macOS may report Chrome as focused only after the first check, so look again shortly after.
chrome.runtime.onStartup.addListener(() => {
  void initialized.then(() => syncIfDue());
  for (const delay of STARTUP_RECHECK_DELAYS_MS) setTimeout(() => void syncIfDue(), delay);
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
  const reachedFortuneoAccount = isFortuneoAccountUrl(changeInfo.url ?? (changeInfo.status === "complete" ? tab.url : undefined));
  if (reachedFortuneoAccount && !activeSync) void initialized.then(() => resumeAfterFortuneoChallenge(tabId));
  if (activeSync && tabId === activeSync.fortuneoTabId) traceAuth(activeSync, "tab-update", { status: changeInfo.status ?? "url", page: fortuneoPageKind(changeInfo.url ?? tab.url), path: fortuneoPathShape(changeInfo.url ?? tab.url), ...(activeSync.collecting ? { during: "read" } : {}) });
  if (!activeSync?.waitingForFortuneo) return;
  if (tabId === activeSync.fortuneoTabId && changeInfo.status === "complete") void collectAndForwardSnapshot(activeSync.requestId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncForLunchMoneyTab(tabId);
});

// A sync skipped while the user was away starts as soon as they are back at Chrome.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void initialized.then(() => syncIfDue());
});
chrome.idle?.onStateChanged.addListener((state) => {
  if (state === "active") void initialized.then(() => syncIfDue());
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
      && ["fortuneo-ready", "fortuneo-read-progress", "fortuneo-page-event"].includes(type);
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
    case "fortuneo-page-event":
      if (activeSync && _sender.tab?.id === activeSync.fortuneoTabId && ["welcome-choice"].includes(message.event)) {
        traceAuth(activeSync, message.event, { path: fortuneoPathShape(_sender.url), ...(activeSync.collecting ? { during: "read" } : {}) });
      }
      return { ok: true };
    case "fortuneo-read-progress":
      return handleFortuneoReadProgress(message, _sender);
    default:
      return { ok: false, error: "UNKNOWN_MESSAGE" };
  }
}

async function handleFortuneoReadProgress(message, sender) {
  const sync = activeSync;
  const step = ["account", "transactions", "deferred", "details"].includes(message.step) ? message.step : null;
  if (!sync?.collecting || !step || sender.tab?.id !== sync.fortuneoTabId
    || !sender.url?.startsWith("https://mabanque.fortuneo.fr/")
    || sync.progressStep !== "fortuneo" || message.collectionId !== sync.collectionId) return { ok: false };
  const completedDetails = message.completedDetails;
  if (!Number.isSafeInteger(completedDetails) || completedDetails < (sync.completedDetails ?? 0)) return { ok: false };
  if (step === sync.fortuneoReadStep && completedDetails === sync.completedDetails) return { ok: true };
  sync.fortuneoReadStep = step;
  sync.completedDetails = completedDetails;
  if (typeof message.apiIssues === "string" && /^[a-z0-9: ]{0,80}$/.test(message.apiIssues)) sync.fortuneoApiIssues = message.apiIssues;
  refreshSyncTimeout(sync);
  traceAuth(sync, "fortuneo-read", { step, completedDetails, ...(sync.fortuneoApiIssues ? { apiIssues: sync.fortuneoApiIssues } : {}) });
  await setUi("running", `[3/4] ${fortuneoReadLabel(step)}${step === "details" && completedDetails ? ` (${completedDetails})` : ""}…`, []);
  return { ok: true };
}

async function syncIfDue() {
  const { lastSuccessfulLocalDate, lastSyncAttemptAt, lastSyncAttemptVersion, setupPreviewConfirmed, fortuneoChallengeLocalDate } = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, lastSyncAttemptVersion: null });
  // Each automatic attempt can make Fortuneo send another SMS: once a code was requested, wait until tomorrow.
  if (fortuneoChallengeLocalDate && fortuneoChallengeLocalDate === localDate()) return false;
  const lastAttemptAge = Date.now() - Date.parse(lastSyncAttemptAt ?? "");
  const attemptedRecently = lastSyncAttemptVersion === chrome.runtime.getManifest().version
    && Number.isFinite(lastAttemptAge) && lastAttemptAge >= 0 && lastAttemptAge < SYNC_RETRY_COOLDOWN_MS;
  if (!setupPreviewConfirmed || lastSuccessfulLocalDate === localDate() || attemptedRecently || activeSync || syncStartPending) return false;
  if (!await userIsAtChrome()) return false;
  return startSync("sync-if-due");
}

// True only when Chrome is the focused app and the user is not idle or locked:
// a background sync could ask for an SMS code that nobody is there to enter.
async function userIsAtChrome() {
  const window = await chrome.windows.getLastFocused().catch(() => null);
  if (!window?.focused || window.state === "minimized") return false;
  const idleState = await chrome.idle?.queryState(USER_IDLE_THRESHOLD_SECONDS).catch(() => "active");
  return idleState === undefined || idleState === "active";
}

async function startSync(type, confirmedSnapshot = null, options = {}) {
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
        await reportNativeStartupFailure(type, startupStage, credentials);
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
    if (knownAccountsResponse?.type !== "fortuneo-account-urls") {
      await reportNativeStartupFailure(type, startupStage, knownAccountsResponse);
      return false;
    }
    // After an SMS code, read from the tab where it was entered: another tab may not share that session.
    const sourceTab = Number.isSafeInteger(options.fortuneoTabId) ? await chrome.tabs.get(options.fortuneoTabId).catch(() => null) : focusedTab;
    const requestedFortuneoUrl = canonicalFortuneoAccountUrl(sourceTab?.url);
    const requestedFortuneoTabId = requestedFortuneoUrl && sourceTab?.id !== undefined ? sourceTab.id : null;
    const afterChallenge = options.afterChallenge === true;
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
    activeSync = { requestId, port, dryRun: type === "dry-run", confirmedSnapshot, snapshot: null, snapshots: [], waitingForFortuneo: false, waitingForAuthentication: false, autoAuthAttempted: afterChallenge, challengeSeen: afterChallenge, authIssue: null, collecting: false, loginProbeId: null, payloads: [], observedPages: new Set(), resourceCandidates: 0, fortuneoDiagnostics: null, retainedDetails, startedAt, timeoutStartedAt: startedAt, deadlineAt: startedAt + SYNC_IDLE_TIMEOUT_MS, waitTimer: null, handshakeTimer: null, authFallbackTimer: null, fortuneoTabId: null, fortuneoTabCreated: false, requestedFortuneoUrl: accountTargets[0] ?? requestedFortuneoUrl, requestedFortuneoTabId, accountTargets, accountTargetIndex: 0, dedicatedFortuneoTab: !(afterChallenge && requestedFortuneoTabId !== null) && (accountTargets.length > 1 || (accountTargets.length === 1 && requestedFortuneoTabId === null)), targetNavigationAttempted: false, progressStep: "setup", fortuneoReadStep: null, authTrace: [], nativeMessageQueue: Promise.resolve() };
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
  const hint = internalErrorHint(error);
  const trace = [{ at: 0, event: "startup-error", stage, result: code, kind, location, hint }];
  const phase = startupStageLabel(stage);
  await setUi("error", `Sync could not start during ${phase}: ${hint} (${code}; ${kind} at ${location}). Copy diagnostics to report it.`, [code], null, type === "dry-run" ? "preview" : "sync", trace);
}

async function reportNativeStartupFailure(type, stage, response) {
  const summary = response?.summary ?? { message: response?.error ?? "NATIVE_HOST_UNAVAILABLE" };
  const code = summary.diagnostic?.code ?? summary.message;
  const phase = startupStageLabel(stage);
  const trace = [{ at: 0, event: "startup-error", stage, result: code, ...summary.diagnostic }];
  await setUi("error", syncFailureLabel(summary, phase), [code], null, type === "dry-run" ? "preview" : "sync", trace);
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
    activeSync.nativePhase = message.phase;
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
    if (!message.ok && !message.summary?.details) traceAuth(completed, "native-error", { ...message.summary?.diagnostic });
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
      ? syncFailureLabel(message.summary, syncStageLabel(completed))
      : message.dryRun
        ? (details ? (completedWithWarnings ? `Preview ready with ${warningCount} warning${warningCount === 1 ? "" : "s"}.` : `Review the changes below.${automaticRetryNote}`) : summaryLabel(message.summary, true, completed.fortuneoDiagnostics))
        : (completedWithWarnings ? `Sync complete with ${warningCount} warning${warningCount === 1 ? "" : "s"}.` : completedOk ? `${syncCompletionLabel(details)}${automaticRetryNote}` : syncFailureLabel(message.summary));
    if (message.dryRun && Boolean(details) && completed.snapshot) await chrome.storage.session.set({ confirmedPreviewSnapshot: completed.snapshot });
    else if (!message.dryRun || !message.ok) await chrome.storage.session.remove("confirmedPreviewSnapshot");
    if (Boolean(details) && !message.dryRun) {
      await chrome.storage.local.set({ ...(reviewNotification.keys ? { reportedCardReviewKeys: reviewNotification.keys } : {}), lastSuccessfulLocalDate: localDate(), lastSuccessfulAt: new Date().toISOString(), setupPreviewConfirmed: true, fortuneoChallengeLocalDate: null, fortuneoChallengeKind: null });
      await forgetFortuneoChallengeTab();
    }
    await setUi(status, resultMessage, warnings, details, message.dryRun ? "preview" : "sync", completed.authTrace);
    const port = completed.port;
    port.disconnect();
    await stopFortuneoCapture(completed, true);
  }
}

async function collectAndForwardSnapshot(requestId) {
  try {
    await readAndForwardSnapshot(requestId);
  } catch (error) {
    await failActiveSync(requestId, error);
  }
}

async function readAndForwardSnapshot(requestId) {
  if (!activeSync || activeSync.requestId !== requestId) return;
  if (activeSync.collecting) return;
  activeSync.collecting = true;
  const fortuneoTab = await getOrCreateFortuneoTab();
  const tab = fortuneoTab.tab;
  // Keep a tab showing a Fortuneo code prompt open, even when the sync is abandoned.
  if (fortuneoTab.created && !activeSync.challengeSeen) activeSync.fortuneoTabCreated = true;
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
  if (isFortuneoAccountUrl(tab.url)) {
    clearAuthFallback(activeSync);
    if (activeSync.challengeSeen && activeSync.idleTimeoutMs) await resolveFortuneoChallenge(activeSync);
    if (!activeSync || activeSync.requestId !== requestId) return;
    if (activeSync.challengeSeen && !activeSync.settledAfterChallenge) {
      // Fortuneo is still opening the session right after the code: reading (or reloading) the page
      // now can sign it out. Wait until the account page stays put, then read it.
      const settling = activeSync;
      settling.settledAfterChallenge = true;
      traceAuth(settling, "post-challenge-settle", { path: fortuneoPathShape(tab.url) });
      await setUi("running", "Waiting for Fortuneo to finish signing in…", []);
      await new Promise((resolve) => setTimeout(resolve, POST_CHALLENGE_SETTLE_MS));
      const settled = await chrome.tabs.get(tab.id).catch(() => null);
      if (activeSync !== settling) return;
      traceAuth(settling, "post-challenge-settled", { page: fortuneoPageKind(settled?.url), path: fortuneoPathShape(settled?.url), status: settled?.status ?? "closed" });
      if (!settled || settled.status === "loading" || settled.url !== readyTab.url) {
        settling.collecting = false;
        settling.waitingForFortuneo = true;
        settling.settledAfterChallenge = false;
        // The page may keep changing without a tab event (single-page app): look again shortly.
        if (settled) setTimeout(() => { if (activeSync === settling && !settling.collecting) void collectAndForwardSnapshot(requestId); }, 1_000);
        return;
      }
    }
  }
  const currentAccountIdentity = fortuneoAccountIdentity(tab.url);
  const requestedAccountIdentity = fortuneoAccountIdentity(activeSync.requestedFortuneoUrl);
  // Accounts are read through the API from any account page (see accountPath below), so a different
  // account in the tab only needs a page change when the extension cannot read in place.
  if (requestedAccountIdentity && currentAccountIdentity && requestedAccountIdentity !== currentAccountIdentity && !activeSync.targetNavigationAttempted && !activeSync.readInPlace) {
    activeSync.targetNavigationAttempted = true;
    activeSync.collecting = false;
    activeSync.waitingForFortuneo = true;
    traceAuth(activeSync, "target-account-restore", { result: "navigate", from: fortuneoPathShape(tab.url), to: fortuneoPathShape(activeSync.requestedFortuneoUrl) });
    await chrome.tabs.update(tab.id, { url: activeSync.requestedFortuneoUrl });
    await setUi("running", "Returning to the selected Fortuneo account…", []);
    return;
  }
  if (!isFortuneoAccountUrl(tab.url)) {
    activeSync.collecting = false;
    activeSync.waitingForFortuneo = true;
    const loginProbeId = crypto.randomUUID();
    activeSync.loginProbeId = loginProbeId;
    if (activeSync.challenge) {
      const waiting = activeSync;
      const status = await inspectFortuneoAuthentication(tab.id);
      if (activeSync !== waiting || waiting.loginProbeId !== loginProbeId) return;
      traceAuth(waiting, "challenge-status", status);
      // Still on the code page (or between pages): keep waiting, never sign in again.
      if (challengeKindForStatus(status) || status.page === "unknown") return;
      waiting.challenge = null;
    }
    const loginState = await prepareFortuneoAutoLogin(tab.id);
    traceAuth(activeSync, "login-probe", { ready: Boolean(loginState?.ok && loginState.ready), result: loginState?.error ?? "ready" });
    if (activeSync?.requestId !== requestId || activeSync.loginProbeId !== loginProbeId) {
      traceAuth(activeSync, "login-probe-ignored", { reason: "superseded" });
      return;
    }
    const sync = activeSync;
    if (FORTUNEO_CHALLENGE_KINDS.includes(loginState?.challenge)) {
      await handleFortuneoChallenge(sync, tab, loginState.challenge);
      return;
    }
    if (loginState?.ok && loginState.navigating) {
      sync.waitingForAuthentication = false;
      traceAuth(sync, "customer-space-transition", { result: "waiting-for-account", path: fortuneoPathShape(tab.url) });
      await setUi("running", "Opening your new Fortuneo customer space…", []);
      // After a code, the new space's sign-in form may replace the welcome page without a tab reload.
      if (sync.challengeSeen) {
        setTimeout(() => {
          if (activeSync === sync && sync.waitingForFortuneo && !sync.collecting) void collectAndForwardSnapshot(sync.requestId);
        }, 3_000);
      }
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
  const collecting = activeSync;
  collecting.collectionId = crypto.randomUUID();
  collecting.completedDetails = 0;
  try {
    response = await sendFortuneoMessage(tab.id, { type: FORTUNEO_COLLECT_MESSAGE, collectionId: collecting.collectionId, ...(fortuneoAccountPath(collecting.requestedFortuneoUrl) ? { accountPath: fortuneoAccountPath(collecting.requestedFortuneoUrl) } : {}) });
  } catch (error) {
    if (chromeErrorCode(error) === "UNEXPECTED_ERROR") throw error;
    response = { ok: false, error: chromeErrorCode(error) };
  }
  if (activeSync !== collecting) return;
  traceAuth(activeSync, "collection-response", { ok: Boolean(response?.ok), payloads: Array.isArray(response?.payloads) ? response.payloads.length : 0, result: response?.error ?? "ok" });
  for (const pageKind of Array.isArray(response?.pageKinds) ? response.pageKinds : []) {
    if (["checking", "deferred", "pending"].includes(pageKind)) activeSync.observedPages.add(pageKind);
  }
  if (Number.isSafeInteger(response?.resourceCandidates)) activeSync.resourceCandidates = Math.max(activeSync.resourceCandidates, response.resourceCandidates);
  if (response?.collectorVersion !== FORTUNEO_COLLECTOR_VERSION) response = { ok: false, error: response?.error ?? "FORTUNEO_CONTENT_UNAVAILABLE" };
  if (!response?.ok) {
    activeSync.collecting = false;
    const code = response?.error ?? "FORTUNEO_READ_FAILED";
    if (code === "FORTUNEO_TAB_NAVIGATING" && (activeSync.readInterruptions ?? 0) < MAX_READ_INTERRUPTIONS) {
      // Fortuneo can move the tab during a read (e.g. to its "new customer space" page shortly after
      // signing in). Follow it and read again once the account page is back, instead of failing.
      const interrupted = activeSync;
      interrupted.readInterruptions = (interrupted.readInterruptions ?? 0) + 1;
      interrupted.waitingForFortuneo = true;
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      traceAuth(interrupted, "read-interrupted", { attempt: interrupted.readInterruptions, page: fortuneoPageKind(current?.url), path: fortuneoPathShape(current?.url) });
      await setUi("running", "Fortuneo changed page during the read; resuming…", []);
      if (current && activeSync === interrupted) {
        setTimeout(() => { if (activeSync === interrupted && !interrupted.collecting) void collectAndForwardSnapshot(requestId); }, 1_500);
      }
      return;
    }
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
    if (code === "FORTUNEO_SESSION_EXPIRED" && activeSync.challengeSeen) {
      const waiting = activeSync;
      waiting.sessionRetries = (waiting.sessionRetries ?? 0) + 1;
      traceAuth(waiting, "post-challenge-session-retry", { attempt: waiting.sessionRetries });
      if (waiting.sessionRetries <= 3) {
        // Fortuneo may still be finishing the session it opened after the code; returning to the
        // login form here would request another SMS code.
        waiting.waitingForFortuneo = true;
        await setUi("running", "Waiting for Fortuneo to finish opening the session…", []);
        await new Promise((resolve) => setTimeout(resolve, 3_000 * waiting.sessionRetries));
        if (activeSync === waiting) await collectAndForwardSnapshot(requestId);
        return;
      }
    } else if (code === "FORTUNEO_SESSION_EXPIRED") {
      const reconnecting = activeSync;
      reconnecting.waitingForFortuneo = true;
      reconnecting.waitingForAuthentication = true;
      reconnecting.targetNavigationAttempted = false;
      traceAuth(reconnecting, "session-expired-login", { from: fortuneoPathShape(tab.url) });
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
    const tabAfterFailure = await chrome.tabs.get(tab.id).catch(() => null);
    const pageAfterFailure = fortuneoPageKind(tabAfterFailure?.url);
    await stopFortuneoCapture(failed, true);
    traceAuth(failed, "collection-error", { result: code, page: pageAfterFailure, path: fortuneoPathShape(tabAfterFailure?.url), ...(failed.fortuneoApiIssues ? { apiIssues: failed.fortuneoApiIssues } : {}), ...response?.diagnostic });
    const failureMessage = code === "FORTUNEO_SESSION_EXPIRED" && failed.challengeSeen
      ? "Fortuneo accepted the code but refused the data read. The extension did not sign in again, to avoid another SMS. Reload the Fortuneo account page, then sync again. Copy diagnostics to report it."
      : code === "FORTUNEO_TAB_NAVIGATING" && pageAfterFailure === "login"
        ? "Fortuneo ended its session while the extension was reading it: the tab went back to the sign-in page. Copy diagnostics to report it."
        : syncFailureLabel({ message: code, diagnostic: response?.diagnostic }, "the Fortuneo data read");
    await setUi("review", failureMessage, [code], null, failed.dryRun ? "preview" : "sync", failed.authTrace);
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
    traceAuth(collectingSync, "next-account", { index: collectingSync.accountTargetIndex + 1, total: collectingSync.accountTargets.length, to: fortuneoPathShape(collectingSync.requestedFortuneoUrl) });
    await setUi("running", `[3/4] Reading Fortuneo account ${collectingSync.accountTargetIndex + 1}/${collectingSync.accountTargets.length}…`, []);
    // Stay on this page: loading the next account's page after an SMS code sends Fortuneo back to sign-in.
    collectingSync.readInPlace = true;
    await collectAndForwardSnapshot(requestId);
    return;
  }
  const combinedSnapshot = combineFortuneoSnapshots(collectingSync.snapshots);
  collectingSync.stage = "native-handoff";
  collectingSync.progressStep = "prepare";
  collectingSync.snapshot = combinedSnapshot;
  collectingSync.port.postMessage({ version: 2, type: "snapshot", requestId, snapshot: combinedSnapshot });
  traceAuth(collectingSync, "snapshot-sent");
}

function fortuneoAccountPath(url) {
  if (!isFortuneoAccountUrl(url)) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
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
  // Signing in again after an SMS code would make Fortuneo send another one.
  sync.autoAuthAttempted = Boolean(sync.challengeSeen);
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
  if (activeSync?.challengeSeen) {
    // A reload right after an SMS code can sign Fortuneo out; give the page time instead.
    traceAuth(activeSync, "collector-retry", { reason: "collector-unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await injectFortuneoContent(tabId);
    return tryFortuneoMessage(tabId, message);
  }
  traceAuth(activeSync, "tab-reload", { reason: "collector-unavailable" });
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
    const timerDelayMs = Math.max(0, Date.now() - sync.deadlineAt);
    const port = sync.port;
    activeSync = null;
    clearFortuneoWait(sync);
    port.disconnect();
    void stopFortuneoCapture(sync, true);
    const message = sync.authIssue === "credentials-unavailable"
      ? "No Fortuneo credentials are stored. Add them in Setup, then sync again."
      : sync.challenge
        ? `${sync.challenge === "sms-code" ? "The Fortuneo SMS code was not entered." : "The Fortuneo security check was not completed."} Complete it in the Fortuneo tab and sync will resume; automatic syncs are paused until tomorrow.`
      : sync.waitingForAuthentication
        ? (sync.authenticationMessage ?? "Fortuneo sign-in was not completed. Sign in, then sync again.").replace(/(?:this )?sync will resume automatically\.?/i, "then sync again.")
      : sync.confirmedSnapshot || sync.progressStep === "write"
        ? "Sync stopped after 60 seconds without progress while processing Lunch Money. Some changes may already have been applied. Preview again before resuming."
        : timerDelayMs >= SYNC_IDLE_TIMEOUT_MS
          ? `Sync interrupted; the timeout check ran ${Math.round(timerDelayMs / 1000)} seconds late. The browser or computer may have been suspended. Sync again. ${fortuneoDetectionSummary(sync)}`
          : `Sync stopped after 60 seconds without progress. ${fortuneoDetectionSummary(sync)}`;
    traceAuth(sync, "sync-timeout", { waitingForAuthentication: sync.waitingForAuthentication, timerDelayMs });
    void setUi("review", message, sync.waitingForAuthentication ? [] : ["SYNC_TIMEOUT"], null, sync.dryRun ? "preview" : "sync", sync.authTrace);
  }, remaining);
}

function refreshSyncTimeout(sync) {
  if (activeSync !== sync) return;
  if (sync.waitTimer) clearTimeout(sync.waitTimer);
  sync.waitTimer = null;
  sync.timeoutStartedAt = Date.now();
  sync.deadlineAt = sync.timeoutStartedAt + (sync.idleTimeoutMs ?? SYNC_IDLE_TIMEOUT_MS);
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
  if (sync.fortuneoReadStep) return `Last Fortuneo step: ${sync.fortuneoReadStep}; card details processed: ${sync.completedDetails ?? 0}.`;
  const seen = ["checking", "deferred", "pending"].filter((key) => sync.observedPages.has(key));
  return `Pages seen: ${seen.length ? seen.join(", ") : "none"}; Fortuneo resources observed: ${sync.resourceCandidates}; usable responses: ${sync.payloads.length}.`;
}

function clearFortuneoWait(sync) {
  clearChallengeWatch(sync);
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
    await promptForFortuneoAuthentication(sync, tab, sync.challengeSeen
      ? "Sign in to Fortuneo in the open tab; sync will resume automatically. It was not filled in again, to avoid another SMS code."
      : "Automatic sign-in did not open this account. Sign in manually; sync will resume automatically.");
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
  const fallbackDeadline = Date.now() + 15_000;
  // Poll so an SMS code prompt is reported within seconds instead of after the fallback delay.
  const scheduleAuthCheck = () => {
    const fallbackTimer = setTimeout(async () => {
      if (sync.authFallbackTimer !== fallbackTimer) return;
      sync.authFallbackTimer = null;
      if (!authenticationIsPending(sync) || sync.accountTargetIndex !== accountTargetIndex) return;
      const status = await inspectFortuneoAuthentication(tab.id);
      if (!authenticationIsPending(sync) || sync.accountTargetIndex !== accountTargetIndex) return;
      const challenge = challengeKindForStatus(status);
      if (challenge) {
        traceAuth(sync, "auth-status", status);
        await handleFortuneoChallenge(sync, tab, challenge);
        return;
      }
      if (Date.now() < fallbackDeadline) {
        scheduleAuthCheck();
        return;
      }
      traceAuth(sync, "auth-status", status);
      const message = authenticationStatusMessage(status);
      await promptForFortuneoAuthentication(sync, tab, message);
    }, 2_500);
    sync.authFallbackTimer = fallbackTimer;
  };
  scheduleAuthCheck();
}

async function prepareFortuneoAutoLogin(tabId) {
  const message = { type: "fortuneo-auto-login-ready" };
  let response = await tryFortuneoMessage(tabId, message);
  if (response?.autoLoginVersion === 5) return response;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["fortuneo-content.js"] });
  response = await tryFortuneoMessage(tabId, message);
  return response?.autoLoginVersion === 5 ? response : { ok: false, error: "FORTUNEO_AUTO_LOGIN_UNAVAILABLE" };
}

async function inspectFortuneoAuthentication(tabId) {
  try {
    const response = await tryFortuneoMessage(tabId, { type: "fortuneo-auth-diagnostics" });
    return response?.autoLoginVersion === 5
      ? { page: response.page, form: response.form, error: response.error, busy: response.busy }
      : { page: "unknown", form: "unknown", error: "diagnostics-unavailable", busy: false };
  } catch (error) {
    return { page: "unknown", form: "unknown", error: chromeErrorCode(error), busy: false };
  }
}

function authenticationStatusMessage(status) {
  if (status?.error === "invalid-credentials") return "Fortuneo rejected the stored identifier or password. Update them in Setup, then sync again.";
  if (status?.error === "account-blocked") return "Fortuneo reports that access is blocked. Complete sign-in manually before syncing again.";
  if (status?.error === "sms-code") return "Enter the code Fortuneo sent by SMS; sync will resume automatically.";
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
  const code = chromeErrorCode(error);
  const kind = internalErrorKind(error);
  const location = internalErrorLocation(error);
  const hint = internalErrorHint(error);
  const phase = syncStageLabel(failed);
  // Only browser API messages are recorded: other errors (e.g. JSON parsing) can quote Fortuneo data.
  const rawMessage = error instanceof Error ? error.message : String(error);
  const browserMessage = /^(?:A listener indicated|The message port closed|Could not establish connection|No tab with id|Frame with ID|Cannot access|The page keeping the extension port)/.test(rawMessage)
    ? rawMessage.replace(/[0-9]+/g, "#").slice(0, 100)
    : null;
  traceAuth(failed, "sync-error", { result: code, stage: failed.stage ?? failed.progressStep ?? "setup", kind, location, hint, ...(browserMessage ? { browserMessage } : {}) });
  try {
    await stopFortuneoCapture(failed, true);
  } catch (cleanupError) {
    traceAuth(failed, "cleanup-error", { kind: internalErrorKind(cleanupError), location: internalErrorLocation(cleanupError) });
  }
  await setUi("error", `Sync failed during ${phase}: ${hint} (${code}; ${kind} at ${location}). Copy diagnostics to report it.`, [code], null, failed.dryRun ? "preview" : "sync", failed.authTrace);
}

function syncStageLabel(sync) {
  if (sync.nativePhase) return diagnosticPhaseLabel(sync.nativePhase);
  return ({ "collecting-fortuneo": "the Fortuneo data read", "preparing-snapshot": "Fortuneo data processing", "native-handoff": "native helper processing" })[sync.stage]
    ?? ({ setup: "local setup", connection: "the Fortuneo connection", fortuneo: "the Fortuneo data read", prepare: "sync preparation", write: "Lunch Money writes" })[sync.progressStep]
    ?? "sync initialization";
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
  if (/Frame with ID .* was removed|frame.*removed|navigation|TAB_LOAD_TIMEOUT|message channel (?:is )?closed|back\/forward cache/i.test(message)) return "FORTUNEO_TAB_NAVIGATING";
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
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof RangeError) return "RangeError";
  return error instanceof Error ? "Error" : "NonErrorThrow";
}

function internalErrorHint(error) {
  return ({
    "state-race": "The sync state changed while an operation was still running",
    "invalid-json": "A response could not be read as valid JSON",
    "tab-lifecycle": "The Fortuneo tab closed or changed while it was being read",
    "native-port": "The connection to the native helper was interrupted",
    TypeError: "The sync encountered an unexpected data type",
    SyntaxError: "A response could not be parsed",
    RangeError: "A value exceeded the supported range",
  })[internalErrorKind(error)] ?? "An internal operation failed; the exact cause is not yet known";
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
  const trace = authTrace ?? activeSync?.authTrace ?? (["review", "error"].includes(status) ? [{ at: 0, event: "sync-error", result: warnings?.[0] ?? "UNEXPECTED_ERROR", phase: "status-publication", kind: "unavailable" }] : null);
  const formattedWarnings = formatUiWarnings(warnings, retainedDetails);
  const uiState = { status, message: String(message).slice(0, 500), warnings: formattedWarnings, ...(retainedDetails ? { details: retainedDetails } : {}), ...(operation ? { operation } : {}), ...((status === "running" || status === "needs-auth") && activeSync?.progressStep ? { progressStep: activeSync.progressStep } : {}), ...((status === "running" || status === "needs-auth") && activeSync?.progressStep === "fortuneo" && activeSync.fortuneoReadStep ? { fortuneoReadStep: activeSync.fortuneoReadStep } : {}), ...(Array.isArray(trace) && trace.length > 0 && ["running", "review", "error", "needs-auth"].includes(status) ? { authTrace: trace.slice(-30) } : {}), updatedAt: new Date().toISOString(), ...((status === "running" || status === "needs-auth") && activeSync?.deadlineAt ? { startedAt: activeSync.startedAt, timeoutStartedAt: activeSync.timeoutStartedAt, deadlineAt: activeSync.deadlineAt } : {}) };
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
    : warning === "SETTLED_CARD_REFERENCE_MISMATCH"
      ? "A settlement differs from its original purchase. The purchase was left unchanged and needs review."
    : warning === "SETTLED_CARD_PURCHASE_GROUPED"
      ? "A settled purchase belongs to a group. It was left unchanged and needs review."
    : warning === "SETTLED_CARD_REFERENCE_UNRESOLVED"
      ? "Some settled card purchases could not be matched uniquely. No replacement purchases or payment credits were created."
      : warning === "UNEXPECTED_ERROR" ? "An internal error stopped the sync. See diagnostics for the failing step."
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
  // Keep one line per read step so per-item progress does not push earlier steps out of the trace.
  const last = sync.authTrace.at(-1);
  if (event === "fortuneo-read" && last?.event === "fortuneo-read" && last.step === details.step) sync.authTrace.pop();
  sync.authTrace.push(entry);
  if (sync.authTrace.length > 30) sync.authTrace.shift();
  scheduleTraceFlush(sync);
}

function scheduleTraceFlush(sync) {
  // Save the running trace even when the status does not change, so diagnostics show the latest steps.
  if (typeof activeSync === "undefined" || sync !== activeSync || sync.traceFlushTimer || typeof setTimeout !== "function") return;
  sync.traceFlushTimer = setTimeout(async () => {
    sync.traceFlushTimer = null;
    if (activeSync !== sync) return;
    const { uiState } = await chrome.storage.session.get("uiState");
    if (activeSync !== sync || !uiState || !["running", "needs-auth"].includes(uiState.status)) return;
    await chrome.storage.session.set({ uiState: { ...uiState, authTrace: sync.authTrace.slice(-30) } });
  }, 500);
}

function fortuneoPathShape(url) {
  // Route shape only: identifiers are masked and query values dropped, so diagnostics stay private.
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://mabanque.fortuneo.fr") return "external";
    const path = parsed.pathname.split("/").map((part) => (part === "" || (/^[a-z]+(?:-[a-z]+)*$/.test(part) && part.length <= 24) ? part : ":id")).join("/");
    const keys = [...parsed.searchParams.keys()].filter((key) => /^[A-Za-z0-9_-]{1,24}$/.test(key)).slice(0, 6);
    return `${path}${keys.length ? `?${keys.join("&")}` : ""}${parsed.hash ? "#" : ""}`.slice(0, 120);
  } catch {
    return "unknown";
  }
}

function fortuneoPageKind(url) {
  if (isFortuneoAccountUrl(url)) return "account";
  if (isFortuneoLogin(url)) return "login";
  if (typeof url === "string" && url.startsWith("https://mabanque.fortuneo.fr/")) return "fortuneo-other";
  return "other";
}

async function updateActionIndicator(status, operation, lastSuccessfulLocalDate, warningCount = 0) {
  const stored = await chrome.storage.local.get(["lastSuccessfulLocalDate", "fortuneoChallengeLocalDate", "fortuneoChallengeKind"]);
  if (lastSuccessfulLocalDate === undefined) lastSuccessfulLocalDate = stored.lastSuccessfulLocalDate;
  const challengePending = Boolean(stored.fortuneoChallengeKind) && stored.fortuneoChallengeLocalDate === localDate() && lastSuccessfulLocalDate !== localDate();
  let text;
  let color = "#2b8066";
  let title;
  if (challengePending && !["running", "success", "warning"].includes(status)) {
    text = stored.fortuneoChallengeKind === "sms-code" ? "SMS" : "2FA";
    color = "#7a3fb0";
    title = stored.fortuneoChallengeKind === "sms-code"
      ? "Fortuneo is waiting for the SMS code. Enter it in the Fortuneo tab; automatic sync is paused until tomorrow."
      : "Fortuneo is waiting for a security check. Complete it in the Fortuneo tab; automatic sync is paused until tomorrow.";
  } else if (status === "running") {
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
  if (!breakdown) return `${prefix}: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} removed`;
  const accountChanges = dryRun
    ? `${breakdown.accountsCreated} to create, ${breakdown.accountsUpdated} to update`
    : `${breakdown.accountsCreated} created, ${breakdown.accountsUpdated} updated`;
  const transactionChanges = dryRun
    ? `${breakdown.transactionsCreated} to create, ${breakdown.transactionsUpdated} to update, ${breakdown.transactionsDeleted} to remove`
    : `${breakdown.transactionsCreated} created, ${breakdown.transactionsUpdated} updated, ${breakdown.transactionsDeleted} removed`;
  const deferredDiagnostic = breakdown.fortuneoDeferred === 0 && diagnostics
    ? ` Deferred read: ${diagnostics.deferredDateCandidates} dates, ${diagnostics.deferredResponses} responses, ${diagnostics.deferredRows} rows; amount ${diagnostics.deferredRowsWithAmount}, label ${diagnostics.deferredRowsWithLabel}, date ${diagnostics.deferredRowsWithDate}; fields ${Array.isArray(diagnostics.deferredFields) ? diagnostics.deferredFields.join(",") : "unknown"}.`
    : "";
  return `${prefix}: accounts ${accountChanges}; transactions ${transactionChanges}. Fortuneo detected ${breakdown.fortuneoSettled} settled, ${breakdown.fortuneoDeferred} deferred, ${breakdown.fortuneoPending} pending.${deferredDiagnostic}`;
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

function syncFailureLabel(summary, fallbackPhase = "native helper processing") {
  const diagnostic = summary?.diagnostic;
  const code = typeof diagnostic?.code === "string" ? diagnostic.code : (typeof summary?.message === "string" ? summary.message : "UNEXPECTED_ERROR");
  if (!diagnostic) return `Sync failed during ${fallbackPhase}: ${code}. The helper supplied no exception details. Copy diagnostics to report it.`;
  const phase = typeof diagnostic.phase === "string" ? diagnosticPhaseLabel(diagnostic.phase) : fallbackPhase;
  const kind = typeof diagnostic.kind === "string" ? diagnostic.kind : "Error";
  const location = typeof diagnostic.location === "string" ? ` at ${diagnostic.location}` : "";
  const fingerprint = typeof diagnostic.fingerprint === "string" ? `; diagnostic ${diagnostic.fingerprint}` : "";
  const hint = typeof diagnostic.hint === "string" ? `${diagnostic.hint}. ` : "";
  return `Sync failed during ${phase}: ${hint}${code} (${kind}${location}${fingerprint}). Copy diagnostics to report it.`;
}

function diagnosticPhaseLabel(phase) {
  return ({
    "validating-request": "request validation",
    "get-fortuneo-credentials": "the saved Fortuneo credential read",
    "get-fortuneo-account-urls": "the saved Fortuneo account read",
    "collecting-fortuneo": "the Fortuneo data read",
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

function challengeKindForStatus(status) {
  return FORTUNEO_CHALLENGE_KINDS.includes(status?.error) ? status.error : null;
}

async function handleFortuneoChallenge(sync, tab, kind) {
  if (activeSync !== sync) return;
  sync.waitingForFortuneo = true;
  sync.waitingForAuthentication = true;
  if (sync.challenge) return;
  sync.challenge = kind;
  sync.challengeSeen = true;
  sync.challengeCount = (sync.challengeCount ?? 0) + 1;
  // Signing in again after a code would make Fortuneo send another one.
  sync.autoAuthAttempted = true;
  sync.idleTimeoutMs = FORTUNEO_CHALLENGE_TIMEOUT_MS;
  // The user needs this tab to type the code, also after the sync gives up.
  sync.fortuneoTabCreated = false;
  clearAuthFallback(sync);
  traceAuth(sync, "security-challenge", { kind });
  await chrome.storage.local.set({ fortuneoChallengeLocalDate: localDate(), fortuneoChallengeKind: kind });
  refreshSyncTimeout(sync);
  // Bring the code tab to the front instead of a notification: the user can type the code right away.
  if (tab.id !== undefined) {
    await chrome.storage.session.set({ fortuneoChallengeTabId: tab.id });
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  if (activeSync !== sync) return;
  const message = authenticationStatusMessage({ error: kind });
  sync.authenticationMessage = message;
  await setUi("needs-auth", message, []);
  if (tab.id !== undefined) watchFortuneoChallenge(sync, tab.id);
}

function watchFortuneoChallenge(sync, tabId) {
  // Fortuneo can leave the code page without reloading the tab, so no tab event announces it.
  clearChallengeWatch(sync);
  sync.challengeWatch = setInterval(async () => {
    if (activeSync !== sync || !sync.challenge) {
      clearChallengeWatch(sync);
      return;
    }
    const status = await inspectFortuneoAuthentication(tabId);
    if (activeSync !== sync || !sync.challenge || challengeKindForStatus(status) || status.page === "unknown") return;
    clearChallengeWatch(sync);
    traceAuth(sync, "challenge-left", { page: status.page });
    sync.challenge = null;
    await collectAndForwardSnapshot(sync.requestId);
  }, 2_000);
}

function clearChallengeWatch(sync) {
  if (sync?.challengeWatch) clearInterval(sync.challengeWatch);
  if (sync) sync.challengeWatch = null;
}

async function resolveFortuneoChallenge(sync) {
  traceAuth(sync, "security-challenge-resolved", { kind: sync.challenge });
  clearChallengeWatch(sync);
  sync.challenge = null;
  sync.idleTimeoutMs = null;
  refreshSyncTimeout(sync);
  // Keep automatic syncs paused for the day (only a success lifts it); the code itself is no longer awaited.
  await chrome.storage.local.set({ fortuneoChallengeKind: null });
  await forgetFortuneoChallengeTab();
}

async function resumeAfterFortuneoChallenge(tabId) {
  // The code was entered after the sync gave up: finish today's sync with the now-open session.
  const { fortuneoChallengeLocalDate, fortuneoChallengeKind, lastSuccessfulLocalDate, setupPreviewConfirmed } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (activeSync || syncStartPending || !setupPreviewConfirmed || !fortuneoChallengeKind || fortuneoChallengeLocalDate !== localDate() || lastSuccessfulLocalDate === localDate()) return false;
  await chrome.storage.local.set({ fortuneoChallengeKind: null });
  await forgetFortuneoChallengeTab();
  return startSync("sync-if-due", null, { fortuneoTabId: tabId, afterChallenge: true });
}

async function forgetFortuneoChallengeTab() {
  try {
    await chrome.storage.session.remove("fortuneoChallengeTabId");
  } catch {
    // Nothing to clear.
  }
}


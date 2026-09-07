import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../packages/extension/src/service-worker.js", import.meta.url), "utf8");
const submitSource = source.slice(source.indexOf("async function submitFortuneoCredentials("), source.indexOf("async function promptForFortuneoAuthentication("));
const advanceAccountSource = source.slice(source.indexOf("function advanceFortuneoAccount("), source.indexOf("async function sendFortuneoMessage("));
const authenticateSource = source.slice(source.indexOf("async function authenticateFortuneoOrPrompt("), source.indexOf("async function prepareFortuneoAutoLogin("));
const stopCaptureSource = source.slice(source.indexOf("async function stopFortuneoCapture("), source.indexOf("function chromeErrorCode("));
const syncTimeoutSource = source.slice(source.indexOf("function scheduleSyncTimeout("), source.indexOf("function refreshSyncTimeout("));

describe("Fortuneo automatic sign-in", () => {
  it("allows a fresh sign-in attempt for the next account and cancels the old fallback", () => {
    const clearAuthFallback = vi.fn();
    const first = "https://mabanque.fortuneo.fr/account-summary/first";
    const second = "https://mabanque.fortuneo.fr/account-summary/second";
    const sync = {
      accountTargetIndex: 0, accountTargets: [first, second], requestedFortuneoUrl: first,
      requestedFortuneoTabId: 1, targetNavigationAttempted: false,
      payloads: [{ path: "account" }], collecting: true, autoAuthAttempted: true,
      waitingForFortuneo: false, fortuneoReadStep: "deferred",
    };
    const advanced = runInNewContext(`${advanceAccountSource}\nadvanceFortuneoAccount(sync)`, { sync, clearAuthFallback });
    expect(advanced).toBe(true);
    expect(clearAuthFallback).toHaveBeenCalledWith(sync);
    expect(sync).toMatchObject({ accountTargetIndex: 1, requestedFortuneoUrl: second, requestedFortuneoTabId: null,
      targetNavigationAttempted: true, payloads: [], collecting: false, autoAuthAttempted: false,
      waitingForFortuneo: true, fortuneoReadStep: "account" });
    expect(runInNewContext(`${advanceAccountSource}\nadvanceFortuneoAccount(sync)`, { sync, clearAuthFallback })).toBe(false);
  });

  it("ignores an authentication fallback from a previous account", async () => {
    let fallback = async () => {};
    const sync = { accountTargetIndex: 0, autoAuthAttempted: false, waitingForFortuneo: true, waitingForAuthentication: false };
    const inspectFortuneoAuthentication = vi.fn();
    const context = {
      sync, tab: { id: 1 }, activeSync: sync, crypto: { randomUUID: () => "id" },
      nativeOneShot: vi.fn().mockResolvedValue({ type: "fortuneo-credentials", available: true, accessCode: "user", password: "password" }),
      submitFortuneoCredentials: vi.fn().mockResolvedValue(true),
      setUi: vi.fn(), traceAuth: vi.fn(), clearAuthFallback: vi.fn(), inspectFortuneoAuthentication,
      authenticationIsPending: () => true, authenticationStatusMessage: vi.fn(), promptForFortuneoAuthentication: vi.fn(),
      setTimeout: (callback: () => Promise<void>) => { fallback = callback; return 1; },
    };
    await runInNewContext(`${authenticateSource}\nauthenticateFortuneoOrPrompt(sync, tab, true)`, context);
    expect(context.submitFortuneoCredentials).toHaveBeenCalledOnce();
    sync.accountTargetIndex = 1;
    await fallback();
    expect(inspectFortuneoAuthentication).not.toHaveBeenCalled();
  });

  it("prompts immediately when an account returns to login after its attempt", async () => {
    const sync = { accountTargetIndex: 1, autoAuthAttempted: true, waitingForAuthentication: false };
    const promptForFortuneoAuthentication = vi.fn();
    const nativeOneShot = vi.fn();
    await runInNewContext(`${authenticateSource}\nauthenticateFortuneoOrPrompt(sync, tab, true)`, {
      sync, tab: { id: 1 }, traceAuth: vi.fn(), promptForFortuneoAuthentication,
      nativeOneShot,
    });
    expect(promptForFortuneoAuthentication).toHaveBeenCalledWith(sync, { id: 1 },
      "Automatic sign-in did not open this account. Sign in manually; sync will resume automatically.");
    expect(nativeOneShot).not.toHaveBeenCalled();
  });

  it.each([false, true])("submits with remembered account=%s even without animation frames", async (remembered) => {
    const click = vi.fn();
    class Element { click = click; }
    class Input extends Element {
      value = "";
      disabled = false;
      dispatchEvent = vi.fn();
      closest() { return form; }
    }
    const user = new Input();
    const password = new Input();
    const submit = new Element();
    let identifierVisible = !remembered;
    const changeAccount = {
      innerText: "Changer de compte", disabled: false,
      getAttribute: () => null, getClientRects: () => [{}],
      click: vi.fn(() => { identifierVisible = true; }),
    };
    const form = {
      querySelectorAll: () => identifierVisible ? [user, password] : [],
      querySelector: (selector: string) => selector.includes("LOGIN") ? (identifierVisible ? user : null) : submit,
    };
    const requestAnimationFrame = vi.fn();
    const context = {
      chrome: { scripting: { executeScript: async (options: { func: (...args: string[]) => Promise<boolean>; args: string[] }) => [{ result: await options.func(...options.args) }] } },
      location: { origin: "https://mabanque.fortuneo.fr" },
      document: { querySelector: () => password, querySelectorAll: () => [changeAccount] },
      HTMLInputElement: Input,
      HTMLElement: Element,
      InputEvent: class {},
      Event: class {},
      requestAnimationFrame,
      setTimeout,
    };
    const result = await runInNewContext(`${submitSource}\nsubmitFortuneoCredentials(1, 'test-user', 'test-password')`, context);
    expect(result).toBe(true);
    expect(user.value).toBe("test-user");
    expect(password.value).toBe("test-password");
    expect(click).toHaveBeenCalledOnce();
    expect(changeAccount.click).toHaveBeenCalledTimes(remembered ? 1 : 0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe("Fortuneo tab cleanup", () => {
  it("closes a tab created by the extension even after it navigates away from Fortuneo", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const context = {
      FORTUNEO_TAB_URL: "https://mabanque.fortuneo.fr/*",
      chrome: { tabs: { query: vi.fn().mockResolvedValue([]), sendMessage: vi.fn(), remove } },
      sync: { fortuneoTabCreated: true, fortuneoTabId: 42 },
    };

    await runInNewContext(`${stopCaptureSource}\nstopFortuneoCapture(sync, true)`, context);

    expect(remove).toHaveBeenCalledWith(42);
  });

  it("does not close a Fortuneo tab that the user already had open", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const context = {
      FORTUNEO_TAB_URL: "https://mabanque.fortuneo.fr/*",
      chrome: { tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]), sendMessage: vi.fn().mockResolvedValue(undefined), remove } },
      sync: { fortuneoTabCreated: false, fortuneoTabId: 42 },
    };

    await runInNewContext(`${stopCaptureSource}\nstopFortuneoCapture(sync, true)`, context);

    expect(remove).not.toHaveBeenCalled();
  });

  it("closes an extension-created tab when authentication times out", async () => {
    let timeout = () => {};
    const stopFortuneoCapture = vi.fn();
    const sync = {
      authIssue: null, authTrace: [], authenticationMessage: "Sign in to Fortuneo",
      confirmedSnapshot: null, deadlineAt: 1, dryRun: false, port: { disconnect: vi.fn() },
      progressStep: "fortuneo", waitTimer: null, waitingForAuthentication: true,
    };
    const context = {
      activeSync: sync, sync, clearFortuneoWait: vi.fn(), fortuneoDetectionSummary: vi.fn(),
      setUi: vi.fn(), stopFortuneoCapture, traceAuth: vi.fn(),
      setTimeout: (callback: () => void) => { timeout = callback; return 1; },
    };

    runInNewContext(`${syncTimeoutSource}\nscheduleSyncTimeout(sync)`, context);
    timeout();

    expect(stopFortuneoCapture).toHaveBeenCalledWith(sync, true);
  });
});

const retrySource = source.slice(source.indexOf("async function scheduleSyncRetries("), source.indexOf("function validateToken("));
const tabSource = source.slice(source.indexOf("async function syncForLunchMoneyTab("), source.indexOf("async function initializeStorage("));
const dueSource = source.slice(source.indexOf("async function syncIfDue("), source.indexOf("async function startSync("));
const startupFailureSource = source.slice(source.indexOf("async function reportStartupFailure("), source.indexOf("function enqueueNativeMessage("));

describe("automatic daily sync", () => {
  it("publishes startup failures instead of leaving automatic sync idle", async () => {
    const setUi = vi.fn();
    const error = new TypeError("sensitive local detail");
    await runInNewContext(`${startupFailureSource}\nreportStartupFailure("sync-if-due", "reading-account-routes", error)`, {
      error, setUi,
      chromeErrorCode: () => "UNEXPECTED_ERROR",
      internalErrorKind: () => "TypeError",
      internalErrorLocation: () => "service-worker:219",
    });
    expect(setUi).toHaveBeenCalledWith(
      "error",
      "Sync could not start during the saved Fortuneo account read: UNEXPECTED_ERROR (TypeError at service-worker:219).",
      ["UNEXPECTED_ERROR"], null, "sync",
      [{ at: 0, event: "startup-error", stage: "reading-account-routes", result: "UNEXPECTED_ERROR", kind: "TypeError", location: "service-worker:219" }],
    );
    expect(JSON.stringify(setUi.mock.calls)).not.toContain("sensitive local detail");
  });

  it("preserves the retry deadline across service-worker wakeups", async () => {
    const create = vi.fn();
    const get = vi.fn().mockResolvedValue({ scheduledTime: 12345 });
    await runInNewContext(`${retrySource}\nscheduleSyncRetries()`, {
      chrome: { alarms: { get, create } }, SYNC_RETRY_ALARM: "retry-daily-sync",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("restores a missing retry alarm", async () => {
    const create = vi.fn();
    await runInNewContext(`${retrySource}\nscheduleSyncRetries()`, {
      chrome: { alarms: { get: vi.fn().mockResolvedValue(undefined), create } }, SYNC_RETRY_ALARM: "retry-daily-sync",
    });
    expect(create).toHaveBeenCalledWith("retry-daily-sync", { delayInMinutes: 15, periodInMinutes: 15 });
  });

  it.each([
    ["https://my.lunchmoney.app/overview", true],
    ["https://beta.lunchmoney.app/transactions", true],
    ["https://example.com/", false],
  ])("checks whether a sync is due when returning to %s", async (url, expected) => {
    const syncIfDue = vi.fn();
    await runInNewContext(`${tabSource}\nsyncForLunchMoneyTab(42)`, {
      initialized: Promise.resolve(), URL, syncIfDue,
      chrome: { tabs: { get: vi.fn().mockResolvedValue({ url }) } },
    });
    expect(syncIfDue).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it.each([
    [null, null, 1],
    [null, new Date(Date.now() - 16 * 60_000).toISOString(), 1],
    [null, new Date().toISOString(), 0],
    ["today", null, 0],
  ])("retries failures after cooldown and skips today's success (%s, %s)", async (lastSuccessfulLocalDate, lastSyncAttemptAt, count) => {
    const startSync = vi.fn().mockResolvedValue(true);
    await runInNewContext(`${dueSource}\nsyncIfDue()`, {
      chrome: { runtime: { getManifest: () => ({ version: "test-version" }) }, storage: { local: { get: vi.fn().mockResolvedValue({ lastSuccessfulLocalDate, lastSyncAttemptAt, lastSyncAttemptVersion: "test-version", setupPreviewConfirmed: true }) } } },
      DEFAULT_SETTINGS: {}, SYNC_RETRY_COOLDOWN_MS: 15 * 60_000,
      localDate: () => "today", activeSync: null, syncStartPending: false, startSync,
    });
    expect(startSync).toHaveBeenCalledTimes(count);
  });
});

const contentSource = readFileSync(new URL("../../packages/extension/src/fortuneo-content.js", import.meta.url), "utf8");
const authDiagnosticsSource = contentSource.slice(contentSource.indexOf("function authenticationDiagnostics("), contentSource.indexOf("async function prepareAutoLogin("));
const welcomeSource = contentSource.slice(contentSource.indexOf("function selectNewCustomerSpace("), contentSource.indexOf("async function waitForLoginForm("));

it("does not mistake a future lockout warning for a blocked account", () => {
  const diagnose = (body: string) => runInNewContext(`${authDiagnosticsSource}\nauthenticationDiagnostics().error`, {
    document: { body: { innerText: body }, querySelector: () => null },
    accountIdFromUrl: () => null, location: { pathname: "/mon-espace", hash: "" },
    HTMLInputElement: class {},
  });
  expect(diagnose("Attention : votre compte sera bloqué après plusieurs tentatives incorrectes.")).toBe("none");
  expect(diagnose("Votre compte est bloqué.")).toBe("account-blocked");
});
const popupSource = readFileSync(new URL("../../packages/extension/src/popup.js", import.meta.url), "utf8");
const progressSource = popupSource.slice(popupSource.indexOf("function progressPercent("), popupSource.indexOf("function fortuneoReadStepLabel("));

describe("extension popup progress", () => {
  it("advances to each phase floor without moving backwards", () => {
    const progressPercent = runInNewContext(`${progressSource}\nprogressPercent`, { Date, Math });
    const now = Date.now();
    const at = (progressStep: string, previousPercent: number, fortuneoReadStep?: string) => progressPercent({ progressStep, fortuneoReadStep, updatedAt: new Date(now).toISOString() }, previousPercent, now);

    expect(at("setup", 2)).toBe(5);
    expect(at("connection", 5)).toBe(25);
    expect(at("fortuneo", 25, "transactions")).toBe(55);
    expect(at("prepare", 55)).toBe(82);
    expect(at("write", 94)).toBe(94);
  });

  it("caps the gentle animation below completion", () => {
    const progressPercent = runInNewContext(`${progressSource}\nprogressPercent`, { Date, Math });
    const now = Date.now();
    const state = { progressStep: "write", updatedAt: new Date(now - 60_000).toISOString() };
    expect(progressPercent(state, 2, now)).toBe(97);
  });
});

describe("Fortuneo welcome page", () => {
  function button(text: string, visible = true, disabled = false) {
    return { innerText: text, disabled, getAttribute: () => null, getClientRects: () => visible ? [{}] : [], click: vi.fn() };
  }

  it("chooses the new customer space once, leaving the old-space button untouched", () => {
    const next = button("Découvrir mon nouvel\n espace client");
    const old = button("Continuer avec l’espace client actuel");
    const results = runInNewContext(`let welcomeSelected = false; ${welcomeSource}\n[selectNewCustomerSpace(), selectNewCustomerSpace()]`, {
      location: { origin: "https://mabanque.fortuneo.fr" }, document: { querySelectorAll: () => [next, old] },
    });
    expect(results).toEqual([true, false]);
    expect(next.click).toHaveBeenCalledOnce();
    expect(old.click).not.toHaveBeenCalled();
  });

  it.each(["hidden", "disabled", "ambiguous", "other-origin"])("does not click a %s control", (kind) => {
    const next = button("Découvrir mon nouvel espace client", kind !== "hidden", kind === "disabled");
    runInNewContext(`let welcomeSelected = false; ${welcomeSource}\nselectNewCustomerSpace()`, {
      location: { origin: kind === "other-origin" ? "https://example.com" : "https://mabanque.fortuneo.fr" },
      document: { querySelectorAll: () => kind === "ambiguous" ? [next, next] : [next] },
    });
    expect(next.click).not.toHaveBeenCalled();
  });

  it("handles a welcome page rendered after login and signals the subsequent account route", () => {
    let tick = () => {};
    let account: string | null = null;
    const next = button("Découvrir mon nouvel espace client");
    let buttons: ReturnType<typeof button>[] = [];
    const notify = vi.fn();
    const clear = vi.fn();
    runInNewContext(`let welcomeSelected = false; let welcomeWatcher = null; ${welcomeSource}\nwatchWelcomePage()`, {
      location: { origin: "https://mabanque.fortuneo.fr" }, document: { querySelectorAll: () => buttons },
      setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: clear,
      accountIdFromUrl: () => account, notifyIfAuthenticated: notify,
    });
    tick();
    expect(next.click).not.toHaveBeenCalled();
    buttons = [next];
    tick();
    tick();
    expect(next.click).toHaveBeenCalledOnce();
    account = "test-account";
    tick();
    expect(notify).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(1);
  });
});

it.each([null, "previous-version"])("automatically retries after an upgrade despite a recent failure on %s", async (lastSyncAttemptVersion) => {
  const startSync = vi.fn().mockResolvedValue(true);
  await runInNewContext(`${dueSource}\nsyncIfDue()`, {
    chrome: { runtime: { getManifest: () => ({ version: "new-version" }) }, storage: { local: { get: vi.fn().mockResolvedValue({
      lastSuccessfulLocalDate: null, lastSyncAttemptAt: new Date().toISOString(), lastSyncAttemptVersion, setupPreviewConfirmed: true,
    }) } } },
    DEFAULT_SETTINGS: {}, SYNC_RETRY_COOLDOWN_MS: 15 * 60_000,
    localDate: () => "today", activeSync: null, syncStartPending: false, startSync,
  });
  expect(startSync).toHaveBeenCalledWith("sync-if-due");
});

const senderSource = source.slice(source.indexOf("function isAllowedSender("), source.indexOf("async function handleMessage("));

describe("extension confidentiality boundaries", () => {
  const runtime = { id: "test-extension", getURL: (path: string) => `chrome-extension://test-extension/${path}` };

  it.each([
    ["configure", { id: runtime.id, url: runtime.getURL("popup.html") }, true],
    ["configure", { id: runtime.id, url: "https://my.lunchmoney.app/", tab: { id: 1 }, frameId: 0 }, false],
    ["list-accounts", { id: runtime.id, url: "https://mabanque.fortuneo.fr/", tab: { id: 1 }, frameId: 0 }, false],
    ["sync-if-due", { id: runtime.id, url: "https://my.lunchmoney.app/", tab: { id: 1 }, frameId: 0 }, true],
    ["sync-if-due", { id: runtime.id, url: "https://my.lunchmoney.app/", tab: { id: 1 }, frameId: 2 }, false],
    ["configure", { id: "other", url: runtime.getURL("popup.html") }, false],
  ])("authorizes %s only for its intended sender", (type, sender, expected) => {
    expect(runInNewContext(`${senderSource}\nisAllowedSender(type, sender)`, {
      chrome: { runtime }, type, sender, URL,
      isLunchMoneyUrl: (value: string) => value === "https://my.lunchmoney.app/",
    })).toBe(expected);
  });

  it("does not restore financial details from disk when session data is gone", async () => {
    const result = await runInNewContext(`${senderSource}\nreadSettings()`, {
      DEFAULT_SETTINGS: { uiState: { status: "idle" } },
      chrome: { storage: {
        local: { get: async () => ({ lastSuccessfulLocalDate: "today", uiState: { details: { merchant: "private" } } }) },
        session: { get: async (defaults: unknown) => defaults },
      } },
    });
    expect(result).toEqual({ lastSuccessfulLocalDate: "today", uiState: { status: "idle" } });
  });
});

const setUiSource = source.slice(source.indexOf("async function setUi("), source.indexOf("function phaseLabelForProgress("));

it("keeps financial review details in session storage", async () => {
  const localSet = vi.fn();
  const sessionSet = vi.fn();
  const details = { transactions: [{ merchant: "private fixture", amount: "42.00" }] };
  await runInNewContext(`${setUiSource}\nsetUi("success", "Preview ready", [], details, "preview")`, {
    details, activeSync: null, LUNCH_MONEY_URLS: [],
    formatUiWarnings: () => [], updateActionIndicator: vi.fn(),
    chrome: {
      storage: { local: { set: localSet }, session: { set: sessionSet } },
      tabs: { query: async () => [] },
    },
  });
  expect(localSet).not.toHaveBeenCalled();
  expect(sessionSet).toHaveBeenCalledWith({ uiState: expect.objectContaining({ details }) });
});

const nativeMessageSource = source.slice(source.indexOf("async function handleNativeMessage("), source.indexOf("async function collectAndForwardSnapshot("));
const nativeMessageQueueSource = source.slice(source.indexOf("function enqueueNativeMessage("), source.indexOf("async function handleNativeMessage("));
const syncFailureSource = source.slice(source.indexOf("function syncFailureLabel("), source.indexOf("function safeCode("));

it("renders redacted failure diagnostics with phase and source location", () => {
  const summary = { message: "UNEXPECTED_ERROR", diagnostic: {
    code: "UNEXPECTED_ERROR", phase: "building-result", kind: "TypeError",
    location: "packages/native-host/src/sync-service.js:147:19", fingerprint: "A1B2C3D4E5F6",
  } };
  const result = runInNewContext(`${syncFailureSource}\nsyncFailureLabel(summary)`, { summary });
  expect(result).toBe("Sync failed during final result construction: UNEXPECTED_ERROR (TypeError at packages/native-host/src/sync-service.js:147:19; diagnostic A1B2C3D4E5F6).");
});

it("serializes native progress and result messages", async () => {
  const order: string[] = [];
  let releaseProgress = () => {};
  const progressBlocked = new Promise<void>((resolve) => { releaseProgress = resolve; });
  const sync = { requestId: "sync-1", nativeMessageQueue: Promise.resolve() };
  const context = {
    sync,
    first: { type: "progress" },
    second: { type: "result" },
    handleNativeMessage: vi.fn(async (message: { type: string }) => {
      order.push(`${message.type}:start`);
      if (message.type === "progress") await progressBlocked;
      order.push(`${message.type}:end`);
    }),
    failActiveSync: vi.fn(),
  };

  runInNewContext(`${nativeMessageQueueSource}\nenqueueNativeMessage(sync, first); enqueueNativeMessage(sync, second);`, context);
  await Promise.resolve();
  expect(order).toEqual(["progress:start"]);
  releaseProgress();
  await sync.nativeMessageQueue;
  expect(order).toEqual(["progress:start", "progress:end", "result:start", "result:end"]);
});

it("claims a completed sync before publishing its final UI state", async () => {
  const disconnect = vi.fn();
  const stopFortuneoCapture = vi.fn();
  let activeDuringSetUi: unknown = "not-called";
  const details = { accounts: [], transactions: [], truncatedTransactions: 0 };
  const context = {
    activeSync: {
      requestId: "sync-1", dryRun: false, port: { disconnect }, snapshot: null,
      fortuneoDiagnostics: null, authTrace: [],
    },
    refreshSyncTimeout: vi.fn(), traceAuth: vi.fn(), clearFortuneoWait: vi.fn(),
    collectAndForwardSnapshot: vi.fn(), phaseLabel: vi.fn(), progressStepForPhase: vi.fn(),
    summaryLabel: vi.fn(), syncCompletionLabel: () => "Sync complete.", localDate: () => "2026-09-12",
    stopFortuneoCapture,
    chrome: { storage: {
      local: { set: vi.fn(), get: vi.fn().mockResolvedValue({}) },
      session: { set: vi.fn(), remove: vi.fn() },
    } },
  };
  Object.assign(context, {
    setUi: vi.fn(async () => { activeDuringSetUi = context.activeSync; }),
    message: { version: 2, type: "result", requestId: "sync-1", ok: true, dryRun: false, summary: { warnings: [], details } },
  });

  await runInNewContext(`${nativeMessageSource}\n${source.slice(source.indexOf("function cardReviewNotification("))}\nhandleNativeMessage(message)`, context);

  expect(activeDuringSetUi).toBeNull();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(stopFortuneoCapture).toHaveBeenCalledOnce();
});

const notificationSource = source.slice(source.indexOf("function cardReviewNotification("));
describe("unresolved card review notifications", () => {
  const key = "a".repeat(43);
  const changed = "b".repeat(43);
  const warning = "SETTLED_CARD_REFERENCE_UNRESOLVED";
  function notify(keys: unknown, previous: string[], dryRun = false) {
    return runInNewContext(`${notificationSource}\ncardReviewNotification(warnings, keys, previous, dryRun)`, { warnings: [warning, "OTHER_WARNING"], keys, previous, dryRun });
  }
  it("reports new items, suppresses already reported items, and preserves other warnings", () => {
    expect(notify([key], []).warnings).toEqual([warning, "OTHER_WARNING"]);
    expect(notify([key], [key]).warnings).toEqual(["OTHER_WARNING"]);
    expect(notify([key, changed], [key]).warnings).toEqual([warning, "OTHER_WARNING"]);
  });
  it("keeps previews explicit and fails open for missing or invalid identities", () => {
    expect(notify([key], [key], true).warnings).toContain(warning);
    for (const keys of [undefined, [], ["invalid"]]) expect(notify(keys, [key]).warnings).toContain(warning);
  });
  it("remembers only current opaque identities, allowing resolved items to expire", () => {
    expect(notify([changed], [key]).keys).toEqual([changed]);
    expect(notify([], [key]).keys).toEqual([]);
  });
});

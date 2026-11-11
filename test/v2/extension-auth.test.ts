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
      setUi: vi.fn(), stopFortuneoCapture, traceAuth: vi.fn(), SYNC_IDLE_TIMEOUT_MS: 60_000,
      setTimeout: (callback: () => void) => { timeout = callback; return 1; },
    };

    runInNewContext(`${syncTimeoutSource}\nscheduleSyncTimeout(sync)`, context);
    timeout();

    expect(stopFortuneoCapture).toHaveBeenCalledWith(sync, true);
  });
});

describe("Fortuneo collection progress", () => {
  const progressSource = source.slice(source.indexOf("async function handleFortuneoReadProgress("), source.indexOf("async function syncIfDue("));
  const sender = { tab: { id: 42 }, url: "https://mabanque.fortuneo.fr/mon-espace" };
  const message = { step: "details", collectionId: "collection-1", completedDetails: 1 };
  const makeSync = () => ({ collecting: true, fortuneoTabId: 42, progressStep: "fortuneo", fortuneoReadStep: "details", collectionId: "collection-1", completedDetails: 0 });

  it("extends the idle deadline only when another detail finishes", async () => {
    const sync = makeSync();
    const refreshSyncTimeout = vi.fn();
    const context = { activeSync: sync, message, sender, refreshSyncTimeout, traceAuth: vi.fn(), setUi: vi.fn(), fortuneoReadLabel: () => "Reading card details" };
    const result = await runInNewContext(`${progressSource}\nhandleFortuneoReadProgress(message, sender)`, context);
    expect(result).toEqual({ ok: true });
    expect(sync.completedDetails).toBe(1);
    expect(context.setUi).toHaveBeenCalledWith("running", "[3/4] Reading card details (1)…", []);
    await runInNewContext(`${progressSource}\nhandleFortuneoReadProgress(message, sender)`, context);
    expect(refreshSyncTimeout).toHaveBeenCalledOnce();
  });

  it("allows a detail read longer than a minute while progress continues, then stops a stalled read", async () => {
    vi.useFakeTimers();
    try {
      const sync = { ...makeSync(), deadlineAt: Date.now() + 60_000, waitTimer: null, port: { disconnect: vi.fn() } };
      const refreshSource = source.slice(source.indexOf("function refreshSyncTimeout("), source.indexOf("function fortuneoProgressLabel("));
      const context = { activeSync: sync, sync, message: { ...message }, sender, Date, setTimeout, clearTimeout,
        SYNC_IDLE_TIMEOUT_MS: 60_000, setUi: vi.fn(), traceAuth: vi.fn(), fortuneoReadLabel: () => "Reading card details",
        clearFortuneoWait: vi.fn(), stopFortuneoCapture: vi.fn(), fortuneoDetectionSummary: () => "details",
      };
      await runInNewContext(`${progressSource}\n${syncTimeoutSource}\n${refreshSource}\nscheduleSyncTimeout(sync)`, context);
      for (let count = 1; count <= 3; count += 1) {
        await vi.advanceTimersByTimeAsync(40_000);
        context.message.completedDetails = count;
        await runInNewContext("handleFortuneoReadProgress(message, sender)", context);
      }
      expect(context.activeSync).toBe(sync);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(context.activeSync).toBeNull();
      expect(sync.port.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("ignores a late collection response after the sync ended; replacement=%s", async (replace) => {
    const readSource = source.slice(source.indexOf("async function readAndForwardSnapshot("), source.indexOf("function advanceFortuneoAccount("));
    const sync = { requestId: "sync-1", collecting: false };
    const replacement = { requestId: "sync-2", collecting: false };
    const context = {
      activeSync: sync as typeof sync | null,
      getOrCreateFortuneoTab: async () => ({ tab: { id: 42, url: "account" }, created: false }),
      waitForFortuneoTabReady: vi.fn(), chrome: { tabs: { get: async () => ({ url: "account", status: "complete" }) } },
      isFortuneoAccountUrl: () => true, fortuneoAccountIdentity: () => null, clearAuthFallback: vi.fn(),
      fortuneoPageKind: () => "account", traceAuth: vi.fn(), setUi: vi.fn(),
      crypto: { randomUUID: () => "collection-1" }, FORTUNEO_COLLECT_MESSAGE: "collect",
      sendFortuneoMessage: async () => { context.activeSync = replace ? replacement : null; return { ok: true, payloads: [] }; },
    };
    await runInNewContext(`${readSource}\nreadAndForwardSnapshot("sync-1")`, context);
    expect(context.activeSync).toBe(replace ? replacement : null);
    expect(context.traceAuth.mock.calls.some((call) => call[1] === "collection-response")).toBe(false);
  });

  it.each([
    { message: { ...message, collectionId: "old-collection" }, sender },
    { message, sender: { ...sender, tab: { id: 43 } } },
    { message: { ...message, completedDetails: -1 }, sender },
    { message: { ...message, completedDetails: 0.5 }, sender },
  ])("ignores stale or invalid progress %#", async ({ message, sender }) => {
    const refreshSyncTimeout = vi.fn();
    const result = await runInNewContext(`${progressSource}\nhandleFortuneoReadProgress(message, sender)`, { activeSync: makeSync(), message, sender, refreshSyncTimeout });
    expect(result).toEqual({ ok: false });
    expect(refreshSyncTimeout).not.toHaveBeenCalled();
  });

  it("reports a delayed timeout and the actual last collection step", () => {
    let timeout = () => {};
    const sync = { deadlineAt: Date.now() - 3_600_000, waitTimer: null, port: { disconnect: vi.fn() }, fortuneoReadStep: "details", completedDetails: 12 };
    const summarySource = source.slice(source.indexOf("function fortuneoDetectionSummary("), source.indexOf("function clearFortuneoWait("));
    const setUi = vi.fn();
    const traceAuth = vi.fn();
    runInNewContext(`${summarySource}\n${syncTimeoutSource}\nscheduleSyncTimeout(sync)`, {
      activeSync: sync, sync, setUi, traceAuth, SYNC_IDLE_TIMEOUT_MS: 60_000,
      clearFortuneoWait: vi.fn(), stopFortuneoCapture: vi.fn(),
      setTimeout: (callback: () => void) => { timeout = callback; return 1; },
    });
    timeout();
    expect(setUi.mock.calls[0]?.[1]).toContain("may have been suspended");
    expect(setUi.mock.calls[0]?.[1]).toContain("card details processed: 12");
    expect(setUi.mock.calls[0]?.[1]).not.toContain("Pages seen: none");
    expect(traceAuth).toHaveBeenCalledWith(sync, "sync-timeout", expect.objectContaining({ timerDelayMs: expect.any(Number) }));
  });
});

const retrySource = source.slice(source.indexOf("async function scheduleSyncRetries("), source.indexOf("function validateToken("));
const tabSource = source.slice(source.indexOf("async function syncForLunchMoneyTab("), source.indexOf("async function initializeStorage("));
const dueSource = source.slice(source.indexOf("async function syncIfDue("), source.indexOf("async function userIsAtChrome("));
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
      internalErrorHint: () => "The sync encountered an unexpected data type",
    });
    expect(setUi).toHaveBeenCalledWith(
      "error",
      "Sync could not start during the saved Fortuneo account read: The sync encountered an unexpected data type (UNEXPECTED_ERROR; TypeError at service-worker:219). Copy diagnostics to report it.",
      ["UNEXPECTED_ERROR"], null, "sync",
      [{ at: 0, event: "startup-error", stage: "reading-account-routes", result: "UNEXPECTED_ERROR", kind: "TypeError", location: "service-worker:219", hint: "The sync encountered an unexpected data type" }],
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
      localDate: () => "today", activeSync: null, syncStartPending: false, startSync, userIsAtChrome: async () => true,
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
    runInNewContext(`let welcomeSelected = false; let welcomeWatcher = null; let welcomeDeadline = 0; ${welcomeSource}\nwatchWelcomePage()`, {
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
    userIsAtChrome: async () => true,
  });
  expect(startSync).toHaveBeenCalledWith("sync-if-due");
});

it("does not start an automatic sync while nobody is at Chrome", async () => {
  const startSync = vi.fn().mockResolvedValue(true);
  const started = await runInNewContext(`${dueSource}\nsyncIfDue()`, {
    chrome: { runtime: { getManifest: () => ({ version: "v" }) }, storage: { local: { get: vi.fn().mockResolvedValue({
      lastSuccessfulLocalDate: null, lastSyncAttemptAt: null, lastSyncAttemptVersion: null, setupPreviewConfirmed: true,
    }) } } },
    DEFAULT_SETTINGS: {}, SYNC_RETRY_COOLDOWN_MS: 15 * 60_000,
    localDate: () => "today", activeSync: null, syncStartPending: false, startSync,
    userIsAtChrome: async () => false,
  });
  expect(started).toBe(false);
  expect(startSync).not.toHaveBeenCalled();
});

describe("user presence before an automatic sync", () => {
  const presenceSource = source.slice(source.indexOf("async function userIsAtChrome("), source.indexOf("async function startSync("));
  const lunchMoney = "https://my.lunchmoney.app/overview";
  const check = (window: unknown, idleState = "active") => runInNewContext(`${presenceSource}\nuserIsAtChrome()`, {
    USER_IDLE_THRESHOLD_SECONDS: 120,
    isLunchMoneyUrl: (url: string) => typeof url === "string" && url.startsWith("https://my.lunchmoney.app"),
    chrome: {
      windows: { getLastFocused: vi.fn().mockResolvedValue(window) },
      idle: { queryState: vi.fn().mockResolvedValue(idleState) },
    },
  });

  it.each([
    ["Chrome is not the focused app", { focused: false, state: "normal", tabs: [{ active: true, url: lunchMoney }] }, "active", false],
    ["the window is minimized", { focused: true, state: "minimized", tabs: [{ active: true, url: lunchMoney }] }, "active", false],
    ["Chrome shows a tab other than Lunch Money", { focused: true, state: "normal", tabs: [{ active: true, url: "https://example.com/" }] }, "active", true],
    ["the user is idle", { focused: true, state: "normal", tabs: [{ active: true, url: lunchMoney }] }, "idle", false],
    ["the screen is locked", { focused: true, state: "normal", tabs: [{ active: true, url: lunchMoney }] }, "locked", false],
    ["Chrome is in front of an active user", { focused: true, state: "normal", tabs: [{ active: true, url: lunchMoney }] }, "active", true],
  ])("is %s → %s", async (_label, window, idleState, expected) => {
    expect(await check(window, idleState)).toBe(expected);
  });
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
  expect(result).toBe("Sync failed during final result construction: UNEXPECTED_ERROR (TypeError at packages/native-host/src/sync-service.js:147:19; diagnostic A1B2C3D4E5F6). Copy diagnostics to report it.");
});

const syncStageSource = source.slice(source.indexOf("function syncStageLabel("), source.indexOf("async function cancelSync("));
const failureSource = source.slice(source.indexOf("async function failActiveSync("), source.indexOf("async function cancelSync("));
const internalErrorSource = source.slice(source.indexOf("function chromeErrorCode("), source.indexOf("async function nativeOneShot("));
const traceSource = source.slice(source.indexOf("function traceAuth("), source.indexOf("function fortuneoPageKind("));
const safeCodeSource = source.slice(source.indexOf("function safeCode("), source.indexOf("function cardReviewNotification("));

it.each([false, true])("keeps the exception hint and diagnostics even when tab cleanup fails=%s", async (cleanupFails) => {
  const error = new TypeError("Cannot read properties of null (reading 'private-account')");
  error.stack = "TypeError: secret account\n at collect (chrome-extension://extension-id/service-worker.js:501:5)";
  const sync = { requestId: "sync-1", dryRun: false, stage: "preparing-snapshot", startedAt: Date.now(), authTrace: [], port: { disconnect: vi.fn() } };
  const setUi = vi.fn();
  const context = { activeSync: sync, error, Error, TypeError, RangeError, SyntaxError, setUi,
    clearFortuneoWait: vi.fn(), stopFortuneoCapture: cleanupFails ? vi.fn().mockRejectedValue(new Error("private cleanup detail")) : vi.fn(),
  };
  await runInNewContext(`${failureSource}\n${internalErrorSource}\n${safeCodeSource}\n${traceSource}\nfailActiveSync("sync-1", error)`, context);
  expect(context.activeSync).toBeNull();
  expect(setUi).toHaveBeenCalledWith("error", expect.stringContaining("Fortuneo data processing: The sync state changed"), ["UNEXPECTED_ERROR"], null, "sync", expect.arrayContaining([
    expect.objectContaining({ event: "sync-error", kind: "state-race", location: "service-worker:501" }),
  ]));
  expect(JSON.stringify(setUi.mock.calls)).not.toMatch(/secret account|private-account|private cleanup detail/);
});

it("keeps context when an older helper sends no diagnostic", () => {
  const result = runInNewContext(`${syncFailureSource}\nsyncFailureLabel({ message: "UNEXPECTED_ERROR" }, "account writes")`);
  expect(result).toContain("during account writes");
  expect(result).toContain("no exception details");
});

it("preserves a native preflight exception and its diagnostic trace", async () => {
  const setUi = vi.fn();
  const response = { type: "result", summary: { message: "UNEXPECTED_ERROR", diagnostic: { code: "UNEXPECTED_ERROR", phase: "get-fortuneo-account-urls", kind: "TypeError", fingerprint: "A1B2C3D4E5F6" } } };
  await runInNewContext(`${startupFailureSource}\n${syncFailureSource}\nreportNativeStartupFailure("sync", "reading-account-routes", response)`, { setUi, response });
  expect(setUi).toHaveBeenCalledWith("error", expect.stringContaining("the saved Fortuneo account read"), ["UNEXPECTED_ERROR"], null, "sync", [expect.objectContaining({ event: "startup-error", fingerprint: "A1B2C3D4E5F6" })]);
});

it("includes native failure details in Copy diagnostics after the sync is cleared", async () => {
  const sync = { requestId: "sync-1", dryRun: false, startedAt: Date.now(), nativePhase: "reading-transactions", authTrace: [], port: { disconnect: vi.fn() } };
  const setUi = vi.fn();
  const context = { activeSync: sync, setUi, refreshSyncTimeout: vi.fn(), clearFortuneoWait: vi.fn(), stopFortuneoCapture: vi.fn(),
    chrome: { storage: { local: { get: vi.fn().mockResolvedValue({}) }, session: { remove: vi.fn() } } },
    message: { version: 2, type: "result", requestId: "sync-1", ok: false, dryRun: false, summary: { message: "UNEXPECTED_ERROR", warnings: ["UNEXPECTED_ERROR"], diagnostic: { code: "UNEXPECTED_ERROR", kind: "TypeError", fingerprint: "A1B2C3D4E5F6" } } },
  };
  await runInNewContext(`${nativeMessageSource}\n${syncFailureSource}\n${syncStageSource}\n${traceSource}\n${notificationSource}\nhandleNativeMessage(message)`, context);
  expect(setUi).toHaveBeenCalledWith("review", expect.stringContaining("Lunch Money transaction read"), ["UNEXPECTED_ERROR"], null, "sync", expect.arrayContaining([expect.objectContaining({ event: "native-error", fingerprint: "A1B2C3D4E5F6" })]));
});

it("offers Copy diagnostics for a previously saved bare error", () => {
  const popup = readFileSync(new URL("../../packages/extension/src/popup.js", import.meta.url), "utf8");
  const debugSource = popup.slice(popup.indexOf("function renderDebugTrace("), popup.indexOf("async function copyDebugTrace("));
  const elements = { "auth-debug": { hidden: true }, "auth-debug-log": { textContent: "" } };
  runInNewContext(`${debugSource}\nrenderDebugTrace(null, { status: "error", message: "UNEXPECTED_ERROR", updatedAt: "2026-10-14" })`, {
    elements, chrome: { runtime: { getManifest: () => ({ version: "2.1.52" }) } },
  });
  expect(elements["auth-debug"].hidden).toBe(false);
  expect(elements["auth-debug-log"].textContent).toContain("failure-context-unavailable");
  expect(elements["auth-debug-log"].textContent).toContain("version=2.1.52");
});

it("reports collection exceptions from tab events as terminal sync failures", async () => {
  const collectorSource = source.slice(source.indexOf("async function collectAndForwardSnapshot("), source.indexOf("async function readAndForwardSnapshot("));
  const error = new SyntaxError("private response");
  const failActiveSync = vi.fn();
  await runInNewContext(`${collectorSource}\ncollectAndForwardSnapshot("sync-1")`, {
    readAndForwardSnapshot: vi.fn().mockRejectedValue(error), failActiveSync,
  });
  expect(failActiveSync).toHaveBeenCalledWith("sync-1", error);
});

it("preserves a Fortuneo parsing hint without retaining the private response", () => {
  const content = readFileSync(new URL("../../packages/extension/src/fortuneo-content.js", import.meta.url), "utf8");
  const diagnosticSource = content.slice(content.indexOf("function safeCode("), content.indexOf("function notifyIfAuthenticated("));
  const error = new SyntaxError("Unexpected token private response with account 123");
  error.stack = "SyntaxError: private response\n at collect (chrome-extension://extension-id/fortuneo-content.js:146:19)";
  const diagnostic = runInNewContext(`${diagnosticSource}\ncollectionErrorDiagnostic(error)`, { error, Error, TypeError, SyntaxError, RangeError });
  expect(diagnostic).toEqual({ code: "FORTUNEO_READ_FAILED", phase: "collecting-fortuneo", kind: "SyntaxError", location: "fortuneo-content:146:19", hint: "A Fortuneo response could not be parsed as JSON" });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private response|account 123|extension-id/);
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

describe("Fortuneo SMS code challenge", () => {
  const challengeSource = source.slice(source.indexOf("function challengeKindForStatus("));
  const diagnose = (body: string, elements: Record<string, unknown> = {}) => runInNewContext(`${authDiagnosticsSource}\nauthenticationDiagnostics().error`, {
    document: { body: { innerText: body }, querySelector: (selector: string) => Object.entries(elements).find(([key]) => selector.includes(key))?.[1] ?? null },
    accountIdFromUrl: () => null, location: { pathname: "/mon-espace", hash: "" },
    HTMLInputElement: class {},
  });

  it("recognizes the SMS code page but not SMS help text beside the login form", () => {
    class Input {}
    const context = (body: string, elements: Record<string, unknown>) => runInNewContext(`${authDiagnosticsSource}\nauthenticationDiagnostics().error`, {
      document: { body: { innerText: body }, querySelector: (selector: string) => Object.entries(elements).find(([key]) => selector.includes(key))?.[1] ?? null },
      accountIdFromUrl: () => null, location: { pathname: "/mon-espace", hash: "" }, HTMLInputElement: Input,
    });
    expect(diagnose("Saisissez le code reçu par SMS au 06 ** ** ** 12", { 'inputmode="numeric"': {} })).toBe("sms-code");
    expect(diagnose("Vérification", { 'autocomplete="one-time-code"': {} })).toBe("sms-code");
    expect(context("Recevez un code par SMS en cas d'oubli", { PASSWD: new Input(), 'inputmode="numeric"': {} })).toBe("none");
  });

  it("pauses automatic syncs for the rest of the day once a code was requested", async () => {
    const startSync = vi.fn().mockResolvedValue(true);
    const run = (fortuneoChallengeLocalDate: string | null) => runInNewContext(`${dueSource}\nsyncIfDue()`, {
      chrome: { runtime: { getManifest: () => ({ version: "v" }) }, storage: { local: { get: vi.fn().mockResolvedValue({
        lastSuccessfulLocalDate: null, lastSyncAttemptAt: null, setupPreviewConfirmed: true, fortuneoChallengeLocalDate,
      }) } } },
      DEFAULT_SETTINGS: {}, SYNC_RETRY_COOLDOWN_MS: 15 * 60_000,
      localDate: () => "2026-11-07", activeSync: null, syncStartPending: false, startSync,
      userIsAtChrome: async () => true,
    });
    expect(await run("2026-11-07")).toBe(false);
    expect(startSync).not.toHaveBeenCalled();
    await run("2026-11-06");
    expect(startSync).toHaveBeenCalledOnce();
  });

  it("keeps the code tab, brings it to the front, extends the wait and records the pause", async () => {
    const sync = { waitingForFortuneo: false, waitingForAuthentication: false, fortuneoTabCreated: true, challenge: null as string | null, idleTimeoutMs: null as number | null };
    const localSet = vi.fn();
    const context = {
      sync, activeSync: sync, FORTUNEO_CHALLENGE_KINDS: ["sms-code", "security-challenge"], FORTUNEO_CHALLENGE_TIMEOUT_MS: 300_000,
      localDate: () => "2026-11-07",
      clearAuthFallback: vi.fn(), traceAuth: vi.fn(), refreshSyncTimeout: vi.fn(), setUi: vi.fn(),
      authenticationStatusMessage: () => "Enter the code Fortuneo sent by SMS; sync will resume automatically.",
      setInterval: vi.fn(() => 9), clearInterval: vi.fn(), inspectFortuneoAuthentication: vi.fn(),
      chrome: {
        storage: { local: { set: localSet }, session: { set: vi.fn() } },
        tabs: { update: vi.fn().mockResolvedValue({}) },
        windows: { update: vi.fn().mockResolvedValue({}) },
      },
    };
    await runInNewContext(`${challengeSource}\nhandleFortuneoChallenge(sync, { id: 7, windowId: 3 }, "sms-code")`, context);
    await runInNewContext(`handleFortuneoChallenge(sync, { id: 7, windowId: 3 }, "sms-code")`, context);
    expect(sync).toMatchObject({ challenge: "sms-code", challengeSeen: true, challengeCount: 1, autoAuthAttempted: true, idleTimeoutMs: 300_000, fortuneoTabCreated: false, waitingForAuthentication: true });
    expect(localSet).toHaveBeenCalledOnce();
    expect(localSet).toHaveBeenCalledWith({ fortuneoChallengeLocalDate: "2026-11-07", fortuneoChallengeKind: "sms-code" });
    expect(context.chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(context.chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(context.setUi).toHaveBeenCalledWith("needs-auth", "Enter the code Fortuneo sent by SMS; sync will resume automatically.", []);
    expect(context.refreshSyncTimeout).toHaveBeenCalledWith(sync);
  });

  it("closes the code tab it opened once the code is accepted, but keeps the user's own tab", async () => {
    const run = async (fortuneoTabCreated: boolean) => {
      const sync: Record<string, unknown> = { waitingForFortuneo: false, waitingForAuthentication: false, fortuneoTabCreated, challenge: null, idleTimeoutMs: null };
      const sessionSet = vi.fn();
      const context = {
        sync, activeSync: sync, FORTUNEO_CHALLENGE_KINDS: ["sms-code"], FORTUNEO_CHALLENGE_TIMEOUT_MS: 300_000, localDate: () => "2026-11-07",
        clearAuthFallback: vi.fn(), traceAuth: vi.fn(), refreshSyncTimeout: vi.fn(), setUi: vi.fn(), authenticationStatusMessage: () => "code",
        setInterval: vi.fn(() => 1), clearInterval: vi.fn(), inspectFortuneoAuthentication: vi.fn(),
        chrome: { storage: { local: { set: vi.fn() }, session: { set: sessionSet, remove: vi.fn() } }, tabs: { update: vi.fn().mockResolvedValue({}) }, windows: { update: vi.fn().mockResolvedValue({}) } },
      };
      await runInNewContext(`${challengeSource}\nhandleFortuneoChallenge(sync, { id: 7, windowId: 1 }, "sms-code")`, context);
      // Kept open while the code is awaited, even if the sync gives up.
      expect(sync.fortuneoTabCreated).toBe(false);
      expect(sessionSet).toHaveBeenCalledWith({ fortuneoChallengeTabId: 7, fortuneoChallengeTabCreated: fortuneoTabCreated });
      await runInNewContext(`resolveFortuneoChallenge(sync)`, context);
      return sync.fortuneoTabCreated;
    };
    expect(await run(true)).toBe(true);
    expect(await run(false)).toBe(false);
  });

  it("reports the SMS prompt from the post-sign-in check instead of waiting for the fallback", async () => {
    const callbacks: Array<() => Promise<void>> = [];
    const sync = { accountTargetIndex: 0, autoAuthAttempted: false, waitingForFortuneo: true, waitingForAuthentication: false };
    const handleFortuneoChallenge = vi.fn();
    const promptForFortuneoAuthentication = vi.fn();
    const status = { error: "none" };
    const context = {
      sync, tab: { id: 1 }, activeSync: sync, Date, crypto: { randomUUID: () => "id" },
      nativeOneShot: vi.fn().mockResolvedValue({ type: "fortuneo-credentials", available: true, accessCode: "user", password: "password" }),
      submitFortuneoCredentials: vi.fn().mockResolvedValue(true),
      setUi: vi.fn(), traceAuth: vi.fn(), clearAuthFallback: vi.fn(),
      inspectFortuneoAuthentication: vi.fn(async () => status),
      challengeKindForStatus: (value: { error: string }) => ["sms-code", "security-challenge"].includes(value.error) ? value.error : null,
      authenticationIsPending: () => true, authenticationStatusMessage: vi.fn(), promptForFortuneoAuthentication, handleFortuneoChallenge,
      setTimeout: (callback: () => Promise<void>) => { callbacks.push(callback); return callbacks.length; },
    };
    await runInNewContext(`${authenticateSource}\nauthenticateFortuneoOrPrompt(sync, tab, true)`, context);
    await callbacks[0]!();
    expect(callbacks).toHaveLength(2);
    status.error = "sms-code";
    await callbacks[1]!();
    expect(handleFortuneoChallenge).toHaveBeenCalledWith(sync, { id: 1 }, "sms-code");
    expect(promptForFortuneoAuthentication).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(2);
  });

  it("leaves the code tab open on timeout and explains that automatic syncs are paused", () => {
    let timeout = () => {};
    const stopFortuneoCapture = vi.fn();
    const setUi = vi.fn();
    const sync = {
      authIssue: null, authTrace: [], challenge: "sms-code", confirmedSnapshot: null, deadlineAt: Date.now() + 300_000,
      dryRun: false, port: { disconnect: vi.fn() }, progressStep: "connection", waitTimer: null, waitingForAuthentication: true,
    };
    runInNewContext(`${syncTimeoutSource}\nscheduleSyncTimeout(sync)`, {
      activeSync: sync, sync, clearFortuneoWait: vi.fn(), fortuneoDetectionSummary: vi.fn(),
      setUi, stopFortuneoCapture, traceAuth: vi.fn(), SYNC_IDLE_TIMEOUT_MS: 60_000,
      setTimeout: (callback: () => void) => { timeout = callback; return 1; },
    });
    timeout();
    expect(setUi.mock.calls[0]?.[1]).toContain("SMS code was not entered");
    expect(setUi.mock.calls[0]?.[1]).toContain("paused until tomorrow");
  });

  it("does not sign in again for the next account once a code was requested", () => {
    const sync = {
      accountTargetIndex: 0, accountTargets: ["first", "second"], requestedFortuneoUrl: "first", requestedFortuneoTabId: 1,
      payloads: [], collecting: true, autoAuthAttempted: true, challengeSeen: true, waitingForFortuneo: false,
    };
    runInNewContext(`${advanceAccountSource}\nadvanceFortuneoAccount(sync)`, { sync, clearAuthFallback: vi.fn() });
    expect(sync.autoAuthAttempted).toBe(true);
  });

  it("resumes in the tab where the code was entered, without signing in again", async () => {
    const startSync = vi.fn().mockResolvedValue(true);
    const localSet = vi.fn();
    const run = (stored: Record<string, unknown>, session: Record<string, unknown> = {}) => runInNewContext(`${challengeSource}\nresumeAfterFortuneoChallenge(42)`, {
      activeSync: null, syncStartPending: false, startSync, DEFAULT_SETTINGS: {}, localDate: () => "2026-11-07",
      chrome: { storage: { local: { get: vi.fn().mockResolvedValue({ setupPreviewConfirmed: true, lastSuccessfulLocalDate: null, ...stored }), set: localSet }, session: { get: vi.fn().mockResolvedValue(session), remove: vi.fn() } } },
    });
    expect(await run({ fortuneoChallengeLocalDate: "2026-11-07", fortuneoChallengeKind: null })).toBe(false);
    await run({ fortuneoChallengeLocalDate: "2026-11-07", fortuneoChallengeKind: "sms-code" });
    expect(startSync).toHaveBeenLastCalledWith("sync-if-due", null, { fortuneoTabId: 42, afterChallenge: true, closeTabWhenDone: false });
    // A code tab the earlier sync opened is closed once this sync ends; the user's own tab is kept.
    await run({ fortuneoChallengeLocalDate: "2026-11-07", fortuneoChallengeKind: "sms-code" }, { fortuneoChallengeTabId: 42, fortuneoChallengeTabCreated: true });
    expect(startSync).toHaveBeenLastCalledWith("sync-if-due", null, { fortuneoTabId: 42, afterChallenge: true, closeTabWhenDone: true });
    await run({ fortuneoChallengeLocalDate: "2026-11-07", fortuneoChallengeKind: "sms-code" }, { fortuneoChallengeTabId: 42, fortuneoChallengeTabCreated: false });
    expect(startSync).toHaveBeenLastCalledWith("sync-if-due", null, { fortuneoTabId: 42, afterChallenge: true, closeTabWhenDone: false });
    // The daily pause stays until a sync succeeds.
    expect(localSet).toHaveBeenCalledWith({ fortuneoChallengeKind: null });
  });

  it("retries a refused read after the code instead of returning to the login form", async () => {
    vi.useFakeTimers();
    try {
      const readSource = source.slice(source.indexOf("async function readAndForwardSnapshot("), source.indexOf("function advanceFortuneoAccount("));
      const sync = { requestId: "sync-1", collecting: false, challengeSeen: true, settledAfterChallenge: true, observedPages: new Set(), resourceCandidates: 0, payloads: [] as unknown[] };
      const update = vi.fn();
      const context = {
        activeSync: sync, Date, setTimeout,
        getOrCreateFortuneoTab: async () => ({ tab: { id: 42, url: "account" }, created: false }),
        waitForFortuneoTabReady: vi.fn(), chrome: { tabs: { get: async () => ({ url: "account", status: "complete" }), update } },
        isFortuneoAccountUrl: () => true, fortuneoAccountIdentity: () => null, clearAuthFallback: vi.fn(),
        fortuneoPageKind: () => "account", traceAuth: vi.fn(), setUi: vi.fn(),
        crypto: { randomUUID: () => "collection-1" }, FORTUNEO_COLLECT_MESSAGE: "collect", FORTUNEO_COLLECTOR_VERSION: 17,
        sendFortuneoMessage: async () => ({ ok: false, error: "FORTUNEO_SESSION_EXPIRED", collectorVersion: 17 }),
        collectAndForwardSnapshot: vi.fn(),
      };
      const pending = runInNewContext(`${readSource}\nreadAndForwardSnapshot("sync-1")`, context);
      await vi.advanceTimersByTimeAsync(3_000);
      await pending;
      expect(update).not.toHaveBeenCalledWith(42, expect.objectContaining({ url: expect.any(String) }));
      expect(context.collectAndForwardSnapshot).toHaveBeenCalledWith("sync-1");
      expect(context.setUi).toHaveBeenCalledWith("running", "Waiting for Fortuneo to finish opening the session…", []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps clicking through Fortuneo's welcome page long after the code was requested", () => {
    vi.useFakeTimers();
    try {
      let account: string | null = null;
      const next = { innerText: "Découvrir mon nouvel espace client", disabled: false, getAttribute: () => null, getClientRects: () => [{}], click: vi.fn() };
      let buttons: unknown[] = [];
      const context = {
        location: { origin: "https://mabanque.fortuneo.fr" }, document: { querySelectorAll: () => buttons },
        Date, setInterval, clearInterval, accountIdFromUrl: () => account, notifyIfAuthenticated: vi.fn(),
      };
      runInNewContext(`let welcomeSelected = false; let welcomeWatcher = null; let welcomeDeadline = 0; ${welcomeSource}\nwatchWelcomePage(600000)`, context);
      vi.advanceTimersByTime(4 * 60_000);
      buttons = [next];
      vi.advanceTimersByTime(250);
      expect(next.click).toHaveBeenCalledOnce();
      account = "checking";
      vi.advanceTimersByTime(250);
      expect(context.notifyIfAuthenticated).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes the sync when the tab leaves the code page without a reload", async () => {
    let tick: () => Promise<void> = async () => {};
    const sync = { requestId: "sync-1", challenge: "sms-code", challengeWatch: null };
    let status = { page: "challenge", error: "sms-code" };
    const context = {
      sync, activeSync: sync, FORTUNEO_CHALLENGE_KINDS: ["sms-code", "security-challenge"],
      inspectFortuneoAuthentication: vi.fn(async () => status), traceAuth: vi.fn(), collectAndForwardSnapshot: vi.fn(),
      setInterval: (callback: () => Promise<void>) => { tick = callback; return 5; }, clearInterval: vi.fn(),
    };
    runInNewContext(`${challengeSource}\nwatchFortuneoChallenge(sync, 7)`, context);
    await tick();
    expect(context.collectAndForwardSnapshot).not.toHaveBeenCalled();
    status = { page: "login", error: "none" };
    await tick();
    expect(context.collectAndForwardSnapshot).toHaveBeenCalledWith("sync-1");
    expect(context.clearInterval).toHaveBeenCalledWith(5);
  });

  it("never fills the sign-in form again after a code", async () => {
    const sync: Record<string, unknown> = { waitingForFortuneo: true, waitingForAuthentication: true, fortuneoTabCreated: false, challenge: null, autoAuthAttempted: true };
    const context = {
      sync, activeSync: sync, FORTUNEO_CHALLENGE_KINDS: ["sms-code"], FORTUNEO_CHALLENGE_TIMEOUT_MS: 300_000,
      localDate: () => "2026-11-07",
      clearAuthFallback: vi.fn(), traceAuth: vi.fn(), refreshSyncTimeout: vi.fn(), setUi: vi.fn(), authenticationStatusMessage: () => "code",
      setInterval: vi.fn(() => 1), clearInterval: vi.fn(), inspectFortuneoAuthentication: vi.fn(),
      chrome: { storage: { local: { set: vi.fn() }, session: { set: vi.fn() } }, tabs: { update: vi.fn().mockResolvedValue({}) } },
    };
    sync.autoAuthAttempted = false;
    await runInNewContext(`${challengeSource}\nhandleFortuneoChallenge(sync, { id: 7 }, "sms-code")`, context);
    expect(sync.autoAuthAttempted).toBe(true);
    sync.challenge = null;
    await runInNewContext(`handleFortuneoChallenge(sync, { id: 7 }, "sms-code")`, context);
    expect(sync).toMatchObject({ challengeCount: 2, autoAuthAttempted: true });
  });

  it("asks for a manual sign-in without filling it again once a code was used", async () => {
    const promptForFortuneoAuthentication = vi.fn();
    const sync = { autoAuthAttempted: true, challengeSeen: true };
    await runInNewContext(`${authenticateSource}\nauthenticateFortuneoOrPrompt(sync, tab, true)`, {
      sync, tab: { id: 1 }, traceAuth: vi.fn(), promptForFortuneoAuthentication, nativeOneShot: vi.fn(),
    });
    expect(promptForFortuneoAuthentication.mock.calls[0]?.[2]).toContain("to avoid another SMS code");
  });

  it("records route shapes without account identifiers or query values", () => {
    const shapeSource = source.slice(source.indexOf("function fortuneoPathShape("), source.indexOf("function fortuneoPageKind("));
    const shape = (url: string) => runInNewContext(`${shapeSource}\nfortuneoPathShape(url)`, { url, URL });
    expect(shape("https://mabanque.fortuneo.fr/mon-espace/banque/compte-courant/00012345678?accountingDate=2026-11-07&code=secret#x"))
      .toBe("/mon-espace/banque/compte-courant/:id?accountingDate&code#");
    expect(shape("https://mabanque.fortuneo.fr/mon-espace/banque/livret-a/FgffdW-ZbqpVGwqQxtkWpg/solde"))
      .toBe("/mon-espace/banque/livret-a/:id/solde");
    expect(shape("https://example.com/whatever")).toBe("external");
  });

  it("keeps one trace line per read step so earlier sign-in steps are not lost", () => {
    const sync = { startedAt: Date.now(), authTrace: [] as Array<Record<string, unknown>> };
    runInNewContext(`${traceSource}
      traceAuth(sync, "tab-update", { page: "account" });
      for (let count = 1; count <= 200; count += 1) traceAuth(sync, "fortuneo-read", { step: "details", completedDetails: count });`, { sync, Date, Math });
    expect(sync.authTrace.map((entry) => entry.event)).toEqual(["tab-update", "fortuneo-read"]);
    expect(sync.authTrace[1]).toMatchObject({ completedDetails: 200 });
  });

  it("recognizes a read cut short by the Fortuneo page navigating away", () => {
    const code = runInNewContext(`${internalErrorSource}\nchromeErrorCode(new Error(message))`, {
      message: "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
      safeCode: () => "UNEXPECTED_ERROR",
    });
    expect(code).toBe("FORTUNEO_TAB_NAVIGATING");
  });

  it("lets the account page settle after a code before reading it", async () => {
    vi.useFakeTimers();
    try {
      const readSource = source.slice(source.indexOf("async function readAndForwardSnapshot("), source.indexOf("function advanceFortuneoAccount("));
      const sync = { requestId: "sync-1", collecting: false, challengeSeen: true, idleTimeoutMs: null, observedPages: new Set(), resourceCandidates: 0, payloads: [] };
      const url = "https://mabanque.fortuneo.fr/mon-espace/banque/compte-courant/1";
      const events: string[] = [];
      const context = {
        activeSync: sync, Date, setTimeout, POST_CHALLENGE_SETTLE_MS: 4_000,
        getOrCreateFortuneoTab: async () => ({ tab: { id: 42, url }, created: false }),
        waitForFortuneoTabReady: vi.fn(), chrome: { tabs: { get: async () => ({ url, status: "complete" }) } },
        isFortuneoAccountUrl: () => true, fortuneoAccountIdentity: () => null, clearAuthFallback: vi.fn(),
        fortuneoPageKind: () => "account", fortuneoPathShape: () => "/path", setUi: vi.fn(),
        traceAuth: (_sync: unknown, event: string) => { events.push(event); },
        crypto: { randomUUID: () => "collection-1" }, FORTUNEO_COLLECT_MESSAGE: "collect",
        sendFortuneoMessage: vi.fn(async () => { context.activeSync = null as never; return { ok: true, payloads: [] }; }),
      };
      const pending = runInNewContext(`${readSource}\nreadAndForwardSnapshot("sync-1")`, context);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(context.sendFortuneoMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(events.filter((event) => event.startsWith("post-challenge"))).toEqual(["post-challenge-settle", "post-challenge-settled"]);
      expect(context.sendFortuneoMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reloads the Fortuneo tab after a code", async () => {
    vi.useFakeTimers();
    try {
      const sendSource = source.slice(source.indexOf("async function sendFortuneoMessage("), source.indexOf("async function injectFortuneoContent("));
      const reloadFortuneoTab = vi.fn();
      const context = {
        activeSync: { challengeSeen: true }, setTimeout, FORTUNEO_COLLECTOR_VERSION: 17, traceAuth: vi.fn(),
        tryFortuneoMessage: vi.fn(async () => null), injectFortuneoContent: vi.fn(), reloadFortuneoTab,
      };
      const pending = runInNewContext(`${sendSource}\nsendFortuneoMessage(42, {})`, context);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(reloadFortuneoTab).not.toHaveBeenCalled();
      expect(context.injectFortuneoContent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows Fortuneo to another page during a read and reads again instead of failing", async () => {
    vi.useFakeTimers();
    try {
      const readSource = source.slice(source.indexOf("async function readAndForwardSnapshot("), source.indexOf("function advanceFortuneoAccount("));
      const sync = { requestId: "sync-1", collecting: false, settledAfterChallenge: true, observedPages: new Set(), resourceCandidates: 0, payloads: [], port: { disconnect: vi.fn() } };
      const events: Array<[string, Record<string, unknown>]> = [];
      const context = {
        activeSync: sync, Date, setTimeout, MAX_READ_INTERRUPTIONS: 2, FORTUNEO_COLLECTOR_VERSION: 17,
        getOrCreateFortuneoTab: async () => ({ tab: { id: 42, url: "account" }, created: false }),
        waitForFortuneoTabReady: vi.fn(), chrome: { tabs: { get: async () => ({ url: "welcome", status: "complete" }) } },
        isFortuneoAccountUrl: (url: string) => url === "account", fortuneoAccountIdentity: () => null, clearAuthFallback: vi.fn(),
        fortuneoPageKind: () => "fortuneo-other", fortuneoPathShape: () => "/welcome", setUi: vi.fn(),
        traceAuth: (_sync: unknown, event: string, details: Record<string, unknown>) => { events.push([event, details]); },
        crypto: { randomUUID: () => "collection-1" }, FORTUNEO_COLLECT_MESSAGE: "collect",
        sendFortuneoMessage: async () => ({ ok: false, error: "FORTUNEO_TAB_NAVIGATING", collectorVersion: 17 }),
        collectAndForwardSnapshot: vi.fn(), stopFortuneoCapture: vi.fn(), clearFortuneoWait: vi.fn(),
      };
      // The real tab.get returns the account page first, then the page Fortuneo moved to.
      let first = true;
      context.chrome.tabs.get = async () => {
        if (first) { first = false; return { url: "account", status: "complete" }; }
        return { url: "welcome", status: "complete" };
      };
      await runInNewContext(`${readSource}\nreadAndForwardSnapshot("sync-1")`, context);
      expect(context.activeSync).toBe(sync);
      expect(events.find(([event]) => event === "read-interrupted")?.[1]).toMatchObject({ attempt: 1, path: "/welcome" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(context.collectAndForwardSnapshot).toHaveBeenCalledWith("sync-1");
      expect(sync.port.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the next account from the current page instead of loading its page", async () => {
    const readSource = source.slice(source.indexOf("async function readAndForwardSnapshot("), source.indexOf("async function sendFortuneoMessage("));
    const first = "https://mabanque.fortuneo.fr/mon-espace/banque/livret-a/saving/solde";
    const second = "https://mabanque.fortuneo.fr/mon-espace/banque/courant/checking/carte/plafond";
    const sync = {
      requestId: "sync-1", collecting: false, settledAfterChallenge: true, observedPages: new Set(), resourceCandidates: 0, payloads: [],
      snapshots: [], accountTargets: [first, second], accountTargetIndex: 0, requestedFortuneoUrl: first, requestedFortuneoTabId: 42,
      port: { postMessage: vi.fn() },
    };
    const messages: Array<Record<string, unknown>> = [];
    const update = vi.fn();
    const context = {
      activeSync: sync, FORTUNEO_COLLECTOR_VERSION: 18, FORTUNEO_COLLECT_MESSAGE: "collect", URL,
      getOrCreateFortuneoTab: async () => ({ tab: { id: 42, url: first }, created: false }),
      waitForFortuneoTabReady: vi.fn(), chrome: { tabs: { get: async () => ({ url: first, status: "complete" }), update } },
      isFortuneoAccountUrl: (url: string) => typeof url === "string" && url.includes("/mon-espace/banque/"),
      fortuneoAccountIdentity: (url: string) => url?.split("/")[6] ?? null, clearAuthFallback: vi.fn(),
      fortuneoPageKind: () => "account", fortuneoPathShape: () => "/path", setUi: vi.fn(), traceAuth: vi.fn(),
      crypto: { randomUUID: () => "collection" },
      sendFortuneoMessage: async (_tab: number, message: Record<string, unknown>) => { messages.push(message); return { ok: true, payloads: [{ path: "/p", text: "{}" }], collectorVersion: 18 }; },
      mergePayloads: (_existing: unknown, incoming: unknown) => incoming,
      adaptFortuneo: () => ({ accounts: [], transactions: [], settlements: [], complete: true }),
      rememberFortuneoAccountUrl: vi.fn(), combineFortuneoSnapshots: () => ({}),
      collectAndForwardSnapshot: (requestId: string) => runInNewContext(`readAndForwardSnapshot(${JSON.stringify(requestId)})`, context),
    };
    await runInNewContext(`${readSource}\nreadAndForwardSnapshot("sync-1")`, context);
    expect(update).not.toHaveBeenCalled();
    expect(messages.map((message) => message.accountPath)).toEqual([new URL(first).pathname, new URL(second).pathname]);
    expect(sync.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot" }));
  });

  it("saves the running trace without waiting for a status change", async () => {
    vi.useFakeTimers();
    try {
      const sync = { startedAt: Date.now(), authTrace: [] as unknown[], traceFlushTimer: null };
      const set = vi.fn();
      const context = {
        sync, activeSync: sync, Date, Math, setTimeout,
        chrome: { storage: { session: { get: async () => ({ uiState: { status: "running", message: "Reading" } }), set } } },
      };
      runInNewContext(`${traceSource}\ntraceAuth(sync, "tab-update", { page: "fortuneo-other" }); traceAuth(sync, "welcome-choice", {});`, context);
      await vi.advanceTimersByTimeAsync(500);
      expect(set).toHaveBeenCalledOnce();
      expect(set.mock.calls[0]?.[0].uiState.authTrace.map((entry: { event: string }) => entry.event)).toEqual(["tab-update", "welcome-choice"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

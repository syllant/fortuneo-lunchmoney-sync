(() => {
const MAX_TOTAL_BYTES = 900_000;
const COLLECTOR_VERSION = 15;
const AUTO_LOGIN_VERSION = 4;
const COLLECT_MESSAGE = `collect-snapshot-v${COLLECTOR_VERSION}`;
const LOADED_KEY = `__fortuneoLunchMoneyContentLoadedV${COLLECTOR_VERSION}Auth${AUTO_LOGIN_VERSION}`;
let welcomeWatcher = null;
let welcomeSelected = false;

if (!globalThis[LOADED_KEY]) {
  globalThis[LOADED_KEY] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === COLLECT_MESSAGE) {
      void collectCurrentApi().then(
        (response) => sendResponse({ ...response, collectorVersion: COLLECTOR_VERSION }),
        (error) => sendResponse({ ok: false, collectorVersion: COLLECTOR_VERSION, error: safeCode(error) }),
      );
      return true;
    }
    if (message?.type === "fortuneo-auto-login-ready") {
      void prepareAutoLogin().then(
        (response) => sendResponse({ ...response, autoLoginVersion: AUTO_LOGIN_VERSION }),
        () => sendResponse({ ok: false, autoLoginVersion: AUTO_LOGIN_VERSION, error: "FORTUNEO_AUTO_LOGIN_UNAVAILABLE" }),
      );
      return true;
    }
    if (message?.type === "fortuneo-auth-diagnostics") {
      sendResponse({ ...authenticationDiagnostics(), autoLoginVersion: AUTO_LOGIN_VERSION });
      return false;
    }
    if (message?.type === "stop-capture") {
      clearInterval(welcomeWatcher);
      welcomeWatcher = null;
      sendResponse({ ok: true });
    }
    return false;
  });
  if (document.readyState === "complete") notifyIfAuthenticated();
  else window.addEventListener("load", notifyIfAuthenticated, { once: true });
}

function authenticationDiagnostics() {
  const body = document.body?.innerText ?? "";
  const normalized = body.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let error = "none";
  if (/identifiant ou le mot de passe ne correspondent|acces refuse|mot de passe incorrect/.test(normalized)) error = "invalid-credentials";
  else if (/acces est bloque|compte (?:est )?bloque/.test(normalized)) error = "account-blocked";
  else if (/code de securite|authentification forte|confirmez|validation mobile|securipass/.test(normalized)) error = "security-challenge";
  else if (/une erreur est survenue|erreur technique|service indisponible/.test(normalized)) error = "technical-error";
  const password = document.querySelector('input[name="PASSWD"]');
  const submit = document.querySelector('#valider_login[type="submit"]');
  const busy = Boolean(document.querySelector('[aria-busy="true"], [role="progressbar"]')) || (submit instanceof HTMLInputElement && submit.disabled);
  return {
    page: accountIdFromUrl() ? "account" : (/challenge|validation|secur/i.test(`${location.pathname}${location.hash}`) ? "challenge" : "login"),
    form: password instanceof HTMLInputElement && submit instanceof HTMLInputElement ? "ready" : "missing",
    error,
    busy,
  };
}

async function prepareAutoLogin() {
  if (location.origin !== "https://mabanque.fortuneo.fr" || /challenge|forgot|oubli|first[_-]?auth|password[_-]?reissue/i.test(`${location.pathname}${location.hash}`)) {
    return { ok: false, error: "FORTUNEO_AUTO_LOGIN_UNAVAILABLE" };
  }
  watchWelcomePage();
  const fields = await waitForLoginForm();
  if (!fields) return { ok: false, error: "FORTUNEO_LOGIN_FORM_NOT_FOUND" };
  if (fields.navigating) return { ok: true, navigating: true };
  return { ok: true, ready: true };
}

function selectNewCustomerSpace() {
  if (location.origin !== "https://mabanque.fortuneo.fr" || welcomeSelected) return false;
  const normalize = (value) => (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const candidates = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')]
    .filter((element) => normalize(element.innerText || element.value || element.textContent) === "decouvrir mon nouvel espace client"
      && !element.disabled && element.getAttribute("aria-disabled") !== "true" && element.getClientRects().length > 0);
  if (candidates.length !== 1) return false;
  welcomeSelected = true;
  candidates[0].click();
  return true;
}

function watchWelcomePage() {
  if (welcomeWatcher) return;
  const deadline = Date.now() + 60_000;
  welcomeWatcher = setInterval(() => {
    if (Date.now() >= deadline || accountIdFromUrl()) {
      clearInterval(welcomeWatcher);
      welcomeWatcher = null;
      if (accountIdFromUrl()) notifyIfAuthenticated();
      return;
    }
    selectNewCustomerSpace();
  }, 250);
}

async function waitForLoginForm() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (welcomeSelected || selectNewCustomerSpace() || accountIdFromUrl()) return { navigating: true };
    const passwordInputs = [...document.querySelectorAll('input[name="PASSWD"]')];
    if (passwordInputs.length === 1) {
      const passwordInput = passwordInputs[0];
      const form = passwordInput.closest("form");
      const submit = form?.querySelector('#valider_login[type="submit"]');
      if (passwordInput instanceof HTMLInputElement && form instanceof HTMLFormElement && submit instanceof HTMLInputElement
        && !passwordInput.disabled && !passwordInput.readOnly && passwordInput.type === "password") {
        return { passwordInput, form, submit };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function collectCurrentApi() {
  const accountId = accountIdFromUrl();
  if (!accountId) return { ok: false, error: "FORTUNEO_ACCOUNT_PAGE_REQUIRED" };
  const envResponse = await fetch("/env.json", { credentials: "same-origin", signal: AbortSignal.timeout(5_000) });
  if (!envResponse.ok) throw new Error("FORTUNEO_ENV_UNAVAILABLE");
  const env = await envResponse.json();
  if (typeof env.apigeeUrl !== "string" || typeof env.apigeeApiKey !== "string") throw new Error("FORTUNEO_ENV_INVALID");

  const request = (path, query) => fetchApi(env, path, query);
  const accountKind = accountKindFromUrl();
  notifyCollectionProgress("account");
  const accountRequests = [
    request(`/account-api/v2/accounts/${encodeURIComponent(accountId)}`),
    request(`/account-api/v2/accounts/${encodeURIComponent(accountId)}/forecasted-balance`, { breakdown: "calendar,origin", forecastedAccountingTransactionBreakdown: "carte_dd" }),
  ];
  const transactionRequests = [
    request(`/fto-transaction-api/v1/accounts/${encodeURIComponent(accountId)}/transactions`, { transactionType: "CAV,PENDING", metadata: "true" }),
    ...(accountKind === "savings" ? [] : [request(`/fto-transaction-api/v1/accounts/${encodeURIComponent(accountId)}/transactions`, { transactionType: "CARD" })]),
  ];
  const accountResults = Promise.allSettled(accountRequests);
  const transactionResults = Promise.allSettled(transactionRequests);
  const settledAccounts = await accountResults;
  notifyCollectionProgress("transactions");
  const settledTransactions = await transactionResults;
  const settled = [...settledAccounts, ...settledTransactions];
  const payloads = settled.filter((result) => result.status === "fulfilled").map((result) => annotateAccountKind(result.value, accountKind));
  const failureCodes = settled.filter((result) => result.status === "rejected").map((result) => safeCode(result.reason));
  const forecast = payloads.find((payload) => payload.path.includes("/forecasted-balance"));
  const forecastData = forecast ? JSON.parse(forecast.text) : null;
  const currentDate = new URL(location.href).searchParams.get("accountingDate");
  const dates = accountKind === "savings" ? [] : [...new Set([
    ...(forecastData ? deferredAccountingDates(forecastData) : []),
    ...(currentDate && /^\d{4}-\d{2}-\d{2}$/.test(currentDate) ? [currentDate] : []),
    ...(forecastData ? allAccountingDates(forecastData) : []),
  ])].slice(0, 24);
  notifyCollectionProgress("deferred");
  const deferred = await Promise.allSettled(dates.map((date) => request(`/account-api/v2/accounts/${encodeURIComponent(accountId)}/upcoming-transactions`, {
    family: "CARTE",
    dateFrom: `${date}T00:00:00.000Z`,
    dateTo: `${date}T00:00:00.000Z`,
  })));
  const successfulDeferred = deferred.filter((result) => result.status === "fulfilled");
  const deferredRows = successfulDeferred.flatMap((result) => responseArray(JSON.parse(result.value.text)));
  if (deferredRows.length > 0 || payloads.some((payload) => payload.path.includes("transactionType=CAV")
    && responseArray(JSON.parse(payload.text)).some((row) => settledCardDetailPath(row)))) notifyCollectionProgress("details");
  const detailCache = new Map();
  for (let index = 0; index < payloads.length; index += 1) {
    if (!payloads[index].path.includes("transactionType=CAV")) continue;
    const enrichment = await enrichTransactionPayload(env, payloads[index], settledCardDetailPath, detailCache, 1000);
    if (enrichment.failed > 0 && (enrichment.requested > 1000 || enrichment.errorCodes.some((code) => code !== "FORTUNEO_API_HTTP_404"))) {
      throw new Error(`FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE_${enrichment.errorCodes.find((code) => code !== "FORTUNEO_API_HTTP_404") ?? "LIMIT"}`);
    }
    payloads[index] = enrichment.payload;
  }
  const detailDiagnostics = { requested: 0, enriched: 0, failed: 0 };
  for (const result of deferred) {
    if (result.status !== "fulfilled") continue;
    const enrichment = await enrichTransactionPayload(env, result.value, deferredDetailPath, detailCache);
    payloads.push(enrichment.payload);
    detailDiagnostics.requested += enrichment.requested;
    detailDiagnostics.enriched += enrichment.enriched;
    detailDiagnostics.failed += enrichment.failed;
  }
  const bounded = boundPayloads(payloads);
  const diagnostics = {
    deferredDateCandidates: dates.length,
    deferredResponses: successfulDeferred.length,
    deferredRows: deferredRows.length,
    deferredRowsWithAmount: deferredRows.filter((row) => hasDeferredAmount(row)).length,
    deferredRowsWithLabel: deferredRows.filter((row) => hasDeferredLabel(row)).length,
    deferredRowsWithDate: deferredRows.filter((row) => hasDeferredDate(row)).length,
    deferredDetailRequested: detailDiagnostics.requested,
    deferredDetailEnriched: detailDiagnostics.enriched,
    deferredDetailFailures: detailDiagnostics.failed,
    deferredFields: [...new Set(deferredRows.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))].filter((key) => /^[A-Za-z0-9_]{1,40}$/.test(key)).slice(0, 16),
  };
  return bounded.length > 0
    ? { ok: true, payloads: bounded, diagnostics }
    : { ok: false, error: failureCodes.includes("FORTUNEO_SESSION_EXPIRED") ? "FORTUNEO_SESSION_EXPIRED" : "FORTUNEO_API_READ_FAILED" };
}

function accountKindFromUrl() {
  return /\/mon-espace\/banque\/(?:livret|livret-a|ldds|lep|pel|cel|epargne)\//i.test(`${location.pathname}${location.hash}`) ? "savings" : "checking";
}

function annotateAccountKind(payload, kind) {
  if (!/\/account-api\/v2\/accounts\/[^/?]+$/.test(payload.path)) return payload;
  const data = JSON.parse(payload.text);
  if (!data || typeof data !== "object" || Array.isArray(data)) return payload;
  return { ...payload, text: JSON.stringify({ ...data, __fortuneoAccountKind: kind }) };
}

function notifyCollectionProgress(step) {
  void chrome.runtime.sendMessage({ type: "fortuneo-read-progress", step }).catch(() => {});
}

async function fetchApi(env, path, query = {}) {
  const url = new URL(path, env.apigeeUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let lastCode = "FORTUNEO_API_READ_FAILED";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url.href, {
        credentials: "include",
        headers: { apikey: env.apigeeApiKey },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 401 || response.status === 403) lastCode = "FORTUNEO_SESSION_EXPIRED";
      else if (response.ok && /json/i.test(response.headers.get("content-type") ?? "")) {
        return { path: `${url.pathname}${url.search}`, text: await response.text() };
      } else lastCode = response.ok ? "FORTUNEO_API_NON_JSON" : `FORTUNEO_API_HTTP_${response.status}`;
    } catch {
      lastCode = "FORTUNEO_API_READ_FAILED";
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error(lastCode);
}

async function enrichTransactionPayload(env, payload, detailPathForRow, detailCache, limit = 100) {
  const data = JSON.parse(payload.text);
  const rows = responseArray(data);
  const output = [...rows];
  const candidates = rows.map((row, index) => ({ row, index })).filter(({ row }) => hasDeferredAmount(row) && Boolean(detailPathForRow(row)));
  const limited = candidates.slice(0, limit);
  let cursor = 0;
  let enriched = 0;
  let failed = Math.max(0, candidates.length - limited.length);
  const errorCodes = new Set();
  const worker = async () => {
    while (cursor < limited.length) {
      const candidate = limited[cursor++];
      if (!candidate) return;
      const detailPath = detailPathForRow(candidate.row);
      const detail = detailPath ? await cachedTransactionDetail(env, detailPath, detailCache) : null;
      if (detail?.merchant && candidate.row && typeof candidate.row === "object" && !Array.isArray(candidate.row)) {
        output[candidate.index] = { ...candidate.row, __fortuneoDetail: detail };
        enriched += 1;
      } else {
        failed += 1;
        errorCodes.add(detail?.error ?? "UNAVAILABLE");
        if (candidate.row && typeof candidate.row === "object" && !Array.isArray(candidate.row)) output[candidate.index] = { ...candidate.row, __fortuneoDetail: { error: detail?.error ?? "UNAVAILABLE" } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, limited.length) }, () => worker()));
  return {
    payload: { ...payload, text: JSON.stringify(replaceResponseArray(data, output)) },
    requested: candidates.length,
    enriched,
    failed,
    errorCodes: [...errorCodes],
  };
}

async function cachedTransactionDetail(env, path, cache) {
  if (!cache.has(path)) cache.set(path, fetchTransactionDetailWithRetry(env, path));
  return cache.get(path);
}

async function fetchTransactionDetailWithRetry(env, path) {
  let error = "MERCHANT_MISSING";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const detail = await fetchDetailApi(env, path);
      const data = JSON.parse(detail.text);
      const merchantName = detailMerchantName(data);
      if (merchantName) return {
        merchant: { name: merchantName },
        ...detailCard(data),
      };
    } catch (cause) {
      error = safeCode(cause);
      // A newly authenticated Fortuneo session can briefly expose the list
      // endpoint before the corresponding detail endpoint is ready.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { error };
}

function detailMerchantName(value) {
  return value && typeof value === "object" && !Array.isArray(value) && value.merchant && typeof value.merchant === "object" && typeof value.merchant.name === "string" && value.merchant.name.trim()
    ? value.merchant.name.trim()
    : null;
}

function detailCard(value) {
  const card = value?.card;
  const transaction = value?.transaction;
  return {
    ...(card && typeof card.contractId === "string" ? { card: { contractId: card.contractId, maskedPan: card.maskedPan } } : {}),
    ...(transaction && typeof transaction.date === "string" && typeof transaction.transactionId === "string"
      ? { transaction: { date: transaction.date, transactionId: transaction.transactionId } } : {}),
  };
}

async function fetchDetailApi(env, path) {
  const base = new URL(env.apigeeUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !/^\/(?:card-api|fto-transaction-api)\//.test(url.pathname)) throw new Error("FORTUNEO_DETAIL_PATH_INVALID");
  return fetchApi(env, `${url.pathname}${url.search}`);
}

function deferredDetailPath(row) {
  return row && typeof row === "object" && !Array.isArray(row) && typeof row.href === "string" ? row.href : null;
}

function settledCardDetailPath(row) {
  const path = deferredDetailPath(row);
  return path && /^\/card-api\/v1\/accounts\/[^/]+\/cards-transactions\//.test(path) ? path : null;
}

function deferredAccountingDates(value, output = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return [...output];
  if (!Array.isArray(value) && value.type === "CARTE_DD" && Array.isArray(value.calendarBreakdown)) {
    for (const item of value.calendarBreakdown) {
      if (item && typeof item.accountingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.accountingDate)) output.add(item.accountingDate);
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) deferredAccountingDates(child, output, depth + 1);
  return [...output];
}

function allAccountingDates(value, output = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return [...output];
  if (!Array.isArray(value) && typeof value.accountingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.accountingDate)) output.add(value.accountingDate);
  for (const child of Array.isArray(value) ? value : Object.values(value)) allAccountingDates(child, output, depth + 1);
  return [...output];
}

function responseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["transactions", "items", "content", "data"]) if (Array.isArray(value[key])) return value[key];
  return [];
}

function replaceResponseArray(value, rows) {
  if (Array.isArray(value)) return rows;
  if (!value || typeof value !== "object") return value;
  for (const key of ["transactions", "items", "content", "data"]) if (Array.isArray(value[key])) return { ...value, [key]: rows };
  return value;
}

function hasDeferredAmount(value) {
  return Boolean(value && typeof value === "object" && (typeof value.amount === "number" || typeof value.amount === "string" || (value.amount && typeof value.amount === "object" && (typeof value.amount.value === "number" || typeof value.amount.value === "string"))));
}

function hasDeferredLabel(value) {
  return Boolean(value && typeof value === "object" && (typeof value.label === "string" || typeof value.merchant === "string" || (value.label && typeof value.label === "object") || (value.merchant && typeof value.merchant === "object")));
}

function hasDeferredDate(value) {
  return Boolean(value && typeof value === "object" && [value.accountingDate, value.transactionDate, value.expectedDate, value.date].some((item) => typeof item === "string"));
}

function accountIdFromUrl() {
  const route = `${location.pathname}${location.hash}`;
  const match = route.match(/\/mon-espace\/banque\/[^/]+\/([^/?#]+)(?:\/|$)/i)
    ?? route.match(/\/account-summary\/([^/?#]+)(?:\/|$)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function boundPayloads(payloads) {
  const output = [];
  let bytes = 0;
  for (const payload of payloads) {
    if (!payload || typeof payload.path !== "string" || typeof payload.text !== "string") continue;
    const size = new TextEncoder().encode(payload.text).byteLength;
    if (size <= 0 || size > MAX_TOTAL_BYTES || bytes + size > MAX_TOTAL_BYTES) continue;
    output.push(payload);
    bytes += size;
  }
  return output;
}

function safeCode(error) {
  const message = error instanceof Error ? error.message : "FORTUNEO_READ_FAILED";
  return /^[A-Z0-9_]+$/.test(message) ? message : "FORTUNEO_READ_FAILED";
}

function notifyIfAuthenticated() {
  if (!/identification|connexion|login/i.test(location.href)) void chrome.runtime.sendMessage({ type: "fortuneo-ready" });
}
})();

export function adaptFortuneo(payloads) {
  const currentApi = adaptCurrentApi(payloads);
  if (currentApi) return currentApi;
  const canonical = payloads.map((item) => findCanonical(item.data)).find(Boolean);
  if (canonical) return validateCanonical(canonical);

  const accounts = deduplicate(payloads.flatMap((item) => collect(item.data, (value) => parseAccount(value, item.path))), (item) => item.sourceId);
  const transactions = deduplicate(payloads.flatMap((item) => collect(item.data, (value) => parseTransaction(value, item.path))), (item) => `${item.accountSourceId}\0${item.sourceId}`);
  const settlements = payloads.flatMap((item) => collectCanonicalSettlements(item.data));
  if (accounts.length === 0 || transactions.length === 0) throw new Error("UNSUPPORTED_FORTUNEO_RESPONSE");
  const complete = payloads.every((item) => explicitlyComplete(item.data));
  return { capturedAt: new Date().toISOString(), complete, accounts: accounts.map((account) => ({ ...account, complete })), transactions, settlements };
}

function adaptCurrentApi(payloads) {
  const accountPayload = payloads.find((item) => /\/account-api\/v2\/accounts\/[^/?]+$/.test(item.path));
  const forecastPayload = payloads.find((item) => item.path.includes("/forecasted-balance"));
  if (!accountPayload || !isRecord(accountPayload.data)) return null;
  const checkingId = firstString(accountPayload.data, ["id", "accountId"]) ?? accountIdFromPath(accountPayload.path);
  if (!checkingId) return null;
  const accountKind = currentAccountKind(accountPayload.data);
  const forecastData = isRecord(forecastPayload?.data) ? forecastPayload.data : null;
  const accountBalance = firstMoney(accountPayload.data, ["balance", "solde"])
    ?? nestedMoney(accountPayload.data, [["balance", "value"], ["balances", 0, "amount", "value"]]);
  const realTimeBalance = forecastData ? familyAmount(forecastData, "REAL_TIME_BALANCE") : null;
  const balance = accountKind === "checking" ? realTimeBalance ?? accountBalance : accountBalance ?? realTimeBalance;
  if (balance === null) return null;
  const checkingName = nestedString(accountPayload.data, [["label", "label"]]) ?? firstString(accountPayload.data, ["label", "name"]) ?? "Fortuneo checking account";
  const currency = findCurrency(forecastData) ?? findCurrency(accountPayload.data) ?? "EUR";
  const history = arrayPayload(payloads.find((item) => item.path.includes("transactionType=CAV%2CPENDING") || item.path.includes("transactionType=CAV%252CPENDING"))?.data);
  const pending = arrayPayload(payloads.find((item) => /transactionType=CARD(?:&|$)/.test(item.path))?.data);
  const deferred = payloads
    .filter((item) => item.path.includes("/upcoming-transactions") && item.path.includes("family=CARTE"))
    .flatMap((item) => arrayPayload(item.data).map((transaction) => ({ transaction, fallbackDate: dateFromPath(item.path) })));
  const cardInfo = new Map();
  const transactions = [];
  const settlements = [];
  for (const item of history) {
    const parsed = parseCurrentTransaction(item, checkingId, "settled");
    const isCard = item?.description?.transactionCategory === "CARD"
      || /^\/card-api\/v1\/accounts\/[^/]+\/cards-transactions\//.test(item?.href ?? "");
    if (!isCard) {
      if (parsed) transactions.push(parsed);
      continue;
    }
    const detail = item.__fortuneoDetail;
    const cardId = currentCardId(detail);
    const purchaseDate = isoDate(detail?.transaction?.date);
    const purchaseId = detail?.transaction?.transactionId;
    const merchant = detail?.merchant?.name;
    if (!parsed) throw new Error("FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE_BOOKING");
    const originalOperationId = firstString(item, ["originalOperationId"]);
    if (detail?.error === "FORTUNEO_API_HTTP_404" && originalOperationId) {
      transactions.push(parsed);
      settlements.push({ sourceId: parsed.sourceId, purchaseSourceId: originalOperationId,
        checkingAccountSourceId: checkingId, date: parsed.date, checkingDebit: parsed.amount,
        currency: parsed.currency, cardCredits: [] });
      continue;
    }
    if (!cardId) throw new Error("FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE_CARD_ID");
    if (!purchaseDate) throw new Error("FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE_PURCHASE_DATE");
    if (typeof purchaseId !== "string") throw new Error("FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE_TRANSACTION_ID");
    if (!merchant) throw new Error("FORTUNEO_SETTLED_CARD_DETAILS_INCOMPLETE_MERCHANT");
    registerCurrentCard(cardInfo, cardId, detail);
    // Keep the card operation reference separate from its checking booking ID.
    const sourceId = originalOperationId ?? `card:${cardId}:${purchaseId}`;
    transactions.push(parsed, { ...parsed, sourceId, accountSourceId: cardId, date: purchaseDate, merchant });
    settlements.push({ sourceId: parsed.sourceId, checkingAccountSourceId: checkingId, date: parsed.date,
      checkingDebit: parsed.amount, currency: parsed.currency,
      cardCredits: [{ cardAccountSourceId: cardId, amount: invertMoney(parsed.amount) }] });
  }
  for (const item of pending) {
    const cardId = currentCardId(item) ?? `pending-card:${checkingId}`;
    registerCurrentCard(cardInfo, cardId, item);
    const parsed = parseCurrentTransaction(item, cardId, "pending");
    if (parsed) transactions.push(parsed);
  }
  for (const { transaction: item, fallbackDate } of deferred) {
    const cardId = currentCardId(item) ?? `deferred-card:${checkingId}`;
    registerCurrentCard(cardInfo, cardId, item);
    const parsed = parseCurrentTransaction(item, cardId, "deferred", fallbackDate);
    if (parsed) transactions.push(parsed);
  }
  const cardBalances = new Map();
  for (const transaction of transactions.filter((item) => item.accountSourceId !== checkingId && item.lifecycle !== "settled")) {
    cardBalances.set(transaction.accountSourceId, (cardBalances.get(transaction.accountSourceId) ?? 0) + Number(transaction.amount));
  }
  const accounts = [{ sourceId: checkingId, kind: accountKind, displayName: checkingName, currency: currency.toLowerCase(), balance: normalizeMoney(balance), complete: false }];
  for (const [sourceId, info] of cardInfo) accounts.push({ sourceId, kind: "card", displayName: info.displayName, currency: currency.toLowerCase(), balance: normalizeMoney(String(cardBalances.get(sourceId) ?? 0)), complete: false, ...(info.mask ? { mask: info.mask } : {}) });
  return { capturedAt: new Date().toISOString(), complete: false, accounts, transactions: deduplicate(transactions, (item) => `${item.accountSourceId}\0${item.sourceId}`), settlements: deduplicate(settlements, (item) => item.sourceId) };
}

function currentAccountKind(value) {
  if (value.__fortuneoAccountKind === "savings") return "savings";
  const discriminator = [
    firstString(value, ["productType", "type", "accountType", "nature"]),
    nestedString(value, [["label", "label"], ["product", "label"], ["product", "type"]]),
  ].filter(Boolean).join(" ");
  return /livret|(?:^|\W)(?:lva|ldds|lep|pel|cel)(?:\W|$)|[ée]pargne|savings/i.test(discriminator) ? "savings" : "checking";
}

function parseCurrentTransaction(value, accountSourceId, lifecycle, fallbackDate = null) {
  if (!isRecord(value)) return null;
  const rawAmount = nestedMoney(value, [["amount", "value"]]) ?? firstMoney(value, ["amount"]);
  const rawDate = firstDate(value, ["accountingDate", "transactionDate", "purchaseDate", "expectedDate", "date"]) ?? fallbackDate;
  const detailedMerchant = nestedString(value, [["__fortuneoDetail", "merchant", "name"]]);
  const merchant = lifecycle === "pending"
    ? nestedString(value, [["merchant", "name"]])
    : lifecycle === "deferred"
      ? detailedMerchant
      : nestedString(value, [["label", "simplifiedLabel"], ["label", "originalLabel"], ["merchant", "name"]]) ?? firstString(value, ["label", "merchantName"]);
  if (rawAmount === null || !rawDate || !merchant) return null;
  const date = isoDate(rawDate);
  if (!date) return null;
  const sourceId = firstString(value, ["id", "transactionId", "reference", "idtMetEm"]) ?? syntheticTransactionId(value, rawDate, rawAmount, merchant);
  if (!sourceId) return null;
  return { sourceId, accountSourceId, date, amount: invertMoney(rawAmount), currency: (findCurrency(value) ?? "EUR").toLowerCase(), merchant, lifecycle };
}

function dateFromPath(path) {
  if (typeof path !== "string") return null;
  const match = path.match(/[?&]dateFrom=(\d{4}-\d{2}-\d{2})(?:T|%3A|&|$)/i);
  return match?.[1] ?? null;
}

function currentCardId(value) {
  return nestedString(value, [["card", "contractId"], ["description", "originProductId"], ["description", "contractId"], ["senderContract", "contractId"], ["senderContract", "id"]])
    ?? firstString(value, ["senderContract"]);
}

function registerCurrentCard(cards, sourceId, value) {
  const mask = nestedString(value, [["card", "maskedPan"]])?.replace(/\D/g, "").slice(-4);
  const label = nestedString(value, [["card", "label"], ["description", "originProductTypeLabel"]]) ?? (mask ? `Fortuneo card •••• ${mask}` : "Fortuneo card");
  if (!cards.has(sourceId)) cards.set(sourceId, { displayName: label, mask });
}

function familyAmount(value, family, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (!Array.isArray(value) && value.family === family) {
    const amount = nestedMoney(value, [["amount", "value"]]);
    if (amount !== null) return amount;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = familyAmount(child, family, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findCurrency(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (!Array.isArray(value)) {
    const direct = firstString(value, ["currency", "currencyCode"]);
    if (direct && /^[A-Za-z]{3}$/.test(direct)) return direct;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findCurrency(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function arrayPayload(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["transactions", "items", "content", "data"]) if (Array.isArray(value[key])) return value[key];
  return [];
}

function findCanonical(value) {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.accounts) && Array.isArray(value.transactions) && Array.isArray(value.settlements) && typeof value.capturedAt === "string") return value;
  for (const key of ["fortuneoLunchMoneySnapshot", "snapshot", "data"]) {
    const found = findCanonical(value[key]);
    if (found) return found;
  }
  return null;
}

function validateCanonical(value) {
  const output = structuredClone(value);
  output.accounts = output.accounts.map((account) => ({ ...account, currency: String(account.currency).toLowerCase() }));
  output.transactions = output.transactions.map((transaction) => ({ ...transaction, currency: String(transaction.currency).toLowerCase() }));
  output.settlements = output.settlements.map((settlement) => ({ ...settlement, currency: String(settlement.currency).toLowerCase() }));
  return output;
}

function collect(value, parser, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  const parsed = parser(value);
  const output = parsed ? [parsed] : [];
  for (const child of Array.isArray(value) ? value : Object.values(value)) output.push(...collect(child, parser, depth + 1));
  return output;
}

function parseAccount(value, responsePath = "") {
  if (!isRecord(value)) return null;
  const sourceId = firstString(value, ["accountId", "compteId", "numeroCompte", "idCompte", "cardId", "carteId"]) ?? accountIdFromPath(responsePath);
  const rawBalance = firstMoney(value, ["balance", "solde", "encours", "montantEncours"]) ?? nestedMoney(value, [["balances", 0, "amount", "value"], ["amount", "value"]]);
  const displayName = firstString(value, ["displayName", "libelle", "label", "name", "nomCarte"]) ?? (sourceId && Array.isArray(value.balances) ? "Fortuneo checking account" : null);
  if (!sourceId || rawBalance === null || !displayName) return null;
  const discriminator = `${firstString(value, ["type", "accountType", "nature", "productType"]) ?? ""} ${displayName}`;
  const kind = value.__fortuneoAccountKind === "savings" || /livret|(?:^|\W)(?:lva|ldds|lep|pel|cel)(?:\W|$)|[ée]pargne|savings/i.test(discriminator)
    ? "savings"
    : /card|carte|world elite|gold/i.test(discriminator) ? "card" : "checking";
  const balance = kind === "card" ? absoluteMoney(rawBalance) : normalizeMoney(rawBalance);
  const mask = firstString(value, ["mask", "maskedNumber", "numeroMasque", "last4"]);
  return { sourceId, kind, displayName, currency: (firstString(value, ["currency", "devise"]) ?? "EUR").toLowerCase(), balance, complete: false, ...(mask ? { mask: mask.replace(/\D/g, "").slice(-4) } : {}) };
}

function parseTransaction(value, responsePath = "") {
  if (!isRecord(value)) return null;
  const accountSourceId = firstString(value, ["accountId", "compteId", "numeroCompte", "cardId", "carteId"]) ?? accountIdFromPath(responsePath);
  const rawAmount = firstMoney(value, ["amount", "montant", "transactionAmount"]) ?? nestedMoney(value, [["amount", "value"]]);
  const rawDate = firstString(value, ["date", "operationDate", "dateOperation", "bookingDate"]);
  const merchant = firstString(value, ["merchant", "payee", "libelle", "label", "description"]) ?? nestedString(value, [["label", "simplifiedLabel"], ["label", "originalLabel"]]);
  const sourceId = firstString(value, ["operationId", "transactionId", "idOperation", "reference", "entryReference", "resourceId", "id"])
    ?? syntheticTransactionId(value, rawDate, rawAmount, merchant);
  if (!sourceId || !accountSourceId || rawAmount === null || !rawDate || !merchant) return null;
  const date = isoDate(rawDate);
  if (!date) return null;
  const status = firstString(value, ["lifecycle", "status", "statut", "state"]) ?? "settled";
  const lifecycle = /pending|hold|attente|autorisation/i.test(status) ? "pending" : /deferred|differe|différé|validated|valide/i.test(status) ? "deferred" : "settled";
  return { sourceId, accountSourceId, date, amount: invertMoney(rawAmount), currency: (firstString(value, ["currency", "devise"]) ?? "EUR").toLowerCase(), merchant, lifecycle };
}

function collectCanonicalSettlements(value) {
  if (!isRecord(value) || !Array.isArray(value.settlements)) return [];
  return value.settlements.filter(isRecord);
}

function explicitlyComplete(value) {
  if (!isRecord(value)) return false;
  if (value.complete === true || value.isComplete === true) return true;
  return value.hasMore === false || value.has_more === false || value.lastPage === true;
}

function firstString(value, keys) {
  for (const key of keys) if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  for (const key of keys) if (typeof value[key] === "number" && Number.isFinite(value[key])) return String(value[key]);
  return null;
}

function firstDate(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
    if (Array.isArray(candidate) && candidate.length >= 3 && candidate.slice(0, 3).every(Number.isFinite)) {
      return `${candidate[0]}-${String(candidate[1]).padStart(2, "0")}-${String(candidate[2]).padStart(2, "0")}`;
    }
    if (isRecord(candidate) && Number.isFinite(candidate.year) && Number.isFinite(candidate.month) && Number.isFinite(candidate.day)) {
      return `${candidate.year}-${String(candidate.month).padStart(2, "0")}-${String(candidate.day).padStart(2, "0")}`;
    }
  }
  return null;
}

function firstMoney(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
    if (typeof candidate === "string" && /^\s*-?[\d\s]+(?:[.,]\d{1,4})?\s*(?:€|EUR)?\s*$/.test(candidate)) return candidate;
  }
  return null;
}

function nestedString(value, paths) {
  for (const path of paths) {
    const candidate = nestedValue(value, path);
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function nestedMoney(value, paths) {
  for (const path of paths) {
    const candidate = nestedValue(value, path);
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
    if (typeof candidate === "string" && /^\s*-?[\d\s]+(?:[.,]\d{1,4})?\s*(?:€|EUR)?\s*$/.test(candidate)) return candidate;
  }
  return null;
}

function nestedValue(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function accountIdFromPath(path) {
  if (typeof path !== "string") return null;
  const candidates = path.split("/").filter((part) => /^[A-Za-z0-9_-]{6,128}$/.test(part));
  return candidates.reverse().find((part) => /\d/.test(part) && !/^v\d+$/i.test(part)) ?? null;
}

function syntheticTransactionId(value, date, amount, merchant) {
  if (!date || amount === null || !merchant) return null;
  const valueDate = firstString(value, ["valueDate", "transactionDate"]) ?? "";
  return `derived:${date}:${valueDate}:${amount}:${merchant}`.slice(0, 500);
}

function normalizeMoney(value) {
  const normalized = String(value).replace(/\s/g, "").replace(/(?:€|EUR)$/i, "").replace(",", ".");
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error("INVALID_FORTUNEO_AMOUNT");
  return number.toFixed(4).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function invertMoney(value) {
  const normalized = normalizeMoney(value);
  return normalized.startsWith("-") ? normalized.slice(1) : `-${normalized}`;
}

function absoluteMoney(value) {
  return normalizeMoney(value).replace(/^-/, "");
}

function isoDate(value) {
  const direct = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const french = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (french) return `${french[3]}-${french[2]}-${french[1]}`;
  if (/^\d{10,13}$/.test(String(value))) {
    const timestamp = Number(value) * (String(value).length === 10 ? 1_000 : 1);
    const date = new Date(timestamp);
    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return null;
}

function deduplicate(values, key) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

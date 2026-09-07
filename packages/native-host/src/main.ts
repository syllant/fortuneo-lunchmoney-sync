#!/usr/bin/env node
import { parseNativeRequest, type NativeResponse, type ResultSummary } from "../../shared/src/messages.js";
import { readNativeMessages, writeNativeMessage } from "./framing.js";
import { KeychainStore } from "./keychain.js";
import { safeErrorDiagnostic } from "./redaction.js";
import { SyncService } from "./sync-service.js";

const send = (message: NativeResponse): void => writeNativeMessage(process.stdout, message);
const service = new SyncService(new KeychainStore(), send);

function errorSummary(error: unknown): ResultSummary {
  const diagnostic = safeErrorDiagnostic(error);
  const { code } = diagnostic;
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    grouped: 0,
    warnings: [code],
    message: code,
    breakdown: {
      accountsCreated: 0,
      accountsUpdated: 0,
      transactionsCreated: 0,
      transactionsUpdated: 0,
      transactionsDeleted: 0,
      settlementsGrouped: 0,
      fortuneoSettled: 0,
      fortuneoDeferred: 0,
      fortuneoPending: 0,
    },
    diagnostic,
  };
}

try {
  for await (const raw of readNativeMessages(process.stdin)) {
    let requestId = "invalid";
    try {
      const request = parseNativeRequest(raw);
      requestId = request.requestId;
      await service.handle(request);
    } catch (error) {
      send({ version: 2, type: "result", requestId, ok: false, dryRun: false, summary: errorSummary(error) });
    }
  }
} catch (error) {
  send({ version: 2, type: "result", requestId: "fatal", ok: false, dryRun: false, summary: errorSummary(error) });
  process.exitCode = 1;
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { SynchronizeResult } from "./sync/synchronize";
import { DomainError, errorCode } from "./domain/errors";
import type { AppEnv } from "./env";
import { enableBanking, lunchMoney } from "./factories";
import { rollingWindow } from "./sync/backfill";
import { Synchronizer } from "./sync/synchronize";
import { ConnectionRepository } from "./storage/connection-repository";
import { notifyWorkflowFailure } from "./notifications/service";
import { probeBankSource, type SourceProbeResult } from "./sync/source-probe";

export type SyncWorkflowParams = { dryRun?: boolean; from?: string; to?: string; sourceProbe?: boolean };
type WorkflowResult = SynchronizeResult | SourceProbeResult;

export class DailySyncWorkflow extends WorkflowEntrypoint<AppEnv, SyncWorkflowParams> {
  override async run(event: WorkflowEvent<SyncWorkflowParams>, step: WorkflowStep): Promise<WorkflowResult> {
    try {
      const dryRun = event.payload.dryRun ?? false;
      if (!dryRun && this.env.SYNC_ENABLED !== "true") throw new DomainError("SYNC_DISABLED");
      const range = event.payload.from && event.payload.to
        ? { from: event.payload.from, to: event.payload.to }
        : rollingWindow(new Date(event.timestamp));

      const connection = await step.do("validate-session", async () => {
        const current = await new ConnectionRepository(this.env.DB).latest();
        if (!current || current.status === "revoked") throw new DomainError("CONNECTION_NOT_AUTHORIZED");
        if (Date.parse(current.validUntil) <= Date.now()) throw new DomainError("CONSENT_EXPIRED");
        return { connectionId: current.id, sessionId: current.sessionId };
      });

      await step.do("list-accounts", async () => {
        const accounts = await enableBanking(this.env).listAccounts(connection.sessionId);
        return { accountCount: accounts.length };
      });

      if (event.payload.sourceProbe) {
        return await step.do(
          "probe-source",
          { retries: { limit: 1, delay: "10 seconds" }, timeout: "5 minutes" },
          async () => probeBankSource(enableBanking(this.env), connection.sessionId),
        );
      }

      const counts = await step.do(
        "sync-account-window",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => new Synchronizer(this.env.DB, enableBanking(this.env), lunchMoney(this.env), this.env.TRANSACTION_HMAC_KEY)
          .synchronize({ dryRun, range, runId: event.instanceId }),
      );

      await step.do("update-balance", async () => Promise.resolve({ updatedAccountBalances: dryRun ? 0 : 1 }));
      return await step.do("record-result", async () => Promise.resolve(counts));
    } catch (error) {
      await notifyWorkflowFailure(this.env, event.instanceId, errorCode(error));
      throw error;
    }
  }
}

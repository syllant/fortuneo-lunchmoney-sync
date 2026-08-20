import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { DomainError, errorCode } from "./domain/errors";
import type { AppEnv } from "./env";
import { enableBanking, lunchMoney } from "./factories";
import { rollingWindow } from "./sync/backfill";
import { Synchronizer } from "./sync/synchronize";
import { ConnectionRepository } from "./storage/connection-repository";
import { notifyWorkflowFailure } from "./notifications/service";

export type SyncWorkflowParams = { dryRun?: boolean; from?: string; to?: string };

export class DailySyncWorkflow extends WorkflowEntrypoint<AppEnv, SyncWorkflowParams> {
  override async run(event: WorkflowEvent<SyncWorkflowParams>, step: WorkflowStep): Promise<{ fetched: number; created: number; updated: number; skipped: number }> {
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

import { logEvent } from "./observability/events";
import type { SyncWorkflowParams } from "./workflow";

type ScheduledSyncEnvironment = {
  SYNC_ENABLED: string;
  SYNC_WORKFLOW: {
    create(options: WorkflowInstanceCreateOptions<SyncWorkflowParams>): Promise<{ id: string }>;
  };
};

export async function startScheduledSync(
  controller: Pick<ScheduledController, "scheduledTime">,
  env: ScheduledSyncEnvironment,
): Promise<string | null> {
  if (env.SYNC_ENABLED !== "true") {
    logEvent({ event: "scheduled_sync_skipped", status: "disabled" });
    return null;
  }
  const instance = await env.SYNC_WORKFLOW.create({
    id: `scheduled-${controller.scheduledTime}`,
    params: { dryRun: false },
    retention: { successRetention: "1 day", errorRetention: "1 day" },
  });
  logEvent({ event: "scheduled_sync_started", run_id: instance.id, status: "accepted" });
  return instance.id;
}

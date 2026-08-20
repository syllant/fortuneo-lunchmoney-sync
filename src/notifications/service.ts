import type { AppEnv } from "../env";
import { logError, logEvent } from "../observability/events";
import { ConnectionRepository } from "../storage/connection-repository";
import { NotificationEventRepository } from "../storage/notification-event-repository";
import { PushSubscriptionRepository } from "../storage/push-subscription-repository";
import { dueNotifications, type NotificationEvent } from "./policy";
import { sendEmptyWebPush } from "./web-push";

type NotificationEnvironment = Pick<
  AppEnv,
  "DB" | "WEB_PUSH_VAPID_PUBLIC_KEY" | "WEB_PUSH_VAPID_PRIVATE_KEY" | "WEB_PUSH_VAPID_SUBJECT"
>;

function vapidConfiguration(env: NotificationEnvironment) {
  return {
    publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY,
    privateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY,
    subject: env.WEB_PUSH_VAPID_SUBJECT,
  };
}

export async function deliverNotification(
  env: NotificationEnvironment,
  notification: NotificationEvent,
  now = new Date(),
): Promise<number> {
  const events = new NotificationEventRepository(env.DB);
  if (await events.exists(notification.eventKey)) return 0;

  const subscriptions = new PushSubscriptionRepository(env.DB);
  const records = await subscriptions.list();
  let delivered = 0;
  for (const record of records) {
    try {
      const response = await sendEmptyWebPush(record.endpoint, vapidConfiguration(env), now);
      if (response.ok) {
        delivered += 1;
        await subscriptions.markSuccess(record.endpoint, now.toISOString());
      } else if (response.status === 404 || response.status === 410) {
        await subscriptions.remove(record.endpoint);
      } else {
        await subscriptions.markError(record.endpoint, `PUSH_HTTP_${response.status}`, now.toISOString());
      }
    } catch {
      await subscriptions.markError(record.endpoint, "PUSH_DELIVERY_ERROR", now.toISOString());
    }
  }

  if (delivered > 0) {
    await events.record(notification.eventKey, notification.kind, now.toISOString());
    logEvent({ event: "notification_sent", status: notification.kind });
  }
  return delivered;
}

export async function notifyDueConditions(env: NotificationEnvironment, now = new Date()): Promise<void> {
  const connection = await new ConnectionRepository(env.DB).latest();
  for (const notification of dueNotifications(connection, now)) {
    await deliverNotification(env, notification, now);
  }
}

export async function notifyWorkflowFailure(
  env: NotificationEnvironment,
  instanceId: string,
  code: string,
  now = new Date(),
): Promise<void> {
  try {
    await deliverNotification(env, {
      eventKey: `workflow-error:${instanceId}:${code}`,
      kind: "sync_error",
    }, now);
  } catch {
    logError({ event: "notification_failed", error_code: "PUSH_NOTIFICATION_ERROR", run_id: instanceId });
  }
}

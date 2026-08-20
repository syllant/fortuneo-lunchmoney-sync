import type { SyncWorkflowParams } from "./workflow";

export type AppEnv = Omit<Env, "DB" | "SYNC_WORKFLOW" | "SYNC_ENABLED"> & {
  DB: D1Database;
  SYNC_WORKFLOW: Workflow<SyncWorkflowParams>;
  SYNC_ENABLED: string;
  ENABLE_BANKING_APP_ID: string;
  ENABLE_BANKING_PRIVATE_KEY: string;
  LUNCH_MONEY_TOKEN: string;
  TRANSACTION_HMAC_KEY: string;
  OAUTH_STATE_HMAC_KEY: string;
  ADMIN_PASSWORD: string;
  WEB_PUSH_VAPID_PUBLIC_KEY: string;
  WEB_PUSH_VAPID_PRIVATE_KEY: string;
  WEB_PUSH_VAPID_SUBJECT: string;
  DATA_PROTECTION_EMAIL: string;
};

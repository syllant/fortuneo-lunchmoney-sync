import type { AppEnv } from "./env";
import { EnableBankingClient } from "./providers/enable-banking/client";
import { LunchMoneyClient } from "./providers/lunch-money/client";

export function enableBanking(env: AppEnv): EnableBankingClient {
  return new EnableBankingClient(env.ENABLE_BANKING_BASE_URL, {
    applicationId: env.ENABLE_BANKING_APP_ID,
    privateKey: env.ENABLE_BANKING_PRIVATE_KEY,
  });
}

export function lunchMoney(env: AppEnv): LunchMoneyClient {
  return new LunchMoneyClient(env.LUNCH_MONEY_BASE_URL, env.LUNCH_MONEY_TOKEN);
}

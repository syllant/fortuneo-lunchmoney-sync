import { createEnableBankingJwt } from "../../security/jwt";

export type EnableBankingCredentials = Readonly<{ applicationId: string; privateKey: string }>;

export async function authorizationHeader(credentials: EnableBankingCredentials): Promise<string> {
  return `Bearer ${await createEnableBankingJwt(credentials.applicationId, credentials.privateKey)}`;
}

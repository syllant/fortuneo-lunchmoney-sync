import type { BankAccount } from "../domain/account";

export type AccountRecord = Readonly<{
  id: string;
  connectionId: string;
  identificationHash: string;
  providerAccountId: string;
  lunchMoneyAccountId: number | null;
}>;

type AccountRow = {
  id: string; connection_id: string; identification_hash: string; provider_account_id: string;
  lunch_money_account_id: number | null;
};

function map(row: AccountRow): AccountRecord {
  return {
    id: row.id, connectionId: row.connection_id, identificationHash: row.identification_hash,
    providerAccountId: row.provider_account_id, lunchMoneyAccountId: row.lunch_money_account_id,
  };
}

export class AccountRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(connectionId: string, account: BankAccount, now: string): Promise<AccountRecord> {
    const existing = await this.findByIdentification(account.identificationHash);
    if (existing) {
      await this.db.prepare("UPDATE accounts SET connection_id = ?, provider_account_id = ?, updated_at = ? WHERE id = ?")
        .bind(connectionId, account.providerAccountId, now, existing.id).run();
      return { ...existing, connectionId, providerAccountId: account.providerAccountId };
    }
    const id = crypto.randomUUID();
    await this.db.prepare(
      "INSERT INTO accounts (id, connection_id, identification_hash, provider_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, connectionId, account.identificationHash, account.providerAccountId, now, now).run();
    return { id, connectionId, identificationHash: account.identificationHash, providerAccountId: account.providerAccountId, lunchMoneyAccountId: null };
  }

  async findByIdentification(hash: string): Promise<AccountRecord | null> {
    const row = await this.db.prepare(
      "SELECT id, connection_id, identification_hash, provider_account_id, lunch_money_account_id FROM accounts WHERE identification_hash = ? LIMIT 1",
    ).bind(hash).first<AccountRow>();
    return row ? map(row) : null;
  }

  async list(connectionId: string): Promise<readonly AccountRecord[]> {
    const result = await this.db.prepare(
      "SELECT id, connection_id, identification_hash, provider_account_id, lunch_money_account_id FROM accounts WHERE connection_id = ? ORDER BY id",
    ).bind(connectionId).all<AccountRow>();
    return result.results.map(map);
  }

  async linkLunchMoney(id: string, lunchMoneyAccountId: number, now: string): Promise<void> {
    await this.db.prepare("UPDATE accounts SET lunch_money_account_id = ?, updated_at = ? WHERE id = ?")
      .bind(lunchMoneyAccountId, now, id).run();
  }
}

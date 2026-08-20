export type SyncIndexRecord = Readonly<{
  externalIdHmac: string;
  lunchMoneyTransactionId: number;
  payloadHmac: string;
}>;

type IndexRow = { external_id_hmac: string; lunch_money_transaction_id: number; payload_hmac: string };

export class SyncIndexRepository {
  constructor(private readonly db: D1Database) {}

  async find(externalIdHmac: string): Promise<SyncIndexRecord | null> {
    const row = await this.db.prepare(
      "SELECT external_id_hmac, lunch_money_transaction_id, payload_hmac FROM sync_index WHERE external_id_hmac = ?",
    ).bind(externalIdHmac).first<IndexRow>();
    return row ? { externalIdHmac: row.external_id_hmac, lunchMoneyTransactionId: row.lunch_money_transaction_id, payloadHmac: row.payload_hmac } : null;
  }

  async save(record: SyncIndexRecord, now: string): Promise<void> {
    await this.db.prepare(
      "INSERT INTO sync_index (external_id_hmac, lunch_money_transaction_id, payload_hmac, last_seen_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(external_id_hmac) DO UPDATE SET lunch_money_transaction_id = excluded.lunch_money_transaction_id, payload_hmac = excluded.payload_hmac, last_seen_at = excluded.last_seen_at",
    ).bind(record.externalIdHmac, record.lunchMoneyTransactionId, record.payloadHmac, now).run();
  }

  async touch(externalIdHmac: string, now: string): Promise<void> {
    await this.db.prepare("UPDATE sync_index SET last_seen_at = ? WHERE external_id_hmac = ?").bind(now, externalIdHmac).run();
  }
}

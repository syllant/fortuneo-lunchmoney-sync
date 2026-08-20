export type PushSubscriptionRecord = Readonly<{ endpoint: string }>;

type PushSubscriptionRow = { endpoint: string };

export class PushSubscriptionRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(endpoint: string, now: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET updated_at = excluded.updated_at, last_error_code = NULL`,
    ).bind(endpoint, now, now).run();
  }

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    const result = await this.db.prepare("SELECT endpoint FROM push_subscriptions ORDER BY created_at")
      .all<PushSubscriptionRow>();
    return result.results.map((row) => ({ endpoint: row.endpoint }));
  }

  async markSuccess(endpoint: string, now: string): Promise<void> {
    await this.db.prepare(
      "UPDATE push_subscriptions SET last_success_at = ?, last_error_code = NULL, updated_at = ? WHERE endpoint = ?",
    ).bind(now, now, endpoint).run();
  }

  async markError(endpoint: string, code: string, now: string): Promise<void> {
    await this.db.prepare(
      "UPDATE push_subscriptions SET last_error_code = ?, updated_at = ? WHERE endpoint = ?",
    ).bind(code, now, endpoint).run();
  }

  async remove(endpoint: string): Promise<void> {
    await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  }
}

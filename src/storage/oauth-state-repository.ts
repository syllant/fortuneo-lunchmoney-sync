export class OAuthStateRepository {
  constructor(private readonly db: D1Database) {}

  async create(stateHmac: string, expiresAt: string): Promise<void> {
    await this.db.prepare("INSERT INTO oauth_states (state_hmac, expires_at, consumed_at) VALUES (?, ?, NULL)")
      .bind(stateHmac, expiresAt).run();
  }

  async consume(stateHmac: string, now: string): Promise<boolean> {
    const result = await this.db.prepare(
      "UPDATE oauth_states SET consumed_at = ? WHERE state_hmac = ? AND consumed_at IS NULL AND expires_at > ?",
    ).bind(now, stateHmac, now).run();
    return (result.meta.changes ?? 0) === 1;
  }
}

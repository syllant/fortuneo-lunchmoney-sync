export class SyncLockRepository {
  constructor(private readonly db: D1Database) {}

  async acquire(ownerId: string, now: Date, ttlSeconds = 600): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const result = await this.db.prepare(
      "INSERT INTO sync_locks (lock_name, owner_id, expires_at) VALUES ('global', ?, ?) " +
      "ON CONFLICT(lock_name) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at WHERE sync_locks.expires_at <= ?",
    ).bind(ownerId, expiresAt, now.toISOString()).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async release(ownerId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sync_locks WHERE lock_name = 'global' AND owner_id = ?").bind(ownerId).run();
  }
}

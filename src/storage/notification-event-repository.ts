export class NotificationEventRepository {
  constructor(private readonly db: D1Database) {}

  async exists(eventKey: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 AS found FROM notification_events WHERE event_key = ? LIMIT 1")
      .bind(eventKey).first<{ found: number }>();
    return row?.found === 1;
  }

  async record(eventKey: string, kind: string, now: string): Promise<void> {
    await this.db.prepare(
      "INSERT OR IGNORE INTO notification_events (event_key, kind, sent_at) VALUES (?, ?, ?)",
    ).bind(eventKey, kind, now).run();
  }
}

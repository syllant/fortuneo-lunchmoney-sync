export type ConnectionRecord = Readonly<{
  id: string;
  sessionId: string;
  validUntil: string;
  status: "authorized" | "expired" | "revoked" | "error";
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}>;

type ConnectionRow = {
  id: string; session_id: string; valid_until: string; status: ConnectionRecord["status"];
  last_success_at: string | null; last_error_code: string | null;
};

function map(row: ConnectionRow): ConnectionRecord {
  return { id: row.id, sessionId: row.session_id, validUntil: row.valid_until, status: row.status, lastSuccessAt: row.last_success_at, lastErrorCode: row.last_error_code };
}

export class ConnectionRepository {
  constructor(private readonly db: D1Database) {}

  async saveAuthorized(sessionId: string, validUntil: string): Promise<ConnectionRecord> {
    const id = crypto.randomUUID();
    await this.db.prepare(
      "INSERT INTO connections (id, provider, session_id, valid_until, status) VALUES (?, 'enable-banking', ?, ?, 'authorized')",
    ).bind(id, sessionId, validUntil).run();
    return { id, sessionId, validUntil, status: "authorized", lastSuccessAt: null, lastErrorCode: null };
  }

  async latest(): Promise<ConnectionRecord | null> {
    const row = await this.db.prepare(
      "SELECT id, session_id, valid_until, status, last_success_at, last_error_code FROM connections ORDER BY rowid DESC LIMIT 1",
    ).first<ConnectionRow>();
    return row ? map(row) : null;
  }

  async markSuccess(id: string, now: string): Promise<void> {
    await this.db.prepare("UPDATE connections SET last_success_at = ?, last_error_code = NULL, status = 'authorized' WHERE id = ?")
      .bind(now, id).run();
  }

  async markError(id: string, code: string, expired = false): Promise<void> {
    await this.db.prepare("UPDATE connections SET status = ?, last_error_code = ? WHERE id = ?")
      .bind(expired ? "expired" : "error", code, id).run();
  }

  async markRevoked(id: string): Promise<void> {
    await this.db.prepare("UPDATE connections SET status = 'revoked', last_error_code = NULL WHERE id = ?").bind(id).run();
  }
}

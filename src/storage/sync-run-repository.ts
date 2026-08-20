export type SyncCounts = Readonly<{ fetched: number; created: number; updated: number; skipped: number }>;

export type LastRun = Readonly<{
  status: string;
  createdCount: number;
  updatedCount: number;
}>;

type LastRunRow = { status: string; created_count: number; updated_count: number };

export class SyncRunRepository {
  constructor(private readonly db: D1Database) {}

  async start(runId: string, now: string): Promise<void> {
    await this.db.prepare("INSERT INTO sync_runs (run_id, started_at, status) VALUES (?, ?, 'running')").bind(runId, now).run();
  }

  async complete(runId: string, now: string, counts: SyncCounts, dryRun: boolean): Promise<void> {
    await this.db.prepare(
      "UPDATE sync_runs SET completed_at = ?, status = ?, fetched_count = ?, created_count = ?, updated_count = ?, skipped_count = ? WHERE run_id = ?",
    ).bind(now, dryRun ? "dry_run" : "success", counts.fetched, counts.created, counts.updated, counts.skipped, runId).run();
  }

  async fail(runId: string, now: string, code: string): Promise<void> {
    await this.db.prepare("UPDATE sync_runs SET completed_at = ?, status = 'failed', error_code = ? WHERE run_id = ?")
      .bind(now, code, runId).run();
  }

  async last(): Promise<LastRun | null> {
    const row = await this.db.prepare(
      "SELECT status, created_count, updated_count FROM sync_runs ORDER BY started_at DESC LIMIT 1",
    ).first<LastRunRow>();
    return row ? { status: row.status, createdCount: row.created_count, updatedCount: row.updated_count } : null;
  }
}

const ALLOWED_KEYS = new Set([
  "event", "run_id", "status", "error_code", "fetched_count", "created_count", "updated_count", "skipped_count",
]);

export function whitelistLogFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => ALLOWED_KEYS.has(key)));
}

type SafeEvent = Readonly<{
  event: string;
  run_id?: string;
  status?: string;
  error_code?: string;
  fetched_count?: number;
  created_count?: number;
  updated_count?: number;
  skipped_count?: number;
}>;

export function logEvent(event: SafeEvent): void {
  console.log(JSON.stringify(event));
}

export function logError(event: SafeEvent): void {
  console.error(JSON.stringify(event));
}

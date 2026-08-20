import type { DateRange } from "../domain/transaction";

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function rollingWindow(now = new Date(), days = 7): DateRange {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: dateOnly(from), to: dateOnly(to) };
}

export function backfillWindows(now = new Date(), totalDays = 90, windowDays = 7): DateRange[] {
  const newest = rollingWindow(now, Math.min(windowDays, totalDays));
  const windows: DateRange[] = [newest];
  let cursor = new Date(`${newest.from}T00:00:00.000Z`);
  let covered = Math.min(windowDays, totalDays);
  while (covered < totalDays) {
    const to = new Date(cursor);
    to.setUTCDate(to.getUTCDate() - 1);
    const size = Math.min(windowDays, totalDays - covered);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (size - 1));
    windows.push({ from: dateOnly(from), to: dateOnly(to) });
    cursor = from;
    covered += size;
  }
  return windows;
}

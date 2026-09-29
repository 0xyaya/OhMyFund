type Schedule = { cadence: 'daily' | 'weekly'; localTime: string; timezone: string; weekday: number | null };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timezone: string) => {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    formatters.set(timezone, value);
  }
  return value;
};
const parts = (date: Date, timezone: string) => Object.fromEntries(
  formatter(timezone).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value])
);
const weekdayNumber = (short: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);

export function nextRunAt(schedule: Schedule, after: Date): Date {
  const [hour, minute] = schedule.localTime.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('Invalid local time.');
  // Scan far enough backwards to see the first occurrence of an ambiguous
  // wall-clock minute. This makes the earlier offset canonical on DST fallback.
  const seenLocalDates = new Set<string>();
  const start = Math.floor((after.getTime() - 26 * 60 * 60_000) / 60_000) * 60_000;
  const limit = after.getTime() + 9 * 24 * 60 * 60_000;
  for (let timestamp = start; timestamp <= limit; timestamp += 60_000) {
    const local = parts(new Date(timestamp), schedule.timezone);
    if (Number(local.hour) !== hour || Number(local.minute) !== minute) continue;
    if (schedule.cadence === 'weekly' && weekdayNumber(local.weekday) !== schedule.weekday) continue;
    const localDate = `${local.year}-${local.month}-${local.day}`;
    if (seenLocalDates.has(localDate)) continue;
    seenLocalDates.add(localDate);
    if (timestamp <= after.getTime()) continue;
    return new Date(timestamp);
  }
  throw new Error('Could not calculate the next scheduled run.');
}

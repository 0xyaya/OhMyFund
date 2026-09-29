import { describe, expect, it } from 'vitest';
import { nextRunAt } from './schedule.js';

describe('nextRunAt', () => {
  it('keeps a daily New York schedule at the same local time across DST', () => {
    const schedule = { cadence: 'daily' as const, localTime: '09:00', timezone: 'America/New_York', weekday: null };
    expect(nextRunAt(schedule, new Date('2026-03-07T15:00:00Z')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('finds the requested weekday', () => {
    const schedule = { cadence: 'weekly' as const, localTime: '10:30', timezone: 'Asia/Ho_Chi_Minh', weekday: 1 };
    expect(nextRunAt(schedule, new Date('2026-09-22T00:00:00Z')).toISOString()).toBe('2026-09-28T03:30:00.000Z');
  });

  it('moves a nonexistent DST wall-clock time to the next valid day', () => {
    const schedule = { cadence: 'daily' as const, localTime: '02:30', timezone: 'America/New_York', weekday: null };
    expect(nextRunAt(schedule, new Date('2026-03-08T05:00:00Z')).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('uses only the earlier repeated New York minute for a daily schedule', () => {
    const schedule = { cadence: 'daily' as const, localTime: '01:30', timezone: 'America/New_York', weekday: null };
    expect(nextRunAt(schedule, new Date('2026-11-01T05:30:00Z')).toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

  it('selects the earlier offset when both repeated New York minutes are ahead', () => {
    const schedule = { cadence: 'daily' as const, localTime: '01:30', timezone: 'America/New_York', weekday: null };
    expect(nextRunAt(schedule, new Date('2026-11-01T04:00:00Z')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('uses only the earlier repeated Paris minute for a weekly schedule', () => {
    const schedule = { cadence: 'weekly' as const, localTime: '02:30', timezone: 'Europe/Paris', weekday: 0 };
    expect(nextRunAt(schedule, new Date('2026-10-25T00:30:00Z')).toISOString()).toBe('2026-11-01T01:30:00.000Z');
  });

  it('rejects malformed local time', () => {
    expect(() => nextRunAt({ cadence: 'daily', localTime: 'noon', timezone: 'UTC', weekday: null }, new Date())).toThrow('Invalid local time');
  });

  it('always returns a later matching wall-clock minute across supported zones', () => {
    const zones = ['UTC', 'America/New_York', 'Europe/Paris', 'Asia/Ho_Chi_Minh'];
    for (const timezone of zones) {
      for (let month = 0; month < 12; month++) {
        const after = new Date(Date.UTC(2026, month, 14, 12, 17));
        const result = nextRunAt({ cadence: 'daily', localTime: '09:37', timezone, weekday: null }, after);
        const local = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(result);
        expect(result.getTime()).toBeGreaterThan(after.getTime());
        expect(local).toBe('09:37');
      }
    }
  });
});

import { db } from '../db.js';
import { nextRunAt } from './schedule.js';
import { randomUUID } from 'node:crypto';

type DuePlan = { id: string; active_mandate_id: string; next_run_at: Date; cadence: 'daily' | 'weekly'; local_time: string; timezone: string; weekday: number | null };
export type ClaimedOccurrence = { id: string; plan_id: string; mandate_id: string; scheduled_for: Date; status: string; lease_owner?: string | null };

export async function enqueueDuePlans(limit = 20, now = new Date()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<DuePlan>(`SELECT id, active_mandate_id, next_run_at, cadence, local_time, timezone, weekday FROM dca_plans
      WHERE status = 'active' AND next_run_at <= $1 ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit]);
    for (const plan of due.rows) {
      await client.query(`INSERT INTO purchase_occurrences (plan_id, mandate_id, scheduled_for) VALUES ($1,$2,$3)
        ON CONFLICT (plan_id, scheduled_for) DO NOTHING`, [plan.id, plan.active_mandate_id, plan.next_run_at]);
      const next = nextRunAt({ cadence: plan.cadence, localTime: plan.local_time.slice(0, 5), timezone: plan.timezone, weekday: plan.weekday }, plan.next_run_at);
      await client.query('UPDATE dca_plans SET next_run_at = $2, updated_at = now() WHERE id = $1', [plan.id, next]);
    }
    await client.query('COMMIT');
    return due.rowCount ?? 0;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function claimOccurrence(workerId: string): Promise<ClaimedOccurrence | null> {
  const claimToken = `${workerId}:${randomUUID()}`;
  const result = await db.query<ClaimedOccurrence>(`UPDATE purchase_occurrences o SET status = 'claimed', lease_owner = $1,
    lease_expires_at = now() + interval '2 minutes', attempt_count = attempt_count + 1, updated_at = now()
    FROM (SELECT o.id FROM purchase_occurrences o JOIN dca_plans p ON p.id = o.plan_id
      WHERE p.status = 'active' AND p.active_mandate_id = o.mandate_id AND
      (o.status = 'due' OR (o.status IN ('claimed','executing','confirming') AND o.lease_expires_at < now()))
      ORDER BY o.scheduled_for, o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1) candidate
    WHERE o.id = candidate.id RETURNING o.id, o.plan_id, o.mandate_id, o.scheduled_for, o.status, o.lease_owner`, [claimToken]);
  return result.rows[0] ?? null;
}

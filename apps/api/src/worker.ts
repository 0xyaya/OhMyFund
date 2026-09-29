import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { executeOccurrence } from './recurring/executor.js';
import { recurringExecutionReadiness } from './readiness.js';
import { claimOccurrence, enqueueDuePlans } from './recurring/queue.js';
import { reconcilePendingSetups } from './recurring/setup.js';

const workerId = `recurring-${randomUUID()}`;
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
let lastMetricsAt = 0;

async function logMetrics() {
  if (Date.now() - lastMetricsAt < 60_000) return;
  lastMetricsAt = Date.now();
  const result = await db.query<{ status: string; count: string }>(`SELECT status, count(*)::text FROM purchase_occurrences
    WHERE created_at > now() - interval '24 hours' GROUP BY status ORDER BY status`);
  const backlog = await db.query<{ count: string; oldest_seconds: string }>(`SELECT count(*)::text, COALESCE(extract(epoch FROM now() - min(scheduled_for)),0)::text AS oldest_seconds
    FROM purchase_occurrences WHERE status IN ('due','claimed','executing','confirming')`);
  console.info(JSON.stringify({ event: 'recurring_metrics', executionEnabled: config.executionEnabled, last24Hours: result.rows.map(row => ({ status: row.status, count: Number(row.count) })), backlog: { count: Number(backlog.rows[0].count), oldestSeconds: Number(backlog.rows[0].oldest_seconds) } }));
}

async function tick() {
  await logMetrics();
  await reconcilePendingSetups(workerId);
  if (!config.executionEnabled) return;
  const readiness = await recurringExecutionReadiness();
  if (!readiness.ok) {
    console.error(JSON.stringify({ event: 'recurring_worker_not_ready', reason: readiness.reason }));
    return;
  }
  await enqueueDuePlans();
  await Promise.all(Array.from({ length: config.recurringWorkerConcurrency }, async () => {
    const occurrence = await claimOccurrence(workerId);
    if (!occurrence) return;
    await executeOccurrence(occurrence).catch(error => console.error(JSON.stringify({ event: 'recurring_execution_failed', occurrenceId: occurrence.id, message: error instanceof Error ? error.message : 'Unknown error' })));
  }));
}

process.on('SIGTERM', async () => { await db.end(); process.exit(0); });
for (;;) {
  await tick().catch(error => console.error(JSON.stringify({ event: 'recurring_worker_tick_failed', message: error instanceof Error ? error.message : 'Unknown error' })));
  await delay(config.executionEnabled ? 5_000 : 30_000);
}

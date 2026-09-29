import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('recurring queue concurrency (PostgreSQL)', () => {
  let setupDb: pg.Pool;
  let appDb: pg.Pool;
  let enqueueDuePlans: typeof import('./queue.js').enqueueDuePlans;
  let claimOccurrence: typeof import('./queue.js').claimOccurrence;
  const userId = randomUUID();
  const fundId = randomUUID();
  const planId = randomUUID();

  beforeAll(async () => {
    const databaseName = new URL(testDatabaseUrl!).pathname;
    if (!/test/i.test(databaseName)) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
    process.env.DATABASE_URL = testDatabaseUrl;
    setupDb = new pg.Pool({ connectionString: testDatabaseUrl });
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
      await setupDb.query(await readFile(new URL(`../../sql/${migration}`, import.meta.url), 'utf8'));
    }
    await setupDb.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [userId, randomUUID(), randomUUID(), `wallet-${userId}`]);
    await setupDb.query('INSERT INTO funds (id, owner_id, name) VALUES ($1,$2,$3)', [fundId, userId, 'Queue test']);
    await setupDb.query(`INSERT INTO dca_plans (id, owner_id, fund_id, amount_atomic, cadence, local_time, timezone, status, next_run_at)
      VALUES ($1,$2,$3,1000000,'daily','09:00','UTC','approval_required',now() - interval '1 minute')`, [planId, userId, fundId]);
    const mandate = await setupDb.query<{ id: string }>(`INSERT INTO plan_mandates
      (plan_id, owner_id, plan_revision, fund_version, basket_json, amount_atomic, cadence, local_time, timezone, fee_bps, slippage_bps, terms_version, authorized_at)
      VALUES ($1,$2,1,1,'[]',1000000,'daily','09:00','UTC',75,100,'test',now()) RETURNING id`, [planId, userId]);
    await setupDb.query(`UPDATE dca_plans SET status = 'active', active_mandate_id = $2 WHERE id = $1`, [planId, mandate.rows[0].id]);
    ({ enqueueDuePlans, claimOccurrence } = await import('./queue.js'));
    ({ db: appDb } = await import('../db.js'));
  });

  afterAll(async () => {
    await setupDb?.query('DELETE FROM purchase_occurrences WHERE plan_id = $1', [planId]);
    await setupDb?.query('UPDATE dca_plans SET active_mandate_id = NULL WHERE id = $1', [planId]);
    await setupDb?.query('DELETE FROM plan_mandates WHERE plan_id = $1', [planId]);
    await setupDb?.query('DELETE FROM dca_plans WHERE id = $1', [planId]);
    await setupDb?.query('DELETE FROM funds WHERE id = $1', [fundId]);
    await setupDb?.query('DELETE FROM users WHERE id = $1', [userId]);
    await appDb?.end();
    await setupDb?.end();
  });

  it('creates and claims only one occurrence across two schedulers and workers', async () => {
    await Promise.all([enqueueDuePlans(), enqueueDuePlans()]);
    const occurrences = await setupDb.query('SELECT id FROM purchase_occurrences WHERE plan_id = $1', [planId]);
    expect(occurrences.rowCount).toBe(1);
    const claims = await Promise.all([claimOccurrence('worker-a'), claimOccurrence('worker-b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean)!;
    await setupDb.query("UPDATE purchase_occurrences SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [claimed.id]);
    const recovered = await claimOccurrence('worker-recovery');
    expect(recovered?.id).toBe(claimed.id);
    const state = await setupDb.query<{ lease_owner: string; attempt_count: number }>('SELECT lease_owner, attempt_count FROM purchase_occurrences WHERE id = $1', [claimed.id]);
    expect(state.rows[0].lease_owner).toMatch(/^worker-recovery:/);
    expect(state.rows[0].attempt_count).toBe(2);
  });

  it('does not claim an occurrence after its plan stops being active', async () => {
    await setupDb.query("UPDATE purchase_occurrences SET status = 'due', lease_owner = NULL, lease_expires_at = NULL WHERE plan_id = $1", [planId]);
    await setupDb.query("UPDATE dca_plans SET status = 'approval_required' WHERE id = $1", [planId]);
    await expect(claimOccurrence('worker-stale')).resolves.toBeNull();
  });
});

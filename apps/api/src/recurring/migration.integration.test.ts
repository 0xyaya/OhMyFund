import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('recurring wallet migration (PostgreSQL)', () => {
  let pool: pg.Pool;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const walletId = randomUUID();
  const address = `wallet-${userId}`;
  const fundId = randomUUID();
  const planId = randomUUID();

  beforeAll(async () => {
    const databaseName = new URL(testDatabaseUrl!).pathname;
    if (!/test/i.test(databaseName)) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql']) {
      await pool.query(await readFile(new URL(`../../sql/${migration}`, import.meta.url), 'utf8'));
    }
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [userId, organizationId, walletId, address]);
    await pool.query(await readFile(new URL('../../sql/004_recurring_execution.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../../sql/005_sponsored_execution.sql', import.meta.url), 'utf8'));
    await pool.query('INSERT INTO funds (id, owner_id, name) VALUES ($1,$2,$3)', [fundId, userId, 'Existing live plan']);
    await pool.query(`INSERT INTO dca_plans (id, owner_id, fund_id, amount_atomic, cadence, local_time, timezone, status, revision, next_run_at)
      VALUES ($1,$2,$3,1000000,'daily','09:00','UTC','active',1,now())`, [planId, userId, fundId]);
    const mandate = await pool.query<{ id: string }>(`INSERT INTO plan_mandates
      (plan_id, owner_id, plan_revision, fund_version, basket_json, amount_atomic, cadence, local_time, timezone, fee_bps, slippage_bps, terms_version)
      VALUES ($1,$2,1,1,'[]',1000000,'daily','09:00','UTC',75,100,'old-policy') RETURNING id`, [planId, userId]);
    await pool.query('UPDATE dca_plans SET active_mandate_id = $2 WHERE id = $1', [planId, mandate.rows[0].id]);
    const wallet = await pool.query<{ id: string }>('SELECT id FROM wallets WHERE owner_id = $1', [userId]);
    await pool.query(`INSERT INTO signer_authorizations
      (wallet_id, plan_id, mandate_id, provider, delegated_user_id, policy_ids, status)
      VALUES ($1,$2,$3,'turnkey',$4,$5::jsonb,'active')`,
    [wallet.rows[0].id, planId, mandate.rows[0].id, randomUUID(), JSON.stringify([randomUUID()])]);
    await pool.query(await readFile(new URL('../../sql/006_recurring_account_setup.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../../sql/007_sponsor_policy_lifecycle.sql', import.meta.url), 'utf8'));
  });

  afterAll(async () => { await pool?.end(); });

  it('backfills the existing Turnkey wallet without changing its address', async () => {
    const result = await pool.query('SELECT owner_id, provider, provider_organization_id, provider_wallet_id, solana_address, status FROM wallets WHERE owner_id = $1', [userId]);
    expect(result.rows).toEqual([{ owner_id: userId, provider: 'turnkey', provider_organization_id: organizationId, provider_wallet_id: walletId, solana_address: address, status: 'active' }]);
  });

  it('adds sponsored execution accounting without changing existing rows', async () => {
    const columns = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'purchase_legs' AND column_name IN ('fee_transfer_atomic','sponsor_address','user_signer_address')
      ORDER BY column_name`);
    expect(columns.rows.map(row => row.column_name)).toEqual(['fee_transfer_atomic', 'sponsor_address', 'user_signer_address']);
    const reservation = await pool.query(`SELECT to_regclass('public.sponsor_fee_reservations') AS relation`);
    expect(reservation.rows[0].relation).toBe('sponsor_fee_reservations');
  });

  it('adds durable setup attempts and setup-owned sponsor reservations', async () => {
    const setup = await pool.query(`SELECT to_regclass('public.mandate_setup_attempts') AS relation`);
    expect(setup.rows[0].relation).toBe('mandate_setup_attempts');
    const nullable = await pool.query<{ column_name: string; is_nullable: string }>(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sponsor_fee_reservations'
        AND column_name IN ('occurrence_id','attempt_id','leg_id','setup_attempt_id') ORDER BY column_name`);
    expect(nullable.rows).toEqual([
      { column_name: 'attempt_id', is_nullable: 'YES' },
      { column_name: 'leg_id', is_nullable: 'YES' },
      { column_name: 'occurrence_id', is_nullable: 'YES' },
      { column_name: 'setup_attempt_id', is_nullable: 'YES' }
    ]);
  });

  it('requires existing live plans to approve the setup-only policy model', async () => {
    const result = await pool.query('SELECT status, revision, active_mandate_id, next_run_at, pause_code FROM dca_plans WHERE id = $1', [planId]);
    expect(result.rows[0]).toEqual({ status: 'approval_required', revision: 2, active_mandate_id: null, next_run_at: null, pause_code: 'terms_changed' });
  });

  it('adds a durable per-mandate sponsor-policy lifecycle', async () => {
    const columns = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'signer_authorizations'
        AND column_name IN ('sponsor_policy_id','sponsor_policy_fingerprint','sponsor_policy_status','sponsor_policy_created_at','sponsor_policy_revoked_at','sponsor_policy_last_error_code')
      ORDER BY column_name`);
    expect(columns.rows.map(row => row.column_name)).toEqual([
      'sponsor_policy_created_at', 'sponsor_policy_fingerprint', 'sponsor_policy_id',
      'sponsor_policy_last_error_code', 'sponsor_policy_revoked_at', 'sponsor_policy_status'
    ]);
    const existing = await pool.query('SELECT status, sponsor_policy_id, sponsor_policy_status FROM signer_authorizations WHERE plan_id = $1', [planId]);
    expect(existing.rows[0]).toEqual({ status: 'active', sponsor_policy_id: null, sponsor_policy_status: null });
  });
});

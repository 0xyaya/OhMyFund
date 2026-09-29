import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('manual recurring reconciliation (PostgreSQL)', () => {
  let pool: pg.Pool;
  let reconcileAttempt: typeof import('./reconcile-attempt.js').reconcileAttempt;
  const userId = randomUUID(); const fundId = randomUUID(); const planId = randomUUID(); const mandateId = randomUUID();
  const walletAddress = '11111111111111111111111111111111';

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: testDatabaseUrl, WEB_ORIGIN: 'http://localhost:3000', PUBLIC_API_HOST: 'localhost:4310',
      TURNKEY_ORGANIZATION_ID: randomUUID(), TURNKEY_API_PUBLIC_KEY: `02${'1'.repeat(64)}`, TURNKEY_API_PRIVATE_KEY: 'private',
      SOLANA_RPC_URL: 'https://rpc.invalid', USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      JUPITER_FEE_ACCOUNT: 'So11111111111111111111111111111111111111112'
    });
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
      await pool.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8'));
    }
    const organizationId = randomUUID(); const walletId = randomUUID();
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [userId, organizationId, walletId, walletAddress]);
    const wallet = await pool.query<{ id: string }>("INSERT INTO wallets (owner_id, provider, provider_organization_id, provider_wallet_id, solana_address) VALUES ($1,'turnkey',$2,$3,$4) RETURNING id", [userId, organizationId, walletId, walletAddress]);
    await pool.query('INSERT INTO funds (id, owner_id, name) VALUES ($1,$2,$3)', [fundId, userId, 'Reconcile']);
    await pool.query("INSERT INTO dca_plans (id, owner_id, fund_id, amount_atomic, cadence, local_time, timezone, status, active_wallet_id) VALUES ($1,$2,$3,1000000,'daily','09:00','UTC','paused',$4)", [planId, userId, fundId, wallet.rows[0].id]);
    await pool.query("INSERT INTO plan_mandates (id, plan_id, owner_id, plan_revision, fund_version, basket_json, amount_atomic, cadence, local_time, timezone, fee_bps, slippage_bps, terms_version) VALUES ($1,$2,$3,1,1,'[]',1000000,'daily','09:00','UTC',75,100,'test')", [mandateId, planId, userId]);
    ({ reconcileAttempt } = await import('./reconcile-attempt.js'));
  });

  afterAll(async () => { const { db } = await import('./db.js'); await db.end(); await pool?.end(); });

  async function seedAttempt() {
    const occurrenceId = randomUUID();
    await pool.query("INSERT INTO purchase_occurrences (id, plan_id, mandate_id, scheduled_for, status) VALUES ($1,$2,$3,now(),'unknown')", [occurrenceId, planId, mandateId]);
    const attempt = await pool.query<{ id: string }>("INSERT INTO purchase_attempts (occurrence_id, attempt_number, signer_provider, gross_amount_atomic, status) VALUES ($1,1,'turnkey',1000000,'unknown') RETURNING id", [occurrenceId]);
    const legs = await pool.query<{ id: string; leg_index: number }>(`INSERT INTO purchase_legs (attempt_id, leg_index, asset_id, variant_id, output_mint, weight_bps, gross_amount_atomic, net_input_atomic, fee_transfer_atomic, expected_rent_lamports, signature, status)
      VALUES ($1,0,'a','a','mint-a',5000,500000,496250,3750,0,'sig-a','unknown'),($1,1,'b','b','mint-b',5000,500000,496250,3750,0,'sig-b','unknown') RETURNING id, leg_index`, [attempt.rows[0].id]);
    for (const leg of legs.rows) await pool.query(`INSERT INTO sponsor_fee_reservations (owner_id, occurrence_id, attempt_id, leg_id, reserved_lamports, status, transaction_signature)
      VALUES ($1,$2,$3,$4,3000000,'unknown',$5)`, [userId, occurrenceId, attempt.rows[0].id, leg.id, `sig-${leg.leg_index === 0 ? 'a' : 'b'}`]);
    return attempt.rows[0].id;
  }

  it('atomically records confirmed and failed legs as a partial attempt', async () => {
    const attemptId = await seedAttempt();
    const status = vi.fn(async (signature: string) => signature === 'sig-a' ? { confirmationStatus: 'confirmed', err: null } : { confirmationStatus: 'confirmed', err: { code: 1 } });
    const amounts = vi.fn(async () => ({ filledInputAtomic: 500000n, filledOutputAtomic: 42n, feeAtomic: 3750n, networkFeeLamports: 5000n, outputDecimals: 8 }));
    await expect(reconcileAttempt(attemptId, { signatureStatus: status as never, confirmedSwapAmounts: amounts as never })).resolves.toMatchObject({ status: 'partial', confirmedLegs: 1, totalLegs: 2 });
    expect((await pool.query('SELECT status FROM purchase_legs WHERE attempt_id = $1 ORDER BY leg_index', [attemptId])).rows.map(row => row.status)).toEqual(['confirmed', 'failed']);
    expect((await pool.query('SELECT status, final_lamports::text FROM sponsor_fee_reservations WHERE attempt_id = $1 ORDER BY transaction_signature', [attemptId])).rows).toEqual([
      { status: 'confirmed', final_lamports: '5000' },
      { status: 'failed', final_lamports: null }
    ]);
  });

  it('rolls back every leg update when RPC fails mid-reconciliation', async () => {
    const attemptId = await seedAttempt();
    const status = vi.fn(async (signature: string) => { if (signature === 'sig-b') throw new Error('rpc unavailable'); return { confirmationStatus: 'confirmed', err: null }; });
    const amounts = vi.fn(async () => ({ filledInputAtomic: 500000n, filledOutputAtomic: 42n, feeAtomic: 3750n, networkFeeLamports: 5000n, outputDecimals: 8 }));
    await expect(reconcileAttempt(attemptId, { signatureStatus: status as never, confirmedSwapAmounts: amounts as never })).rejects.toThrow('rpc unavailable');
    expect((await pool.query('SELECT status FROM purchase_legs WHERE attempt_id = $1 ORDER BY leg_index', [attemptId])).rows.map(row => row.status)).toEqual(['unknown', 'unknown']);
  });

  it('records an all-failed result as failed rather than partial', async () => {
    const attemptId = await seedAttempt();
    const status = vi.fn(async () => ({ confirmationStatus: 'confirmed', err: { code: 1 } }));
    const amounts = vi.fn();
    await expect(reconcileAttempt(attemptId, { signatureStatus: status as never, confirmedSwapAmounts: amounts as never })).resolves.toMatchObject({ status: 'failed', confirmedLegs: 0 });
    expect((await pool.query('SELECT status FROM purchase_attempts WHERE id = $1', [attemptId])).rows[0].status).toBe('failed');
  });
});

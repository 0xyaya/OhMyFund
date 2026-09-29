import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const signed = (fill: number) => Buffer.concat([Buffer.from([1]), Buffer.alloc(64, fill)]).toString('hex');
const signature = (fill: number) => bs58.encode(Buffer.alloc(64, fill));
let signCount = 0;
let failSecond = false;
let rejectWideRoute = false;
let buildAccountLimits: number[] = [];
let buildExcludedDexes: string[][] = [];
let fallbackPriceFloors: bigint[] = [];
let simulationFailuresRemaining = 0;
let fallbackOutAmount = '100';

vi.mock('../wallets/index.js', () => ({ walletSigner: () => ({ signSolanaTransaction: async () => { signCount++; return { signedTransactionHex: signed(signCount) }; } }) }));
vi.mock('../wallets/turnkey.js', () => ({ turnkeySponsorSigner: () => ({ organizationId: 'sponsor-org', address: 'ComputeBudget111111111111111111111111111111', signer: { signSolanaTransaction: async () => ({ signedTransactionHex: signed(signCount) }) } }) }));
vi.mock('../prices/jupiter.js', () => ({ fetchJupiterSolPrice: vi.fn(async () => ({ solPriceAtomicPerSol: 100_000_000n, blockId: 100 })) }));
vi.mock('../readiness.js', () => ({ recurringExecutionReadiness: vi.fn(async () => ({ ok: true })), recurringPlanReadiness: vi.fn(async () => ({ ok: true })) }));
vi.mock('../swaps/jupiter.js', () => ({ assertJupiterFallbackPrice: vi.fn((minimum: bigint, candidate: { otherAmountThreshold: string }, maximumDegradationBps = 0) => {
  fallbackPriceFloors.push(minimum);
  if (BigInt(candidate.otherAmountThreshold) * 10_000n < minimum * BigInt(10_000 - maximumDegradationBps)) throw new Error('The alternate Jupiter route is below the allowed minimum output.');
}), fetchJupiterBuild: vi.fn(async (_input: unknown, _apiKey: string, _fetcher: typeof fetch, maxAccounts = 40, excludedDexes: readonly string[] = []) => {
  buildAccountLimits.push(maxAccounts);
  buildExcludedDexes.push([...excludedDexes]);
  const outAmount = excludedDexes.length ? fallbackOutAmount : '100';
  return { maxAccounts, outAmount, otherAmountThreshold: rejectWideRoute && maxAccounts === 40 ? '10000' : '9990', blockhashWithMetadata: { lastValidBlockHeight: 999 }, routePlan: [{ swapInfo: { label: excludedDexes.length ? 'Deriverse' : 'GoonFi V2' } }] };
}) }));
vi.mock('../solana.js', () => ({
  assertFreshBlockhash: vi.fn(),
  assertRequiredSigners: vi.fn(),
  assertSignatureAddedBy: vi.fn(),
  associatedTokenAccount: vi.fn(async (_owner: string, mint: string) => `ata-${mint}`),
  createAssociatedTokenAccountInstruction: vi.fn(), tokenTransferCheckedInstruction: vi.fn(() => ({})),
  tokenAccountSizeForMint: vi.fn(async () => 165),
  tokenProgramsForMints: vi.fn(async (mints: string[]) => new Map(mints.map(mint => [mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']))),
  existingAccounts: vi.fn(async (accounts: string[]) => new Set(accounts)), nativeBalanceLamports: vi.fn(async () => 1_000_000_000n),
  rentExemptionLamports: vi.fn(async () => 2_000_000n), transactionFeeLamports: vi.fn(async () => 5_000n), currentSlot: vi.fn(async () => 120),
  estimateComputeUnits: vi.fn(async () => {
    if (simulationFailuresRemaining > 0) { simulationFailuresRemaining--; throw new Error('Solana simulation failed.'); }
    return 1000;
  }), isJupiterSlippageSimulationError: vi.fn((error: unknown) => error instanceof Error && error.message === 'Solana simulation failed.'), unsignedTransactionHex: vi.fn((build: { maxAccounts?: number }) => {
    if (rejectWideRoute && build.maxAccounts === 40) throw new Error('The Jupiter route exceeds Solana transaction size limits.');
    return '00';
  }),
  transactionIdFromSignedHex: vi.fn(() => signature(signCount)),
  submitSignedTransaction: vi.fn(async (hex: string) => bs58.encode(Buffer.from(hex, 'hex').subarray(1, 65))),
  currentBlockHeight: vi.fn(async () => 1),
  verifiedLookupTables: vi.fn(async () => ({})),
  signatureStatus: vi.fn(async (value: string) => failSecond && value === signature(2) ? { confirmationStatus: 'confirmed', err: { code: 1 } } : { confirmationStatus: 'confirmed', err: null }),
  confirmedSwapAmounts: vi.fn(async () => ({ filledInputAtomic: 500_000n, filledOutputAtomic: 42n, feeAtomic: 4_250n, networkFeeLamports: 5_000n, outputDecimals: 8 }))
}));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('recurring executor ledger (PostgreSQL)', () => {
  let pool: pg.Pool;
  let appDb: pg.Pool;
  let executeOccurrence: typeof import('./executor.js').executeOccurrence;
  let walletId: string;
  const userId = randomUUID(); const fundId = randomUUID(); const planId = randomUUID(); const mandateId = randomUUID(); const occurrenceId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.WEB_ORIGIN = 'http://localhost:3000'; process.env.PUBLIC_API_HOST = 'localhost:4310';
    process.env.TURNKEY_ORGANIZATION_ID = randomUUID(); process.env.TURNKEY_API_PUBLIC_KEY = `02${'1'.repeat(64)}`; process.env.TURNKEY_API_PRIVATE_KEY = 'private';
    process.env.SOLANA_RPC_URL = 'https://rpc.invalid'; process.env.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    process.env.EXECUTION_ENABLED = 'true'; process.env.RECURRING_BUYS_AVAILABLE = 'true'; process.env.JUPITER_API_KEY = 'test';
    process.env.JUPITER_FEE_ACCOUNT = 'So11111111111111111111111111111111111111112';
    process.env.JUPITER_FEE_ACCOUNT_AUTHORITY = 'ComputeBudget111111111111111111111111111111';
    process.env.TURNKEY_SPONSOR_ORGANIZATION_ID = randomUUID(); process.env.TURNKEY_SPONSOR_WALLET_ID = randomUUID();
    process.env.TURNKEY_SPONSOR_WALLET_ADDRESS = 'ComputeBudget111111111111111111111111111111';
    process.env.TURNKEY_SPONSOR_API_PUBLIC_KEY = `02${'2'.repeat(64)}`; process.env.TURNKEY_SPONSOR_API_PRIVATE_KEY = 'sponsor-private';
    process.env.RECURRING_MAX_NETWORK_FEE_ATOMIC = '1000'; process.env.RECURRING_MINIMUM_NET_INVESTMENT_ATOMIC = '1000';
    process.env.RECURRING_MAX_OCCURRENCE_ATOMIC = '10000000'; process.env.RECURRING_MAX_DAILY_ATOMIC = '20000000';
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) await pool.query(await readFile(new URL(`../../sql/${migration}`, import.meta.url), 'utf8'));
    const organizationId = randomUUID(); const providerWalletId = randomUUID(); const address = '11111111111111111111111111111111';
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [userId, organizationId, providerWalletId, address]);
    const wallet = await pool.query<{ id: string }>(`INSERT INTO wallets (owner_id, provider, provider_organization_id, provider_wallet_id, solana_address)
      VALUES ($1,'turnkey',$2,$3,$4) ON CONFLICT (solana_address) DO UPDATE SET updated_at = now() RETURNING id`, [userId, organizationId, providerWalletId, address]);
    walletId = wallet.rows[0].id;
    await pool.query('INSERT INTO funds (id, owner_id, name) VALUES ($1,$2,$3)', [fundId, userId, 'Executor']);
    await pool.query(`INSERT INTO dca_plans (id, owner_id, fund_id, amount_atomic, cadence, local_time, timezone, status, active_wallet_id)
      VALUES ($1,$2,$3,1000000,'daily','09:00','UTC','approval_required',$4)`, [planId, userId, fundId, wallet.rows[0].id]);
    await pool.query("INSERT INTO signer_authorizations (wallet_id, plan_id, provider, delegated_user_id, policy_ids, status) VALUES ($1,$2,'turnkey',$3,'[]','active')", [wallet.rows[0].id, planId, randomUUID()]);
    await pool.query(`INSERT INTO plan_mandates (id, plan_id, owner_id, plan_revision, fund_version, basket_json, amount_atomic, cadence, local_time, timezone, fee_bps, slippage_bps, terms_version, authorized_at)
      VALUES ($1,$2,$3,1,1,$4,1000000,'daily','09:00','UTC',75,100,'test',now())`, [mandateId, planId, userId, JSON.stringify([{ assetId: 'sol', variantId: 'sol', weightBps: 5000, mint: 'mint-a' }, { assetId: 'btc', variantId: 'btc', weightBps: 5000, mint: 'mint-b' }])]);
    await pool.query('UPDATE signer_authorizations SET mandate_id = $2 WHERE plan_id = $1', [planId, mandateId]);
    await pool.query("UPDATE dca_plans SET status = 'active', active_mandate_id = $2 WHERE id = $1", [planId, mandateId]);
    await pool.query("INSERT INTO purchase_occurrences (id, plan_id, mandate_id, scheduled_for, status, lease_owner, lease_expires_at) VALUES ($1,$2,$3,now(),'claimed','claim-first',now() + interval '2 minutes')", [occurrenceId, planId, mandateId]);
    ({ executeOccurrence } = await import('./executor.js'));
    ({ db: appDb } = await import('../db.js'));
  });

  afterAll(async () => { await appDb?.end(); await pool?.end(); });

  it('persists confirmed legs and prevents duplicate attempts across recovery', async () => {
    failSecond = true;
    const occurrence = { id: occurrenceId, plan_id: planId, mandate_id: mandateId, scheduled_for: new Date(), status: 'claimed', lease_owner: 'claim-first' };
    await expect(executeOccurrence(occurrence)).resolves.toBeUndefined();
    const state = await pool.query('SELECT status FROM purchase_occurrences WHERE id = $1', [occurrenceId]);
    expect(state.rows[0].status).toBe('partial');
    const legs = await pool.query('SELECT status FROM purchase_legs ORDER BY leg_index');
    expect(legs.rows.map(row => row.status)).toEqual(['confirmed', 'failed']);
    await expect(executeOccurrence(occurrence)).resolves.toBeUndefined();
    expect((await pool.query('SELECT count(*)::int AS count FROM purchase_attempts WHERE occurrence_id = $1', [occurrenceId])).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM purchase_legs')).rows[0].count).toBe(2);
  }, 30_000);

  it('confirms every leg of a later occurrence and records exact totals', async () => {
    failSecond = false;
    rejectWideRoute = true;
    buildAccountLimits = [];
    buildExcludedDexes = [];
    fallbackPriceFloors = [];
    simulationFailuresRemaining = 1;
    fallbackOutAmount = '100';
    const nextId = randomUUID();
    const setupAttemptId = randomUUID();
    const foreignUserId = randomUUID();
    const foreignSetupAttemptId = randomUUID();
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [foreignUserId, randomUUID(), randomUUID(), randomUUID()]);
    await pool.query(`INSERT INTO mandate_setup_attempts
      (id, owner_id, plan_id, mandate_id, wallet_id, purpose, attempt_number, status, prepare_idempotency_key)
      VALUES ($1,$2,$3,$4,$5,'initial',1,'confirmed',$6)`, [setupAttemptId, userId, planId, mandateId, walletId, randomUUID()]);
    await pool.query(`INSERT INTO mandate_setup_attempts
      (id, owner_id, plan_id, mandate_id, wallet_id, purpose, attempt_number, status, prepare_idempotency_key)
      VALUES ($1,$2,$3,$4,$5,'initial',2,'confirmed',$6)`, [foreignSetupAttemptId, foreignUserId, planId, mandateId, walletId, randomUUID()]);
    await pool.query(`INSERT INTO sponsor_fee_reservations
      (owner_id, setup_attempt_id, reserved_lamports, final_lamports, status)
      VALUES ($1,$2,20000000,20000000,'confirmed')`, [userId, setupAttemptId]);
    await pool.query(`INSERT INTO sponsor_fee_reservations
      (owner_id, setup_attempt_id, reserved_lamports, final_lamports, status)
      VALUES ($1,$2,200000000,200000000,'confirmed')`, [foreignUserId, foreignSetupAttemptId]);
    await pool.query("UPDATE dca_plans SET status = 'active', pause_reason = NULL, pause_code = NULL WHERE id = $1", [planId]);
    await pool.query("INSERT INTO purchase_occurrences (id, plan_id, mandate_id, scheduled_for, status, lease_owner, lease_expires_at) VALUES ($1,$2,$3,now() + interval '1 day','claimed','claim-next',now() + interval '2 minutes')", [nextId, planId, mandateId]);
    await executeOccurrence({ id: nextId, plan_id: planId, mandate_id: mandateId, scheduled_for: new Date(), status: 'claimed', lease_owner: 'claim-next' });
    expect((await pool.query('SELECT status FROM purchase_occurrences WHERE id = $1', [nextId])).rows[0].status).toBe('confirmed');
    const attempt = await pool.query('SELECT status, confirmed_gross_atomic::text AS gross, fee_atomic::text AS fee FROM purchase_attempts WHERE occurrence_id = $1', [nextId]);
    expect(attempt.rows[0]).toEqual({ status: 'confirmed', gross: '1000000', fee: '8500' });
    expect((await pool.query('SELECT count(*)::int AS count FROM purchase_legs WHERE attempt_id = (SELECT id FROM purchase_attempts WHERE occurrence_id = $1) AND status = $2', [nextId, 'confirmed'])).rows[0].count).toBe(2);
    expect(buildAccountLimits).toEqual([40, 20, 20, 40, 20]);
    expect(buildExcludedDexes).toEqual([[], [], ['GoonFi V2'], [], []]);
    expect(fallbackPriceFloors).toEqual([10_000n, 10_000n, 10_000n, 10_000n, 10_000n]);
  }, 30_000);
});

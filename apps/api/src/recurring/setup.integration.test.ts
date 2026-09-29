import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { associatedTokenAccount, currentBlockHeight, currentSlot, estimateSetupComputeUnits, existingAccounts, fetchJupiterSolPrice, latestBlockhash,
  rentExemptionLamports, setupTransactionFeeLamports, setupTransactionHex, tokenAccountBalanceAtomic, tokenAccountSizeForMint,
  tokenProgramsForMints, transactionMessageFingerprint, assertSignatureAddedBy, confirmedSetupAmounts, nativeBalanceLamports,
  signatureStatus, submitSignedTransaction, transactionIdFromSignedHex, sponsorSignSolanaTransaction } = vi.hoisted(() => ({
  associatedTokenAccount: vi.fn(async (_owner: string, mint: string) => mint),
  currentBlockHeight: vi.fn(async () => 10),
  currentSlot: vi.fn(async () => 50),
  estimateSetupComputeUnits: vi.fn(async () => 150_000),
  existingAccounts: vi.fn(async (accounts: string[]) => new Set(accounts)),
  fetchJupiterSolPrice: vi.fn(async () => ({ solPriceAtomicPerSol: 150_000_000n, blockId: 49 })),
  latestBlockhash: vi.fn(async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100, slot: 50 })),
  rentExemptionLamports: vi.fn(async () => 2_039_280n),
  setupTransactionFeeLamports: vi.fn(async () => 10_000n),
  setupTransactionHex: vi.fn(() => '00aa'),
  tokenAccountBalanceAtomic: vi.fn(async () => ({ amountAtomic: 5_000_000n, decimals: 6 })),
  tokenAccountSizeForMint: vi.fn(async () => 165),
  tokenProgramsForMints: vi.fn(async (mints: string[]) => new Map(mints.map(mint => [mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']))),
  transactionMessageFingerprint: vi.fn(() => 'a'.repeat(64)),
  assertSignatureAddedBy: vi.fn(),
  confirmedSetupAmounts: vi.fn(async () => ({ reimbursementAtomic: 613_284n, networkFeeLamports: 10_000n })),
  nativeBalanceLamports: vi.fn(async () => 1_000_000_000n),
  signatureStatus: vi.fn(async () => ({ confirmationStatus: 'confirmed', err: null })),
  submitSignedTransaction: vi.fn(async () => '3'.repeat(64)),
  transactionIdFromSignedHex: vi.fn(() => '3'.repeat(64)),
  sponsorSignSolanaTransaction: vi.fn(async () => ({ signedTransactionHex: '00cc' }))
}));

vi.mock('../solana.js', () => ({ associatedTokenAccount, currentBlockHeight, currentSlot, estimateSetupComputeUnits, existingAccounts, latestBlockhash,
  rentExemptionLamports, setupTransactionFeeLamports, setupTransactionHex, tokenAccountBalanceAtomic, tokenAccountSizeForMint,
  tokenProgramsForMints, transactionMessageFingerprint, assertSignatureAddedBy, confirmedSetupAmounts, nativeBalanceLamports,
  signatureStatus, submitSignedTransaction, transactionIdFromSignedHex }));
vi.mock('../readiness.js', () => ({ setupExecutionReadiness: vi.fn(async () => ({ ok: true })) }));
vi.mock('../prices/jupiter.js', () => ({ fetchJupiterSolPrice }));
vi.mock('../wallets/turnkey.js', () => ({ turnkeySponsorSigner: vi.fn(() => ({ signer: { signSolanaTransaction: sponsorSignSolanaTransaction }, organizationId: 'sponsor-org', address: 'So11111111111111111111111111111111111111112' })) }));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('recurring account setup state (PostgreSQL)', () => {
  let pool: pg.Pool;
  let service: typeof import('./setup.js');
  const userId = randomUUID();
  const organizationId = randomUUID();
  const providerWalletId = randomUUID();
  const walletId = randomUUID();
  const fundId = randomUUID();
  const planId = randomUUID();
  const mandateId = randomUUID();
  const walletAddress = '11111111111111111111111111111111';
  const mints = ['So11111111111111111111111111111111111111112', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'];

  beforeAll(async () => {
    const databaseName = new URL(testDatabaseUrl!).pathname;
    if (!/test/i.test(databaseName)) throw new Error('TEST_DATABASE_URL must name a dedicated test database.');
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.PUBLIC_API_HOST = 'localhost:4310';
    process.env.TURNKEY_ORGANIZATION_ID = randomUUID();
    process.env.TURNKEY_API_PUBLIC_KEY = `02${'1'.repeat(64)}`;
    process.env.TURNKEY_API_PRIVATE_KEY = 'private';
    process.env.SOLANA_RPC_URL = 'https://rpc.invalid';
    process.env.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    process.env.RECURRING_BUYS_AVAILABLE = 'true';
    process.env.SETUP_EXECUTION_ENABLED = 'true';
    process.env.RECURRING_ALLOWLIST_USER_IDS = userId;
    process.env.JUPITER_API_KEY = 'test';
    process.env.JUPITER_FEE_ACCOUNT = 'ComputeBudget111111111111111111111111111111';
    process.env.TURNKEY_SPONSOR_WALLET_ADDRESS = 'So11111111111111111111111111111111111111112';
    process.env.TURNKEY_SPONSOR_ORGANIZATION_ID = randomUUID();
    process.env.TURNKEY_SPONSOR_API_PUBLIC_KEY = `03${'2'.repeat(64)}`;
    process.env.TURNKEY_SPONSOR_API_PRIVATE_KEY = 'sponsor-private';
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
      await pool.query(await readFile(new URL(`../../sql/${migration}`, import.meta.url), 'utf8'));
    }
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [userId, organizationId, providerWalletId, walletAddress]);
    await pool.query("INSERT INTO wallets (id, owner_id, provider, provider_organization_id, provider_wallet_id, solana_address) VALUES ($1,$2,'turnkey',$3,$4,$5)", [walletId, userId, organizationId, providerWalletId, walletAddress]);
    await pool.query('INSERT INTO funds (id, owner_id, name) VALUES ($1,$2,$3)', [fundId, userId, 'Setup']);
    await pool.query(`INSERT INTO dca_plans (id, owner_id, fund_id, amount_atomic, cadence, local_time, timezone, status, revision, active_wallet_id)
      VALUES ($1,$2,$3,5000000,'daily','09:00','UTC','approval_required',1,$4)`, [planId, userId, fundId, walletId]);
    await pool.query(`INSERT INTO plan_mandates (id, plan_id, owner_id, plan_revision, fund_version, basket_json, amount_atomic, cadence, local_time, timezone, fee_bps, slippage_bps, terms_version)
      VALUES ($1,$2,$3,1,1,$4,5000000,'daily','09:00','UTC',75,100,'recurring-buy-v1')`, [mandateId, planId, userId, JSON.stringify(mints.map((mint, index) => ({ assetId: `asset-${index}`, variantId: `variant-${index}`, weightBps: 5000, mint })))]);
    await pool.query('UPDATE dca_plans SET active_mandate_id = $2 WHERE id = $1', [planId, mandateId]);
    service = await import('./setup.js');
  });

  afterAll(async () => {
    const { db } = await import('../db.js');
    await db.end();
    await pool?.end();
  });

  it('records one idempotent zero-charge setup when all accounts exist', async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([
      service.prepareAccountSetup(userId, planId, 1, key),
      service.prepareAccountSetup(userId, planId, 1, key)
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'confirmed', missingAccounts: [], reimbursementAtomic: '0' });
    expect((await pool.query('SELECT count(*)::int AS count FROM mandate_setup_attempts WHERE mandate_id = $1', [mandateId])).rows[0].count).toBe(1);
  });

  it('records a no-charge repair and resumes a plan when accounts already reappeared', async () => {
    await pool.query("UPDATE dca_plans SET status = 'paused', pause_code = 'account_setup_required', pause_reason = 'missing', revision = 2 WHERE id = $1", [planId]);
    const repaired = await service.prepareAccountSetup(userId, planId, 2, randomUUID());
    expect(repaired).toMatchObject({ purpose: 'repair', status: 'confirmed', reimbursementAtomic: '0' });
    expect((await pool.query('SELECT status, pause_code, revision FROM dca_plans WHERE id = $1', [planId])).rows[0]).toEqual({ status: 'active', pause_code: null, revision: 3 });
  });

  it('expires blockhash and quote-lifetime approvals safely and builds fresh transactions', async () => {
    await pool.query("UPDATE dca_plans SET status = 'approval_required', pause_code = 'approval_required', pause_reason = 'approve', revision = 4 WHERE id = $1", [planId]);
    existingAccounts.mockResolvedValue(new Set());
    currentBlockHeight.mockResolvedValue(10);
    latestBlockhash.mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100, slot: 50 });
    const first = await service.prepareAccountSetup(userId, planId, 4, randomUUID());
    expect(first).toMatchObject({ status: 'awaiting_user_signature', missingAccounts: [{ size: 165 }, { size: 165 }] });
    expect(BigInt(first.reimbursementAtomic)).toBeGreaterThan(0n);

    currentBlockHeight.mockResolvedValue(200);
    latestBlockhash.mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 300, slot: 60 });
    const replacement = await service.prepareAccountSetup(userId, planId, 4, randomUUID());
    expect(replacement.attemptId).not.toBe(first.attemptId);
    expect(replacement.status).toBe('awaiting_user_signature');
    expect((await pool.query('SELECT status FROM mandate_setup_attempts WHERE id = $1', [first.attemptId])).rows[0].status).toBe('expired');

    await pool.query("UPDATE mandate_setup_attempts SET quote_expires_at = now() - interval '1 second' WHERE id = $1", [replacement.attemptId]);
    const requoted = await service.prepareAccountSetup(userId, planId, 4, randomUUID());
    expect(requoted.attemptId).not.toBe(replacement.attemptId);
    expect(requoted.status).toBe('awaiting_user_signature');
    expect((await pool.query('SELECT status FROM mandate_setup_attempts WHERE id = $1', [replacement.attemptId])).rows[0].status).toBe('expired');
  });

  it('persists both signatures before submission and reconciles exact effects', async () => {
    currentBlockHeight.mockResolvedValue(200);
    const latest = await pool.query<{ id: string; reimbursement_atomic: string; missing_accounts_json: { address: string }[] }>(`SELECT id, reimbursement_atomic::text, missing_accounts_json
      FROM mandate_setup_attempts WHERE status = 'awaiting_user_signature' ORDER BY attempt_number DESC LIMIT 1`);
    const occurrenceId = randomUUID();
    const purchaseAttemptId = randomUUID();
    const legId = randomUUID();
    const foreignUserId = randomUUID();
    const foreignOccurrenceId = randomUUID();
    const foreignPurchaseAttemptId = randomUUID();
    const foreignLegId = randomUUID();
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [foreignUserId, randomUUID(), randomUUID(), randomUUID()]);
    await pool.query("INSERT INTO purchase_occurrences (id, plan_id, mandate_id, scheduled_for, status) VALUES ($1,$2,$3,now() - interval '1 day','confirmed')", [occurrenceId, planId, mandateId]);
    await pool.query("INSERT INTO purchase_occurrences (id, plan_id, mandate_id, scheduled_for, status) VALUES ($1,$2,$3,now() - interval '2 days','confirmed')", [foreignOccurrenceId, planId, mandateId]);
    await pool.query(`INSERT INTO purchase_attempts (id, occurrence_id, attempt_number, signer_provider, gross_amount_atomic, status)
      VALUES ($1,$2,1,'turnkey',1000000,'confirmed')`, [purchaseAttemptId, occurrenceId]);
    await pool.query(`INSERT INTO purchase_attempts (id, occurrence_id, attempt_number, signer_provider, gross_amount_atomic, status)
      VALUES ($1,$2,1,'turnkey',1000000,'confirmed')`, [foreignPurchaseAttemptId, foreignOccurrenceId]);
    await pool.query(`INSERT INTO purchase_legs (id, attempt_id, leg_index, asset_id, variant_id, output_mint, weight_bps, gross_amount_atomic, status)
      VALUES ($1,$2,0,'asset','variant',$3,10000,1000000,'confirmed')`, [legId, purchaseAttemptId, mints[0]]);
    await pool.query(`INSERT INTO purchase_legs (id, attempt_id, leg_index, asset_id, variant_id, output_mint, weight_bps, gross_amount_atomic, status)
      VALUES ($1,$2,0,'asset','variant',$3,10000,1000000,'confirmed')`, [foreignLegId, foreignPurchaseAttemptId, mints[0]]);
    await pool.query(`INSERT INTO sponsor_fee_reservations
      (owner_id, occurrence_id, attempt_id, leg_id, reserved_lamports, final_lamports, status)
      VALUES ($1,$2,$3,$4,100000000,100000000,'confirmed')`, [userId, occurrenceId, purchaseAttemptId, legId]);
    await pool.query(`INSERT INTO sponsor_fee_reservations
      (owner_id, occurrence_id, attempt_id, leg_id, reserved_lamports, final_lamports, status)
      VALUES ($1,$2,$3,$4,400000000,400000000,'confirmed')`, [foreignUserId, foreignOccurrenceId, foreignPurchaseAttemptId, foreignLegId]);
    confirmedSetupAmounts.mockResolvedValue({ reimbursementAtomic: BigInt(latest.rows[0].reimbursement_atomic), networkFeeLamports: 10_000n });
    const submitted = await service.submitAccountSetup(userId, planId, { expectedRevision: 4, attemptId: latest.rows[0].id, userSignedTransactionHex: '00bb' }, randomUUID());
    expect(submitted.status).toBe('confirming');
    const persisted = await pool.query('SELECT status, user_signed_transaction_hex, fully_signed_transaction_hex, transaction_signature FROM mandate_setup_attempts WHERE id = $1', [latest.rows[0].id]);
    expect(persisted.rows[0]).toEqual({ status: 'confirming', user_signed_transaction_hex: '00bb', fully_signed_transaction_hex: '00cc', transaction_signature: '3'.repeat(64) });
    existingAccounts.mockImplementation(async (accounts: string[]) => new Set(accounts));
    const confirmed = await service.getAccountSetup(userId, planId);
    expect(confirmed).toMatchObject({ status: 'confirmed', transactionSignature: '3'.repeat(64) });
    const reservation = await pool.query('SELECT status, final_lamports::text FROM sponsor_fee_reservations WHERE setup_attempt_id = $1', [latest.rows[0].id]);
    expect(reservation.rows[0]).toEqual({ status: 'confirmed', final_lamports: '4088560' });
  });
});

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { recurringMandateFingerprint, turnkeyMandatePolicy } from '@ohmyfund/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { getUser, getPolicies, provisionSponsorPolicy, revokeSponsorPolicy, MockPolicyProvisionerClientFailure } = vi.hoisted(() => ({
  getUser: vi.fn(), getPolicies: vi.fn(), provisionSponsorPolicy: vi.fn(), revokeSponsorPolicy: vi.fn(),
  MockPolicyProvisionerClientFailure: class extends Error {
    constructor(readonly code: string, message: string, readonly unknownResult = false) { super(message); }
  }
}));
vi.mock('@turnkey/sdk-server', () => ({ Turnkey: class { apiClient() { return { getUser, getPolicies }; } } }));
vi.mock('./policy-provisioner-client.js', () => ({
  PolicyProvisionerClientFailure: MockPolicyProvisionerClientFailure,
  provisionSponsorPolicy,
  revokeSponsorPolicy
}));
vi.mock('./solana.js', () => ({
  associatedTokenAccount: vi.fn(async (_owner: string, mint: string) => mint === process.env.USDC_MINT ? '11111111111111111111111111111111' : mint),
  tokenProgramsForMints: vi.fn(async (mints: string[]) => new Map(mints.map(mint => [mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'])))
}));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;

integration('recurring plan lifecycle (PostgreSQL)', () => {
  let pool: pg.Pool;
  let service: typeof import('./plans.js');
  const userId = randomUUID();
  const organizationId = randomUUID();
  const providerWalletId = randomUUID();
  const fundId = randomUUID();
  const walletAddress = '11111111111111111111111111111111';

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
    process.env.EXECUTION_ENABLED = 'false';
    process.env.RECURRING_BUYS_AVAILABLE = 'true';
    process.env.RECURRING_ALLOWLIST_USER_IDS = userId;
    process.env.JUPITER_API_KEY = 'test';
    process.env.JUPITER_FEE_ACCOUNT = 'So11111111111111111111111111111111111111112';
    process.env.JUPITER_FEE_ACCOUNT_AUTHORITY = 'ComputeBudget111111111111111111111111111111';
    process.env.TURNKEY_SPONSOR_WALLET_ADDRESS = 'ComputeBudget111111111111111111111111111111';
    process.env.TURNKEY_SPONSOR_ORGANIZATION_ID = randomUUID();
    process.env.TURNKEY_SPONSOR_WALLET_ID = randomUUID();
    process.env.TURNKEY_SPONSOR_API_PUBLIC_KEY = `03${'2'.repeat(64)}`;
    process.env.TURNKEY_SPONSOR_API_PRIVATE_KEY = 'sponsor-private';
    process.env.TURNKEY_SPONSOR_DELEGATED_USER_ID = randomUUID();
    process.env.POLICY_PROVISIONER_URL = 'http://policy-provisioner';
    process.env.POLICY_PROVISIONER_SHARED_SECRET = 'secret';
    process.env.TURNKEY_POLICY_PROVISIONER_API_PUBLIC_KEY = `02${'3'.repeat(64)}`;
    process.env.RECURRING_MAX_NETWORK_FEE_ATOMIC = '10000';
    process.env.RECURRING_MINIMUM_NET_INVESTMENT_ATOMIC = '100000';
    process.env.RECURRING_MAX_OCCURRENCE_ATOMIC = '10000000';
    process.env.RECURRING_MAX_DAILY_ATOMIC = '20000000';
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    for (const migration of ['001_initial.sql', '002_fund_activity.sql', '003_public_funds.sql', '004_recurring_execution.sql', '005_sponsored_execution.sql', '006_recurring_account_setup.sql', '007_sponsor_policy_lifecycle.sql']) {
      await pool.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8'));
    }
    await pool.query('INSERT INTO users (id, turnkey_organization_id, turnkey_wallet_id, solana_address) VALUES ($1,$2,$3,$4)', [userId, organizationId, providerWalletId, walletAddress]);
    await pool.query("INSERT INTO wallets (owner_id, provider, provider_organization_id, provider_wallet_id, solana_address) VALUES ($1,'turnkey',$2,$3,$4)", [userId, organizationId, providerWalletId, walletAddress]);
    await pool.query('INSERT INTO funds (id, owner_id, name) VALUES ($1,$2,$3)', [fundId, userId, 'Lifecycle']);
    await pool.query("INSERT INTO fund_assets (fund_id, asset_id, variant_id, weight_bps) VALUES ($1,'solana','solana:wSOL',6000),($1,'apple','apple:xStock',4000)", [fundId]);
    service = await import('./plans.js');
    provisionSponsorPolicy.mockImplementation(async (mandateId: string) => {
      const mandate = await pool.query<{ plan_id: string }>('SELECT plan_id FROM plan_mandates WHERE id = $1', [mandateId]);
      const input = await service.mandatePolicyInput(userId, mandate.rows[0].plan_id);
      return { policyId: mandateId, policyFingerprint: await recurringMandateFingerprint(input) };
    });
    revokeSponsorPolicy.mockResolvedValue({ policyId: '00000000-0000-4000-8000-000000000099', policyFingerprint: 'a'.repeat(64) });
  });

  afterAll(async () => {
    const { db } = await import('./db.js');
    await db.end();
    await pool?.end();
  });

  async function confirmAccountSetup(planId: string) {
    const row = await pool.query<{ mandate_id: string; wallet_id: string }>(`SELECT p.active_mandate_id AS mandate_id, w.id AS wallet_id
      FROM dca_plans p JOIN wallets w ON w.owner_id = p.owner_id AND w.provider = 'turnkey' AND w.status = 'active' WHERE p.id = $1`, [planId]);
    await pool.query(`INSERT INTO mandate_setup_attempts
      (owner_id, plan_id, mandate_id, wallet_id, purpose, attempt_number, status, prepare_idempotency_key)
      VALUES ($1,$2,$3,$4,'initial',1,'confirmed',$5)`, [userId, planId, row.rows[0].mandate_id, row.rows[0].wallet_id, randomUUID()]);
  }

  it('prepares idempotently, then pauses, resumes, and cancels with revision guards', async () => {
    const plan = await service.createPlan(userId, fundId, { amountAtomic: '1000000', cadence: 'daily', localTime: '09:00', timezone: 'UTC', weekday: null });
    const prepareKey = randomUUID();
    const prepared = await service.preparePlan(userId, plan.id, plan.revision, prepareKey);
    const repeated = await service.preparePlan(userId, plan.id, plan.revision, prepareKey);
    expect(repeated).toEqual(prepared);
    expect((await pool.query('SELECT count(*)::int AS count FROM plan_mandates WHERE plan_id = $1', [plan.id])).rows[0].count).toBe(1);
    await confirmAccountSetup(plan.id);

    const wallet = await pool.query<{ id: string }>('SELECT id FROM wallets WHERE owner_id = $1', [userId]);
    const delegatedUserId = randomUUID();
    const policyId = randomUUID();
    const delegatedPublicKey = `02${'1'.repeat(64)}`;
    getUser.mockResolvedValue({ user: { apiKeys: [{ credential: { publicKey: delegatedPublicKey } }] } });
    const intent = await service.createAuthorizationIntent(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId }, randomUUID());
    const policyFingerprint = await recurringMandateFingerprint(intent.mandatePolicyInput);
    const policy = turnkeyMandatePolicy(intent.mandatePolicyInput, delegatedUserId, policyFingerprint);
    getPolicies.mockResolvedValue({ policies: [{ policyId, ...policy }] });
    await expect(service.getPlanAuthorization(userId, plan.id)).resolves.toEqual({ delegatedUserId, policyIds: [], policyFingerprint: null });
    const authorizeKey = randomUUID();
    const active = await service.authorizePlan(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId, policyIds: [policyId], policyFingerprint }, authorizeKey);
    expect(active).toMatchObject({ status: 'active', revision: 2, pauseCode: null });
    await expect(service.authorizePlan(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId, policyIds: [policyId], policyFingerprint }, authorizeKey)).resolves.toEqual(active);
    await expect(service.getPlanAuthorization(userId, plan.id)).resolves.toEqual({ delegatedUserId, policyIds: [policyId], policyFingerprint });
    const competingPlan = await service.createPlan(userId, fundId, { amountAtomic: '1000000', cadence: 'daily', localTime: '11:00', timezone: 'UTC', weekday: null });
    await service.preparePlan(userId, competingPlan.id, competingPlan.revision, randomUUID());
    await expect(service.createAuthorizationIntent(userId, organizationId, competingPlan.id, { expectedRevision: 1, delegatedUserId }, randomUUID())).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });

    const paused = await service.pausePlan(userId, plan.id, 2, randomUUID());
    expect(paused).toMatchObject({ status: 'paused', revision: 3, pauseReason: 'Paused by user.', pauseCode: 'user' });
    await expect(service.resumePlan(userId, plan.id, 2, randomUUID())).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const resumed = await service.resumePlan(userId, plan.id, 3, randomUUID());
    expect(resumed).toMatchObject({ status: 'active', revision: 4, pauseReason: null, pauseCode: null });
    getPolicies.mockResolvedValueOnce({ policies: [{ policyId, ...policy }] });
    await expect(service.cancelPlan(userId, plan.id, 4, randomUUID())).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect((await pool.query('SELECT status, pause_code FROM dca_plans WHERE id = $1', [plan.id])).rows[0]).toEqual({ status: 'paused', pause_code: 'sponsor_policy_revocation_required' });
    getPolicies.mockResolvedValueOnce({ policies: [] });
    const cancelled = await service.cancelPlan(userId, plan.id, 4, randomUUID());
    expect(cancelled).toMatchObject({ status: 'cancelled', revision: 5 });
    expect((await pool.query('SELECT status FROM signer_authorizations WHERE wallet_id = $1', [wallet.rows[0].id])).rows[0].status).toBe('revoked');

    const deniedPlan = await service.createPlan(userId, fundId, { amountAtomic: '1000000', cadence: 'daily', localTime: '10:00', timezone: 'UTC', weekday: null });
    await service.preparePlan(userId, deniedPlan.id, deniedPlan.revision, randomUUID());
    await confirmAccountSetup(deniedPlan.id);
    const deniedIntent = await service.createAuthorizationIntent(userId, organizationId, deniedPlan.id, { expectedRevision: 1, delegatedUserId }, randomUUID());
    const deniedFingerprint = await recurringMandateFingerprint(deniedIntent.mandatePolicyInput);
    const deniedPolicy = turnkeyMandatePolicy(deniedIntent.mandatePolicyInput, delegatedUserId, deniedFingerprint);
    getPolicies.mockResolvedValueOnce({ policies: [{ policyId, ...deniedPolicy, notes: 'altered policy' }] });
    await expect(service.authorizePlan(userId, organizationId, deniedPlan.id, { expectedRevision: 1, delegatedUserId, policyIds: [policyId], policyFingerprint: deniedFingerprint }, randomUUID())).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await pool.query('SELECT status FROM dca_plans WHERE id = $1', [deniedPlan.id])).rows[0].status).toBe('approval_required');
    await expect(service.getPlanAuthorization(userId, deniedPlan.id)).resolves.toEqual({ delegatedUserId, policyIds: [policyId], policyFingerprint: deniedFingerprint });
    await expect(service.cancelPlan(userId, deniedPlan.id, 1, randomUUID())).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    getPolicies.mockResolvedValueOnce({ policies: [] });
    await expect(service.cancelPlan(userId, deniedPlan.id, 1, randomUUID())).resolves.toMatchObject({ status: 'cancelled' });
    expect((await pool.query('SELECT status FROM signer_authorizations WHERE plan_id = $1', [deniedPlan.id])).rows[0].status).toBe('revoked');
  }, 60_000);

  it('preserves the old policy record and automatically revokes sponsor authority before replacement', async () => {
    const plan = await service.createPlan(userId, fundId, { amountAtomic: '1000000', cadence: 'daily', localTime: '13:00', timezone: 'UTC', weekday: null });
    await service.preparePlan(userId, plan.id, plan.revision, randomUUID());
    await confirmAccountSetup(plan.id);
    const delegatedUserId = randomUUID();
    const oldPolicyId = randomUUID();
    const firstIntent = await service.createAuthorizationIntent(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId }, randomUUID());
    const firstFingerprint = await recurringMandateFingerprint(firstIntent.mandatePolicyInput);
    const firstPolicy = turnkeyMandatePolicy(firstIntent.mandatePolicyInput, delegatedUserId, firstFingerprint);
    getUser.mockResolvedValue({ user: { apiKeys: [{ credential: { publicKey: `02${'1'.repeat(64)}` } }] } });
    getPolicies.mockResolvedValueOnce({ policies: [{ policyId: oldPolicyId, ...firstPolicy }] });
    await service.authorizePlan(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId, policyIds: [oldPolicyId], policyFingerprint: firstFingerprint }, randomUUID());

    getPolicies.mockResolvedValueOnce({ policies: [{ policyId: oldPolicyId, ...firstPolicy }] });
    await expect(service.updatePlan(userId, plan.id, { amountAtomic: '2000000', cadence: 'daily', localTime: '13:00', timezone: 'UTC', weekday: null, expectedRevision: 2 })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    getPolicies.mockResolvedValueOnce({ policies: [] });
    const changed = await service.updatePlan(userId, plan.id, { amountAtomic: '2000000', cadence: 'daily', localTime: '13:00', timezone: 'UTC', weekday: null, expectedRevision: 2 });
    await service.preparePlan(userId, plan.id, changed.revision, randomUUID());
    await confirmAccountSetup(plan.id);
    expect((await pool.query("SELECT status, policy_ids, sponsor_policy_status FROM signer_authorizations WHERE plan_id = $1 ORDER BY created_at", [plan.id])).rows).toEqual([{ status: 'revoked', policy_ids: [oldPolicyId], sponsor_policy_status: 'revoked' }]);

    getPolicies.mockResolvedValueOnce({ policies: [] });
    await expect(service.createAuthorizationIntent(userId, organizationId, plan.id, { expectedRevision: changed.revision, delegatedUserId }, randomUUID())).resolves.toMatchObject({ policyIds: [] });
    expect((await pool.query("SELECT status, policy_ids FROM signer_authorizations WHERE plan_id = $1 ORDER BY created_at", [plan.id])).rows).toEqual([
      { status: 'revoked', policy_ids: [oldPolicyId] },
      { status: 'pending', policy_ids: [] }
    ]);
    getPolicies.mockResolvedValueOnce({ policies: [] });
    await service.cancelPlan(userId, plan.id, changed.revision, randomUUID());
  }, 60_000);

  it('reconciles unknown creation and leaves failed revocation paused and retryable', async () => {
    getPolicies.mockReset();
    getUser.mockReset();
    const plan = await service.createPlan(userId, fundId, { amountAtomic: '1000000', cadence: 'daily', localTime: '14:00', timezone: 'UTC', weekday: null });
    await service.preparePlan(userId, plan.id, plan.revision, randomUUID());
    await confirmAccountSetup(plan.id);
    const delegatedUserId = randomUUID();
    const userPolicyId = randomUUID();
    const intent = await service.createAuthorizationIntent(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId }, randomUUID());
    const fingerprint = await recurringMandateFingerprint(intent.mandatePolicyInput);
    getUser.mockResolvedValue({ user: { apiKeys: [{ credential: { publicKey: `02${'1'.repeat(64)}` } }] } });
    getPolicies.mockResolvedValue({ policies: [{ policyId: userPolicyId, ...turnkeyMandatePolicy(intent.mandatePolicyInput, delegatedUserId, fingerprint) }] });
    provisionSponsorPolicy.mockRejectedValueOnce(new MockPolicyProvisionerClientFailure('PROVISIONER_UNKNOWN', 'unknown', true));
    await expect(service.authorizePlan(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId, policyIds: [userPolicyId], policyFingerprint: fingerprint }, randomUUID()))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect((await pool.query('SELECT sponsor_policy_status FROM signer_authorizations WHERE plan_id = $1 AND status = $2', [plan.id, 'pending'])).rows[0].sponsor_policy_status).toBe('provisioning_unknown');

    await expect(service.authorizePlan(userId, organizationId, plan.id, { expectedRevision: 1, delegatedUserId, policyIds: [userPolicyId], policyFingerprint: fingerprint }, randomUUID()))
      .resolves.toMatchObject({ status: 'active' });
    expect((await pool.query('SELECT count(*)::int AS count FROM signer_authorizations WHERE plan_id = $1', [plan.id])).rows[0].count).toBe(1);

    getPolicies.mockResolvedValue({ policies: [] });
    revokeSponsorPolicy.mockRejectedValueOnce(new MockPolicyProvisionerClientFailure('POLICY_DELETE_DENIED', 'denied'));
    const update = { amountAtomic: '2000000', cadence: 'daily' as const, localTime: '14:00', timezone: 'UTC', weekday: null, expectedRevision: 2 };
    await expect(service.updatePlan(userId, plan.id, update)).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect((await pool.query('SELECT status, revision, pause_code FROM dca_plans WHERE id = $1', [plan.id])).rows[0])
      .toEqual({ status: 'paused', revision: 2, pause_code: 'sponsor_policy_revocation_required' });
    await expect(service.updatePlan(userId, plan.id, update)).resolves.toMatchObject({ status: 'approval_required', revision: 3 });
    expect((await pool.query('SELECT status, sponsor_policy_status FROM signer_authorizations WHERE plan_id = $1', [plan.id])).rows[0])
      .toEqual({ status: 'revoked', sponsor_policy_status: 'revoked' });
  }, 60_000);
});

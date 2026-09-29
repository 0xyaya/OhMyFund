import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, connect, getPolicies, testConfig } = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(),
  getPolicies: vi.fn(async () => ({ policies: [] as Array<{ policyId: string; notes: string }> })),
  testConfig: {
    recurringBuysAvailable: false, executionEnabled: false, jupiterApiKey: null as string | null,
    jupiterFeeAccount: null as string | null, jupiterFeeAccountAuthority: null as string | null, recurringDefaultSlippageBps: 100,
    recurringAllowlistUserIds: new Set(['user']), recurringMaxOccurrenceAtomic: 10_000_000n,
    turnkeyApiPrivateKey: 'private', turnkeyApiPublicKey: '02'.padEnd(66, '1'),
    turnkeySponsorOrganizationId: null as string | null, turnkeySponsorWalletId: null as string | null,
    turnkeySponsorWalletAddress: null as string | null, turnkeySponsorApiPublicKey: null as string | null, turnkeySponsorApiPrivateKey: null as string | null,
    turnkeySponsorDelegatedUserId: null as string | null, policyProvisionerUrl: null as string | null,
    policyProvisionerSharedSecret: null as string | null, turnkeyPolicyProvisionerApiPublicKey: null as string | null
  }
}));
class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
vi.mock('./db.js', () => ({ db: { query, connect } }));
vi.mock('./config.js', () => ({ config: testConfig }));
vi.mock('./auth.js', () => ({ ApiFailure }));
vi.mock('./catalog.js', () => ({ findSelection: vi.fn() }));
vi.mock('./recurring/schedule.js', () => ({ nextRunAt: vi.fn(() => new Date('2026-09-23T00:00:00Z')) }));
vi.mock('@turnkey/sdk-server', () => ({ Turnkey: class { apiClient() { return { getPolicies }; } } }));

const { assertNoLiveTurnkeyPolicies, cancelPlan, createPlan, getPlanAuthorization, preparePlan, recurringConfiguration, updatePlan } = await import('./plans.js');
const row = (overrides = {}) => ({
  id: 'plan', owner_id: 'user', fund_id: 'fund', amount_atomic: '1000000', cadence: 'daily' as const,
  local_time: '09:00:00', timezone: 'UTC', weekday: null, status: 'draft' as const, revision: 1,
  next_run_at: null, pause_reason: null, pause_code: null, created_at: new Date('2026-09-22T00:00:00Z'), ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  getPolicies.mockResolvedValue({ policies: [] });
  Object.assign(testConfig, { recurringBuysAvailable: false, executionEnabled: false, jupiterApiKey: null, jupiterFeeAccount: null, jupiterFeeAccountAuthority: null,
    turnkeySponsorOrganizationId: null, turnkeySponsorWalletId: null, turnkeySponsorWalletAddress: null,
    turnkeySponsorApiPublicKey: null, turnkeySponsorApiPrivateKey: null, turnkeySponsorDelegatedUserId: null,
    policyProvisionerUrl: null, policyProvisionerSharedSecret: null, turnkeyPolicyProvisionerApiPublicKey: null });
});

describe('recurring plans', () => {
  it('reports activation unavailable until every execution dependency is enabled', () => {
    expect(recurringConfiguration('user')).toMatchObject({ available: false, delegatedPublicKey: null });
    Object.assign(testConfig, { recurringBuysAvailable: true, executionEnabled: false, jupiterApiKey: 'key', jupiterFeeAccount: 'fee', jupiterFeeAccountAuthority: 'authority',
      turnkeySponsorOrganizationId: 'org', turnkeySponsorWalletId: 'wallet', turnkeySponsorWalletAddress: 'address', turnkeySponsorApiPublicKey: 'public', turnkeySponsorApiPrivateKey: 'private',
      turnkeySponsorDelegatedUserId: 'sponsor-user', policyProvisionerUrl: 'http://provisioner', policyProvisionerSharedSecret: 'secret', turnkeyPolicyProvisionerApiPublicKey: 'different' });
    expect(recurringConfiguration('user')).toMatchObject({ available: true, executionEnabled: false, feeBps: 75, delegatedPublicKey: testConfig.turnkeyApiPublicKey, unavailableReason: null });
  });

  it('creates an owned draft and rejects a missing fund', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [row()] });
    await expect(createPlan('user', 'fund', { amountAtomic: '1000000', cadence: 'daily', localTime: '09:00', timezone: 'UTC', weekday: null })).resolves.toMatchObject({ id: 'plan', status: 'draft', feeBps: 75 });
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(createPlan('user', 'missing', { amountAtomic: '1000000', cadence: 'daily', localTime: '09:00', timezone: 'UTC', weekday: null })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('uses revision guards for updates and draft cancellation', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    query.mockResolvedValueOnce({ rowCount: 1, rows: [row({ revision: 2, status: 'approval_required' })] });
    await expect(updatePlan('user', 'plan', { amountAtomic: '2000000', cadence: 'weekly', localTime: '10:00', timezone: 'UTC', weekday: 1, expectedRevision: 1 })).resolves.toMatchObject({ revision: 2, status: 'approval_required' });
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(cancelPlan('user', 'plan')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('blocks mandate preparation before any database transaction when execution is disabled', async () => {
    await expect(preparePlan('user', 'plan', 1, 'key')).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns only string policy IDs for an owned plan authorization', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ delegated_user_id: '00000000-0000-4000-8000-000000000010', policy_ids: ['00000000-0000-4000-8000-000000000011', 7] }] });
    await expect(getPlanAuthorization('user', 'plan')).resolves.toEqual({ delegatedUserId: '00000000-0000-4000-8000-000000000010', policyIds: ['00000000-0000-4000-8000-000000000011'], policyFingerprint: null });
  });

  it('detects an orphaned mandate policy even before its ID was stored', async () => {
    const mandateId = '00000000-0000-4000-8000-000000000020';
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ organization_id: 'org', policy_ids: [], mandate_id: mandateId }] });
    getPolicies.mockResolvedValueOnce({ policies: [{ policyId: 'orphan', notes: `OhMyFund user mandate ${mandateId}; fingerprint ${'a'.repeat(64)}` }] });
    await expect(assertNoLiveTurnkeyPolicies('user', { planId: '00000000-0000-4000-8000-000000000021' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });
});

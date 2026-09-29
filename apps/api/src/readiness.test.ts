import { beforeEach, expect, it, vi } from 'vitest';

const { config, parsedTokenAccount, nativeBalanceLamports, getWalletAccount, getUser, getPolicies, query, mandatePolicyInput, fetchMock } = vi.hoisted(() => ({
  config: {
    recurringBuysAvailable: true, jupiterApiKey: 'key', jupiterFeeAccount: 'fee', jupiterFeeAccountAuthority: 'treasury', usdcMint: 'usdc', solanaRpcUrl: 'rpc',
    turnkeySponsorOrganizationId: 'org', turnkeySponsorWalletId: 'wallet-id', turnkeySponsorWalletAddress: 'sponsor', turnkeySponsorApiPublicKey: 'public', turnkeySponsorApiPrivateKey: 'private',
    turnkeySponsorDelegatedUserId: 'sponsor-user', policyProvisionerUrl: 'http://provisioner', policyProvisionerSharedSecret: 'secret', turnkeyPolicyProvisionerApiPublicKey: 'provisioner-public',
    turnkeySetupSponsorPolicyId: 'setup-policy', setupMaxReimbursementAtomic: 5000000n,
    recurringSponsorMinimumBalanceLamports: 10n
  },
  parsedTokenAccount: vi.fn(), nativeBalanceLamports: vi.fn(), getWalletAccount: vi.fn(), getUser: vi.fn(), getPolicies: vi.fn(), query: vi.fn(), mandatePolicyInput: vi.fn(), fetchMock: vi.fn()
}));

vi.mock('./config.js', () => ({ config }));
vi.mock('./db.js', () => ({ db: { query } }));
vi.mock('./plans.js', () => ({ mandatePolicyInput }));
vi.mock('./solana.js', () => ({ parsedTokenAccount, nativeBalanceLamports }));
vi.mock('./vendor-call.js', () => ({ vendorCall: vi.fn(async (_name: string, run: () => Promise<unknown>) => run()) }));
vi.mock('@turnkey/sdk-server', () => ({ Turnkey: class { apiClient() { return { getWalletAccount, getUser, getPolicies }; } } }));
vi.mock('@ohmyfund/contracts', () => ({
  recurringMandateFingerprint: vi.fn(async () => 'fingerprint'),
  turnkeySponsorMandatePolicy: vi.fn(() => ({ effect: 'EFFECT_ALLOW', consensus: 'consensus', condition: 'condition', notes: 'notes' }))
  ,turnkeySetupSponsorPolicy: vi.fn(() => ({ effect: 'EFFECT_ALLOW', consensus: 'setup-consensus', condition: 'setup-condition', notes: 'setup-notes' }))
}));

const { recurringExecutionReadiness, recurringPlanReadiness, resetReadinessCacheForTest, setupExecutionReadiness } = await import('./readiness.js');

beforeEach(() => {
  vi.clearAllMocks(); resetReadinessCacheForTest();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, provisionerPublicKey: 'provisioner-public' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  config.jupiterApiKey = 'key';
  parsedTokenAccount.mockResolvedValue({ mint: 'usdc', authority: 'treasury' });
  nativeBalanceLamports.mockResolvedValue(100n);
  getWalletAccount.mockResolvedValue({ account: { organizationId: 'org', walletId: 'wallet-id', address: 'sponsor', addressFormat: 'ADDRESS_FORMAT_SOLANA' } });
  getUser.mockResolvedValue({ user: { apiKeys: [{ credential: { publicKey: 'public' } }] } });
  query.mockResolvedValue({ rowCount: 1, rows: [{ owner_id: 'owner', plan_id: 'plan' }] });
  mandatePolicyInput.mockResolvedValue({});
  getPolicies.mockResolvedValue({ policies: [{ policyId: 'sponsor-policy', effect: 'EFFECT_ALLOW', consensus: 'consensus', condition: 'condition', notes: 'notes' }] });
});

it('verifies the separate global setup sponsor policy', async () => {
  getPolicies.mockResolvedValue({ policies: [{ policyId: 'setup-policy', effect: 'EFFECT_ALLOW', consensus: 'setup-consensus', condition: 'setup-condition', notes: 'setup-notes' }] });
  await expect(setupExecutionReadiness()).resolves.toEqual({ ok: true });
});

it('passes complete sponsor custody, fee account, and balance checks and caches briefly', async () => {
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: true });
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: true });
  expect(parsedTokenAccount).toHaveBeenCalledTimes(1);
});

it('returns only safe reason codes for configuration and custody failures', async () => {
  config.jupiterApiKey = null as unknown as string;
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'recurring_configuration' });
  config.jupiterApiKey = 'key'; resetReadinessCacheForTest();
  getWalletAccount.mockResolvedValue({ account: { organizationId: 'wrong', walletId: 'wallet-id', address: 'sponsor', addressFormat: 'ADDRESS_FORMAT_SOLANA' } });
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'sponsor_custody_invalid' });
  resetReadinessCacheForTest(); getWalletAccount.mockResolvedValue({ account: { organizationId: 'org', walletId: 'wallet-id', address: 'sponsor', addressFormat: 'ADDRESS_FORMAT_SOLANA' } });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, provisionerPublicKey: 'wrong' }), { status: 200 }));
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'sponsor_custody_invalid' });
  resetReadinessCacheForTest();
  getUser.mockResolvedValueOnce({ user: { apiKeys: [{ credential: { publicKey: 'different' } }] } });
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'sponsor_custody_invalid' });
});

it('fails closed for a wrong fee account, low balance, or vendor error', async () => {
  parsedTokenAccount.mockResolvedValueOnce({ mint: 'wrong', authority: 'treasury' });
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'fee_account_invalid' });
  resetReadinessCacheForTest(); nativeBalanceLamports.mockResolvedValueOnce(9n);
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'sponsor_balance_low' });
  resetReadinessCacheForTest(); parsedTokenAccount.mockRejectedValueOnce(new Error('rpc secret detail'));
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: false, reason: 'vendor_unavailable' });
});

it('validates one stored mandate policy without making global readiness depend on another plan', async () => {
  query.mockResolvedValueOnce({ rowCount: 1, rows: [{ sponsor_policy_id: 'sponsor-policy', sponsor_policy_fingerprint: 'fingerprint', sponsor_policy_status: 'active' }] });
  await expect(recurringPlanReadiness('owner', 'plan', 'mandate')).resolves.toEqual({ ok: true });
  resetReadinessCacheForTest();
  query.mockResolvedValueOnce({ rowCount: 1, rows: [{ sponsor_policy_id: 'bad-policy', sponsor_policy_fingerprint: 'fingerprint', sponsor_policy_status: 'active' }] });
  await expect(recurringPlanReadiness('owner', 'bad-plan', 'bad-mandate')).resolves.toEqual({ ok: false, reason: 'sponsor_policy_invalid' });
  await expect(recurringExecutionReadiness()).resolves.toEqual({ ok: true });
});

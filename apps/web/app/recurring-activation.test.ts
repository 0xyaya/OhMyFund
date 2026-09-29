import assert from 'node:assert/strict';
import test from 'node:test';
import { activateRecurringPlan, canReapproveRecurringPlan, ensureRecurringAccounts, turnkeyApprovalSession } from './recurring-activation';

const planId = '33333333-3333-4333-8333-333333333333';
const attemptId = '55555555-5555-4555-8555-555555555555';
const account = { mint: 'So11111111111111111111111111111111111111112', tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', address: '11111111111111111111111111111111', size: 165, rentLamports: '2039280' };

test('offers reapproval after an execution failure but not for other paused states', () => {
  assert.equal(canReapproveRecurringPlan({ status: 'approval_required', pauseCode: 'approval_required' }), true);
  assert.equal(canReapproveRecurringPlan({ status: 'paused', pauseCode: 'execution_failure' }), true);
  assert.equal(canReapproveRecurringPlan({ status: 'paused', pauseCode: 'sponsor_policy_revocation_required' }), true);
  assert.equal(canReapproveRecurringPlan({ status: 'paused', pauseCode: 'user' }), false);
  assert.equal(canReapproveRecurringPlan({ status: 'paused', pauseCode: 'account_setup_required' }), false);
});

test('opens Turnkey login instead of silently ignoring recurring approval', async () => {
  let loginCalls = 0;
  let message = '';
  const missing = turnkeyApprovalSession({ account: null, turnkeySession: null,
    login: async () => { loginCalls++; }, onUnavailable: value => { message = value; } });
  assert.equal(missing, null);
  assert.equal(loginCalls, 1);
  assert.match(message, /Reconnect your Turnkey wallet/);

  const readyAccount = { address: 'wallet' };
  const readySession = { organizationId: 'organization' };
  const ready = turnkeyApprovalSession({ account: readyAccount, turnkeySession: readySession,
    login: async () => { throw new Error('should not log in'); }, onUnavailable: () => { throw new Error('should not report unavailable'); } });
  assert.deepEqual(ready, { account: readyAccount, session: readySession });
});

test('revokes the previous recurring policy before requesting replacement authorization', async () => {
  const original = globalThis.fetch;
  const fundId = '22222222-2222-4222-8222-222222222222';
  const mandateId = '44444444-4444-4444-8444-444444444444';
  const delegatedUserId = '66666666-6666-4666-8666-666666666666';
  const policyId = '77777777-7777-4777-8777-777777777777';
  const address = '11111111111111111111111111111111';
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as const;
  const plan = { id: planId, fundId, amountAtomic: '5000000', cadence: 'weekly' as const, localTime: '09:00', timezone: 'UTC', weekday: 1,
    status: 'approval_required' as const, revision: 3, nextRunAt: null, pauseReason: 'Terms changed.', pauseCode: 'terms_changed' as const,
    feeBps: 75 as const, slippageBps: 100, createdAt: new Date().toISOString() };
  const mandate = { id: mandateId, planId, planRevision: 3, fundVersion: 2, amountAtomic: '5000000', cadence: 'weekly' as const,
    localTime: '09:00', timezone: 'UTC', weekday: 1, feeBps: 75 as const, slippageBps: 100, termsVersion: 'recurring-buy-v1', authorizedAt: null,
    basket: [
      { assetId: 'bitcoin', variantId: 'btc', weightBps: 5000, mint: address },
      { assetId: 'solana', variantId: 'sol', weightBps: 5000, mint: 'So11111111111111111111111111111111111111112' }
    ] };
  const mandatePolicyInput = { mandateId, planId, planRevision: 3, fundVersion: 2, walletAddress: address, sponsorAddress: address,
    usdcMint: address, sourceTokenAccount: address, feeTokenAccount: address, maximumOccurrenceDebitAtomic: '5000000', basket: [
      { outputMint: address, destinationTokenAccount: address, tokenProgram, grossAllocationAtomic: '2500000', fixedSwapInputAtomic: '2400000', maximumFeeTransferAtomic: '100000' },
      { outputMint: 'So11111111111111111111111111111111111111112', destinationTokenAccount: 'SysvarRent111111111111111111111111111111111', tokenProgram, grossAllocationAtomic: '2500000', fixedSwapInputAtomic: '2400000', maximumFeeTransferAtomic: '100000' }
    ] };
  const policyFingerprint = 'a'.repeat(64);
  const serverPolicy = { policyName: 'Backend policy', notes: 'Backend-generated terms', effect: 'EFFECT_ALLOW' as const,
    consensus: `approvers.any(user, user.id == '${delegatedUserId}')`, condition: "solana.tx.address_table_lookups.count() == 0" };
  let submittedPolicies: unknown = null;
  let authorizeBody: unknown = null;
  const order: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/authorization/cleanup')) { assert.equal(init?.body, '{}'); order.push('cleanup'); return Response.json({ ok: true }); }
    if (path.endsWith('/setup/prepare')) return Response.json({ attemptId, planId, purpose: 'initial', status: 'confirmed', missingAccounts: [], reimbursementAtomic: '0', rentLamports: '0', networkFeeLamports: '0', expiresAt: null, unsignedTransactionHex: null });
    if (path.endsWith('/prepare')) { order.push('prepare'); return Response.json({ plan, mandate }); }
    if (path.endsWith('/authorization-intent')) { order.push('intent'); return Response.json({ delegatedUserId, policyIds: [], policyFingerprint, mandatePolicyInput,
      policyVersion: 'recurring-mandate-v2', policy: serverPolicy }); }
    if (path.endsWith('/authorize')) { authorizeBody = JSON.parse(String(init?.body)); return Response.json({ ...plan, status: 'active', revision: 4, nextRunAt: new Date().toISOString(), pauseReason: null, pauseCode: null }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await activateRecurringPlan({ plan, session: { csrfToken: 'csrf', organizationId: 'organization' }, configuration: { delegatedPublicKey: `02${'1'.repeat(64)}`, feeAccount: address },
      confirm: () => true, signSetupTransaction: async () => { throw new Error('should not sign'); },
      revokeExistingPolicies: async () => { order.push('revoke'); }, fetchOrCreateDelegatedUser: async () => ({ userId: delegatedUserId }),
      createPolicies: async (_organizationId, policies) => { submittedPolicies = policies; return [{ policyId }]; },
      deletePolicies: async () => undefined, onProgress: () => undefined });
    assert.deepEqual(order, ['revoke', 'cleanup', 'prepare', 'intent']);
    assert.deepEqual(submittedPolicies, [serverPolicy]);
    assert.deepEqual(authorizeBody, { expectedRevision: 3, delegatedUserId, policyIds: [policyId], policyFingerprint,
      policyVersion: 'recurring-mandate-v2' });
  } finally { globalThis.fetch = original; }
});

test('stops before preparing a replacement when authorization cleanup fails', async () => {
  const original = globalThis.fetch;
  const fundId = '22222222-2222-4222-8222-222222222222';
  const address = '11111111111111111111111111111111';
  const plan = { id: planId, fundId, amountAtomic: '5000000', cadence: 'weekly' as const, localTime: '09:00', timezone: 'UTC', weekday: 1,
    status: 'paused' as const, revision: 3, nextRunAt: null, pauseReason: 'The previous execution failed.', pauseCode: 'execution_failure' as const,
    feeBps: 75 as const, slippageBps: 100, createdAt: new Date().toISOString() };
  const order: string[] = [];
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    order.push(path);
    if (path.endsWith('/authorization/cleanup')) return Response.json({ error: { code: 'CONFLICT', message: 'Sponsor policy cleanup is incomplete. Retry this action.' } }, { status: 409 });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await assert.rejects(() => activateRecurringPlan({ plan, session: { csrfToken: 'csrf', organizationId: 'organization' }, configuration: { delegatedPublicKey: `02${'1'.repeat(64)}`, feeAccount: address },
      confirm: () => true, signSetupTransaction: async () => { throw new Error('should not sign'); },
      revokeExistingPolicies: async () => { order.push('revoke'); }, fetchOrCreateDelegatedUser: async () => { throw new Error('should not create delegated user'); },
      createPolicies: async () => { throw new Error('should not create policy'); }, deletePolicies: async () => undefined, onProgress: () => undefined }),
    /Sponsor policy cleanup is incomplete/);
    assert.deepEqual(order, ['revoke', `/api/plans/${planId}/authorization/cleanup`]);
  } finally { globalThis.fetch = original; }
});

test('skips setup signing when every token account already exists', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ attemptId, planId, purpose: 'initial', status: 'confirmed', missingAccounts: [], reimbursementAtomic: '0', rentLamports: '0', networkFeeLamports: '0', expiresAt: null, unsignedTransactionHex: null });
  };
  try {
    await ensureRecurringAccounts({ planId, expectedRevision: 1, csrfToken: 'csrf', confirm: () => true,
      signSetupTransaction: async () => { throw new Error('should not sign'); }, onProgress: () => undefined });
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('reviews, signs, submits, and polls one account-setup transaction', async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  const responses = [
    { attemptId, planId, purpose: 'initial', status: 'awaiting_user_signature', missingAccounts: [account], reimbursementAtomic: '306642', rentLamports: '2039280', networkFeeLamports: '5000', expiresAt: new Date().toISOString(), unsignedTransactionHex: '00aa' },
    { attemptId, planId, purpose: 'initial', status: 'confirming', missingAccountCount: 1, reimbursementAtomic: '306642', transactionSignature: '1'.repeat(64), message: null },
    { attemptId, planId, purpose: 'initial', status: 'confirmed', missingAccountCount: 1, reimbursementAtomic: '306642', transactionSignature: '1'.repeat(64), message: 'Token accounts are ready.' }
  ];
  globalThis.fetch = async input => {
    paths.push(new URL(String(input), 'http://localhost').pathname);
    return Response.json(responses.shift());
  };
  let review = '';
  let signed = 0;
  try {
    await ensureRecurringAccounts({ planId, expectedRevision: 1, csrfToken: 'csrf', confirm: message => { review = message; return true; },
      signSetupTransaction: async unsigned => { signed++; assert.equal(unsigned, '00aa'); return '00bb'; },
      onProgress: () => undefined, delay: async () => undefined });
    assert.equal(signed, 1);
    assert.match(review, /0\.306642 USDC/);
    assert.match(review, /0\.75% recurring-buy fee is not charged/);
    assert.deepEqual(paths, [`/api/plans/${planId}/setup/prepare`, `/api/plans/${planId}/setup/submit`, `/api/plans/${planId}/setup`]);
  } finally { globalThis.fetch = original; }
});

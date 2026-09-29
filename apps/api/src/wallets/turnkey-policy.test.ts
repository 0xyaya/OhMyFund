import { beforeEach, expect, it, vi } from 'vitest';
import { PolicyProvisioningFailure, resetTurnkeyPolicyCacheForTest, TurnkeyPolicyManager, type TurnkeyPolicyDefinition } from './turnkey-policy.js';

const expected: TurnkeyPolicyDefinition = {
  policyName: 'OhMyFund sponsor mandate 12345678',
  effect: 'EFFECT_ALLOW',
  consensus: "approvers.any(user, user.id == 'sponsor')",
  condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'",
  notes: `OhMyFund sponsor mandate 12345678-1234-4234-8234-123456789012; fingerprint ${'a'.repeat(64)}`
};

function fixture(initial: Array<TurnkeyPolicyDefinition & { policyId: string }> = []) {
  let policies = [...initial];
  const getPolicies = vi.fn(async () => ({ policies }));
  const createPolicies = vi.fn(async ({ policies: definitions }: { policies: TurnkeyPolicyDefinition[] }) => {
    policies = [...policies, { policyId: '00000000-0000-4000-8000-000000000001', ...definitions[0] }];
    return { activity: { status: 'ACTIVITY_STATUS_COMPLETED' }, policyIds: ['00000000-0000-4000-8000-000000000001'] };
  });
  const deletePolicies = vi.fn(async ({ policyIds }: { policyIds: string[] }) => {
    policies = policies.filter(policy => !policyIds.includes(policy.policyId));
    return { activity: { status: 'ACTIVITY_STATUS_COMPLETED' }, policyIds };
  });
  const manager = new TurnkeyPolicyManager('org', { apiPublicKey: 'public', apiPrivateKey: 'private' }, { getPolicies, createPolicies, deletePolicies });
  return { manager, getPolicies, createPolicies, deletePolicies };
}

beforeEach(() => resetTurnkeyPolicyCacheForTest());

it('creates one exact policy, verifies it, and revokes its exact ID', async () => {
  const { manager, createPolicies, deletePolicies } = fixture();
  await expect(manager.ensure(expected, true)).resolves.toEqual({ policyId: '00000000-0000-4000-8000-000000000001', created: true });
  expect(createPolicies).toHaveBeenCalledWith({ organizationId: 'org', policies: [expected] });
  await expect(manager.verify('00000000-0000-4000-8000-000000000001', expected)).resolves.toBe(true);
  await expect(manager.revoke('00000000-0000-4000-8000-000000000001')).resolves.toEqual({ deleted: true });
  expect(deletePolicies).toHaveBeenCalledWith({ organizationId: 'org', policyIds: ['00000000-0000-4000-8000-000000000001'] });
});

it('reconciles an existing exact policy without creating another one', async () => {
  const existing = { policyId: '00000000-0000-4000-8000-000000000002', ...expected };
  const { manager, createPolicies } = fixture([existing]);
  await expect(manager.ensure(expected, false)).resolves.toEqual({ policyId: existing.policyId, created: false });
  expect(createPolicies).not.toHaveBeenCalled();
});

it('fails closed when the same mandate notes have different policy terms', async () => {
  const { manager, createPolicies } = fixture([{ policyId: '00000000-0000-4000-8000-000000000003', ...expected, condition: 'different' }]);
  await expect(manager.ensure(expected, true)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  expect(createPolicies).not.toHaveBeenCalled();
});

it('deduplicates concurrent policy snapshot requests', async () => {
  const { manager, getPolicies } = fixture([{ policyId: '00000000-0000-4000-8000-000000000004', ...expected }]);
  await Promise.all([manager.policies(), manager.policies(), manager.policies()]);
  expect(getPolicies).toHaveBeenCalledTimes(1);
});

it('marks a timed-out creation as an unknown result and never retries it', async () => {
  const { manager, createPolicies } = fixture();
  createPolicies.mockRejectedValueOnce(new Error('request timed out'));
  await expect(manager.ensure(expected, true)).rejects.toEqual(expect.objectContaining<Partial<PolicyProvisioningFailure>>({
    code: 'POLICY_CREATE_UNKNOWN', unknownResult: true
  }));
  expect(createPolicies).toHaveBeenCalledTimes(1);
});

import { Turnkey } from '@turnkey/sdk-server';
import { vendorCall } from '../vendor-call.js';

export type TurnkeyPolicyDefinition = {
  policyName: string;
  effect: 'EFFECT_ALLOW' | 'EFFECT_DENY';
  consensus: string;
  condition: string;
  notes: string;
};

type TurnkeyPolicy = TurnkeyPolicyDefinition & { policyId: string };
type PolicyApi = {
  getPolicies(input: { organizationId: string }): Promise<{ policies: TurnkeyPolicy[] }>;
  createPolicies(input: { organizationId: string; policies: TurnkeyPolicyDefinition[] }): Promise<{
    activity: { status: string };
    policyIds: string[];
  }>;
  deletePolicies(input: { organizationId: string; policyIds: string[] }): Promise<{
    activity: { status: string };
    policyIds: string[];
  }>;
};

export type PolicyFailureCode =
  | 'POLICY_CREATE_DENIED'
  | 'POLICY_CREATE_UNKNOWN'
  | 'POLICY_DELETE_DENIED'
  | 'POLICY_DELETE_UNKNOWN'
  | 'POLICY_MISMATCH'
  | 'POLICY_NOT_FOUND'
  | 'POLICY_PROVIDER_UNAVAILABLE';

export class PolicyProvisioningFailure extends Error {
  constructor(readonly code: PolicyFailureCode, message: string, readonly unknownResult = false) {
    super(message);
  }
}

const CACHE_MS = 5_000;
const snapshots = new Map<string, { expiresAt: number; policies: Map<string, TurnkeyPolicy> }>();
const refreshes = new Map<string, Promise<Map<string, TurnkeyPolicy>>>();

function exact(policy: TurnkeyPolicy, expected: TurnkeyPolicyDefinition) {
  return policy.policyName === expected.policyName && policy.effect === expected.effect &&
    policy.consensus === expected.consensus && policy.condition === expected.condition && policy.notes === expected.notes;
}

function safeFailure(error: unknown, operation: 'create' | 'delete') {
  if (error instanceof PolicyProvisioningFailure) return error;
  const message = error instanceof Error ? error.message.toUpperCase() : '';
  const unknown = message.includes('TIMED OUT') || message.includes('TIMEOUT') || message.includes('UNAVAILABLE') || message.includes('CIRCUIT BREAKER');
  if (unknown) return new PolicyProvisioningFailure(operation === 'create' ? 'POLICY_CREATE_UNKNOWN' : 'POLICY_DELETE_UNKNOWN', `Turnkey policy ${operation} has an unknown result.`, true);
  if (message.includes('POLICY') || message.includes('CONSENSUS') || message.includes('DENIED')) {
    return new PolicyProvisioningFailure(operation === 'create' ? 'POLICY_CREATE_DENIED' : 'POLICY_DELETE_DENIED', `Turnkey denied policy ${operation}.`);
  }
  return new PolicyProvisioningFailure('POLICY_PROVIDER_UNAVAILABLE', `Turnkey policy ${operation} failed.`);
}

export class TurnkeyPolicyManager {
  private readonly api: PolicyApi;
  private readonly cacheKey: string;

  constructor(readonly organizationId: string, credentials: { apiPrivateKey: string; apiPublicKey: string }, api?: PolicyApi) {
    this.api = api ?? new Turnkey({
      apiBaseUrl: 'https://api.turnkey.com',
      apiPrivateKey: credentials.apiPrivateKey,
      apiPublicKey: credentials.apiPublicKey,
      defaultOrganizationId: organizationId
    }).apiClient();
    this.cacheKey = `${organizationId}:${credentials.apiPublicKey.toLowerCase()}`;
  }

  invalidate() {
    snapshots.delete(this.cacheKey);
  }

  async policies(force = false) {
    const cached = snapshots.get(this.cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.policies;
    const pending = refreshes.get(this.cacheKey);
    if (pending) return pending;
    const refresh = vendorCall('Turnkey policy snapshot', async () => {
      const response = await this.api.getPolicies({ organizationId: this.organizationId });
      const policies = new Map(response.policies.map(policy => [policy.policyId, policy]));
      snapshots.set(this.cacheKey, { expiresAt: Date.now() + CACHE_MS, policies });
      return policies;
    }, { timeoutMs: 8_000, retries: 1 }).finally(() => refreshes.delete(this.cacheKey));
    refreshes.set(this.cacheKey, refresh);
    return refresh;
  }

  async verify(policyId: string, expected: TurnkeyPolicyDefinition) {
    const policy = (await this.policies()).get(policyId);
    return Boolean(policy && exact(policy, expected));
  }

  async findExact(expected: TurnkeyPolicyDefinition) {
    const policies = await this.policies(true);
    const sameNotes = [...policies.values()].filter(policy => policy.notes === expected.notes);
    const match = sameNotes.find(policy => exact(policy, expected));
    if (match) return match.policyId;
    if (sameNotes.length) throw new PolicyProvisioningFailure('POLICY_MISMATCH', 'A Turnkey policy with this mandate identity has different terms.');
    return null;
  }

  async ensure(expected: TurnkeyPolicyDefinition, allowCreate: boolean) {
    const existing = await this.findExact(expected);
    if (existing) return { policyId: existing, created: false };
    if (!allowCreate) throw new PolicyProvisioningFailure('POLICY_NOT_FOUND', 'The uncertain Turnkey policy was not found.');
    try {
      const response = await vendorCall('Turnkey policy creation', () => this.api.createPolicies({
        organizationId: this.organizationId,
        policies: [expected]
      }), { timeoutMs: 15_000, retries: 0 });
      if (response.activity.status !== 'ACTIVITY_STATUS_COMPLETED' || response.policyIds.length !== 1) {
        throw new PolicyProvisioningFailure('POLICY_CREATE_UNKNOWN', 'Turnkey did not complete policy creation.', true);
      }
      this.invalidate();
      const policyId = response.policyIds[0];
      if (!await this.verify(policyId, expected)) {
        try {
          await this.revoke(policyId);
        } catch {
          throw new PolicyProvisioningFailure('POLICY_CREATE_UNKNOWN', 'The created Turnkey policy did not match and cleanup has an unknown result.', true);
        }
        throw new PolicyProvisioningFailure('POLICY_MISMATCH', 'The created Turnkey policy does not match the mandate.');
      }
      return { policyId, created: true };
    } catch (error) {
      throw safeFailure(error, 'create');
    }
  }

  async revoke(policyId: string) {
    const before = await this.policies(true);
    if (!before.has(policyId)) return { deleted: false };
    try {
      const response = await vendorCall('Turnkey policy deletion', () => this.api.deletePolicies({
        organizationId: this.organizationId,
        policyIds: [policyId]
      }), { timeoutMs: 15_000, retries: 0 });
      if (response.activity.status !== 'ACTIVITY_STATUS_COMPLETED' || !response.policyIds.includes(policyId)) {
        throw new PolicyProvisioningFailure('POLICY_DELETE_UNKNOWN', 'Turnkey did not complete policy deletion.', true);
      }
      this.invalidate();
      if ((await this.policies(true)).has(policyId)) {
        throw new PolicyProvisioningFailure('POLICY_DELETE_UNKNOWN', 'The deleted Turnkey policy is still present.', true);
      }
      return { deleted: true };
    } catch (error) {
      throw safeFailure(error, 'delete');
    }
  }
}

export function resetTurnkeyPolicyCacheForTest() {
  snapshots.clear();
  refreshes.clear();
}

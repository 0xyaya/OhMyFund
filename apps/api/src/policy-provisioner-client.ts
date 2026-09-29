import { config } from './config.js';
import { vendorCall } from './vendor-call.js';

export class PolicyProvisionerClientFailure extends Error {
  constructor(readonly code: string, message: string, readonly unknownResult = false) {
    super(message);
  }
}

type PolicyResult = { policyId: string; policyFingerprint: string };

async function request(path: string, mandateId: string): Promise<PolicyResult> {
  if (!config.policyProvisionerUrl || !config.policyProvisionerSharedSecret) {
    throw new PolicyProvisionerClientFailure('PROVISIONER_NOT_CONFIGURED', 'Sponsor policy provisioning is not configured.');
  }
  try {
    return await vendorCall('Sponsor policy provisioner', async signal => {
      const response = await fetch(new URL(path, config.policyProvisionerUrl!), {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-ohmyfund-provisioner-secret': config.policyProvisionerSharedSecret! },
        body: JSON.stringify({ mandateId })
      });
      const payload = await response.json().catch(() => null) as { policyId?: unknown; policyFingerprint?: unknown; error?: { code?: unknown; message?: unknown } } | null;
      if (!response.ok) {
        const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'PROVISIONER_FAILED';
        const message = typeof payload?.error?.message === 'string' ? payload.error.message : 'Sponsor policy provisioning failed.';
        throw new PolicyProvisionerClientFailure(code, message, response.status === 504 || code.endsWith('_UNKNOWN'));
      }
      if (typeof payload?.policyId !== 'string' || typeof payload.policyFingerprint !== 'string') {
        throw new PolicyProvisionerClientFailure('PROVISIONER_INVALID_RESPONSE', 'Sponsor policy provisioner returned an invalid response.');
      }
      return { policyId: payload.policyId, policyFingerprint: payload.policyFingerprint };
    }, { timeoutMs: 20_000, retries: 0 });
  } catch (error) {
    if (error instanceof PolicyProvisionerClientFailure) throw error;
    const message = error instanceof Error ? error.message.toUpperCase() : '';
    const unknown = message.includes('TIMED OUT') || message.includes('TIMEOUT') || message.includes('ABORT');
    throw new PolicyProvisionerClientFailure(unknown ? 'PROVISIONER_UNKNOWN' : 'PROVISIONER_UNAVAILABLE', unknown ? 'Sponsor policy provisioning has an unknown result.' : 'Sponsor policy provisioner is unavailable.', unknown);
  }
}

export const provisionSponsorPolicy = (mandateId: string) => request('/internal/policies/provision', mandateId);
export const revokeSponsorPolicy = (mandateId: string) => request('/internal/policies/revoke', mandateId);

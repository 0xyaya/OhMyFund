import { Turnkey } from '@turnkey/sdk-server';
import { config } from './config.js';
import { db } from './db.js';
import { mandatePolicyInput } from './plans.js';
import { nativeBalanceLamports, parsedTokenAccount } from './solana.js';
import { vendorCall } from './vendor-call.js';
import { recurringMandateFingerprint, turnkeySetupSponsorPolicy, turnkeySponsorMandatePolicy } from '@ohmyfund/contracts';
import { resetTurnkeyPolicyCacheForTest, TurnkeyPolicyManager } from './wallets/turnkey-policy.js';

export type RecurringReadinessReason = 'recurring_configuration' | 'fee_account_invalid' | 'sponsor_custody_invalid' | 'sponsor_policy_invalid' | 'sponsor_balance_low' | 'vendor_unavailable';
let cached: { expiresAt: number; result: { ok: true } | { ok: false; reason: RecurringReadinessReason } } | null = null;
let setupCached: { expiresAt: number; result: { ok: true } | { ok: false; reason: RecurringReadinessReason } } | null = null;

export function resetReadinessCacheForTest() {
  cached = null;
  setupCached = null;
  resetTurnkeyPolicyCacheForTest();
}

function sponsorApi() {
  return new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPrivateKey: config.turnkeySponsorApiPrivateKey!,
    apiPublicKey: config.turnkeySponsorApiPublicKey!,
    defaultOrganizationId: config.turnkeySponsorOrganizationId!
  }).apiClient();
}

async function sponsorBasics(includeProvisioner: boolean) {
  const api = sponsorApi();
  const [feeAccount, balance, custody, sponsorUser, provisioner] = await Promise.all([
    parsedTokenAccount(config.jupiterFeeAccount!, config.solanaRpcUrl),
    nativeBalanceLamports(config.turnkeySponsorWalletAddress!, config.solanaRpcUrl),
    vendorCall('Turnkey sponsor readiness', () => api.getWalletAccount({
      organizationId: config.turnkeySponsorOrganizationId!, walletId: config.turnkeySponsorWalletId!, address: config.turnkeySponsorWalletAddress!
    }), { timeoutMs: 8_000, retries: 1 }),
    vendorCall('Turnkey sponsor user readiness', () => api.getUser({
      organizationId: config.turnkeySponsorOrganizationId!, userId: config.turnkeySponsorDelegatedUserId!
    }), { timeoutMs: 8_000, retries: 1 }),
    includeProvisioner ? vendorCall('Sponsor policy provisioner readiness', signal => fetch(new URL('/internal/health', config.policyProvisionerUrl!), {
      signal, headers: { 'x-ohmyfund-provisioner-secret': config.policyProvisionerSharedSecret! }
    }), { timeoutMs: 5_000, retries: 1 }) : Promise.resolve(null)
  ]);
  if (feeAccount.mint !== config.usdcMint || feeAccount.authority !== config.jupiterFeeAccountAuthority) return { ok: false as const, reason: 'fee_account_invalid' as const };
  if (custody.account.organizationId !== config.turnkeySponsorOrganizationId || custody.account.walletId !== config.turnkeySponsorWalletId ||
      custody.account.address !== config.turnkeySponsorWalletAddress || custody.account.addressFormat !== 'ADDRESS_FORMAT_SOLANA') {
    return { ok: false as const, reason: 'sponsor_custody_invalid' as const };
  }
  if (!sponsorUser.user.apiKeys.some(key => key.credential.publicKey.toLowerCase() === config.turnkeySponsorApiPublicKey!.toLowerCase())) {
    return { ok: false as const, reason: 'sponsor_custody_invalid' as const };
  }
  if (balance < config.recurringSponsorMinimumBalanceLamports) return { ok: false as const, reason: 'sponsor_balance_low' as const };
  if (provisioner) {
    const payload = await provisioner.json().catch(() => null) as { ok?: unknown; provisionerPublicKey?: unknown } | null;
    if (!provisioner.ok || payload?.ok !== true || typeof payload.provisionerPublicKey !== 'string' ||
        payload.provisionerPublicKey.toLowerCase() !== config.turnkeyPolicyProvisionerApiPublicKey!.toLowerCase() ||
        payload.provisionerPublicKey.toLowerCase() === config.turnkeySponsorApiPublicKey!.toLowerCase()) {
      return { ok: false as const, reason: 'sponsor_custody_invalid' as const };
    }
  }
  return { ok: true as const };
}

export async function setupExecutionReadiness() {
  if (setupCached && setupCached.expiresAt > Date.now()) return setupCached.result;
  const missing = !config.recurringBuysAvailable || !config.jupiterFeeAccount || !config.jupiterFeeAccountAuthority ||
    !config.turnkeySponsorOrganizationId || !config.turnkeySponsorWalletId || !config.turnkeySponsorWalletAddress ||
    !config.turnkeySponsorApiPublicKey || !config.turnkeySponsorApiPrivateKey || !config.turnkeySponsorDelegatedUserId || !config.turnkeySetupSponsorPolicyId;
  if (missing) return { ok: false as const, reason: 'recurring_configuration' as const };
  try {
    const basics = await sponsorBasics(false);
    if (!basics.ok) return basics;
    const expected = turnkeySetupSponsorPolicy({
      sponsorAddress: config.turnkeySponsorWalletAddress!, usdcMint: config.usdcMint,
      feeTokenAccount: config.jupiterFeeAccount!, maximumReimbursementAtomic: config.setupMaxReimbursementAtomic.toString()
    }, config.turnkeySponsorDelegatedUserId!);
    const manager = new TurnkeyPolicyManager(config.turnkeySponsorOrganizationId!, {
      apiPublicKey: config.turnkeySponsorApiPublicKey!, apiPrivateKey: config.turnkeySponsorApiPrivateKey!
    });
    const result = await manager.verify(config.turnkeySetupSponsorPolicyId!, expected)
      ? { ok: true as const } : { ok: false as const, reason: 'sponsor_policy_invalid' as const };
    setupCached = { expiresAt: Date.now() + 30_000, result };
    return result;
  } catch {
    return { ok: false as const, reason: 'vendor_unavailable' as const };
  }
}

export async function recurringExecutionReadiness() {
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const missing = !config.recurringBuysAvailable || !config.jupiterApiKey || !config.jupiterFeeAccount || !config.jupiterFeeAccountAuthority ||
    !config.turnkeySponsorOrganizationId || !config.turnkeySponsorWalletId || !config.turnkeySponsorWalletAddress ||
    !config.turnkeySponsorApiPublicKey || !config.turnkeySponsorApiPrivateKey || !config.turnkeySponsorDelegatedUserId ||
    !config.policyProvisionerUrl || !config.policyProvisionerSharedSecret || !config.turnkeyPolicyProvisionerApiPublicKey;
  if (missing || config.turnkeySponsorApiPublicKey!.toLowerCase() === config.turnkeyPolicyProvisionerApiPublicKey!.toLowerCase()) {
    return { ok: false as const, reason: 'recurring_configuration' as const };
  }
  try {
    const result = await sponsorBasics(true);
    cached = { expiresAt: Date.now() + 30_000, result };
    return result;
  } catch {
    return { ok: false as const, reason: 'vendor_unavailable' as const };
  }
}

export async function recurringPlanReadiness(userId: string, planId: string, mandateId: string) {
  try {
    const stored = await db.query<{ sponsor_policy_id: string | null; sponsor_policy_fingerprint: string | null; sponsor_policy_status: string | null }>(`SELECT
      sa.sponsor_policy_id, sa.sponsor_policy_fingerprint, sa.sponsor_policy_status
      FROM signer_authorizations sa JOIN dca_plans p ON p.id = sa.plan_id
      WHERE p.id = $1 AND p.owner_id = $2 AND p.active_mandate_id = $3 AND p.status = 'active'
        AND sa.mandate_id = $3 AND sa.status = 'active'`, [planId, userId, mandateId]);
    if (stored.rowCount !== 1 || stored.rows[0].sponsor_policy_status !== 'active' || !stored.rows[0].sponsor_policy_id || !stored.rows[0].sponsor_policy_fingerprint) {
      return { ok: false as const, reason: 'sponsor_policy_invalid' as const };
    }
    const mandate = await mandatePolicyInput(userId, planId, ['active']);
    const fingerprint = await recurringMandateFingerprint(mandate);
    if (fingerprint !== stored.rows[0].sponsor_policy_fingerprint) return { ok: false as const, reason: 'sponsor_policy_invalid' as const };
    const expected = turnkeySponsorMandatePolicy(mandate, config.turnkeySponsorDelegatedUserId!, fingerprint);
    const manager = new TurnkeyPolicyManager(config.turnkeySponsorOrganizationId!, {
      apiPublicKey: config.turnkeySponsorApiPublicKey!, apiPrivateKey: config.turnkeySponsorApiPrivateKey!
    });
    return await manager.verify(stored.rows[0].sponsor_policy_id, expected)
      ? { ok: true as const } : { ok: false as const, reason: 'sponsor_policy_invalid' as const };
  } catch {
    return { ok: false as const, reason: 'vendor_unavailable' as const };
  }
}

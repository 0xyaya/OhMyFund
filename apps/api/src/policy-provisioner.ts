import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  recurringMandateFingerprint,
  recurringMandatePolicyInputSchema,
  turnkeySponsorMandatePolicy,
  type RecurringMandatePolicyInput
} from '@ohmyfund/contracts';
import { allocateAtomic, feeAtomic } from './money.js';
import { associatedTokenAccount, tokenProgramsForMints } from './solana.js';
import { PolicyProvisioningFailure, TurnkeyPolicyManager } from './wallets/turnkey-policy.js';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const positiveAtomic = (name: string, fallback: string) => {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[1-9]\d{0,17}$/.test(value)) throw new Error(`${name} must be a positive atomic-unit integer`);
  return BigInt(value);
};

const runtime = {
  port: Number(process.env.POLICY_PROVISIONER_PORT ?? 4311),
  databaseUrl: required('DATABASE_URL'),
  solanaRpcUrl: required('SOLANA_RPC_URL'),
  usdcMint: required('USDC_MINT'),
  feeTokenAccount: required('JUPITER_FEE_ACCOUNT'),
  sponsorOrganizationId: required('TURNKEY_SPONSOR_ORGANIZATION_ID'),
  sponsorAddress: required('TURNKEY_SPONSOR_WALLET_ADDRESS'),
  sponsorDelegatedUserId: required('TURNKEY_SPONSOR_DELEGATED_USER_ID'),
  sponsorSignerPublicKey: required('TURNKEY_SPONSOR_API_PUBLIC_KEY'),
  provisionerPublicKey: required('TURNKEY_POLICY_PROVISIONER_API_PUBLIC_KEY'),
  provisionerPrivateKey: required('TURNKEY_POLICY_PROVISIONER_API_PRIVATE_KEY'),
  sharedSecret: required('POLICY_PROVISIONER_SHARED_SECRET'),
  maximumNetworkFeeAtomic: positiveAtomic('RECURRING_MAX_NETWORK_FEE_ATOMIC', '50000'),
  minimumNetInvestmentAtomic: positiveAtomic('RECURRING_MINIMUM_NET_INVESTMENT_ATOMIC', '1000000')
};

if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) throw new Error('POLICY_PROVISIONER_PORT must be a valid port');
if (runtime.sponsorSignerPublicKey.toLowerCase() === runtime.provisionerPublicKey.toLowerCase()) {
  throw new Error('The sponsor signer and policy provisioner must use different Turnkey API keys.');
}

const pool = new pg.Pool({ connectionString: runtime.databaseUrl, max: 4, idleTimeoutMillis: 30_000 });
const manager = new TurnkeyPolicyManager(runtime.sponsorOrganizationId, {
  apiPublicKey: runtime.provisionerPublicKey,
  apiPrivateKey: runtime.provisionerPrivateKey
});
const bodySchema = z.object({ mandateId: z.uuid() }).strict();
const inFlight = new Map<string, Promise<{ policyId: string; policyFingerprint: string }>>();

type BasketItem = { assetId: string; variantId: string; weightBps: number; mint: string };
type AuthorizationRow = {
  authorization_id: string;
  plan_id: string;
  plan_revision: number;
  fund_version: number;
  amount_atomic: string;
  basket_json: BasketItem[];
  wallet_address: string;
  sponsor_policy_id: string | null;
  sponsor_policy_fingerprint: string | null;
  sponsor_policy_status: string | null;
};

async function authorization(mandateId: string) {
  const result = await pool.query<AuthorizationRow>(`SELECT sa.id AS authorization_id, m.plan_id, m.plan_revision, m.fund_version,
    m.amount_atomic::text, m.basket_json, w.solana_address AS wallet_address,
    sa.sponsor_policy_id, sa.sponsor_policy_fingerprint, sa.sponsor_policy_status
    FROM signer_authorizations sa
    JOIN plan_mandates m ON m.id = sa.mandate_id
    JOIN wallets w ON w.id = sa.wallet_id
    WHERE sa.mandate_id = $1 AND sa.provider = 'turnkey' AND w.provider = 'turnkey'
      AND sa.status IN ('pending','active') ORDER BY sa.created_at DESC LIMIT 1`, [mandateId]);
  if (result.rowCount !== 1) throw new PolicyProvisioningFailure('POLICY_NOT_FOUND', 'The mandate authorization is unavailable.');
  return result.rows[0];
}

async function mandateInput(mandateId: string, row: AuthorizationRow): Promise<RecurringMandatePolicyInput> {
  const gross = allocateAtomic(BigInt(row.amount_atomic), row.basket_json);
  const reserves = allocateAtomic(runtime.maximumNetworkFeeAtomic, row.basket_json);
  const programs = await tokenProgramsForMints(row.basket_json.map(item => item.mint), runtime.solanaRpcUrl);
  const sourceTokenAccount = await associatedTokenAccount(row.wallet_address, runtime.usdcMint, TOKEN_PROGRAM_ADDRESS);
  const basket = await Promise.all(row.basket_json.map(async (item, index) => {
    const tokenProgram = programs.get(item.mint);
    if (!tokenProgram) throw new PolicyProvisioningFailure('POLICY_MISMATCH', 'A mandate mint was not checked.');
    const grossAllocation = gross[index].amountAtomic;
    const maximumFee = feeAtomic(grossAllocation) + reserves[index].amountAtomic;
    const fixedSwapInput = grossAllocation - maximumFee;
    if (fixedSwapInput <= 0n) throw new PolicyProvisioningFailure('POLICY_MISMATCH', 'The mandate amount is too small after fee reserves.');
    return {
      outputMint: item.mint,
      destinationTokenAccount: String(await associatedTokenAccount(row.wallet_address, item.mint, tokenProgram)),
      tokenProgram: String(tokenProgram) as 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' | 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      grossAllocationAtomic: grossAllocation.toString(),
      fixedSwapInputAtomic: fixedSwapInput.toString(),
      maximumFeeTransferAtomic: maximumFee.toString()
    };
  }));
  if (basket.reduce((sum, item) => sum + BigInt(item.fixedSwapInputAtomic), 0n) < runtime.minimumNetInvestmentAtomic) {
    throw new PolicyProvisioningFailure('POLICY_MISMATCH', 'The mandate net investment is below the configured minimum.');
  }
  return recurringMandatePolicyInputSchema.parse({
    mandateId,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    fundVersion: row.fund_version,
    walletAddress: row.wallet_address,
    sponsorAddress: runtime.sponsorAddress,
    usdcMint: runtime.usdcMint,
    sourceTokenAccount: String(sourceTokenAccount),
    feeTokenAccount: runtime.feeTokenAccount,
    maximumOccurrenceDebitAtomic: row.amount_atomic,
    basket
  });
}

async function provision(mandateId: string) {
  const row = await authorization(mandateId);
  const canonicalInput = await mandateInput(mandateId, row);
  const policyFingerprint = await recurringMandateFingerprint(canonicalInput);
  const expected = turnkeySponsorMandatePolicy(canonicalInput, runtime.sponsorDelegatedUserId, policyFingerprint);
  if (row.sponsor_policy_status === 'active' && row.sponsor_policy_id) {
    if (row.sponsor_policy_fingerprint !== policyFingerprint || !await manager.verify(row.sponsor_policy_id, expected)) {
      throw new PolicyProvisioningFailure('POLICY_MISMATCH', 'The stored sponsor policy does not match the mandate.');
    }
    return { policyId: row.sponsor_policy_id, policyFingerprint };
  }
  if (!['provisioning', 'provisioning_unknown'].includes(row.sponsor_policy_status ?? '')) {
    throw new PolicyProvisioningFailure('POLICY_CREATE_DENIED', 'The mandate is not ready for sponsor policy provisioning.');
  }
  try {
    const result = await manager.ensure(expected, row.sponsor_policy_status === 'provisioning');
    const updated = await pool.query(`UPDATE signer_authorizations SET sponsor_policy_id = $2, sponsor_policy_fingerprint = $3,
      sponsor_policy_status = 'active', sponsor_policy_created_at = COALESCE(sponsor_policy_created_at, now()),
      sponsor_policy_last_error_code = NULL, updated_at = now()
      WHERE id = $1 AND mandate_id = $4 AND sponsor_policy_status IN ('provisioning','provisioning_unknown','active')`,
    [row.authorization_id, result.policyId, policyFingerprint, mandateId]);
    if (!updated.rowCount) throw new PolicyProvisioningFailure('POLICY_CREATE_UNKNOWN', 'The sponsor policy was created but could not be recorded.', true);
    return { policyId: result.policyId, policyFingerprint };
  } catch (error) {
    const failure = error instanceof PolicyProvisioningFailure ? error : new PolicyProvisioningFailure('POLICY_PROVIDER_UNAVAILABLE', 'Sponsor policy provisioning failed.');
    const status = failure.unknownResult || row.sponsor_policy_status === 'provisioning_unknown' ? 'provisioning_unknown' : 'failed';
    await pool.query(`UPDATE signer_authorizations SET sponsor_policy_status = $2, sponsor_policy_last_error_code = $3, updated_at = now()
      WHERE id = $1 AND sponsor_policy_status IN ('provisioning','provisioning_unknown')`, [row.authorization_id, status, failure.code]);
    throw failure;
  }
}

async function revoke(mandateId: string) {
  const row = await authorization(mandateId);
  const input = await mandateInput(mandateId, row);
  const policyFingerprint = row.sponsor_policy_fingerprint ?? await recurringMandateFingerprint(input);
  const expected = turnkeySponsorMandatePolicy(input, runtime.sponsorDelegatedUserId, policyFingerprint);
  if (row.sponsor_policy_status === 'revoked') return { policyId: row.sponsor_policy_id ?? mandateId, policyFingerprint };
  if (row.sponsor_policy_status !== 'revocation_pending') {
    throw new PolicyProvisioningFailure('POLICY_DELETE_DENIED', 'The mandate is not ready for sponsor policy revocation.');
  }
  try {
    const policyId = row.sponsor_policy_id ?? await manager.findExact(expected);
    if (policyId) await manager.revoke(policyId);
    await pool.query(`UPDATE signer_authorizations SET sponsor_policy_status = 'revoked', sponsor_policy_revoked_at = now(),
      sponsor_policy_id = COALESCE(sponsor_policy_id, $2), sponsor_policy_last_error_code = NULL, updated_at = now()
      WHERE id = $1 AND sponsor_policy_status = 'revocation_pending'`, [row.authorization_id, policyId]);
    return { policyId: policyId ?? mandateId, policyFingerprint };
  } catch (error) {
    const failure = error instanceof PolicyProvisioningFailure ? error : new PolicyProvisioningFailure('POLICY_PROVIDER_UNAVAILABLE', 'Sponsor policy revocation failed.');
    await pool.query(`UPDATE signer_authorizations SET sponsor_policy_last_error_code = $2, updated_at = now()
      WHERE id = $1 AND sponsor_policy_status = 'revocation_pending'`, [row.authorization_id, failure.code]);
    throw failure;
  }
}

function once(key: string, operation: () => Promise<{ policyId: string; policyFingerprint: string }>) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = operation().finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

function authorized(secret: unknown) {
  if (typeof secret !== 'string') return false;
  const received = Buffer.from(secret);
  const expected = Buffer.from(runtime.sharedSecret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const app = Fastify({ logger: true, bodyLimit: 1024 });
app.get('/internal/health', async (request, reply) => {
  if (!authorized(request.headers['x-ohmyfund-provisioner-secret'])) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
  return { ok: true, provisionerPublicKey: runtime.provisionerPublicKey };
});
app.post('/internal/policies/provision', async (request, reply) => {
  if (!authorized(request.headers['x-ohmyfund-provisioner-secret'])) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
  const { mandateId } = bodySchema.parse(request.body);
  return once(`provision:${mandateId}`, () => provision(mandateId));
});
app.post('/internal/policies/revoke', async (request, reply) => {
  if (!authorized(request.headers['x-ohmyfund-provisioner-secret'])) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
  const { mandateId } = bodySchema.parse(request.body);
  return once(`revoke:${mandateId}`, () => revoke(mandateId));
});
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof PolicyProvisioningFailure) {
    return reply.code(error.unknownResult ? 504 : error.code === 'POLICY_PROVIDER_UNAVAILABLE' ? 503 : 409)
      .send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'Invalid request.' } });
  app.log.error(error);
  return reply.code(500).send({ error: { code: 'PROVISIONER_FAILED', message: 'Sponsor policy provisioning failed.' } });
});

process.on('SIGTERM', async () => { await app.close(); await pool.end(); process.exit(0); });
await app.listen({ host: '0.0.0.0', port: runtime.port });

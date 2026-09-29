import { Turnkey } from '@turnkey/sdk-server';
import type pg from 'pg';
import { db } from './db.js';
import { ApiFailure } from './auth.js';
import { config } from './config.js';
import { findSelection } from './catalog.js';
import { nextRunAt } from './recurring/schedule.js';
import { allocateAtomic, feeAtomic, RECURRING_FEE_BPS } from './money.js';
import { recurringMandateFingerprint, recurringMandatePolicyInputSchema, turnkeyMandatePolicy, type RecurringMandatePolicyInput } from '@ohmyfund/contracts';
import { vendorCall } from './vendor-call.js';
import { associatedTokenAccount, tokenProgramsForMints } from './solana.js';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { PolicyProvisionerClientFailure, provisionSponsorPolicy, revokeSponsorPolicy } from './policy-provisioner-client.js';

const FEE_BPS = RECURRING_FEE_BPS;
const TERMS_VERSION = 'recurring-buy-v1';
type PlanInput = { amountAtomic: string; cadence: 'daily' | 'weekly'; localTime: string; timezone: string; weekday: number | null };
type PlanStatus = 'draft' | 'approval_required' | 'active' | 'paused' | 'cancelled';
type PauseCode = 'user' | 'execution_failure' | 'terms_changed' | 'approval_required' | 'account_setup_required' | 'sponsor_policy_revocation_required';
type PlanRow = { id: string; owner_id: string; fund_id: string; amount_atomic: string; cadence: 'daily' | 'weekly'; local_time: string; timezone: string; weekday: number | null; status: PlanStatus; revision: number; next_run_at: Date | null; pause_reason: string | null; pause_code: PauseCode | null; fee_bps?: number | null; slippage_bps?: number | null; created_at: Date };
type MandateRow = { id: string; plan_id: string; plan_revision: number; fund_version: number; basket_json: unknown; amount_atomic: string; cadence: 'daily' | 'weekly'; local_time: string; timezone: string; weekday: number | null; fee_bps: 75; slippage_bps: number; terms_version: string; authorized_at: Date | null };
type BasketItem = { assetId: string; variantId: string; weightBps: number; mint: string };

const mapPlan = (p: PlanRow) => ({
  id: p.id, fundId: p.fund_id, amountAtomic: String(p.amount_atomic), cadence: p.cadence, localTime: p.local_time.slice(0, 5), timezone: p.timezone, weekday: p.weekday,
  status: p.status, revision: p.revision, nextRunAt: p.next_run_at?.toISOString() ?? null, pauseReason: p.pause_reason, pauseCode: p.pause_code, feeBps: FEE_BPS,
  slippageBps: p.slippage_bps ?? config.recurringDefaultSlippageBps, createdAt: p.created_at.toISOString()
});
const mapMandate = (m: MandateRow) => ({
  id: m.id, planId: m.plan_id, planRevision: m.plan_revision, fundVersion: m.fund_version, basket: m.basket_json, amountAtomic: String(m.amount_atomic),
  cadence: m.cadence, localTime: m.local_time.slice(0, 5), timezone: m.timezone, weekday: m.weekday, feeBps: m.fee_bps, slippageBps: m.slippage_bps,
  termsVersion: m.terms_version, authorizedAt: m.authorized_at?.toISOString() ?? null
});

export async function assertNoLiveTurnkeyPolicies(userId: string, scope: { planId?: string; fundId?: string }) {
  const authorizations = await db.query<{ organization_id: string; policy_ids: unknown; mandate_id: string | null }>(`SELECT w.provider_organization_id AS organization_id, sa.policy_ids, sa.mandate_id
    FROM signer_authorizations sa JOIN wallets w ON w.id = sa.wallet_id JOIN dca_plans p ON p.id = sa.plan_id
    WHERE p.owner_id = $1 AND ($2::uuid IS NULL OR p.id = $2) AND ($3::uuid IS NULL OR p.fund_id = $3)
      AND sa.status IN ('pending','active')`, [userId, scope.planId ?? null, scope.fundId ?? null]);
  const byOrganization = new Map<string, { ids: Set<string>; mandates: Set<string> }>();
  for (const row of authorizations.rows) {
    const current = byOrganization.get(row.organization_id) ?? { ids: new Set<string>(), mandates: new Set<string>() };
    if (Array.isArray(row.policy_ids)) for (const item of row.policy_ids) if (typeof item === 'string') current.ids.add(item);
    if (row.mandate_id) current.mandates.add(row.mandate_id);
    byOrganization.set(row.organization_id, current);
  }
  for (const [organizationId, expected] of byOrganization) {
    const api = new Turnkey({ apiBaseUrl: 'https://api.turnkey.com', apiPrivateKey: config.turnkeyApiPrivateKey, apiPublicKey: config.turnkeyApiPublicKey, defaultOrganizationId: organizationId }).apiClient();
    const policies = await vendorCall('turnkey-policy-mutation-check', () => api.getPolicies({ organizationId }), { timeoutMs: 8_000, retries: 1 });
    const stillLive = policies.policies.some(policy => expected.ids.has(policy.policyId) || [...expected.mandates].some(mandateId => policy.notes?.startsWith(`OhMyFund user mandate ${mandateId}; fingerprint `)));
    if (stillLive) throw new ApiFailure(409, 'CONFLICT', 'Revoke the current Turnkey recurring-buy policy before changing these terms.');
  }
}

export async function mandatePolicyInput(userId: string, planId: string, statuses: PlanStatus[] = ['approval_required']): Promise<RecurringMandatePolicyInput> {
  if (!config.jupiterFeeAccount || !config.turnkeySponsorWalletAddress) throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Sponsored recurring-buy authorization is not configured.');
  const result = await db.query<{ mandate_id: string; plan_revision: number; fund_version: number; amount_atomic: string; basket_json: BasketItem[]; wallet_address: string }>(`SELECT m.id AS mandate_id,
    m.plan_revision, m.fund_version, m.amount_atomic, m.basket_json, w.solana_address AS wallet_address
    FROM dca_plans p JOIN plan_mandates m ON m.id = p.active_mandate_id
    JOIN wallets w ON w.owner_id = p.owner_id AND w.provider = 'turnkey' AND w.status = 'active'
    WHERE p.id = $1 AND p.owner_id = $2 AND p.status = ANY($3::text[])`, [planId, userId, statuses]);
  if (!result.rowCount) throw new ApiFailure(409, 'CONFLICT', 'The current mandate is unavailable for authorization.');
  const row = result.rows[0];
  const gross = allocateAtomic(BigInt(row.amount_atomic), row.basket_json);
  const reserves = allocateAtomic(config.recurringMaxNetworkFeeAtomic, row.basket_json);
  const programs = await tokenProgramsForMints(row.basket_json.map(item => item.mint), config.solanaRpcUrl);
  const sourceTokenAccount = await associatedTokenAccount(row.wallet_address, config.usdcMint, TOKEN_PROGRAM_ADDRESS);
  const basket = await Promise.all(row.basket_json.map(async (item, index) => {
    const tokenProgram = programs.get(item.mint);
    if (!tokenProgram) throw new Error(`Token mint ${item.mint} was not checked during authorization.`);
    const grossAllocation = gross[index].amountAtomic;
    const maximumFee = feeAtomic(grossAllocation) + reserves[index].amountAtomic;
    const fixedSwapInput = grossAllocation - maximumFee;
    if (fixedSwapInput <= 0n) throw new ApiFailure(422, 'VALIDATION', 'The plan amount is too small after reserving sponsored transaction costs.');
    return {
      outputMint: item.mint, destinationTokenAccount: String(await associatedTokenAccount(row.wallet_address, item.mint, tokenProgram)),
      tokenProgram: String(tokenProgram) as 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' | 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      grossAllocationAtomic: grossAllocation.toString(), fixedSwapInputAtomic: fixedSwapInput.toString(), maximumFeeTransferAtomic: maximumFee.toString()
    };
  }));
  if (basket.reduce((sum, item) => sum + BigInt(item.fixedSwapInputAtomic), 0n) < config.recurringMinimumNetInvestmentAtomic) {
    throw new ApiFailure(422, 'VALIDATION', 'The plan amount is too small after reserving sponsored transaction costs.');
  }
  return recurringMandatePolicyInputSchema.parse({
    mandateId: row.mandate_id, planId, planRevision: row.plan_revision, fundVersion: row.fund_version,
    walletAddress: row.wallet_address, sponsorAddress: config.turnkeySponsorWalletAddress,
    usdcMint: config.usdcMint, sourceTokenAccount: String(sourceTokenAccount), feeTokenAccount: config.jupiterFeeAccount,
    maximumOccurrenceDebitAtomic: row.amount_atomic, basket
  });
}

function requireActivationAvailable(userId: string) {
  if (!config.recurringBuysAvailable || !config.jupiterApiKey || !config.jupiterFeeAccount || !config.jupiterFeeAccountAuthority || !config.turnkeySponsorOrganizationId ||
      !config.turnkeySponsorWalletId || !config.turnkeySponsorWalletAddress || !config.turnkeySponsorApiPublicKey ||
      !config.turnkeySponsorApiPrivateKey || !config.turnkeySponsorDelegatedUserId || !config.policyProvisionerUrl ||
      !config.policyProvisionerSharedSecret || !config.turnkeyPolicyProvisionerApiPublicKey ||
      config.turnkeySponsorApiPublicKey.toLowerCase() === config.turnkeyPolicyProvisionerApiPublicKey.toLowerCase() ||
      !config.recurringAllowlistUserIds.has(userId)) {
    throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Recurring-buy activation is not enabled yet.');
  }
}

async function ensureSponsorAuthorization(planId: string, mandateId: string, expectedFingerprint: string) {
  const authorization = await db.query<{
    id: string; sponsor_policy_id: string | null; sponsor_policy_fingerprint: string | null; sponsor_policy_status: string | null;
  }>(`SELECT id, sponsor_policy_id, sponsor_policy_fingerprint, sponsor_policy_status
    FROM signer_authorizations WHERE plan_id = $1 AND mandate_id = $2 AND status = 'pending'`, [planId, mandateId]);
  if (!authorization.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Authorization intent is missing or changed. Restart activation.');
  const row = authorization.rows[0];
  if (row.sponsor_policy_status === 'active' && row.sponsor_policy_id && row.sponsor_policy_fingerprint === expectedFingerprint) {
    const verified = await provisionSponsorPolicy(mandateId);
    if (verified.policyId !== row.sponsor_policy_id || verified.policyFingerprint !== expectedFingerprint) {
      throw new ApiFailure(409, 'CONFLICT', 'The sponsor policy does not match this mandate.');
    }
    return verified;
  }
  if (row.sponsor_policy_status === 'pending' || row.sponsor_policy_status === 'failed') {
    const claimed = await db.query(`UPDATE signer_authorizations SET sponsor_policy_status = 'provisioning',
      sponsor_policy_last_error_code = NULL, updated_at = now()
      WHERE id = $1 AND sponsor_policy_status IN ('pending','failed')`, [row.id]);
    if (!claimed.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Sponsor policy provisioning is already in progress.');
  } else if (!['provisioning', 'provisioning_unknown'].includes(row.sponsor_policy_status ?? '')) {
    throw new ApiFailure(409, 'CONFLICT', 'Sponsor policy provisioning cannot continue from its current state.');
  }
  try {
    const result = await provisionSponsorPolicy(mandateId);
    if (result.policyFingerprint !== expectedFingerprint) throw new ApiFailure(409, 'CONFLICT', 'The sponsor policy fingerprint does not match this mandate.');
    const recorded = await db.query(`UPDATE signer_authorizations SET sponsor_policy_id = $2, sponsor_policy_fingerprint = $3,
      sponsor_policy_status = 'active', sponsor_policy_created_at = COALESCE(sponsor_policy_created_at, now()),
      sponsor_policy_last_error_code = NULL, updated_at = now()
      WHERE id = $1 AND mandate_id = $4 AND sponsor_policy_status IN ('provisioning','provisioning_unknown','active')`,
    [row.id, result.policyId, result.policyFingerprint, mandateId]);
    if (!recorded.rowCount) throw new ApiFailure(409, 'CONFLICT', 'The sponsor policy was verified but could not be recorded.');
    return result;
  } catch (error) {
    if (error instanceof PolicyProvisionerClientFailure) {
      await db.query(`UPDATE signer_authorizations SET sponsor_policy_status = $2,
        sponsor_policy_last_error_code = $3, updated_at = now()
        WHERE id = $1 AND sponsor_policy_status = 'provisioning'`,
      [row.id, error.unknownResult ? 'provisioning_unknown' : 'failed', error.code.slice(0, 80)]);
      throw new ApiFailure(error.unknownResult ? 409 : 503, error.unknownResult ? 'CONFLICT' : 'TEMPORARY_UNAVAILABLE', error.message);
    }
    throw error;
  }
}

export async function revokeSponsorAuthorization(userId: string, scope: { planId?: string; fundId?: string }) {
  const rows = await db.query<{ plan_id: string; mandate_id: string; authorization_id: string; sponsor_policy_status: string | null }>(`SELECT p.id AS plan_id,
    sa.mandate_id, sa.id AS authorization_id, sa.sponsor_policy_status
    FROM dca_plans p JOIN signer_authorizations sa ON sa.plan_id = p.id
    WHERE p.owner_id = $1 AND ($2::uuid IS NULL OR p.id = $2) AND ($3::uuid IS NULL OR p.fund_id = $3)
      AND sa.status IN ('pending','active') AND sa.mandate_id IS NOT NULL
    ORDER BY p.id, sa.created_at`, [userId, scope.planId ?? null, scope.fundId ?? null]);
  if (!rows.rowCount) return;
  const toRevoke: typeof rows.rows = [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const planId of [...new Set(rows.rows.map(row => row.plan_id))]) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recurring-sign:${planId}`]);
      await client.query(`UPDATE dca_plans SET status = CASE WHEN status IN ('approval_required','active','paused') THEN 'paused' ELSE status END,
        next_run_at = NULL, pause_reason = 'Sponsor policy cleanup is required before this plan can change.',
        pause_code = CASE WHEN status IN ('approval_required','active','paused') THEN 'sponsor_policy_revocation_required' ELSE pause_code END,
        updated_at = now() WHERE id = $1 AND owner_id = $2 AND status <> 'cancelled'`, [planId, userId]);
    }
    for (const row of rows.rows) {
      if (row.sponsor_policy_status === null || ['pending', 'failed', 'revoked'].includes(row.sponsor_policy_status)) {
        await client.query(`UPDATE signer_authorizations SET sponsor_policy_status = 'revoked', sponsor_policy_revoked_at = now(),
          sponsor_policy_last_error_code = NULL, updated_at = now() WHERE id = $1`, [row.authorization_id]);
        continue;
      }
      await client.query(`UPDATE signer_authorizations SET sponsor_policy_status = 'revocation_pending',
        sponsor_policy_last_error_code = NULL, updated_at = now() WHERE id = $1`, [row.authorization_id]);
      toRevoke.push(row);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  for (const row of toRevoke) {
    try {
      await revokeSponsorPolicy(row.mandate_id);
      await db.query(`UPDATE signer_authorizations SET sponsor_policy_status = 'revoked', sponsor_policy_revoked_at = COALESCE(sponsor_policy_revoked_at, now()),
        sponsor_policy_last_error_code = NULL, updated_at = now()
        WHERE id = $1 AND sponsor_policy_status IN ('revocation_pending','revoked')`, [row.authorization_id]);
    } catch (error) {
      if (error instanceof PolicyProvisionerClientFailure) {
        await db.query(`UPDATE signer_authorizations SET sponsor_policy_last_error_code = $2, updated_at = now()
          WHERE id = $1 AND sponsor_policy_status = 'revocation_pending'`, [row.authorization_id, error.code.slice(0, 80)]);
        throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Sponsor policy cleanup is incomplete. Retry this action.');
      }
      throw error;
    }
  }
}

export async function prepareAuthorizationCleanup(userId: string, scope: { planId?: string; fundId?: string }) {
  await revokeSponsorAuthorization(userId, scope);
  await assertNoLiveTurnkeyPolicies(userId, scope);
  await db.query(`UPDATE signer_authorizations sa SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
    FROM dca_plans p WHERE p.id = sa.plan_id AND p.owner_id = $1
      AND ($2::uuid IS NULL OR p.id = $2) AND ($3::uuid IS NULL OR p.fund_id = $3)
      AND sa.status IN ('pending','active') AND sa.sponsor_policy_status = 'revoked'`,
  [userId, scope.planId ?? null, scope.fundId ?? null]);
}

async function idempotent<T>(client: pg.PoolClient, userId: string, planId: string, key: string, action: string, run: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${userId}:${key}`]);
  const existing = await client.query<{ action: string; plan_id: string; response_json: T | null }>('SELECT action, plan_id, response_json FROM plan_action_requests WHERE owner_id = $1 AND idempotency_key = $2', [userId, key]);
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (row.action !== action || row.plan_id !== planId || row.response_json === null) throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used.');
    return row.response_json;
  }
  await client.query('INSERT INTO plan_action_requests (owner_id, idempotency_key, action, plan_id) VALUES ($1,$2,$3,$4)', [userId, key, action, planId]);
  const response = await run();
  await client.query('UPDATE plan_action_requests SET response_json = $3::jsonb WHERE owner_id = $1 AND idempotency_key = $2', [userId, key, JSON.stringify(response)]);
  return response;
}

async function completedAction<T>(userId: string, planId: string, key: string, action: string): Promise<T | null> {
  const existing = await db.query<{ action: string; plan_id: string; response_json: T | null }>(
    'SELECT action, plan_id, response_json FROM plan_action_requests WHERE owner_id = $1 AND idempotency_key = $2', [userId, key]);
  if (!existing.rowCount) return null;
  const row = existing.rows[0];
  if (row.action !== action || row.plan_id !== planId || row.response_json === null) {
    throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used.');
  }
  return row.response_json;
}

export async function listPlans(userId: string, fundId: string) {
  const result = await db.query<PlanRow>(`SELECT p.*, m.slippage_bps, m.fee_bps FROM dca_plans p JOIN funds f ON f.id = p.fund_id
    LEFT JOIN plan_mandates m ON m.id = p.active_mandate_id WHERE p.owner_id = $1 AND p.fund_id = $2 AND f.owner_id = $1 ORDER BY p.created_at DESC`, [userId, fundId]);
  return { plans: result.rows.map(mapPlan) };
}

export async function listPlanOccurrences(userId: string, planId: string) {
  const owned = await db.query('SELECT 1 FROM dca_plans WHERE id = $1 AND owner_id = $2', [planId, userId]);
  if (!owned.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Plan not found.');
  const result = await db.query<{
    occurrence_id: string; scheduled_for: Date; occurrence_status: string; occurrence_created_at: Date; occurrence_updated_at: Date;
    attempt_id: string | null; attempt_number: number | null; signer_provider: 'turnkey' | 'moonpay' | null; gross_amount_atomic: string | null; confirmed_gross_atomic: string | null; attempt_fee_atomic: string | null; attempt_status: string | null;
    leg_id: string | null; leg_index: number | null; asset_id: string | null; variant_id: string | null; output_mint: string | null; leg_gross_amount_atomic: string | null; filled_input_atomic: string | null; filled_output_atomic: string | null; leg_fee_atomic: string | null; signature: string | null; leg_status: string | null; truncated: boolean;
  }>(`WITH ranked_occurrences AS (
    SELECT *, row_number() OVER (ORDER BY scheduled_for DESC, id) AS position FROM purchase_occurrences WHERE plan_id = $1
  )
    SELECT o.id AS occurrence_id, o.scheduled_for, o.status AS occurrence_status, o.created_at AS occurrence_created_at, o.updated_at AS occurrence_updated_at,
    a.id AS attempt_id, a.attempt_number, a.signer_provider, a.gross_amount_atomic, a.confirmed_gross_atomic, a.fee_atomic AS attempt_fee_atomic, a.status AS attempt_status,
    l.id AS leg_id, l.leg_index, l.asset_id, l.variant_id, l.output_mint, l.gross_amount_atomic AS leg_gross_amount_atomic,
    l.filled_input_atomic, l.filled_output_atomic, l.fee_atomic AS leg_fee_atomic, l.signature, l.status AS leg_status,
    EXISTS (SELECT 1 FROM ranked_occurrences WHERE position > 100) AS truncated
    FROM ranked_occurrences o LEFT JOIN purchase_attempts a ON a.occurrence_id = o.id LEFT JOIN purchase_legs l ON l.attempt_id = a.id
    WHERE o.position <= 100 ORDER BY o.scheduled_for DESC, a.attempt_number, l.leg_index`, [planId]);
  const occurrences = new Map<string, any>();
  for (const row of result.rows) {
    let occurrence = occurrences.get(row.occurrence_id);
    if (!occurrence) {
      occurrence = { id: row.occurrence_id, planId, scheduledFor: row.scheduled_for.toISOString(), status: row.occurrence_status, attempts: [], createdAt: row.occurrence_created_at.toISOString(), updatedAt: row.occurrence_updated_at.toISOString() };
      occurrences.set(row.occurrence_id, occurrence);
    }
    if (!row.attempt_id) continue;
    let attempt = occurrence.attempts.find((item: { id: string }) => item.id === row.attempt_id);
    if (!attempt) {
      attempt = { id: row.attempt_id, number: row.attempt_number, provider: row.signer_provider, grossAmountAtomic: String(row.gross_amount_atomic), confirmedGrossAtomic: String(row.confirmed_gross_atomic), feeAtomic: String(row.attempt_fee_atomic), status: row.attempt_status, legs: [] };
      occurrence.attempts.push(attempt);
    }
    if (row.leg_id) attempt.legs.push({ id: row.leg_id, index: row.leg_index, assetId: row.asset_id, variantId: row.variant_id, outputMint: row.output_mint, grossAmountAtomic: String(row.leg_gross_amount_atomic), filledInputAtomic: row.filled_input_atomic === null ? null : String(row.filled_input_atomic), filledOutputAtomic: row.filled_output_atomic === null ? null : String(row.filled_output_atomic), feeAtomic: row.leg_fee_atomic === null ? null : String(row.leg_fee_atomic), signature: row.signature, status: row.leg_status });
  }
  return { occurrences: [...occurrences.values()], truncated: result.rows[0]?.truncated ?? false };
}

export async function getPlanAuthorization(userId: string, planId: string) {
  const result = await db.query<{ delegated_user_id: string | null; policy_ids: unknown; policy_fingerprint: string | null }>(`SELECT sa.delegated_user_id, sa.policy_ids, sa.policy_fingerprint
    FROM dca_plans p
    LEFT JOIN LATERAL (SELECT * FROM signer_authorizations candidate WHERE candidate.plan_id = p.id AND candidate.status IN ('pending','active') ORDER BY candidate.authorized_at DESC LIMIT 1) sa ON true
    WHERE p.id = $1 AND p.owner_id = $2`, [planId, userId]);
  if (!result.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Plan not found.');
  const value = result.rows[0];
  const policyIds = Array.isArray(value.policy_ids) ? value.policy_ids.filter((item): item is string => typeof item === 'string') : [];
  return { delegatedUserId: value.delegated_user_id, policyIds, policyFingerprint: value.policy_fingerprint ?? null };
}

export async function createPlan(userId: string, fundId: string, input: PlanInput) {
  const result = await db.query<PlanRow>(`INSERT INTO dca_plans (owner_id, fund_id, amount_atomic, cadence, local_time, timezone, weekday)
    SELECT $1, id, $3::bigint, $4, $5::time, $6, $7::smallint FROM funds WHERE id = $2 AND owner_id = $1 RETURNING *`,
  [userId, fundId, input.amountAtomic, input.cadence, input.localTime, input.timezone, input.weekday]);
  if (!result.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Fund not found.');
  return mapPlan(result.rows[0]);
}

export async function updatePlan(userId: string, planId: string, input: PlanInput & { expectedRevision: number }) {
  await prepareAuthorizationCleanup(userId, { planId });
  const result = await db.query<PlanRow>(`WITH signing_fence AS (SELECT pg_advisory_xact_lock(hashtext('recurring-sign:' || ($1::uuid)::text)))
    UPDATE dca_plans SET amount_atomic = $3::bigint, cadence = $4, local_time = $5::time, timezone = $6, weekday = $7::smallint,
    status = CASE WHEN status IN ('active','paused') THEN 'approval_required' ELSE status END, active_mandate_id = CASE WHEN status IN ('active','paused') THEN NULL ELSE active_mandate_id END,
    next_run_at = NULL, pause_reason = CASE WHEN status IN ('active','paused') THEN 'Plan terms changed and need approval.' ELSE pause_reason END,
    pause_code = CASE WHEN status IN ('active','paused') THEN 'terms_changed' ELSE pause_code END, revision = revision + 1, updated_at = now()
    FROM signing_fence WHERE id = $1 AND owner_id = $2 AND status <> 'cancelled' AND revision = $8 RETURNING dca_plans.*`,
  [planId, userId, input.amountAtomic, input.cadence, input.localTime, input.timezone, input.weekday, input.expectedRevision]);
  if (!result.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or is unavailable. Refresh and try again.');
  return mapPlan(result.rows[0]);
}

export async function preparePlan(userId: string, planId: string, expectedRevision: number, idempotencyKey: string) {
  requireActivationAvailable(userId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const response = await idempotent(client, userId, planId, idempotencyKey, 'prepare', async () => {
      const planResult = await client.query<PlanRow & { fund_version: number }>(`SELECT p.*, f.version AS fund_version FROM dca_plans p JOIN funds f ON f.id = p.fund_id
        WHERE p.id = $1 AND p.owner_id = $2 AND p.revision = $3 AND p.status IN ('draft','approval_required','paused') FOR UPDATE`, [planId, userId, expectedRevision]);
      if (!planResult.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or cannot be prepared. Refresh and try again.');
      const plan = planResult.rows[0];
      if (BigInt(plan.amount_atomic) > config.recurringMaxOccurrenceAtomic) throw new ApiFailure(422, 'VALIDATION', 'This amount exceeds the controlled-launch limit.');
      const assets = await client.query<{ asset_id: string; variant_id: string; weight_bps: number }>('SELECT asset_id, variant_id, weight_bps FROM fund_assets WHERE fund_id = $1 ORDER BY asset_id, variant_id', [plan.fund_id]);
      const basket = assets.rows.map(row => {
        const selected = findSelection(row.asset_id, row.variant_id);
        if (!selected) throw new ApiFailure(409, 'ASSET_UNAVAILABLE', 'A basket asset is no longer available.');
        return { assetId: row.asset_id, variantId: row.variant_id, weightBps: row.weight_bps, mint: selected.mint };
      });
      if (!basket.length) throw new ApiFailure(409, 'VALIDATION', 'Add at least one asset before enabling recurring buys.');
      const allocations = allocateAtomic(BigInt(plan.amount_atomic), basket);
      if (allocations.some(allocation => allocation.amountAtomic === 0n)) {
        throw new ApiFailure(422, 'VALIDATION', 'The amount is too small to buy every asset in this fund.');
      }
      const mandateResult = await client.query<MandateRow>(`INSERT INTO plan_mandates
        (plan_id, owner_id, plan_revision, fund_version, basket_json, amount_atomic, cadence, local_time, timezone, weekday, fee_bps, slippage_bps, terms_version)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::bigint,$7,$8::time,$9,$10::smallint,$11,$12,$13)
        ON CONFLICT (plan_id, plan_revision) DO UPDATE SET basket_json = EXCLUDED.basket_json RETURNING *`,
      [plan.id, userId, plan.revision, plan.fund_version, JSON.stringify(basket), plan.amount_atomic, plan.cadence, plan.local_time, plan.timezone, plan.weekday, FEE_BPS, config.recurringDefaultSlippageBps, TERMS_VERSION]);
      const updated = await client.query<PlanRow>(`UPDATE dca_plans SET status = 'approval_required', active_mandate_id = $3, next_run_at = NULL, pause_reason = 'Approve restricted Turnkey access to activate.', pause_code = 'approval_required', updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING *`, [planId, userId, mandateResult.rows[0].id]);
      return { plan: mapPlan({ ...updated.rows[0], fee_bps: FEE_BPS, slippage_bps: config.recurringDefaultSlippageBps }), mandate: mapMandate(mandateResult.rows[0]) };
    });
    await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function verifyDelegatedAccess(organizationId: string, delegatedUserId: string, policyIds: string[], policyFingerprint: string, mandate: RecurringMandatePolicyInput) {
  if (!config.jupiterFeeAccount) throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'The recurring-buy fee account is not configured.');
  const api = new Turnkey({ apiBaseUrl: 'https://api.turnkey.com', apiPrivateKey: config.turnkeyApiPrivateKey, apiPublicKey: config.turnkeyApiPublicKey, defaultOrganizationId: organizationId }).apiClient();
  const [user, policies] = await vendorCall('turnkey-policy-verification', () => Promise.all([
    api.getUser({ organizationId, userId: delegatedUserId }), api.getPolicies({ organizationId })
  ]), { timeoutMs: 8_000, retries: 1 });
  if (!user.user.apiKeys.some(key => key.credential.publicKey.toLowerCase() === config.turnkeyApiPublicKey.toLowerCase())) throw new ApiFailure(403, 'FORBIDDEN', 'The delegated Turnkey key does not match OhMyFund.');
  const expectedFingerprint = await recurringMandateFingerprint(mandate);
  if (policyFingerprint !== expectedFingerprint) throw new ApiFailure(403, 'FORBIDDEN', 'The recurring-buy policy fingerprint does not match this mandate.');
  const expected = turnkeyMandatePolicy(mandate, delegatedUserId, expectedFingerprint);
  const matching = policies.policies.find(policy => policyIds.includes(policy.policyId) && policy.effect === expected.effect && policy.consensus === expected.consensus && policy.condition === expected.condition && policy.notes === expected.notes);
  if (!matching) throw new ApiFailure(403, 'FORBIDDEN', 'The restricted recurring-buy policy could not be verified.');
}

export async function createAuthorizationIntent(userId: string, organizationId: string, planId: string, input: { expectedRevision: number; delegatedUserId: string }, idempotencyKey: string) {
  requireActivationAvailable(userId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const response = await idempotent(client, userId, planId, idempotencyKey, 'authorization-intent', async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`active-plan:${userId}`]);
      const plan = await client.query<{ wallet_id: string; mandate_id: string }>(`SELECT w.id AS wallet_id, p.active_mandate_id AS mandate_id FROM dca_plans p JOIN wallets w ON w.owner_id = p.owner_id
        WHERE p.id = $1 AND p.owner_id = $2 AND p.revision = $3 AND p.status = 'approval_required'
          AND w.provider = 'turnkey' AND w.provider_organization_id = $4 AND w.status = 'active' FOR UPDATE OF p`,
      [planId, userId, input.expectedRevision, organizationId]);
      if (!plan.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or cannot start authorization.');
      const setup = await client.query("SELECT 1 FROM mandate_setup_attempts WHERE mandate_id = $1 AND status = 'confirmed' LIMIT 1", [plan.rows[0].mandate_id]);
      if (!setup.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Complete the one-time token-account setup before approving recurring buys.');
      const other = await client.query("SELECT 1 FROM signer_authorizations WHERE wallet_id = $1 AND plan_id <> $2 AND status IN ('pending','active')", [plan.rows[0].wallet_id, planId]);
      if (other.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Another recurring plan still has Turnkey authorization. Cancel it first.');
      const existing = await client.query<{ id: string; policy_ids: unknown; mandate_id: string | null; sponsor_policy_status: string | null }>("SELECT id, policy_ids, mandate_id, sponsor_policy_status FROM signer_authorizations WHERE plan_id = $1 AND status IN ('pending','active') FOR UPDATE", [planId]);
      if (existing.rowCount) {
        const oldPolicyIds = Array.isArray(existing.rows[0].policy_ids) ? existing.rows[0].policy_ids.filter((item): item is string => typeof item === 'string') : [];
        if (oldPolicyIds.length || existing.rows[0].mandate_id) {
          const api = new Turnkey({ apiBaseUrl: 'https://api.turnkey.com', apiPrivateKey: config.turnkeyApiPrivateKey, apiPublicKey: config.turnkeyApiPublicKey, defaultOrganizationId: organizationId }).apiClient();
          const policies = await vendorCall('turnkey-policy-replacement-check', () => api.getPolicies({ organizationId }), { timeoutMs: 8_000, retries: 1 });
          if (policies.policies.some(policy => oldPolicyIds.includes(policy.policyId) || (existing.rows[0].mandate_id && policy.notes?.startsWith(`OhMyFund user mandate ${existing.rows[0].mandate_id}; fingerprint `)))) {
            throw new ApiFailure(409, 'CONFLICT', 'Revoke the previous Turnkey recurring-buy policy before approving changed terms.');
          }
        }
        if (existing.rows[0].sponsor_policy_status && existing.rows[0].sponsor_policy_status !== 'revoked') {
          throw new ApiFailure(409, 'CONFLICT', 'Sponsor policy cleanup must finish before changed terms can be approved.');
        }
        await client.query("UPDATE signer_authorizations SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = $1", [existing.rows[0].id]);
      }
      await client.query(`INSERT INTO signer_authorizations (wallet_id, plan_id, mandate_id, provider, delegated_user_id, policy_ids, status, sponsor_policy_status)
        VALUES ($1,$2,$3,'turnkey',$4,'[]'::jsonb,'pending','pending')`, [plan.rows[0].wallet_id, planId, plan.rows[0].mandate_id, input.delegatedUserId]);
      return { delegatedUserId: input.delegatedUserId, policyIds: [] as string[], policyFingerprint: null };
    });
    await client.query('COMMIT');
    const mandate = await mandatePolicyInput(userId, planId);
    const policyFingerprint = await recurringMandateFingerprint(mandate);
    return { ...response, mandatePolicyInput: mandate, policyFingerprint, policyVersion: 'recurring-mandate-v2' as const,
      policy: turnkeyMandatePolicy(mandate, response.delegatedUserId, policyFingerprint) };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function authorizePlan(userId: string, organizationId: string, planId: string, input: { expectedRevision: number; delegatedUserId: string; policyIds: string[]; policyFingerprint: string }, idempotencyKey: string) {
  requireActivationAvailable(userId);
  const replay = await completedAction<ReturnType<typeof mapPlan>>(userId, planId, idempotencyKey, 'authorize');
  if (replay) return replay;
  const mandate = await mandatePolicyInput(userId, planId);
  const proposed = await db.query<{ id: string; solana_address: string }>(`UPDATE signer_authorizations sa
    SET policy_ids = $6::jsonb, policy_fingerprint = $7, updated_at = now()
    FROM wallets w, dca_plans p
    WHERE sa.wallet_id = w.id AND sa.plan_id = p.id AND p.id = $1 AND p.owner_id = $2
      AND p.active_mandate_id = sa.mandate_id AND w.owner_id = $2 AND w.provider = 'turnkey'
      AND w.provider_organization_id = $4 AND w.status = 'active' AND sa.delegated_user_id = $5
      AND ((p.revision = $3 AND sa.status = 'pending') OR
        (p.revision = $3 + 1 AND p.status = 'active' AND sa.status = 'active' AND sa.policy_ids = $6::jsonb AND sa.policy_fingerprint = $7))
    RETURNING w.id, w.solana_address`,
  [planId, userId, input.expectedRevision, organizationId, input.delegatedUserId, JSON.stringify(input.policyIds), input.policyFingerprint]);
  if (!proposed.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Authorization intent is missing or changed. Restart activation.');
  if (proposed.rows[0].solana_address !== mandate.walletAddress) throw new ApiFailure(409, 'CONFLICT', 'The mandate wallet changed during authorization.');
  await verifyDelegatedAccess(organizationId, input.delegatedUserId, input.policyIds, input.policyFingerprint, mandate);
  await ensureSponsorAuthorization(planId, mandate.mandateId, input.policyFingerprint);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const response = await idempotent(client, userId, planId, idempotencyKey, 'authorize', async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`active-plan:${userId}`]);
      const active = await client.query(`SELECT 1 FROM dca_plans p LEFT JOIN signer_authorizations sa ON sa.plan_id = p.id AND sa.status = 'active'
        WHERE p.owner_id = $1 AND p.id <> $2 AND (p.status IN ('active','paused') OR sa.id IS NOT NULL)`, [userId, planId]);
      if (active.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Only one active or paused recurring plan per wallet is allowed during the controlled launch.');
      const current = await client.query<PlanRow>('SELECT * FROM dca_plans WHERE id = $1 AND owner_id = $2 AND revision = $3 AND status = $4 FOR UPDATE', [planId, userId, input.expectedRevision, 'approval_required']);
      if (!current.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or authorization is no longer current.');
      const setup = await client.query("SELECT 1 FROM mandate_setup_attempts WHERE mandate_id = (SELECT active_mandate_id FROM dca_plans WHERE id = $1) AND status = 'confirmed' LIMIT 1", [planId]);
      if (!setup.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Complete the one-time token-account setup before activating recurring buys.');
      const runAt = nextRunAt({ cadence: current.rows[0].cadence, localTime: current.rows[0].local_time.slice(0, 5), timezone: current.rows[0].timezone, weekday: current.rows[0].weekday }, new Date());
      const result = await client.query<PlanRow & { mandate_id: string }>(`UPDATE dca_plans p SET status = 'active', active_wallet_id = $5, pause_reason = NULL, pause_code = NULL, next_run_at = $4, revision = revision + 1, updated_at = now()
        FROM plan_mandates m WHERE p.id = $1 AND p.owner_id = $2 AND p.revision = $3 AND m.id = p.active_mandate_id AND m.plan_revision = p.revision RETURNING p.*, m.id AS mandate_id`,
      [planId, userId, input.expectedRevision, runAt, proposed.rows[0].id]);
      if (!result.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or authorization is no longer current.');
      await client.query('UPDATE plan_mandates SET authorized_at = now() WHERE id = $1', [result.rows[0].mandate_id]);
      const authorization = await client.query(`UPDATE signer_authorizations SET status = 'active', policy_ids = $4::jsonb, policy_fingerprint = $5,
        authorized_at = now(), updated_at = now() WHERE wallet_id = $1 AND plan_id = $2 AND mandate_id = $6 AND delegated_user_id = $3
        AND status = 'pending' AND sponsor_policy_status = 'active' AND sponsor_policy_fingerprint = $5`,
      [proposed.rows[0].id, planId, input.delegatedUserId, JSON.stringify(input.policyIds), input.policyFingerprint, result.rows[0].mandate_id]);
      if (!authorization.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Authorization intent is missing or changed. Restart activation.');
      await client.query('UPDATE users SET recurring_authorized_at = now(), recurring_delegated_user_id = $2 WHERE id = $1', [userId, input.delegatedUserId]);
      return mapPlan({ ...result.rows[0], fee_bps: FEE_BPS, slippage_bps: config.recurringDefaultSlippageBps });
    });
    await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function pausePlan(userId: string, planId: string, expectedRevision: number, idempotencyKey: string) {
  return transition(userId, planId, expectedRevision, idempotencyKey, 'pause', ['active'], 'paused', 'Paused by user.', 'user', null);
}

export async function resumePlan(userId: string, planId: string, expectedRevision: number, idempotencyKey: string) {
  requireActivationAvailable(userId);
  const result = await db.query<PlanRow>('SELECT * FROM dca_plans WHERE id = $1 AND owner_id = $2 AND revision = $3 AND status = $4', [planId, userId, expectedRevision, 'paused']);
  if (!result.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or cannot resume.');
  const plan = result.rows[0];
  const runAt = nextRunAt({ cadence: plan.cadence, localTime: plan.local_time.slice(0, 5), timezone: plan.timezone, weekday: plan.weekday }, new Date());
  return transition(userId, planId, expectedRevision, idempotencyKey, 'resume', ['paused'], 'active', null, null, runAt, 'user');
}

export async function cancelPlan(userId: string, planId: string, expectedRevision?: number, idempotencyKey?: string) {
  if (expectedRevision === undefined || !idempotencyKey) {
    const result = await db.query<PlanRow>(`UPDATE dca_plans SET status = 'cancelled', next_run_at = NULL, revision = revision + 1, updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND status = 'draft' RETURNING *`, [planId, userId]);
    if (!result.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan is already cancelled or unavailable.');
    return mapPlan(result.rows[0]);
  }
  await prepareAuthorizationCleanup(userId, { planId });
  return transition(userId, planId, expectedRevision, idempotencyKey, 'cancel', ['draft', 'approval_required', 'active', 'paused'], 'cancelled', null, null, null);
}

async function transition(userId: string, planId: string, revision: number, key: string, action: string, from: PlanStatus[], to: PlanStatus, reason: string | null, pauseCode: PauseCode | null, next: Date | null, requiredPauseCode: PauseCode | null = null, beforeUpdate?: (client: pg.PoolClient) => Promise<void>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const response = await idempotent(client, userId, planId, key, action, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recurring-sign:${planId}`]);
      if (beforeUpdate) await beforeUpdate(client);
      if (to === 'active') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`active-plan:${userId}`]);
        const active = await client.query("SELECT 1 FROM dca_plans WHERE owner_id = $1 AND status IN ('active','paused') AND id <> $2", [userId, planId]);
        if (active.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Only one active or paused recurring plan per wallet is allowed during the controlled launch.');
      }
      const result = await client.query<PlanRow>(`UPDATE dca_plans SET status = $4, pause_reason = $5, pause_code = $6, next_run_at = $7, revision = revision + 1, updated_at = now()
        WHERE id = $1 AND owner_id = $2 AND revision = $3 AND status = ANY($8::text[]) AND ($9::text IS NULL OR pause_code = $9) RETURNING *`, [planId, userId, revision, to, reason, pauseCode, next, from, requiredPauseCode]);
      if (!result.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Plan changed or cannot make that change. Refresh and try again.');
      if (to === 'cancelled') {
        await client.query(`UPDATE signer_authorizations SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE plan_id = $1 AND status IN ('pending','active')`, [planId]);
      }
      return mapPlan(result.rows[0]);
    });
    await client.query('COMMIT'); return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export function recurringConfiguration(userId: string) {
  const configured = Boolean(config.jupiterApiKey && config.jupiterFeeAccount && config.jupiterFeeAccountAuthority && config.turnkeySponsorOrganizationId && config.turnkeySponsorWalletId &&
    config.turnkeySponsorWalletAddress && config.turnkeySponsorApiPublicKey && config.turnkeySponsorApiPrivateKey && config.turnkeySponsorDelegatedUserId &&
    config.policyProvisionerUrl && config.policyProvisionerSharedSecret && config.turnkeyPolicyProvisionerApiPublicKey &&
    config.turnkeySponsorApiPublicKey.toLowerCase() !== config.turnkeyPolicyProvisionerApiPublicKey.toLowerCase());
  const available = config.recurringBuysAvailable && configured && config.recurringAllowlistUserIds.has(userId);
  return {
    available, executionEnabled: config.executionEnabled, feeBps: FEE_BPS,
    defaultSlippageBps: config.recurringDefaultSlippageBps, delegatedPublicKey: available ? config.turnkeyApiPublicKey : null,
    feeAccount: available ? config.jupiterFeeAccount : null, maxOccurrenceAtomic: config.recurringMaxOccurrenceAtomic.toString(),
    unavailableReason: available ? null : 'Recurring execution is not enabled and fully configured.'
  };
}

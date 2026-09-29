import type pg from 'pg';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { ApiFailure } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { sponsoredCostUsdcAtomic } from '../money.js';
import { fetchJupiterSolPrice } from '../prices/jupiter.js';
import {
  assertSignatureAddedBy, associatedTokenAccount, confirmedSetupAmounts, currentBlockHeight, currentSlot,
  estimateSetupComputeUnits, existingAccounts, latestBlockhash, nativeBalanceLamports, rentExemptionLamports,
  setupTransactionFeeLamports, setupTransactionHex, signatureStatus, submitSignedTransaction,
  tokenAccountBalanceAtomic, tokenAccountSizeForMint, tokenProgramsForMints, transactionIdFromSignedHex,
  transactionMessageFingerprint, type SetupTransactionAccount, type SetupTransactionInput
} from '../solana.js';
import { turnkeySponsorSigner } from '../wallets/turnkey.js';
import { setupExecutionReadiness } from '../readiness.js';
import { nextRunAt } from './schedule.js';

type SetupStatus = 'preparing' | 'awaiting_user_signature' | 'user_signed' | 'submitted' | 'confirming' | 'confirmed' | 'failed' | 'expired' | 'unknown';
type SetupPurpose = 'initial' | 'repair';
type MissingAccount = { mint: string; tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' | 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'; address: string; size: number; rentLamports: string };
type SetupRow = {
  id: string; owner_id: string; plan_id: string; mandate_id: string; wallet_id: string; purpose: SetupPurpose; status: SetupStatus;
  missing_accounts_json: MissingAccount[]; reimbursement_atomic: string; rent_lamports: string; expected_network_fee_lamports: string;
  unsigned_transaction_hex: string | null; user_signed_transaction_hex: string | null; fully_signed_transaction_hex: string | null;
  transaction_signature: string | null; last_valid_block_height: string | null; quote_expires_at: Date | null;
  submit_idempotency_key: string | null; error_message: string | null;
};
type SetupContext = {
  plan_id: string; revision: number; status: string; pause_code: string | null; mandate_id: string; basket_json: { mint: string }[];
  wallet_id: string; wallet_address: string; organization_id: string;
};

const quote = (row: SetupRow) => ({
  attemptId: row.id, planId: row.plan_id, purpose: row.purpose, status: row.status,
  missingAccounts: row.missing_accounts_json, reimbursementAtomic: String(row.reimbursement_atomic),
  rentLamports: String(row.rent_lamports), networkFeeLamports: String(row.expected_network_fee_lamports),
  expiresAt: row.quote_expires_at?.toISOString() ?? null, unsignedTransactionHex: row.unsigned_transaction_hex
});

const result = (row: SetupRow) => ({
  attemptId: row.id, planId: row.plan_id, purpose: row.purpose, status: row.status,
  missingAccountCount: row.missing_accounts_json.length, reimbursementAtomic: String(row.reimbursement_atomic),
  transactionSignature: row.transaction_signature,
  message: row.error_message ?? (row.status === 'confirmed' ? 'Token accounts are ready.' : row.status === 'unknown' ? 'Confirmation is delayed. OhMyFund is checking the exact transaction.' : null)
});

function assertSetupAvailable(userId: string) {
  if (!config.recurringBuysAvailable || !config.jupiterApiKey || !config.jupiterFeeAccount || !config.turnkeySponsorWalletAddress ||
      !config.turnkeySponsorOrganizationId || !config.turnkeySponsorApiPublicKey || !config.turnkeySponsorApiPrivateKey ||
      !config.recurringAllowlistUserIds.has(userId)) {
    throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Account setup is not enabled yet.');
  }
}

async function context(client: pg.PoolClient, userId: string, planId: string, expectedRevision?: number) {
  const loaded = await client.query<SetupContext>(`SELECT p.id AS plan_id, p.revision, p.status, p.pause_code, p.active_mandate_id AS mandate_id,
    m.basket_json, w.id AS wallet_id, w.solana_address AS wallet_address, w.provider_organization_id AS organization_id
    FROM dca_plans p JOIN plan_mandates m ON m.id = p.active_mandate_id
    JOIN wallets w ON w.owner_id = p.owner_id AND w.provider = 'turnkey' AND w.status = 'active'
    WHERE p.id = $1 AND p.owner_id = $2 AND w.provider = 'turnkey' AND w.status = 'active'`, [planId, userId]);
  if (!loaded.rowCount) throw new ApiFailure(409, 'CONFLICT', 'Prepare the recurring plan before setting up its token accounts.');
  const row = loaded.rows[0];
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new ApiFailure(409, 'CONFLICT', 'This recurring plan changed. Refresh and retry.');
  if (row.status !== 'approval_required' && !(row.status === 'paused' && row.pause_code === 'account_setup_required')) {
    throw new ApiFailure(409, 'CONFLICT', 'This recurring plan does not require account setup.');
  }
  return row;
}

async function nextAttemptNumber(client: pg.PoolClient, mandateId: string) {
  const value = await client.query<{ number: number }>('SELECT COALESCE(max(attempt_number),0)::int + 1 AS number FROM mandate_setup_attempts WHERE mandate_id = $1', [mandateId]);
  return value.rows[0].number;
}

async function resumeRepairPlan(client: pg.PoolClient, row: Pick<SetupRow, 'purpose' | 'plan_id' | 'mandate_id'>) {
  if (row.purpose !== 'repair') return;
  const schedule = await client.query<{ cadence: 'daily' | 'weekly'; local_time: string; timezone: string; weekday: number | null }>('SELECT cadence, local_time::text, timezone, weekday FROM plan_mandates WHERE id = $1', [row.mandate_id]);
  const mandate = schedule.rows[0];
  await client.query(`UPDATE dca_plans SET status = 'active', pause_code = NULL, pause_reason = NULL, next_run_at = $2, revision = revision + 1, updated_at = now()
    WHERE id = $1 AND status = 'paused' AND pause_code = 'account_setup_required'`, [row.plan_id, nextRunAt({ cadence: mandate.cadence, localTime: mandate.local_time.slice(0, 5), timezone: mandate.timezone, weekday: mandate.weekday }, new Date())]);
}

async function expireUserOnlyAttempt(row: SetupRow) {
  if (row.status !== 'awaiting_user_signature' && row.status !== 'user_signed') return row;
  const quoteExpired = Boolean(row.quote_expires_at && row.quote_expires_at.getTime() <= Date.now());
  if (!quoteExpired && (!row.last_valid_block_height || await currentBlockHeight(config.solanaRpcUrl) < Number(row.last_valid_block_height))) return row;
  const expired = await db.query<SetupRow>(`UPDATE mandate_setup_attempts SET status = 'expired', user_signed_transaction_hex = NULL,
    unsigned_transaction_hex = NULL, error_code = 'BLOCKHASH_EXPIRED', error_message = 'The setup approval expired. Review and sign a fresh transaction.', updated_at = now()
    WHERE id = $1 AND status IN ('awaiting_user_signature','user_signed') RETURNING *`, [row.id]);
  await db.query("UPDATE sponsor_fee_reservations SET status = 'released', updated_at = now() WHERE setup_attempt_id = $1 AND status = 'reserved'", [row.id]);
  return expired.rows[0] ?? row;
}

export async function prepareAccountSetup(userId: string, planId: string, expectedRevision: number, idempotencyKey: string) {
  assertSetupAvailable(userId);
  const client = await db.connect();
  const lockKey = `account-setup:${planId}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    const existingKey = await client.query<SetupRow>('SELECT * FROM mandate_setup_attempts WHERE owner_id = $1 AND prepare_idempotency_key = $2', [userId, idempotencyKey]);
    if (existingKey.rowCount) {
      if (existingKey.rows[0].plan_id !== planId) throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'That setup request key was already used.');
      return quote(await expireUserOnlyAttempt(existingKey.rows[0]));
    }
    const setupContext = await context(client, userId, planId, expectedRevision);
    const unresolved = await client.query<SetupRow>(`SELECT * FROM mandate_setup_attempts WHERE mandate_id = $1
      AND status IN ('preparing','awaiting_user_signature','user_signed','submitted','confirming','unknown') ORDER BY attempt_number DESC LIMIT 1`, [setupContext.mandate_id]);
    if (unresolved.rowCount) {
      const current = await expireUserOnlyAttempt(unresolved.rows[0]);
      if (current.status !== 'expired') return quote(current);
    }

    const mints = [...new Set(setupContext.basket_json.map(item => item.mint))];
    const programs = await tokenProgramsForMints(mints, config.solanaRpcUrl);
    const derived = await Promise.all(mints.map(async mint => {
      const tokenProgram = programs.get(mint);
      if (!tokenProgram) throw new Error(`Token mint ${mint} was not checked during setup.`);
      return { mint, tokenProgram: String(tokenProgram) as MissingAccount['tokenProgram'], address: String(await associatedTokenAccount(setupContext.wallet_address, mint, tokenProgram)) };
    }));
    const present = await existingAccounts(derived.map(item => item.address), config.solanaRpcUrl);
    const missing = derived.filter(item => !present.has(item.address));
    const purpose: SetupPurpose = setupContext.status === 'paused' ? 'repair' : 'initial';
    const attemptNumber = await nextAttemptNumber(client, setupContext.mandate_id);
    if (!missing.length) {
      if (purpose === 'initial') {
        const alreadyConfirmed = await client.query<SetupRow>("SELECT * FROM mandate_setup_attempts WHERE mandate_id = $1 AND status = 'confirmed' ORDER BY attempt_number DESC LIMIT 1", [setupContext.mandate_id]);
        if (alreadyConfirmed.rowCount) return quote(alreadyConfirmed.rows[0]);
      }
      await client.query('BEGIN');
      try {
        const inserted = await client.query<SetupRow>(`INSERT INTO mandate_setup_attempts
          (owner_id, plan_id, mandate_id, wallet_id, purpose, attempt_number, status, prepare_idempotency_key)
          VALUES ($1,$2,$3,$4,$5,$6,'confirmed',$7) RETURNING *`,
        [userId, planId, setupContext.mandate_id, setupContext.wallet_id, purpose, attemptNumber, idempotencyKey]);
        await resumeRepairPlan(client, inserted.rows[0]);
        await client.query('COMMIT');
        return quote(inserted.rows[0]);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }

    const rentBySize = new Map<number, bigint>();
    const missingAccounts: MissingAccount[] = [];
    for (const item of missing) {
      const size = await tokenAccountSizeForMint(item.mint, programs.get(item.mint)!, config.solanaRpcUrl, config.turnkeySponsorWalletAddress!);
      let rent = rentBySize.get(size);
      if (rent === undefined) { rent = await rentExemptionLamports(size, config.solanaRpcUrl); rentBySize.set(size, rent); }
      missingAccounts.push({ ...item, size, rentLamports: rent.toString() });
    }
    const rentLamports = missingAccounts.reduce((sum, item) => sum + BigInt(item.rentLamports), 0n);
    const sourceTokenAccount = String(await associatedTokenAccount(setupContext.wallet_address, config.usdcMint, TOKEN_PROGRAM_ADDRESS));
    const sourceBalance = await tokenAccountBalanceAtomic(sourceTokenAccount, config.solanaRpcUrl);
    if (sourceBalance.decimals !== 6) throw new Error('The configured USDC source account has unexpected decimals.');
    const blockhash = await latestBlockhash(config.solanaRpcUrl);
    const setupAccounts: SetupTransactionAccount[] = missingAccounts.map(item => ({ account: item.address, owner: setupContext.wallet_address, mint: item.mint, tokenProgram: item.tokenProgram }));
    const base: SetupTransactionInput = {
      sponsor: config.turnkeySponsorWalletAddress!, user: setupContext.wallet_address, sourceTokenAccount,
      usdcMint: config.usdcMint, feeTokenAccount: config.jupiterFeeAccount!, reimbursementAtomic: 1n,
      accounts: setupAccounts, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight,
      computeUnits: 1_400_000, computeUnitPriceMicroLamports: config.setupComputeUnitPriceMicroLamports
    };
    const computeUnits = await estimateSetupComputeUnits(base, config.solanaRpcUrl);
    const priced = { ...base, computeUnits };
    const networkFeeLamports = await setupTransactionFeeLamports(priced, config.solanaRpcUrl);
    const price = await fetchJupiterSolPrice(config.jupiterApiKey!, await currentSlot(config.solanaRpcUrl), config.recurringSolPriceMaximumAgeSlots);
    const reimbursementAtomic = sponsoredCostUsdcAtomic(networkFeeLamports, rentLamports, price.solPriceAtomicPerSol);
    if (reimbursementAtomic <= 0n || reimbursementAtomic > config.setupMaxReimbursementAtomic) throw new ApiFailure(422, 'VALIDATION', 'The token-account setup cost exceeds the configured limit.');
    if (networkFeeLamports + rentLamports > config.setupMaxSponsoredLamportsPerTransaction) throw new ApiFailure(422, 'VALIDATION', 'The token-account setup exceeds the sponsor safety limit.');
    if (sourceBalance.amountAtomic < reimbursementAtomic) throw new ApiFailure(422, 'VALIDATION', `Deposit at least ${reimbursementAtomic.toString()} atomic USDC units to pay the one-time account setup cost.`);
    const finalInput = { ...priced, reimbursementAtomic };
    await estimateSetupComputeUnits(finalInput, config.solanaRpcUrl);
    const unsignedTransactionHex = setupTransactionHex(finalInput);
    const inserted = await client.query<SetupRow>(`INSERT INTO mandate_setup_attempts
      (owner_id, plan_id, mandate_id, wallet_id, purpose, attempt_number, status, prepare_idempotency_key, missing_accounts_json,
       sol_price_atomic_per_sol, sol_price_block_id, expected_network_fee_lamports, rent_lamports, reimbursement_atomic,
       unsigned_transaction_hex, message_fingerprint, last_valid_block_height, quote_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'awaiting_user_signature',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now() + interval '60 seconds') RETURNING *`,
    [userId, planId, setupContext.mandate_id, setupContext.wallet_id, purpose, attemptNumber, idempotencyKey, JSON.stringify(missingAccounts),
      price.solPriceAtomicPerSol.toString(), price.blockId, networkFeeLamports.toString(), rentLamports.toString(), reimbursementAtomic.toString(),
      unsignedTransactionHex, transactionMessageFingerprint(unsignedTransactionHex), blockhash.lastValidBlockHeight]);
    return quote(inserted.rows[0]);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

async function reserveSetupSponsorCost(row: SetupRow) {
  const cost = BigInt(row.rent_lamports) + BigInt(row.expected_network_fee_lamports);
  const sponsorBalance = await nativeBalanceLamports(config.turnkeySponsorWalletAddress!, config.solanaRpcUrl);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sponsor-fee-budget'))");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sponsor-fee-user:${row.owner_id}`]);
    const existing = await client.query('SELECT 1 FROM sponsor_fee_reservations WHERE setup_attempt_id = $1', [row.id]);
    if (existing.rowCount) { await client.query('COMMIT'); return; }
    const totals = await client.query<{ user_lamports: string; global_lamports: string; active_lamports: string }>(`SELECT
      COALESCE(sum(CASE WHEN setup_attempt_id IS NOT NULL AND owner_id = $1 AND created_at > now() - interval '24 hours' AND status IN ('reserved','submitted','confirmed','failed','unknown') THEN COALESCE(final_lamports,reserved_lamports) ELSE 0 END),0)::text AS user_lamports,
      COALESCE(sum(CASE WHEN setup_attempt_id IS NOT NULL AND created_at > now() - interval '24 hours' AND status IN ('reserved','submitted','confirmed','failed','unknown') THEN COALESCE(final_lamports,reserved_lamports) ELSE 0 END),0)::text AS global_lamports,
      COALESCE(sum(CASE WHEN status IN ('reserved','submitted','unknown') THEN reserved_lamports ELSE 0 END),0)::text AS active_lamports
      FROM sponsor_fee_reservations`, [row.owner_id]);
    const sums = totals.rows[0];
    if (BigInt(sums.user_lamports) + cost > config.setupMaxSponsoredLamportsPerUserDaily) throw new Error('The account-setup sponsor limit for this user was reached.');
    if (BigInt(sums.global_lamports) + cost > config.setupMaxSponsoredLamportsGlobalDaily) throw new Error('The global account-setup sponsor limit was reached.');
    if (sponsorBalance - BigInt(sums.active_lamports) - cost < config.recurringSponsorMinimumBalanceLamports) throw new Error('The sponsor wallet balance is below its safety minimum.');
    await client.query(`INSERT INTO sponsor_fee_reservations (owner_id, setup_attempt_id, reserved_lamports)
      VALUES ($1,$2,$3)`, [row.owner_id, row.id, cost.toString()]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function submitAccountSetup(userId: string, planId: string, input: { expectedRevision: number; attemptId: string; userSignedTransactionHex: string }, idempotencyKey: string) {
  assertSetupAvailable(userId);
  const client = await db.connect();
  const lockKey = `account-setup:${input.attemptId}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    const setupContext = await context(client, userId, planId, input.expectedRevision);
    const reusedKey = await client.query<SetupRow>('SELECT * FROM mandate_setup_attempts WHERE owner_id = $1 AND submit_idempotency_key = $2', [userId, idempotencyKey]);
    if (reusedKey.rowCount && reusedKey.rows[0].id !== input.attemptId) {
      throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'That setup submission key was already used.');
    }
    const loaded = await client.query<SetupRow>('SELECT * FROM mandate_setup_attempts WHERE id = $1 AND owner_id = $2 AND plan_id = $3 AND mandate_id = $4', [input.attemptId, userId, planId, setupContext.mandate_id]);
    if (!loaded.rowCount) throw new ApiFailure(404, 'NOT_FOUND', 'The account-setup attempt was not found.');
    let row = loaded.rows[0];
    if (row.status === 'confirmed' || row.status === 'submitted' || row.status === 'confirming' || row.status === 'unknown') return result(row);
    if (row.status === 'failed' || row.status === 'expired' || !row.unsigned_transaction_hex || !row.last_valid_block_height) throw new ApiFailure(409, 'CONFLICT', 'Prepare a fresh account-setup approval.');
    if (row.user_signed_transaction_hex && row.user_signed_transaction_hex !== input.userSignedTransactionHex) throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'This setup attempt already has a different user signature.');
    assertSignatureAddedBy(row.unsigned_transaction_hex, input.userSignedTransactionHex, setupContext.wallet_address);
    if ((row.quote_expires_at && row.quote_expires_at.getTime() <= Date.now()) || await currentBlockHeight(config.solanaRpcUrl) >= Number(row.last_valid_block_height)) {
      await client.query("UPDATE mandate_setup_attempts SET status = 'expired', unsigned_transaction_hex = NULL, error_code = 'BLOCKHASH_EXPIRED', error_message = 'The setup approval expired. Review and sign a fresh transaction.', updated_at = now() WHERE id = $1", [row.id]);
      throw new ApiFailure(409, 'CONFLICT', 'The setup approval expired. Review and sign a fresh transaction.');
    }
    const persisted = await client.query<SetupRow>(`UPDATE mandate_setup_attempts SET status = 'user_signed', submit_idempotency_key = COALESCE(submit_idempotency_key,$2),
      user_signed_transaction_hex = $3, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, idempotencyKey, input.userSignedTransactionHex]);
    row = persisted.rows[0];
    if (!config.setupExecutionEnabled) return result(row);
    const readiness = await setupExecutionReadiness();
    if (!readiness.ok) throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Account-setup sponsorship is not ready.');
    await reserveSetupSponsorCost(row);
    const sponsor = turnkeySponsorSigner();
    let sponsorSigned: string;
    try {
      sponsorSigned = (await sponsor.signer.signSolanaTransaction({ organizationId: sponsor.organizationId, address: sponsor.address, unsignedTransactionHex: input.userSignedTransactionHex })).signedTransactionHex;
      assertSignatureAddedBy(input.userSignedTransactionHex, sponsorSigned, sponsor.address);
    } catch (error) {
      await client.query("UPDATE mandate_setup_attempts SET error_code = 'SPONSOR_SIGNING_FAILED', error_message = $2, updated_at = now() WHERE id = $1", [row.id, error instanceof Error ? error.message.slice(0, 240) : 'Sponsor signing failed.']);
      await client.query("UPDATE sponsor_fee_reservations SET status = 'released', updated_at = now() WHERE setup_attempt_id = $1 AND status = 'reserved'", [row.id]);
      throw error;
    }
    const transactionSignature = transactionIdFromSignedHex(sponsorSigned);
    const signed = await client.query<SetupRow>(`UPDATE mandate_setup_attempts SET status = 'submitted', fully_signed_transaction_hex = $2,
      transaction_signature = $3, error_code = NULL, error_message = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, sponsorSigned, transactionSignature]);
    await client.query("UPDATE sponsor_fee_reservations SET status = 'submitted', transaction_signature = $2, updated_at = now() WHERE setup_attempt_id = $1", [row.id, transactionSignature]);
    try {
      const submitted = await submitSignedTransaction(sponsorSigned, config.solanaRpcUrl);
      if (submitted !== transactionSignature) throw new Error('Solana returned an unexpected setup transaction signature.');
      row = (await client.query<SetupRow>("UPDATE mandate_setup_attempts SET status = 'confirming', updated_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
    } catch {
      row = (await client.query<SetupRow>("UPDATE mandate_setup_attempts SET status = 'unknown', error_code = 'SUBMISSION_UNKNOWN', error_message = 'Submission is uncertain. OhMyFund will reconcile this exact transaction.', updated_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
      await client.query("UPDATE sponsor_fee_reservations SET status = 'unknown', updated_at = now() WHERE setup_attempt_id = $1", [row.id]);
    }
    return result(row ?? signed.rows[0]);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}

export async function reconcileSetupAttempt(attemptId: string) {
  const loaded = await db.query<SetupRow>('SELECT * FROM mandate_setup_attempts WHERE id = $1', [attemptId]);
  if (!loaded.rowCount) return null;
  let row = loaded.rows[0];
  if (row.status === 'awaiting_user_signature' || row.status === 'user_signed') return result(await expireUserOnlyAttempt(row));
  if (!['submitted', 'confirming', 'unknown'].includes(row.status) || !row.transaction_signature || !row.last_valid_block_height) return result(row);
  const chainStatus = await signatureStatus(row.transaction_signature, config.solanaRpcUrl);
  if (!chainStatus) {
    if (await currentBlockHeight(config.solanaRpcUrl) < Number(row.last_valid_block_height)) return result(row);
    row = (await db.query<SetupRow>(`UPDATE mandate_setup_attempts SET status = 'failed', fully_signed_transaction_hex = NULL,
      user_signed_transaction_hex = NULL, unsigned_transaction_hex = NULL, error_code = 'EXPIRED_ABSENT', error_message = 'The setup transaction expired without reaching Solana. Retry setup.', updated_at = now()
      WHERE id = $1 RETURNING *`, [row.id])).rows[0];
    await db.query("UPDATE sponsor_fee_reservations SET status = 'released', updated_at = now() WHERE setup_attempt_id = $1 AND status IN ('reserved','submitted','unknown')", [row.id]);
    return result(row);
  }
  if (chainStatus.err) {
    row = (await db.query<SetupRow>(`UPDATE mandate_setup_attempts SET status = 'failed', fully_signed_transaction_hex = NULL,
      user_signed_transaction_hex = NULL, unsigned_transaction_hex = NULL, error_code = 'ONCHAIN_FAILED', error_message = 'Solana rejected the setup transaction. Retry setup.', updated_at = now()
      WHERE id = $1 RETURNING *`, [row.id])).rows[0];
    await db.query("UPDATE sponsor_fee_reservations SET status = 'failed', final_lamports = $2, updated_at = now() WHERE setup_attempt_id = $1", [row.id, row.expected_network_fee_lamports]);
    return result(row);
  }
  if (chainStatus.confirmationStatus !== 'confirmed' && chainStatus.confirmationStatus !== 'finalized') return result(row);
  const effects = await confirmedSetupAmounts(row.transaction_signature, config.jupiterFeeAccount!, config.usdcMint, config.solanaRpcUrl);
  const present = await existingAccounts(row.missing_accounts_json.map(item => item.address), config.solanaRpcUrl);
  if (!effects || effects.reimbursementAtomic !== BigInt(row.reimbursement_atomic) || present.size !== row.missing_accounts_json.length) {
    row = (await db.query<SetupRow>("UPDATE mandate_setup_attempts SET status = 'unknown', error_code = 'EFFECT_MISMATCH', error_message = 'The confirmed setup effects need review.', updated_at = now() WHERE id = $1 RETURNING *", [row.id])).rows[0];
    return result(row);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    row = (await client.query<SetupRow>(`UPDATE mandate_setup_attempts SET status = 'confirmed', fully_signed_transaction_hex = NULL,
      user_signed_transaction_hex = NULL, unsigned_transaction_hex = NULL, error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`, [row.id])).rows[0];
    await client.query("UPDATE sponsor_fee_reservations SET status = 'confirmed', final_lamports = $2, updated_at = now() WHERE setup_attempt_id = $1", [row.id, (effects.networkFeeLamports + BigInt(row.rent_lamports)).toString()]);
    await resumeRepairPlan(client, row);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return result(row);
}

export async function getAccountSetup(userId: string, planId: string) {
  const loaded = await db.query<SetupRow>('SELECT * FROM mandate_setup_attempts WHERE owner_id = $1 AND plan_id = $2 ORDER BY attempt_number DESC LIMIT 1', [userId, planId]);
  if (!loaded.rowCount) throw new ApiFailure(404, 'NOT_FOUND', 'No account-setup attempt exists for this plan.');
  return reconcileSetupAttempt(loaded.rows[0].id);
}

export async function reconcilePendingSetups(workerId: string, limit = 10) {
  const rows = await db.query<{ id: string }>(`WITH candidates AS (
      SELECT id FROM mandate_setup_attempts WHERE status IN ('submitted','confirming','unknown','user_signed')
        AND (lease_expires_at IS NULL OR lease_expires_at < now()) ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE mandate_setup_attempts a SET lease_owner = $1, lease_expires_at = now() + interval '2 minutes', updated_at = now()
      FROM candidates c WHERE a.id = c.id RETURNING a.id`, [workerId, limit]);
  for (const row of rows.rows) {
    try { await reconcileSetupAttempt(row.id); }
    finally { await db.query('UPDATE mandate_setup_attempts SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_owner = $2', [row.id, workerId]); }
  }
}

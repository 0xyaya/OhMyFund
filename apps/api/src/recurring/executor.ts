import type pg from 'pg';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { db } from '../db.js';
import { config } from '../config.js';
import { allocateAtomic, computeChargeBreakdown, feeAtomic } from '../money.js';
import { fetchJupiterSolPrice } from '../prices/jupiter.js';
import { assertJupiterFallbackPrice, fetchJupiterBuild } from '../swaps/jupiter.js';
import { assertFreshBlockhash, assertRequiredSigners, assertSignatureAddedBy, associatedTokenAccount, confirmedSwapAmounts, currentBlockHeight, currentSlot, estimateComputeUnits, existingAccounts, isJupiterSlippageSimulationError, nativeBalanceLamports, signatureStatus, submitSignedTransaction, tokenProgramsForMints, tokenTransferCheckedInstruction, transactionFeeLamports, transactionIdFromSignedHex, unsignedTransactionHex } from '../solana.js';
import { walletSigner } from '../wallets/index.js';
import { turnkeySponsorSigner } from '../wallets/turnkey.js';
import { recurringExecutionReadiness, recurringPlanReadiness } from '../readiness.js';
import type { ClaimedOccurrence } from './queue.js';

type BasketItem = { assetId: string; variantId: string; weightBps: number; mint: string };
type Context = { owner_id: string; provider: 'turnkey' | 'moonpay'; organization_id: string; address: string; amount_atomic: string; basket_json: BasketItem[]; slippage_bps: number };
type Leg = { id: string; leg_index: number; output_mint: string; gross_amount_atomic: string; signature: string | null; signed_transaction_hex: string | null; last_valid_block_height: string | null; status: string };
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const STATIC_ROUTE_ACCOUNT_LIMITS = [40, 20, 16] as const;
const STATIC_ROUTE_SIMULATION_ATTEMPTS = 2;
const STATIC_ROUTE_MAX_PRICE_DEGRADATION_BPS = 10;

async function pause(client: pg.PoolClient, occurrence: ClaimedOccurrence, status: 'failed' | 'partial' | 'unknown', reason: string, leg?: { id: string; status: 'failed' | 'unknown' }, pauseCode: 'execution_failure' | 'account_setup_required' = 'execution_failure') {
  if (!occurrence.lease_owner) throw new Error('The recurring-buy occurrence has no execution lease token.');
  await client.query('BEGIN');
  try {
    const fenced = await client.query('UPDATE purchase_occurrences SET status = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_owner = $2 RETURNING id', [occurrence.id, occurrence.lease_owner, status]);
    if (!fenced.rowCount) { await client.query('ROLLBACK'); return; }
    await client.query(`UPDATE purchase_attempts SET status = $2, error_class = $3, updated_at = now()
      WHERE id = (SELECT id FROM purchase_attempts WHERE occurrence_id = $1 ORDER BY attempt_number DESC LIMIT 1)`, [occurrence.id, status, reason.slice(0, 120)]);
    if (leg) await client.query("UPDATE purchase_legs SET status = $2, error_class = $3, updated_at = now() WHERE id = $1 AND status <> 'confirmed'", [leg.id, leg.status, reason.slice(0, 120)]);
    if (leg) await client.query(`UPDATE sponsor_fee_reservations SET status = CASE
      WHEN $2 = 'unknown' THEN 'unknown' WHEN status = 'submitted' THEN 'failed' ELSE 'released' END, updated_at = now()
      WHERE leg_id = $1 AND status IN ('reserved','submitted')`, [leg.id, leg.status]);
    await client.query('UPDATE dca_plans SET status = $3, pause_reason = $4, pause_code = $5, next_run_at = NULL, revision = revision + 1, updated_at = now() WHERE id = $1 AND active_mandate_id = $2 AND status = \'active\'', [occurrence.plan_id, occurrence.mandate_id, 'paused', reason, pauseCode]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function renewLease(occurrence: ClaimedOccurrence) {
  if (!occurrence.lease_owner) throw new Error('The recurring-buy occurrence has no execution lease token.');
  const renewed = await db.query(`UPDATE purchase_occurrences SET lease_expires_at = now() + interval '2 minutes', updated_at = now()
    WHERE id = $1 AND lease_owner = $2 AND status IN ('claimed','executing','confirming') RETURNING id`, [occurrence.id, occurrence.lease_owner]);
  if (!renewed.rowCount) throw new Error('The recurring-buy worker lost its execution lease.');
}

async function reserveSponsorFee(input: { ownerId: string; occurrenceId: string; attemptId: string; legId: string; sponsorBalanceLamports: bigint }) {
  const reserved = config.recurringMaxSponsoredLamportsPerTransaction;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sponsor-fee-budget'))");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sponsor-fee-user:${input.ownerId}`]);
    const existing = await client.query<{ id: string; reserved_lamports: string }>('SELECT id, reserved_lamports::text FROM sponsor_fee_reservations WHERE leg_id = $1', [input.legId]);
    if (existing.rowCount) { await client.query('COMMIT'); return BigInt(existing.rows[0].reserved_lamports); }
    const totals = await client.query<{ user_lamports: string; global_lamports: string }>(`SELECT
      COALESCE(sum(CASE WHEN owner_id = $1 THEN COALESCE(final_lamports, reserved_lamports) ELSE 0 END),0)::text AS user_lamports,
      COALESCE(sum(COALESCE(final_lamports, reserved_lamports)),0)::text AS global_lamports
      FROM sponsor_fee_reservations WHERE occurrence_id IS NOT NULL
        AND created_at > now() - interval '24 hours' AND status IN ('reserved','submitted','confirmed','failed','unknown')`, [input.ownerId]);
    if (BigInt(totals.rows[0].user_lamports) + reserved > config.recurringMaxSponsoredLamportsPerUserDaily) throw new Error('The user sponsor-fee daily limit was reached.');
    if (BigInt(totals.rows[0].global_lamports) + reserved > config.recurringMaxSponsoredLamportsGlobalDaily) throw new Error('The global sponsor-fee daily limit was reached.');
    const active = await client.query<{ lamports: string }>(`SELECT COALESCE(sum(reserved_lamports),0)::text AS lamports FROM sponsor_fee_reservations
      WHERE status IN ('reserved','submitted','unknown')`);
    if (input.sponsorBalanceLamports - BigInt(active.rows[0].lamports) - reserved < config.recurringSponsorMinimumBalanceLamports) throw new Error('The sponsor wallet balance is below its safety minimum.');
    const inserted = await client.query<{ id: string }>(`INSERT INTO sponsor_fee_reservations (owner_id, occurrence_id, attempt_id, leg_id, reserved_lamports)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [input.ownerId, input.occurrenceId, input.attemptId, input.legId, reserved.toString()]);
    await client.query('UPDATE purchase_legs SET sponsor_reservation_id = $2 WHERE id = $1', [input.legId, inserted.rows[0].id]);
    await client.query('COMMIT');
    return reserved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function executeOccurrence(occurrence: ClaimedOccurrence) {
  if (!config.executionEnabled) return;
  const readiness = await recurringExecutionReadiness();
  if (!readiness.ok) throw new Error(`Recurring execution readiness failed: ${readiness.reason}`);
  if (!config.jupiterApiKey || !config.jupiterFeeAccount || !config.turnkeySponsorWalletAddress) throw new Error('Execution is enabled without sponsored recurring-buy configuration.');
  const client = await db.connect();
  let confirmed = 0;
  let activeLeg: Leg | null = null;
  let dailyLimitLocked = false;
  let dailyLimitKey: string | null = null;
  let signingLockHeld = false;
  const signingLockKey = `recurring-sign:${occurrence.plan_id}`;
  try {
    const loaded = await client.query<Context>(`SELECT p.owner_id, w.provider, w.provider_organization_id AS organization_id, w.solana_address AS address,
      m.amount_atomic, m.basket_json, m.slippage_bps FROM purchase_occurrences o JOIN dca_plans p ON p.id = o.plan_id
      JOIN wallets w ON w.id = p.active_wallet_id JOIN signer_authorizations sa ON sa.wallet_id = w.id AND sa.plan_id = p.id AND sa.status = 'active'
      JOIN plan_mandates m ON m.id = o.mandate_id WHERE o.id = $1 AND o.lease_owner = $2 AND p.status = 'active'
        AND p.active_mandate_id = o.mandate_id AND sa.mandate_id = o.mandate_id`, [occurrence.id, occurrence.lease_owner]);
    if (!loaded.rowCount) return;
    const context = loaded.rows[0];
    const planReadiness = await recurringPlanReadiness(context.owner_id, occurrence.plan_id, occurrence.mandate_id);
    if (!planReadiness.ok) {
      await pause(client, occurrence, 'failed', 'The sponsor policy for this recurring plan is invalid or unavailable. Reapprove the plan.');
      return;
    }
    {
      await client.query('UPDATE purchase_occurrences SET status = $3, updated_at = now() WHERE id = $1 AND lease_owner = $2', [occurrence.id, occurrence.lease_owner, 'executing']);
      dailyLimitKey = `recurring-daily-limit:${context.owner_id}`;
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [dailyLimitKey]);
      dailyLimitLocked = true;
      let attempt = await client.query<{ id: string }>('SELECT id FROM purchase_attempts WHERE occurrence_id = $1 ORDER BY attempt_number DESC LIMIT 1', [occurrence.id]);
      if (!attempt.rowCount) attempt = await client.query<{ id: string }>(`INSERT INTO purchase_attempts (occurrence_id, attempt_number, signer_provider, gross_amount_atomic, status)
        VALUES ($1,1,$2,$3,'building') RETURNING id`, [occurrence.id, context.provider, context.amount_atomic]);
      const attemptId = attempt.rows[0].id;
      if (BigInt(context.amount_atomic) > config.recurringMaxOccurrenceAtomic) { await pause(client, occurrence, 'failed', 'The occurrence exceeds the controlled-launch limit.'); return; }
      const daily = await client.query<{ gross: string }>(`SELECT COALESCE(sum(a.gross_amount_atomic),0)::text AS gross FROM purchase_attempts a
        JOIN purchase_occurrences o ON o.id = a.occurrence_id JOIN dca_plans p ON p.id = o.plan_id
        WHERE p.owner_id = $1 AND a.created_at > now() - interval '24 hours' AND a.status <> 'failed'`, [context.owner_id]);
      if (BigInt(daily.rows[0].gross) > config.recurringMaxDailyAtomic) { await pause(client, occurrence, 'failed', 'The controlled-launch daily limit was reached.'); return; }
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [dailyLimitKey]);
      dailyLimitLocked = false;
      const allocations = allocateAtomic(BigInt(context.amount_atomic), context.basket_json);
      const infrastructureReserves = allocateAtomic(config.recurringMaxNetworkFeeAtomic, context.basket_json);
      for (const allocation of allocations) {
        const basket = context.basket_json[allocation.index];
        await client.query(`INSERT INTO purchase_legs (attempt_id, leg_index, asset_id, variant_id, output_mint, weight_bps, gross_amount_atomic)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (attempt_id, leg_index) DO NOTHING`,
        [attemptId, allocation.index, allocation.assetId, allocation.variantId, basket.mint, allocation.weightBps, allocation.amountAtomic.toString()]);
      }
      const legs = await client.query<Leg>('SELECT * FROM purchase_legs WHERE attempt_id = $1 ORDER BY leg_index', [attemptId]);
      if (legs.rowCount !== allocations.length) throw new Error('The recurring-buy basket could not be prepared completely.');
      const signer = walletSigner(context.provider);
      const sponsor = turnkeySponsorSigner();
      const sourceTokenAccount = await associatedTokenAccount(context.address, config.usdcMint, TOKEN_PROGRAM_ADDRESS);
      const tokenPrograms = await tokenProgramsForMints(legs.rows.map(leg => leg.output_mint), config.solanaRpcUrl);
      const destinationAccounts = new Map(await Promise.all(legs.rows.map(async leg => {
        const tokenProgram = tokenPrograms.get(leg.output_mint);
        if (!tokenProgram) throw new Error(`Token mint ${leg.output_mint} was not checked during preflight.`);
        return [leg.output_mint, await associatedTokenAccount(context.address, leg.output_mint, tokenProgram)] as const;
      })));
      const presentDestinationAccounts = await existingAccounts([...destinationAccounts.values()], config.solanaRpcUrl);
      if (presentDestinationAccounts.size !== destinationAccounts.size) {
        await pause(client, occurrence, 'failed', 'A token account is missing. Approve the one-time account repair before recurring buys resume.', undefined, 'account_setup_required');
        return;
      }
      for (const leg of legs.rows) {
        activeLeg = leg;
        if (leg.status === 'confirmed') { confirmed++; activeLeg = null; continue; }
        if (leg.signature) {
          const status = await signatureStatus(leg.signature, config.solanaRpcUrl);
          if (!status && leg.last_valid_block_height && await currentBlockHeight(config.solanaRpcUrl) > Number(leg.last_valid_block_height)) {
            await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'A signed transaction expired without a conclusive chain result. Manual review is required.', { id: leg.id, status: 'unknown' }); return;
          }
          if (!status) { await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'A signed transaction has an unknown chain result. Manual review is required.', { id: leg.id, status: 'unknown' }); return; }
          if (status.err) { await pause(client, occurrence, confirmed ? 'partial' : 'failed', 'A recurring-buy transaction failed onchain.', { id: leg.id, status: 'failed' }); return; }
        } else {
          await renewLease(occurrence);
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [signingLockKey]);
          signingLockHeld = true;
          const authorized = await client.query(`SELECT 1 FROM dca_plans p JOIN wallets w ON w.id = p.active_wallet_id
            JOIN signer_authorizations sa ON sa.wallet_id = w.id AND sa.plan_id = p.id AND sa.status = 'active'
            WHERE p.id = $1 AND p.status = 'active' AND p.active_mandate_id = $2 AND w.status = 'active'`, [occurrence.plan_id, occurrence.mandate_id]);
          if (!authorized.rowCount) { await pause(client, occurrence, confirmed ? 'partial' : 'failed', 'Recurring-buy authorization is no longer active.', { id: leg.id, status: 'failed' }); return; }
          const destinationTokenProgram = tokenPrograms.get(leg.output_mint)!;
          const destinationTokenAccount = destinationAccounts.get(leg.output_mint)!;
          const grossAtomic = BigInt(leg.gross_amount_atomic);
          const profitFeeAtomic = feeAtomic(grossAtomic);
          const maximumInfrastructureAtomic = infrastructureReserves[leg.leg_index]?.amountAtomic;
          if (maximumInfrastructureAtomic === undefined) throw new Error('The sponsored reserve allocation is missing.');
          const fixedSwapInputAtomic = grossAtomic - profitFeeAtomic - maximumInfrastructureAtomic;
          if (fixedSwapInputAtomic <= 0n) throw new Error('The approved leg has no net investment after its fee reserve.');
          const sponsorBalance = await nativeBalanceLamports(sponsor.address, config.solanaRpcUrl);
          const reservedLamports = await reserveSponsorFee({ ownerId: context.owner_id, occurrenceId: occurrence.id, attemptId, legId: leg.id, sponsorBalanceLamports: sponsorBalance });
          const maximumFeeTransferAtomic = profitFeeAtomic + maximumInfrastructureAtomic;
          const maximumFeeInstruction = tokenTransferCheckedInstruction({ source: sourceTokenAccount, mint: config.usdcMint, destination: config.jupiterFeeAccount, owner: context.address, amountAtomic: maximumFeeTransferAtomic });
          const maximumLocalInstructions = [maximumFeeInstruction];
          let build: Awaited<ReturnType<typeof fetchJupiterBuild>> | null = null;
          let firstUnits: number | null = null;
          let routeFailure: Error | null = null;
          let firstQuoteMinimumOutput: bigint | null = null;
          const excludedDexes = new Set<string>();
          routeSearch: for (const maxAccounts of STATIC_ROUTE_ACCOUNT_LIMITS) {
            for (let quoteAttempt = 0; quoteAttempt < STATIC_ROUTE_SIMULATION_ATTEMPTS; quoteAttempt++) {
              let candidate: Awaited<ReturnType<typeof fetchJupiterBuild>> | null = null;
              try {
                candidate = await fetchJupiterBuild({ inputMint: config.usdcMint, outputMint: leg.output_mint, amountAtomic: fixedSwapInputAtomic.toString(), taker: context.address, payer: sponsor.address, sourceTokenAccount, destinationTokenAccount, destinationTokenProgram, feeAccount: config.jupiterFeeAccount, feeBps: 0, slippageBps: context.slippage_bps }, config.jupiterApiKey, fetch, maxAccounts, [...excludedDexes]);
                firstQuoteMinimumOutput ??= BigInt(candidate.otherAmountThreshold);
                assertJupiterFallbackPrice(firstQuoteMinimumOutput, candidate, STATIC_ROUTE_MAX_PRICE_DEGRADATION_BPS);
                unsignedTransactionHex(candidate, sponsor.address, 1_400_000, {}, maximumLocalInstructions, true);
                const candidateUnits = await estimateComputeUnits(candidate, sponsor.address, config.solanaRpcUrl, fetch, {}, maximumLocalInstructions, true);
                build = candidate;
                firstUnits = candidateUnits;
                break routeSearch;
              } catch (error) {
                if (!(error instanceof Error)) throw error;
                const retryableSimulation = isJupiterSlippageSimulationError(error);
                const retryableRoute = error.message.includes('transaction size limits') || error.message === 'Jupiter returned an unsupported setup instruction.';
                if (!retryableSimulation && !retryableRoute) throw error;
                routeFailure = error;
                if (retryableSimulation && candidate) {
                  for (const route of candidate.routePlan) {
                    const label = route.swapInfo.label.trim();
                    if (label && label.length <= 100) excludedDexes.add(label);
                  }
                  if (quoteAttempt + 1 < STATIC_ROUTE_SIMULATION_ATTEMPTS) continue;
                }
                break;
              }
            }
          }
          if (!build || firstUnits === null) throw routeFailure ?? new Error('Jupiter could not build a static-account route.');
          assertFreshBlockhash(await currentBlockHeight(config.solanaRpcUrl), build.blockhashWithMetadata.lastValidBlockHeight);
          const price = await fetchJupiterSolPrice(config.jupiterApiKey, await currentSlot(config.solanaRpcUrl), config.recurringSolPriceMaximumAgeSlots);
          const rentLamports = 0n;
          const firstNetworkFee = await transactionFeeLamports(build, sponsor.address, firstUnits, config.solanaRpcUrl, fetch, {}, maximumLocalInstructions, true);
          let charge = computeChargeBreakdown({ grossAtomic, networkFeeLamports: firstNetworkFee, rentLamports, solPriceAtomicPerSol: price.solPriceAtomicPerSol,
            maximumInfrastructureAtomic, minimumNetInvestmentAtomic: 1n });
          let localInstructions = [tokenTransferCheckedInstruction({ source: sourceTokenAccount, mint: config.usdcMint, destination: config.jupiterFeeAccount, owner: context.address, amountAtomic: charge.feeTransferAtomic })];
          const units = await estimateComputeUnits(build, sponsor.address, config.solanaRpcUrl, fetch, {}, localInstructions, true);
          const networkFee = await transactionFeeLamports(build, sponsor.address, units, config.solanaRpcUrl, fetch, {}, localInstructions, true);
          charge = computeChargeBreakdown({ grossAtomic, networkFeeLamports: networkFee, rentLamports, solPriceAtomicPerSol: price.solPriceAtomicPerSol,
            maximumInfrastructureAtomic, minimumNetInvestmentAtomic: 1n });
          if (charge.netInvestmentAtomic !== fixedSwapInputAtomic || charge.sponsoredLamports > reservedLamports) throw new Error('The sponsored charge no longer matches the approved mandate.');
          localInstructions = [tokenTransferCheckedInstruction({ source: sourceTokenAccount, mint: config.usdcMint, destination: config.jupiterFeeAccount, owner: context.address, amountAtomic: charge.feeTransferAtomic })];
          const unsigned = unsignedTransactionHex(build, sponsor.address, units, {}, localInstructions, true);
          assertRequiredSigners(unsigned, [sponsor.address, context.address]);
          await renewLease(occurrence);
          if (!config.executionEnabled) throw new Error('Recurring execution was disabled before signing.');
          const userSigned = await signer.signSolanaTransaction({ organizationId: context.organization_id, address: context.address, unsignedTransactionHex: unsigned });
          assertSignatureAddedBy(unsigned, userSigned.signedTransactionHex, context.address);
          await renewLease(occurrence);
          if (!config.executionEnabled) throw new Error('Recurring execution was disabled before sponsor signing.');
          const sponsorSigned = await sponsor.signer.signSolanaTransaction({ organizationId: sponsor.organizationId, address: sponsor.address, unsignedTransactionHex: userSigned.signedTransactionHex });
          assertSignatureAddedBy(userSigned.signedTransactionHex, sponsorSigned.signedTransactionHex, sponsor.address);
          await renewLease(occurrence);
          const signature = transactionIdFromSignedHex(sponsorSigned.signedTransactionHex);
          await client.query(`UPDATE purchase_legs SET status = 'submitted', signature = $2, signed_transaction_hex = $3, last_valid_block_height = $4, quote_expires_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1`,
          [leg.id, signature, sponsorSigned.signedTransactionHex, build.blockhashWithMetadata.lastValidBlockHeight]);
          await client.query(`UPDATE purchase_legs SET profit_fee_atomic = $2, infrastructure_fee_atomic = $3, net_input_atomic = $4,
            expected_network_fee_lamports = $5, expected_rent_lamports = $6, fee_transfer_atomic = $7, ata_created = $8,
            sponsor_address = $9, user_signer_address = $10 WHERE id = $1`, [leg.id, charge.profitFeeAtomic.toString(), charge.infrastructureFeeAtomic.toString(), charge.netInvestmentAtomic.toString(),
            networkFee.toString(), rentLamports.toString(), charge.feeTransferAtomic.toString(), false, sponsor.address, context.address]);
          await client.query(`UPDATE purchase_attempts SET status = 'submitted', profit_fee_atomic = profit_fee_atomic + $2,
            infrastructure_fee_atomic = infrastructure_fee_atomic + $3, net_investment_atomic = net_investment_atomic + $4,
            sponsored_lamports = sponsored_lamports + $5, sol_price_atomic_per_sol = $6, sol_price_block_id = $7, updated_at = now() WHERE id = $1`,
          [attemptId, charge.profitFeeAtomic.toString(), charge.infrastructureFeeAtomic.toString(), charge.netInvestmentAtomic.toString(), charge.sponsoredLamports.toString(), price.solPriceAtomicPerSol.toString(), price.blockId]);
          await client.query("UPDATE sponsor_fee_reservations SET status = 'submitted', transaction_signature = $2, updated_at = now() WHERE leg_id = $1", [leg.id, signature]);
          let submitted: string;
          try { submitted = await submitSignedTransaction(sponsorSigned.signedTransactionHex, config.solanaRpcUrl); }
          catch { await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'Transaction submission has an unknown result. Manual review is required.', { id: leg.id, status: 'unknown' }); return; }
          if (submitted !== signature) { await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'Transaction submission returned an unexpected signature. Manual review is required.', { id: leg.id, status: 'unknown' }); return; }
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [signingLockKey]);
          signingLockHeld = false;
          leg.signature = signature;
        }
        await client.query('UPDATE purchase_occurrences SET status = $3, lease_expires_at = now() + interval \'2 minutes\', updated_at = now() WHERE id = $1 AND lease_owner = $2', [occurrence.id, occurrence.lease_owner, 'confirming']);
        await client.query('UPDATE purchase_attempts SET status = $2, updated_at = now() WHERE id = $1', [attemptId, 'confirming']);
        let amounts = null;
        for (let poll = 0; poll < 20; poll++) {
          await renewLease(occurrence);
          const status = await signatureStatus(leg.signature!, config.solanaRpcUrl);
          if (status?.err) { await pause(client, occurrence, confirmed ? 'partial' : 'failed', 'A recurring-buy transaction failed onchain.', { id: leg.id, status: 'failed' }); return; }
          if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            amounts = await confirmedSwapAmounts(leg.signature!, context.address, config.usdcMint, leg.output_mint, config.jupiterFeeAccount, config.solanaRpcUrl);
            if (amounts) break;
          }
          await wait(2_000);
        }
        if (!amounts) { await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'Transaction confirmation is still unknown. Manual review is required.', { id: leg.id, status: 'unknown' }); return; }
        const expected = await client.query<{ net_input_atomic: string; fee_transfer_atomic: string; expected_rent_lamports: string }>('SELECT net_input_atomic::text, fee_transfer_atomic::text, expected_rent_lamports::text FROM purchase_legs WHERE id = $1', [leg.id]);
        const expectedNet = BigInt(expected.rows[0].net_input_atomic);
        const expectedFee = BigInt(expected.rows[0].fee_transfer_atomic);
        if (amounts.filledInputAtomic !== expectedNet + expectedFee || amounts.filledOutputAtomic <= 0n || amounts.feeAtomic !== expectedFee) { await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'Confirmed transaction amounts could not be reconciled safely.', { id: leg.id, status: 'unknown' }); return; }
        if (!Number.isInteger(amounts.outputDecimals)) { await pause(client, occurrence, confirmed ? 'partial' : 'unknown', 'Confirmed transaction output decimals could not be reconciled safely.', { id: leg.id, status: 'unknown' }); return; }
        await client.query(`UPDATE purchase_legs SET status = 'confirmed', filled_input_atomic = $2, filled_output_atomic = $3, fee_atomic = $4, output_decimals = $5,
          actual_network_fee_lamports = $6, signed_transaction_hex = NULL, updated_at = now() WHERE id = $1`,
        [leg.id, amounts.filledInputAtomic.toString(), amounts.filledOutputAtomic.toString(), amounts.feeAtomic.toString(), amounts.outputDecimals, amounts.networkFeeLamports.toString()]);
        await client.query("UPDATE sponsor_fee_reservations SET status = 'confirmed', final_lamports = $2, updated_at = now() WHERE leg_id = $1", [leg.id, (amounts.networkFeeLamports + BigInt(expected.rows[0].expected_rent_lamports)).toString()]);
        confirmed++;
        activeLeg = null;
      }
      await client.query(`UPDATE purchase_attempts SET status = 'confirmed', confirmed_gross_atomic = totals.gross, fee_atomic = totals.fee, updated_at = now()
        FROM (SELECT COALESCE(sum(filled_input_atomic),0) AS gross, COALESCE(sum(fee_atomic),0) AS fee FROM purchase_legs WHERE attempt_id = $1) totals WHERE id = $1`, [attemptId]);
      const completed = await client.query('UPDATE purchase_occurrences SET status = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_owner = $2 RETURNING id', [occurrence.id, occurrence.lease_owner, 'confirmed']);
      if (!completed.rowCount) throw new Error('The recurring-buy worker lost its execution lease before completion.');
    }
  } catch (error) {
    const inconclusive = Boolean(activeLeg?.signature);
    await pause(client, occurrence, confirmed ? 'partial' : inconclusive ? 'unknown' : 'failed', error instanceof Error ? error.message.slice(0, 300) : 'Recurring buy failed.', activeLeg ? { id: activeLeg.id, status: inconclusive ? 'unknown' : 'failed' } : undefined);
    throw error;
  } finally {
    if (signingLockHeld) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [signingLockKey]).catch(() => undefined);
    if (dailyLimitLocked && dailyLimitKey) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [dailyLimitKey]).catch(() => undefined);
    client.release();
  }
}

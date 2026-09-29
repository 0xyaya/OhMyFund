import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { db } from './db.js';
import { config } from './config.js';
import { confirmedSwapAmounts, signatureStatus } from './solana.js';

type ReconcileDependencies = { signatureStatus: typeof signatureStatus; confirmedSwapAmounts: typeof confirmedSwapAmounts };

export async function reconcileAttempt(attemptId: string, dependencies: ReconcileDependencies = { signatureStatus, confirmedSwapAmounts }) {
  z.uuid().parse(attemptId);
  if (!config.jupiterFeeAccount) throw new Error('JUPITER_FEE_ACCOUNT is required for reconciliation.');
  const client = await db.connect();
  try {
  await client.query('BEGIN');
  const context = await client.query<{ occurrence_id: string; plan_id: string; wallet: string }>(`SELECT a.occurrence_id, o.plan_id, w.solana_address AS wallet
    FROM purchase_attempts a JOIN purchase_occurrences o ON o.id = a.occurrence_id JOIN dca_plans p ON p.id = o.plan_id
    JOIN wallets w ON w.id = p.active_wallet_id WHERE a.id = $1 AND a.status IN ('unknown','partial') FOR UPDATE OF a, o`, [attemptId]);
  if (!context.rowCount) throw new Error('Attempt not found.');
  const legs = await client.query<{ id: string; output_mint: string; signature: string | null; status: string; net_input_atomic: string | null; fee_transfer_atomic: string | null; expected_rent_lamports: string | null }>(`SELECT id, output_mint, signature, status, net_input_atomic::text, fee_transfer_atomic::text, expected_rent_lamports::text
    FROM purchase_legs WHERE attempt_id = $1 ORDER BY leg_index`, [attemptId]);
  for (const leg of legs.rows) {
    if (!leg.signature || leg.status === 'confirmed') continue;
    const chain = await dependencies.signatureStatus(leg.signature, config.solanaRpcUrl);
    if (chain?.err) {
      await client.query("UPDATE purchase_legs SET status = 'failed', error_class = 'ONCHAIN_FAILURE', updated_at = now() WHERE id = $1", [leg.id]);
      await client.query("UPDATE sponsor_fee_reservations SET status = 'failed', updated_at = now() WHERE leg_id = $1 AND status IN ('submitted','unknown')", [leg.id]);
      continue;
    }
    if (chain?.confirmationStatus !== 'confirmed' && chain?.confirmationStatus !== 'finalized') continue;
    const amounts = await dependencies.confirmedSwapAmounts(leg.signature, context.rows[0].wallet, config.usdcMint, leg.output_mint, config.jupiterFeeAccount, config.solanaRpcUrl);
    if (!leg.net_input_atomic || leg.fee_transfer_atomic === null || leg.expected_rent_lamports === null) continue;
    const expectedNet = BigInt(leg.net_input_atomic);
    const expectedFee = BigInt(leg.fee_transfer_atomic);
    if (!amounts || amounts.filledInputAtomic !== expectedNet + expectedFee || amounts.filledOutputAtomic <= 0n || amounts.feeAtomic !== expectedFee || !Number.isInteger(amounts.outputDecimals)) continue;
    await client.query(`UPDATE purchase_legs SET status = 'confirmed', filled_input_atomic = $2, filled_output_atomic = $3, fee_atomic = $4, output_decimals = $5,
      actual_network_fee_lamports = $6, signed_transaction_hex = NULL, updated_at = now() WHERE id = $1`,
    [leg.id, amounts.filledInputAtomic.toString(), amounts.filledOutputAtomic.toString(), amounts.feeAtomic.toString(), amounts.outputDecimals, amounts.networkFeeLamports.toString()]);
    await client.query("UPDATE sponsor_fee_reservations SET status = 'confirmed', final_lamports = $2, updated_at = now() WHERE leg_id = $1 AND status IN ('submitted','unknown')",
      [leg.id, (amounts.networkFeeLamports + BigInt(leg.expected_rent_lamports)).toString()]);
  }
  const totals = await client.query<{ total: string; confirmed: string; failed: string; gross: string; fee: string }>(`SELECT count(*)::text AS total,
    count(*) FILTER (WHERE status = 'confirmed')::text AS confirmed, count(*) FILTER (WHERE status = 'failed')::text AS failed,
    COALESCE(sum(filled_input_atomic) FILTER (WHERE status = 'confirmed'),0)::text AS gross,
    COALESCE(sum(fee_atomic) FILTER (WHERE status = 'confirmed'),0)::text AS fee FROM purchase_legs WHERE attempt_id = $1`, [attemptId]);
  const value = totals.rows[0];
  const status = value.confirmed === value.total ? 'confirmed' : Number(value.confirmed) > 0 ? 'partial' : value.failed === value.total ? 'failed' : 'unknown';
  await client.query(`UPDATE purchase_attempts SET status = $2, confirmed_gross_atomic = $3, fee_atomic = $4,
    sponsored_lamports = COALESCE((SELECT sum(COALESCE(final_lamports, reserved_lamports)) FROM sponsor_fee_reservations WHERE attempt_id = $1 AND status IN ('confirmed','failed')), 0),
    updated_at = now() WHERE id = $1`, [attemptId, status, value.gross, value.fee]);
  await client.query('UPDATE purchase_occurrences SET status = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1', [context.rows[0].occurrence_id, status]);
  await client.query('COMMIT');
  return { attemptId, status, confirmedLegs: Number(value.confirmed), totalLegs: Number(value.total), grossAtomic: value.gross, feeAtomic: value.fee };
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await reconcileAttempt(z.uuid().parse(process.argv[2]));
  console.log(JSON.stringify(result));
  await db.end();
}

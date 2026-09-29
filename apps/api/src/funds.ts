import type { PoolClient } from 'pg';
import { db } from './db.js';
import { prepareAuthorizationCleanup } from './plans.js';
import { ApiFailure } from './auth.js';
import { findSelection } from './catalog.js';

type Asset = { assetId: string; variantId: string; weightBps: number };
type FundInput = { name: string; assets: Asset[] };
type FundRow = { id: string; name: string; version: number; public_id: string | null; publisher_name: string | null; published_at: Date | null; created_at: Date; updated_at: Date };
type FundEditRow = { id: string; kind: 'created' | 'updated'; version: number; before_state: FundInput | null; after_state: FundInput; created_at: Date };
type PaymentRow = { id: string; signature: string; amount_atomic: string; invested_atomic: string | null; fee_atomic: string; profit_fee_atomic: string | null; infrastructure_fee_atomic: string | null; sponsored_lamports: string | null; ata_created: boolean | null; output_atomic: string; output_decimals: number; output_mint: string; created_at: Date };

function validateCatalog(assets: Asset[]) {
  const variants = assets.map(asset => findSelection(asset.assetId, asset.variantId));
  if (variants.some(variant => !variant)) throw new ApiFailure(400, 'VALIDATION', 'Choose an asset from the approved Tokens catalog.', { assets: 'One or more assets are not available.' });
  if (new Set(variants.map(variant => variant!.mint)).size !== variants.length) throw new ApiFailure(400, 'VALIDATION', 'Choose each token only once.', { assets: 'Two selected assets use the same token mint.' });
}
async function hydrate(client: PoolClient, fund: FundRow) {
  const result = await client.query<{ asset_id: string; variant_id: string; weight_bps: number }>('SELECT asset_id, variant_id, weight_bps FROM fund_assets WHERE fund_id = $1 ORDER BY asset_id', [fund.id]);
  return { id: fund.id, name: fund.name, version: fund.version, assets: result.rows.map(a => ({ assetId: a.asset_id, variantId: a.variant_id, weightBps: a.weight_bps })), publication: fund.public_id && fund.publisher_name && fund.published_at ? { publicId: fund.public_id, publisherName: fund.publisher_name, publishedAt: fund.published_at.toISOString() } : null, createdAt: fund.created_at.toISOString(), updatedAt: fund.updated_at.toISOString() };
}
export async function listFunds(userId: string) {
  const client = await db.connect();
  try {
    const rows = await client.query<FundRow>('SELECT id, name, version, public_id, publisher_name, published_at, created_at, updated_at FROM funds WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    return { funds: await Promise.all(rows.rows.map(row => hydrate(client, row))) };
  } finally { client.release(); }
}
export async function getFund(userId: string, fundId: string) {
  const client = await db.connect();
  try {
    const result = await client.query<FundRow>('SELECT id, name, version, public_id, publisher_name, published_at, created_at, updated_at FROM funds WHERE id = $1 AND owner_id = $2', [fundId, userId]);
    if (!result.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Fund not found.');
    return hydrate(client, result.rows[0]);
  } finally { client.release(); }
}
export async function listFundActivity(userId: string, fundId: string) {
  const owned = await db.query('SELECT 1 FROM funds WHERE id = $1 AND owner_id = $2', [fundId, userId]);
  if (!owned.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Fund not found.');
  const [result, payments] = await Promise.all([
    db.query<FundEditRow>('SELECT id, kind, version, before_state, after_state, created_at FROM fund_edit_events WHERE fund_id = $1 AND owner_id = $2 ORDER BY version DESC LIMIT 100', [fundId, userId]),
    db.query<PaymentRow>(`SELECT l.id, l.signature, l.filled_input_atomic AS amount_atomic, l.net_input_atomic AS invested_atomic, l.fee_atomic,
      l.profit_fee_atomic, l.infrastructure_fee_atomic, (COALESCE(l.actual_network_fee_lamports,0) + COALESCE(l.expected_rent_lamports,0))::text AS sponsored_lamports,
      l.ata_created, l.filled_output_atomic AS output_atomic, l.output_decimals, l.output_mint, l.updated_at AS created_at
      FROM purchase_legs l JOIN purchase_attempts a ON a.id = l.attempt_id JOIN purchase_occurrences o ON o.id = a.occurrence_id
      JOIN dca_plans p ON p.id = o.plan_id WHERE p.fund_id = $1 AND p.owner_id = $2 AND l.status = 'confirmed' AND l.signature IS NOT NULL
      ORDER BY l.updated_at DESC LIMIT 100`, [fundId, userId])
  ]);
  return {
    edits: result.rows.map(row => ({ id: row.id, kind: row.kind, version: row.version, before: row.before_state, after: row.after_state, occurredAt: row.created_at.toISOString() })),
    payments: payments.rows.map(row => ({ id: row.id, signature: row.signature, amountAtomic: String(row.amount_atomic), investedAtomic: String(row.invested_atomic ?? BigInt(row.amount_atomic) - BigInt(row.fee_atomic)), feeAtomic: String(row.fee_atomic),
      profitFeeAtomic: String(row.profit_fee_atomic ?? row.fee_atomic), infrastructureFeeAtomic: String(row.infrastructure_fee_atomic ?? 0), sponsoredLamports: String(row.sponsored_lamports ?? 0), ataCreated: row.ata_created ?? false,
      outputAtomic: String(row.output_atomic), outputDecimals: row.output_decimals, outputMint: row.output_mint, status: 'confirmed' as const, occurredAt: row.created_at.toISOString() }))
  };
}
export async function createFund(userId: string, input: FundInput) {
  validateCatalog(input.assets);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<FundRow>('INSERT INTO funds (owner_id, name) VALUES ($1,$2) RETURNING id, name, version, public_id, publisher_name, published_at, created_at, updated_at', [userId, input.name]);
    for (const asset of input.assets) await client.query('INSERT INTO fund_assets (fund_id, asset_id, variant_id, weight_bps) VALUES ($1,$2,$3,$4)', [result.rows[0].id, asset.assetId, asset.variantId, asset.weightBps]);
    const fund = await hydrate(client, result.rows[0]);
    await client.query('INSERT INTO fund_edit_events (owner_id, fund_id, kind, version, after_state) VALUES ($1,$2,$3,$4,$5::jsonb)', [userId, fund.id, 'created', fund.version, JSON.stringify({ name: fund.name, assets: fund.assets })]);
    await client.query('COMMIT');
    return fund;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function replaceFund(userId: string, fundId: string, input: FundInput & { expectedVersion: number }) {
  validateCatalog(input.assets);
  await prepareAuthorizationCleanup(userId, { fundId });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<FundRow>('SELECT id, name, version, public_id, publisher_name, published_at, created_at, updated_at FROM funds WHERE id = $1 AND owner_id = $2 FOR UPDATE', [fundId, userId]);
    if (!current.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Fund not found.');
    if (current.rows[0].version !== input.expectedVersion) throw new ApiFailure(409, 'CONFLICT', 'This fund changed in another tab. Reload before saving.');
    const plans = await client.query<{ id: string }>("SELECT id FROM dca_plans WHERE fund_id = $1 AND owner_id = $2 AND status IN ('approval_required','active','paused') ORDER BY id", [fundId, userId]);
    for (const plan of plans.rows) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recurring-sign:${plan.id}`]);
    const before = await hydrate(client, current.rows[0]);
    const updated = await client.query<FundRow>('UPDATE funds SET name = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING id, name, version, public_id, publisher_name, published_at, created_at, updated_at', [input.name, fundId]);
    await client.query('DELETE FROM fund_assets WHERE fund_id = $1', [fundId]);
    for (const asset of input.assets) await client.query('INSERT INTO fund_assets (fund_id, asset_id, variant_id, weight_bps) VALUES ($1,$2,$3,$4)', [fundId, asset.assetId, asset.variantId, asset.weightBps]);
    const fund = await hydrate(client, updated.rows[0]);
    await client.query('INSERT INTO fund_edit_events (owner_id, fund_id, kind, version, before_state, after_state) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [userId, fund.id, 'updated', fund.version, JSON.stringify({ name: before.name, assets: before.assets }), JSON.stringify({ name: fund.name, assets: fund.assets })]);
    await client.query(`UPDATE dca_plans SET status = 'approval_required', active_mandate_id = NULL, next_run_at = NULL,
      pause_reason = 'Basket changed and needs approval.', pause_code = 'terms_changed', revision = revision + 1, updated_at = now()
      WHERE fund_id = $1 AND owner_id = $2 AND status IN ('approval_required','active','paused')`, [fundId, userId]);
    await client.query('COMMIT');
    return fund;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

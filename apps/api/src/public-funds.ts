import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fundNameSchema } from '@ohmyfund/contracts';
import { db } from './db.js';
import { ApiFailure } from './auth.js';
import { findSelection } from './catalog.js';

type AssetRow = { asset_id: string; variant_id: string; weight_bps: number };
type FundAssetRow = AssetRow & { fund_id: string };
type FundRow = { id: string; owner_id: string; name: string; version: number; public_id: string | null; publisher_name: string | null; published_at: Date | null; copy_count: string; created_at: Date; updated_at: Date };
type CopyEventRow = { request_hash: string; copied_fund_id: string | null; source_version: number };

const requestHash = (publicId: string, name: string) => createHash('sha256').update(`${publicId}\0${name}`).digest('hex');

async function assetsFor(client: PoolClient, fundId: string, order = 'asset_id') {
  const result = await client.query<AssetRow>(`SELECT asset_id, variant_id, weight_bps FROM fund_assets WHERE fund_id = $1 ORDER BY ${order}`, [fundId]);
  return result.rows;
}

async function assetsForFunds(client: PoolClient, fundIds: string[]) {
  if (!fundIds.length) return new Map<string, AssetRow[]>();
  const result = await client.query<FundAssetRow>('SELECT fund_id, asset_id, variant_id, weight_bps FROM fund_assets WHERE fund_id = ANY($1::uuid[]) ORDER BY fund_id, weight_bps DESC, asset_id ASC', [fundIds]);
  const grouped = new Map<string, AssetRow[]>();
  for (const row of result.rows) {
    const assets = grouped.get(row.fund_id) ?? [];
    assets.push({ asset_id: row.asset_id, variant_id: row.variant_id, weight_bps: row.weight_bps });
    grouped.set(row.fund_id, assets);
  }
  return grouped;
}

async function privateFund(client: PoolClient, userId: string, fundId: string) {
  const result = await client.query<Pick<FundRow, 'id' | 'name' | 'version' | 'created_at' | 'updated_at'>>('SELECT id, name, version, created_at, updated_at FROM funds WHERE id = $1 AND owner_id = $2', [fundId, userId]);
  if (!result.rowCount) throw new ApiFailure(404, 'NOT_FOUND', 'Copied fund is no longer available.');
  const row = result.rows[0];
  const assets = await assetsFor(client, row.id);
  return { id: row.id, name: row.name, version: row.version, assets: assets.map(asset => ({ assetId: asset.asset_id, variantId: asset.variant_id, weightBps: asset.weight_bps })), publication: null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function publicAsset(asset: AssetRow) {
  const selection = findSelection(asset.asset_id, asset.variant_id);
  return { assetId: asset.asset_id, variantId: asset.variant_id, symbol: selection?.symbol ?? asset.asset_id, name: selection?.name ?? asset.asset_id, ...(selection?.issuer ? { issuer: selection.issuer } : {}), weightBps: asset.weight_bps };
}

function validateSelections(rows: AssetRow[]) {
  const selections = rows.map(row => findSelection(row.asset_id, row.variant_id));
  const missing = rows.filter((_, index) => !selections[index]).map(row => row.asset_id);
  if (missing.length) throw new ApiFailure(409, 'ASSET_UNAVAILABLE', 'One or more assets are no longer available.', { assets: missing.join(', ') });
  if (rows.length < 2 || rows.length > 8 || rows.reduce((sum, row) => sum + row.weight_bps, 0) !== 10000 || new Set(rows.map(row => row.asset_id)).size !== rows.length || new Set(selections.map(selection => selection!.mint)).size !== rows.length) throw new ApiFailure(400, 'VALIDATION', 'This fund is not eligible to publish or copy.');
}

async function eventByKey(client: PoolClient, userId: string, idempotencyKey: string) {
  const result = await client.query<CopyEventRow>('SELECT request_hash, copied_fund_id, source_version FROM fund_copy_events WHERE copying_user_id = $1 AND idempotency_key = $2', [userId, idempotencyKey]);
  return result.rows[0] ?? null;
}

async function eventBySource(client: PoolClient, userId: string, publicId: string) {
  const result = await client.query<CopyEventRow>('SELECT request_hash, copied_fund_id, source_version FROM fund_copy_events WHERE copying_user_id = $1 AND source_public_id = $2 ORDER BY created_at LIMIT 1', [userId, publicId]);
  return result.rows[0] ?? null;
}

async function replay(client: PoolClient, userId: string, event: CopyEventRow, hash: string, strictHash: boolean) {
  if (strictHash && event.request_hash !== hash) throw new ApiFailure(409, 'IDEMPOTENCY_CONFLICT', 'This copy request key was already used with different details.');
  if (!event.copied_fund_id) throw new ApiFailure(404, 'NOT_FOUND', 'Copied fund is no longer available.');
  return { fund: await privateFund(client, userId, event.copied_fund_id), sourceVersion: event.source_version, alreadyCopied: !strictHash };
}

export async function listPublicFunds() {
  const client = await db.connect();
  try {
    const result = await client.query<FundRow & { rank: string }>(`SELECT id, owner_id, name, version, public_id, publisher_name, published_at, copy_count, created_at, updated_at,
      row_number() OVER (ORDER BY copy_count DESC, published_at ASC, id ASC) AS rank
      FROM funds WHERE published_at IS NOT NULL AND public_id IS NOT NULL AND publisher_name IS NOT NULL
      ORDER BY copy_count DESC, published_at ASC, id ASC LIMIT 50`);
    const assetsByFund = await assetsForFunds(client, result.rows.map(row => row.id));
    return { funds: result.rows.map(row => {
      const assets = assetsByFund.get(row.id) ?? [];
      return { rank: Number(row.rank), publicId: row.public_id!, fundName: row.name, publisherName: row.publisher_name!, topAssets: assets.slice(0, 3).map(asset => { const item = publicAsset(asset); return { assetId: item.assetId, variantId: item.variantId, symbol: item.symbol, weightBps: item.weightBps }; }), assetCount: assets.length, copyCount: Number(row.copy_count), basketUpdatedAt: row.updated_at.toISOString() };
    }) };
  } finally { client.release(); }
}

export async function getPublicFund(publicId: string) {
  const client = await db.connect();
  try {
    const result = await client.query<FundRow>('SELECT id, owner_id, name, version, public_id, publisher_name, published_at, copy_count, created_at, updated_at FROM funds WHERE public_id = $1 AND published_at IS NOT NULL AND publisher_name IS NOT NULL', [publicId]);
    if (!result.rowCount) throw new ApiFailure(404, 'NOT_FOUND', 'Public fund not found.');
    const row = result.rows[0];
    const assets = await assetsFor(client, row.id, 'weight_bps DESC, asset_id ASC');
    return { publicId: row.public_id!, fundName: row.name, publisherName: row.publisher_name!, assets: assets.map(publicAsset), assetCount: assets.length, copyCount: Number(row.copy_count), basketUpdatedAt: row.updated_at.toISOString() };
  } finally { client.release(); }
}

export async function publishFund(userId: string, fundId: string, publisherName: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<FundRow>('SELECT id, owner_id, name, version, public_id, publisher_name, published_at, copy_count, created_at, updated_at FROM funds WHERE id = $1 AND owner_id = $2 FOR UPDATE', [fundId, userId]);
    if (!current.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Fund not found.');
    fundNameSchema.parse(current.rows[0].name);
    validateSelections(await assetsFor(client, fundId));
    const firstPublication = !current.rows[0].public_id;
    const result = await client.query<{ public_id: string; publisher_name: string; published_at: Date }>('UPDATE funds SET public_id = COALESCE(public_id, gen_random_uuid()), publisher_name = $1, published_at = COALESCE(published_at, now()) WHERE id = $2 RETURNING public_id, publisher_name, published_at', [publisherName, fundId]);
    await client.query('COMMIT');
    const row = result.rows[0];
    return { publication: { publicId: row.public_id, publisherName: row.publisher_name, publishedAt: row.published_at.toISOString() }, firstPublication };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function unpublishFund(userId: string, fundId: string) {
  const result = await db.query('UPDATE funds SET published_at = NULL WHERE id = $1 AND owner_id = $2 RETURNING id', [fundId, userId]);
  if (!result.rowCount) throw new ApiFailure(403, 'FORBIDDEN', 'Fund not found.');
  return { ok: true };
}

export async function copyPublicFund(userId: string, publicId: string, name: string, idempotencyKey: string) {
  const hash = requestHash(publicId, name);
  const preflight = await db.connect();
  try {
    const keyed = await eventByKey(preflight, userId, idempotencyKey);
    if (keyed) return replay(preflight, userId, keyed, hash, true);
    const existing = await eventBySource(preflight, userId, publicId);
    if (existing) return replay(preflight, userId, existing, hash, false);
  } finally { preflight.release(); }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}:${idempotencyKey}`]);
    const keyed = await eventByKey(client, userId, idempotencyKey);
    if (keyed) { const result = await replay(client, userId, keyed, hash, true); await client.query('COMMIT'); return result; }
    const sourceResult = await client.query<FundRow>('SELECT id, owner_id, name, version, public_id, publisher_name, published_at, copy_count, created_at, updated_at FROM funds WHERE public_id = $1 FOR UPDATE', [publicId]);
    if (!sourceResult.rowCount) throw new ApiFailure(404, 'NOT_FOUND', 'Public fund not found.');
    const existing = await eventBySource(client, userId, publicId);
    if (existing) { const result = await replay(client, userId, existing, hash, false); await client.query('COMMIT'); return result; }
    const source = sourceResult.rows[0];
    if (!source.published_at) throw new ApiFailure(404, 'NOT_FOUND', 'This fund is no longer public.');
    if (source.owner_id === userId) throw new ApiFailure(409, 'SELF_COPY', 'You already own this fund.');
    const sourceAssets = await assetsFor(client, source.id);
    validateSelections(sourceAssets);
    const created = await client.query<Pick<FundRow, 'id' | 'name' | 'version' | 'created_at' | 'updated_at'>>('INSERT INTO funds (owner_id, name) VALUES ($1,$2) RETURNING id, name, version, created_at, updated_at', [userId, name]);
    for (const asset of sourceAssets) await client.query('INSERT INTO fund_assets (fund_id, asset_id, variant_id, weight_bps) VALUES ($1,$2,$3,$4)', [created.rows[0].id, asset.asset_id, asset.variant_id, asset.weight_bps]);
    const fund = await privateFund(client, userId, created.rows[0].id);
    await client.query('INSERT INTO fund_edit_events (owner_id, fund_id, kind, version, after_state) VALUES ($1,$2,$3,$4,$5::jsonb)', [userId, fund.id, 'created', fund.version, JSON.stringify({ name: fund.name, assets: fund.assets })]);
    await client.query('INSERT INTO fund_copy_events (source_fund_id, source_public_id, source_version, copied_fund_id, copying_user_id, idempotency_key, request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)', [source.id, publicId, source.version, fund.id, userId, idempotencyKey, hash]);
    await client.query('UPDATE funds SET copy_count = copy_count + 1 WHERE id = $1', [source.id]);
    await client.query('COMMIT');
    return { fund, sourceVersion: source.version, alreadyCopied: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

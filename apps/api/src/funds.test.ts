import { beforeEach, expect, it, vi } from 'vitest';

const query = vi.fn();
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));
const poolQuery = vi.fn();
vi.mock('./db.js', () => ({ db: { connect, query: poolQuery } }));
vi.mock('./auth.js', () => ({ ApiFailure: class ApiFailure extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
vi.mock('./catalog.js', () => ({ findSelection: (assetId: string, variantId: string) => ({ mint: `${assetId}:${variantId}` }) }));
vi.mock('./plans.js', () => ({
  prepareAuthorizationCleanup: vi.fn(async () => undefined)
}));

const { createFund, listFundActivity, listFunds, replaceFund } = await import('./funds.js');
const owner = '00000000-0000-4000-8000-000000000001';
const fundId = '00000000-0000-4000-8000-000000000002';
const now = new Date('2026-09-18T00:00:00Z');
const input = { name: 'Growth', assets: [{ assetId: 'solana', variantId: 'sol', weightBps: 5000 }, { assetId: 'bitcoin', variantId: 'btc', weightBps: 5000 }] };

beforeEach(() => {
  query.mockReset(); poolQuery.mockReset(); release.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('INSERT INTO funds')) return { rows: [{ id: fundId, name: input.name, version: 1, created_at: now, updated_at: now }] };
    if (sql.startsWith('SELECT asset_id')) return { rows: input.assets.map(asset => ({ asset_id: asset.assetId, variant_id: asset.variantId, weight_bps: asset.weightBps })) };
    return { rows: [], rowCount: 1 };
  });
});

it('records fund creation in the same transaction as the target basket', async () => {
  await createFund(owner, input);
  const statements = query.mock.calls.map(call => String(call[0]));
  expect(statements[0]).toBe('BEGIN');
  expect(statements.findIndex(sql => sql.startsWith('INSERT INTO fund_edit_events'))).toBeLessThan(statements.indexOf('COMMIT'));
  const event = query.mock.calls.find(call => String(call[0]).startsWith('INSERT INTO fund_edit_events'));
  expect(event?.[1].slice(0, 4)).toEqual([owner, fundId, 'created', 1]);
  expect(JSON.parse(event?.[1][4])).toEqual(input);
});

it('rolls back fund creation if its history cannot be recorded', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('INSERT INTO fund_edit_events')) throw new Error('event insert failed');
    if (sql.startsWith('INSERT INTO funds')) return { rows: [{ id: fundId, name: input.name, version: 1, created_at: now, updated_at: now }] };
    if (sql.startsWith('SELECT asset_id')) return { rows: input.assets.map(asset => ({ asset_id: asset.assetId, variant_id: asset.variantId, weight_bps: asset.weightBps })) };
    return { rows: [], rowCount: 1 };
  });
  await expect(createFund(owner, input)).rejects.toThrow('event insert failed');
  expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
  expect(query.mock.calls.map(call => call[0])).not.toContain('COMMIT');
});

it('records before and after basket snapshots with a fund edit', async () => {
  const next = { name: 'Growth', assets: [{ assetId: 'solana', variantId: 'sol', weightBps: 6000 }, { assetId: 'bitcoin', variantId: 'btc', weightBps: 4000 }], expectedVersion: 1 };
  let reads = 0;
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT id, name, version')) return { rows: [{ id: fundId, name: input.name, version: 1, created_at: now, updated_at: now }], rowCount: 1 };
    if (sql.startsWith('UPDATE funds')) return { rows: [{ id: fundId, name: next.name, version: 2, created_at: now, updated_at: now }] };
    if (sql.startsWith('SELECT asset_id')) return { rows: (reads++ === 0 ? input.assets : next.assets).map(asset => ({ asset_id: asset.assetId, variant_id: asset.variantId, weight_bps: asset.weightBps })) };
    return { rows: [], rowCount: 1 };
  });
  await replaceFund(owner, fundId, next);
  const event = query.mock.calls.find(call => String(call[0]).startsWith('INSERT INTO fund_edit_events'));
  expect(event?.[1].slice(0, 4)).toEqual([owner, fundId, 'updated', 2]);
  expect(JSON.parse(event?.[1][4])).toEqual(input);
  expect(JSON.parse(event?.[1][5])).toEqual({ name: next.name, assets: next.assets });
  expect(query.mock.calls.some(call => String(call[0]).includes("status = 'approval_required'"))).toBe(true);
  expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
});

it('checks fund ownership before reading edit history', async () => {
  poolQuery.mockResolvedValueOnce({ rowCount: 0 });
  await expect(listFundActivity(owner, fundId)).rejects.toThrow('Fund not found.');
  expect(poolQuery).toHaveBeenCalledTimes(1);
});

it('includes publication metadata when listing a public fund', async () => {
  query
    .mockResolvedValueOnce({ rows: [{ id: fundId, name: input.name, version: 1, public_id: '00000000-0000-4000-8000-000000000003', publisher_name: 'Yann', published_at: now, created_at: now, updated_at: now }] })
    .mockResolvedValueOnce({ rows: input.assets.map(asset => ({ asset_id: asset.assetId, variant_id: asset.variantId, weight_bps: asset.weightBps })) });
  const result = await listFunds(owner);
  expect(result.funds[0].publication).toEqual({ publicId: '00000000-0000-4000-8000-000000000003', publisherName: 'Yann', publishedAt: now.toISOString() });
});

it('maps only confirmed recurring payments into fund activity', async () => {
  poolQuery
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] })
    .mockResolvedValueOnce({ rows: [{ id: 'edit', kind: 'updated', version: 2, before_state: input, after_state: input, created_at: now }] })
    .mockResolvedValueOnce({ rows: [{ id: 'leg', signature: 'sig', amount_atomic: '1000000', invested_atomic: '992000', fee_atomic: '8000', profit_fee_atomic: '7500', infrastructure_fee_atomic: '500', sponsored_lamports: '5000', ata_created: true, output_atomic: '42', output_decimals: 8, output_mint: 'mint', created_at: now }] });
  const result = await listFundActivity(owner, fundId);
  expect(result.payments).toEqual([{ id: 'leg', signature: 'sig', amountAtomic: '1000000', investedAtomic: '992000', feeAtomic: '8000', profitFeeAtomic: '7500', infrastructureFeeAtomic: '500', sponsoredLamports: '5000', ataCreated: true, outputAtomic: '42', outputDecimals: 8, outputMint: 'mint', status: 'confirmed', occurredAt: now.toISOString() }]);
  expect(String(poolQuery.mock.calls[2][0])).toContain("l.status = 'confirmed'");
  expect(poolQuery.mock.calls[2][1]).toEqual([fundId, owner]);
});

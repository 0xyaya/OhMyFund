import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const query = vi.fn();
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));
const poolQuery = vi.fn();
vi.mock('./db.js', () => ({ db: { connect, query: poolQuery } }));
vi.mock('./auth.js', () => ({ ApiFailure: class ApiFailure extends Error { constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); } } }));
vi.mock('./catalog.js', () => ({ findSelection: (assetId: string, variantId: string) => assetId === 'unavailable' ? undefined : ({ symbol: assetId.toUpperCase(), name: assetId, mint: `${assetId}:${variantId}` }) }));

const { copyPublicFund, getPublicFund, listPublicFunds, publishFund, unpublishFund } = await import('./public-funds.js');
const owner = '00000000-0000-4000-8000-000000000001';
const copier = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000003';
const copiedId = '00000000-0000-4000-8000-000000000004';
const publicId = '00000000-0000-4000-8000-000000000005';
const requestKey = '00000000-0000-4000-8000-000000000006';
const now = new Date('2026-09-20T00:00:00Z');
const assets = [
  { asset_id: 'solana', variant_id: 'sol', weight_bps: 6000 },
  { asset_id: 'bitcoin', variant_id: 'btc', weight_bps: 4000 }
];
const source = { id: sourceId, owner_id: owner, name: 'Core', version: 3, public_id: publicId, publisher_name: 'Yann', published_at: now, copy_count: '0', created_at: now, updated_at: now };

beforeEach(() => {
  query.mockReset(); poolQuery.mockReset(); release.mockReset(); connect.mockClear();
});

it('loads the top-50 leaderboard in two database queries', async () => {
  query
    .mockResolvedValueOnce({ rows: [{ ...source, rank: '1' }] })
    .mockResolvedValueOnce({ rows: assets.map(asset => ({ fund_id: sourceId, ...asset })) });
  const result = await listPublicFunds();
  expect(query).toHaveBeenCalledTimes(2);
  expect(result.funds[0]).toMatchObject({ publicId, assetCount: 2, copyCount: 0 });
  expect(result.funds[0].topAssets.map(asset => asset.assetId)).toEqual(['solana', 'bitcoin']);
});

it('returns a public fund detail ordered for display', async () => {
  query
    .mockResolvedValueOnce({ rows: [source], rowCount: 1 })
    .mockResolvedValueOnce({ rows: assets });
  const result = await getPublicFund(publicId);
  expect(result).toMatchObject({ publicId, fundName: 'Core', publisherName: 'Yann', assetCount: 2, copyCount: 0 });
  expect(result.assets.map(asset => asset.symbol)).toEqual(['SOLANA', 'BITCOIN']);
});

it('rejects a missing public fund', async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  await expect(getPublicFund(publicId)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  expect(release).toHaveBeenCalledOnce();
});

it('copies the basket, event, activity, and count in one transaction', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT request_hash')) return { rows: [] };
    if (sql.includes('FROM funds WHERE public_id')) return { rows: [source], rowCount: 1 };
    if (sql.startsWith('SELECT asset_id')) return { rows: assets };
    if (sql.startsWith('INSERT INTO funds')) return { rows: [{ id: copiedId, name: 'Core copy', version: 1, created_at: now, updated_at: now }] };
    if (sql.startsWith('SELECT id, name, version')) return { rows: [{ id: copiedId, name: 'Core copy', version: 1, created_at: now, updated_at: now }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const result = await copyPublicFund(copier, publicId, 'Core copy', requestKey);
  const statements = query.mock.calls.map(call => String(call[0]));
  expect(result).toMatchObject({ sourceVersion: 3, alreadyCopied: false, fund: { id: copiedId } });
  expect(statements).toContain('BEGIN');
  expect(statements.findIndex(sql => sql.startsWith('INSERT INTO fund_copy_events'))).toBeLessThan(statements.indexOf('COMMIT'));
  expect(statements.findIndex(sql => sql.startsWith('UPDATE funds SET copy_count'))).toBeLessThan(statements.indexOf('COMMIT'));
});

it('rolls back every copy write when the event cannot be recorded', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT request_hash')) return { rows: [] };
    if (sql.includes('FROM funds WHERE public_id')) return { rows: [source], rowCount: 1 };
    if (sql.startsWith('SELECT asset_id')) return { rows: assets };
    if (sql.startsWith('INSERT INTO funds')) return { rows: [{ id: copiedId, name: 'Core copy', version: 1, created_at: now, updated_at: now }] };
    if (sql.startsWith('SELECT id, name, version')) return { rows: [{ id: copiedId, name: 'Core copy', version: 1, created_at: now, updated_at: now }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO fund_copy_events')) throw new Error('event insert failed');
    return { rows: [], rowCount: 1 };
  });
  await expect(copyPublicFund(copier, publicId, 'Core copy', requestKey)).rejects.toThrow('event insert failed');
  expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
  expect(query.mock.calls.map(call => call[0])).not.toContain('COMMIT');
});

it('replays the original response for the same idempotency key', async () => {
  const requestHash = createHash('sha256').update(`${publicId}\0Core copy`).digest('hex');
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT request_hash')) return { rows: [{ request_hash: requestHash, copied_fund_id: copiedId, source_version: 3 }] };
    if (sql.startsWith('SELECT id, name, version')) return { rows: [{ id: copiedId, name: 'Core copy', version: 1, created_at: now, updated_at: now }], rowCount: 1 };
    if (sql.startsWith('SELECT asset_id')) return { rows: assets };
    return { rows: [], rowCount: 1 };
  });
  const result = await copyPublicFund(copier, publicId, 'Core copy', requestKey);
  expect(result.alreadyCopied).toBe(false);
  expect(query.mock.calls.map(call => call[0])).not.toContain('BEGIN');
});

it('rejects an idempotency key reused with different copy details', async () => {
  query.mockResolvedValueOnce({ rows: [{ request_hash: 'different', copied_fund_id: copiedId, source_version: 3 }] });
  await expect(copyPublicFund(copier, publicId, 'Core copy', requestKey)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  expect(query.mock.calls.map(call => call[0])).not.toContain('BEGIN');
});

it('returns the first copy when the same user copies a source again', async () => {
  const requestHash = createHash('sha256').update(`${publicId}\0Original name`).digest('hex');
  query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ request_hash: requestHash, copied_fund_id: copiedId, source_version: 3 }] })
    .mockResolvedValueOnce({ rows: [{ id: copiedId, name: 'Original name', version: 1, created_at: now, updated_at: now }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: assets });
  const result = await copyPublicFund(copier, publicId, 'Renamed retry', crypto.randomUUID());
  expect(result).toMatchObject({ alreadyCopied: true, fund: { id: copiedId, name: 'Original name' } });
  expect(query.mock.calls.map(call => call[0])).not.toContain('BEGIN');
});

it('rejects copying your own public fund and rolls back', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT request_hash')) return { rows: [] };
    if (sql.includes('FROM funds WHERE public_id')) return { rows: [{ ...source, owner_id: copier }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  await expect(copyPublicFund(copier, publicId, 'Core copy', requestKey)).rejects.toMatchObject({ status: 409, code: 'SELF_COPY' });
  expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
});

it('rejects a source unpublished during copy and rolls back', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT request_hash')) return { rows: [] };
    if (sql.includes('FROM funds WHERE public_id')) return { rows: [{ ...source, published_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  await expect(copyPublicFund(copier, publicId, 'Core copy', requestKey)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
});

it('rejects unavailable assets before creating a copied fund', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT request_hash')) return { rows: [] };
    if (sql.includes('FROM funds WHERE public_id')) return { rows: [source], rowCount: 1 };
    if (sql.startsWith('SELECT asset_id')) return { rows: [{ ...assets[0], asset_id: 'unavailable' }, assets[1]] };
    return { rows: [], rowCount: 1 };
  });
  await expect(copyPublicFund(copier, publicId, 'Core copy', requestKey)).rejects.toMatchObject({ status: 409, code: 'ASSET_UNAVAILABLE' });
  expect(query.mock.calls.some(call => String(call[0]).startsWith('INSERT INTO funds'))).toBe(false);
});

it('returns 200 semantics when a previously published fund is republished', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT id, owner_id')) return { rows: [{ ...source, published_at: null }], rowCount: 1 };
    if (sql.startsWith('SELECT asset_id')) return { rows: assets };
    if (sql.startsWith('UPDATE funds SET public_id')) return { rows: [{ public_id: publicId, publisher_name: 'Yann', published_at: now }] };
    return { rows: [], rowCount: 1 };
  });
  const result = await publishFund(owner, sourceId, 'Yann');
  expect(result.firstPublication).toBe(false);
});

it('rejects publishing a fund owned by another user and rolls back', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
  await expect(publishFund(owner, sourceId, 'Yann')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  expect(query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
});

it('unpublishes an owned fund and rejects a missing fund', async () => {
  poolQuery.mockResolvedValueOnce({ rows: [{ id: sourceId }], rowCount: 1 });
  await expect(unpublishFund(owner, sourceId)).resolves.toEqual({ ok: true });
  poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  await expect(unpublishFund(owner, sourceId)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
});

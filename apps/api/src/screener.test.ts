import { expect, it, vi } from 'vitest';
import { catalogSchema, screenerDetailSchema, screenerListSchema } from '@ohmyfund/contracts';
import { approvedAssets, findSelection, screenerAssets } from './catalog.js';
import { listScreener, screenerDetail } from './screener.js';

vi.mock('./auth.js', () => ({ ApiFailure: class ApiFailure extends Error {} }));

it('loads the approved Tokens snapshot with exact pair identities', () => {
  expect(screenerAssets).toHaveLength(479);
  expect(approvedAssets).toHaveLength(695);
  expect(new Set(approvedAssets.map(item => item.mint)).size).toBe(694);
  catalogSchema.parse({ assets: approvedAssets });
  for (const item of approvedAssets) expect(findSelection(item.assetId, item.variantId)?.mint).toBe(item.mint);
});

it('filters, sorts and pages the public screener', () => {
  const first = screenerListSchema.parse(listScreener({ category: 'equity', q: 'apple', sort: 'name', direction: 'asc', page: '1' }));
  expect(first.rows.some(row => row.assetId === 'apple')).toBe(true);
  expect(first.rows.every(row => row.category === 'equity')).toBe(true);
  const all = screenerListSchema.parse(listScreener({ category: 'crypto' }));
  expect(all.rows.length).toBeLessThanOrEqual(20);
  expect(all.pageCount).toBe(Math.ceil(all.total / 20));
  const currencies = screenerListSchema.parse(listScreener({ category: 'currency' }));
  expect(currencies.total).toBe(17);
  expect(currencies.rows.every(row => row.category === 'currency')).toBe(true);
  expect(new Date(currencies.snapshot.retrievedAt).getTime()).toBeGreaterThan(new Date(all.snapshot.retrievedAt).getTime());
  expect(screenerListSchema.parse(listScreener({ category: 'treasury' })).total).toBe(11);
  expect(() => listScreener({ page: '0' })).toThrow();
});

it('returns variants for one approved asset and rejects unknown assets', () => {
  const detail = screenerDetailSchema.parse(screenerDetail('apple'));
  expect(detail.variants.length).toBeGreaterThan(0);
  expect(detail.variants.some(variant => variant.variantId === detail.primaryVariantId)).toBe(true);
  expect(() => screenerDetail('not-a-real-asset')).toThrow();
});

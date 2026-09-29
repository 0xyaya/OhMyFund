import { expect, it, vi } from 'vitest';
import { fetchJupiterSolPrice } from './jupiter.js';

const mint = 'So11111111111111111111111111111111111111112';
const response = (usdPrice: unknown, blockId: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify({ [mint]: { usdPrice, blockId } }), { status }));

it('returns a fresh SOL price in atomic USDC units', async () => {
  await expect(fetchJupiterSolPrice('key', 1_100, 150, response(116.9341104, 1_000))).resolves.toEqual({
    solPriceAtomicPerSol: 116_934_110n, blockId: 1_000
  });
});

it('rounds the external price to the nearest atomic USDC unit', async () => {
  await expect(fetchJupiterSolPrice('key', 1_000, 1, response(1.0000005, 1_000))).resolves.toMatchObject({ solPriceAtomicPerSol: 1_000_001n });
});

it('rejects stale, future, malformed, and unavailable prices', async () => {
  await expect(fetchJupiterSolPrice('key', 1_151, 150, response(100, 1_000))).rejects.toThrow('stale or future');
  await expect(fetchJupiterSolPrice('key', 999, 150, response(100, 1_000))).rejects.toThrow('stale or future');
  await expect(fetchJupiterSolPrice('key', 1_000, 150, response(-1, 1_000))).rejects.toThrow('missing or malformed');
  await expect(fetchJupiterSolPrice('key', 1_000, 150, response(100, 1_000, 503))).rejects.toThrow('status 503');
});

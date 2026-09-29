import { z } from 'zod';
import { vendorCall } from '../vendor-call.js';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const priceRowSchema = z.object({ usdPrice: z.number().finite().positive(), blockId: z.number().int().positive() });

function decimalPriceToAtomic(value: number) {
  const decimal = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(decimal)) throw new Error('Jupiter returned an unsupported SOL price format.');
  const [whole, fraction = ''] = decimal.split('.');
  const padded = `${fraction}0000000`;
  const rounded = BigInt(whole) * 1_000_000n + BigInt(padded.slice(0, 6));
  return padded[6] >= '5' ? rounded + 1n : rounded;
}

export async function fetchJupiterSolPrice(apiKey: string, currentSlot: number, maximumAgeSlots: number, fetcher: typeof fetch = fetch) {
  const response = await vendorCall('Jupiter SOL price', async signal => {
    const result = await fetcher(`https://api.jup.ag/price/v3?ids=${WRAPPED_SOL_MINT}`, {
      signal, headers: { 'x-api-key': apiKey, accept: 'application/json' }
    });
    if (!result.ok) throw new Error(`Jupiter SOL price failed with status ${result.status}.`);
    return result;
  }, { timeoutMs: 8_000, retries: 2 });
  const body = z.record(z.string(), z.unknown()).parse(await response.json());
  const row = priceRowSchema.safeParse(body[WRAPPED_SOL_MINT]);
  if (!row.success) throw new Error('Jupiter returned a missing or malformed SOL price.');
  if (!Number.isSafeInteger(currentSlot) || currentSlot < row.data.blockId || currentSlot - row.data.blockId > maximumAgeSlots) {
    throw new Error('Jupiter returned a stale or future SOL price.');
  }
  return { solPriceAtomicPerSol: decimalPriceToAtomic(row.data.usdPrice), blockId: row.data.blockId };
}

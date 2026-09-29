import { describe, expect, it } from 'vitest';
import { allocateAtomic, computeChargeBreakdown, feeAtomic, sponsoredCostUsdcAtomic } from './money.js';

describe('atomic money', () => {
  it('preserves the gross total and assigns tied remainder by basket order', () => {
    const result = allocateAtomic(5n, [
      { assetId: 'a', variantId: '1', weightBps: 3334 },
      { assetId: 'b', variantId: '2', weightBps: 3333 },
      { assetId: 'c', variantId: '3', weightBps: 3333 }
    ]);
    expect(result.map(row => row.amountAtomic)).toEqual([2n, 2n, 1n]);
    expect(result.reduce((sum, row) => sum + row.amountAtomic, 0n)).toBe(5n);
  });

  it('uses integer floor rounding for the 0.75% fee', () => {
    expect(feeAtomic(1_000_000n)).toBe(7_500n);
    expect(feeAtomic(99n)).toBe(0n);
  });

  it('rejects invalid totals, basket sizes, and weights', () => {
    const valid = [
      { assetId: 'a', variantId: '1', weightBps: 5_000 },
      { assetId: 'b', variantId: '2', weightBps: 5_000 }
    ];
    expect(() => allocateAtomic(0n, valid)).toThrow('positive');
    expect(() => allocateAtomic(1n, valid.slice(0, 1))).toThrow('2 to 8');
    expect(() => allocateAtomic(1n, valid.map(asset => ({ ...asset, weightBps: 4_000 })))).toThrow('10000');
  });

  it('rejects invalid fee inputs', () => {
    expect(() => feeAtomic(-1n)).toThrow('Invalid fee');
    expect(() => feeAtomic(1n, 10_001)).toThrow('Invalid fee');
    expect(() => feeAtomic(1n, 0.5)).toThrow('Invalid fee');
  });

  it('computes profit, sponsored costs, and net investment without exceeding gross', () => {
    const result = computeChargeBreakdown({
      grossAtomic: 10_000_000n,
      networkFeeLamports: 5_000n,
      rentLamports: 2_039_280n,
      solPriceAtomicPerSol: 150_000_000n,
      maximumInfrastructureAtomic: 500_000n,
      minimumNetInvestmentAtomic: 1_000_000n
    });
    expect(result).toEqual({
      grossAtomic: 10_000_000n,
      profitFeeAtomic: 75_000n,
      infrastructureFeeAtomic: 306_642n,
      feeTransferAtomic: 381_642n,
      netInvestmentAtomic: 9_425_000n,
      sponsoredLamports: 2_044_280n,
      solPriceAtomicPerSol: 150_000_000n
    });
    expect(result.feeTransferAtomic + result.netInvestmentAtomic).toBeLessThanOrEqual(result.grossAtomic);
  });

  it('charges no rent when the destination token account already exists', () => {
    const result = computeChargeBreakdown({
      grossAtomic: 10_000_000n,
      networkFeeLamports: 5_000n,
      rentLamports: 0n,
      solPriceAtomicPerSol: 150_000_000n,
      maximumInfrastructureAtomic: 500_000n,
      minimumNetInvestmentAtomic: 1_000_000n
    });
    expect(result.infrastructureFeeAtomic).toBe(750n);
    expect(result.netInvestmentAtomic).toBe(9_425_000n);
  });

  it('rounds a fractional atomic USDC reimbursement up', () => {
    const result = computeChargeBreakdown({
      grossAtomic: 2_000_000n,
      networkFeeLamports: 1n,
      rentLamports: 0n,
      solPriceAtomicPerSol: 1n,
      maximumInfrastructureAtomic: 1n,
      minimumNetInvestmentAtomic: 1n
    });
    expect(result.infrastructureFeeAtomic).toBe(1n);
  });

  it('quotes setup reimbursement without adding the 0.75% profit fee', () => {
    expect(sponsoredCostUsdcAtomic(5_000n, 2_039_280n, 150_000_000n)).toBe(306_642n);
    expect(sponsoredCostUsdcAtomic(1n, 0n, 1n)).toBe(1n);
  });

  it('rejects reimbursement above the mandate cap or below the net minimum', () => {
    const base = {
      grossAtomic: 1_000_000n,
      networkFeeLamports: 1_000_000n,
      rentLamports: 0n,
      solPriceAtomicPerSol: 100_000_000n,
      maximumInfrastructureAtomic: 99_999n,
      minimumNetInvestmentAtomic: 1n
    };
    expect(() => computeChargeBreakdown(base)).toThrow('approved maximum');
    expect(() => computeChargeBreakdown({ ...base, maximumInfrastructureAtomic: 100_000n, minimumNetInvestmentAtomic: 893_000n })).toThrow('approved minimum');
  });

  it('rejects non-positive and negative charge inputs', () => {
    const valid = {
      grossAtomic: 1_000_000n,
      networkFeeLamports: 5_000n,
      rentLamports: 0n,
      solPriceAtomicPerSol: 100_000_000n,
      maximumInfrastructureAtomic: 500_000n,
      minimumNetInvestmentAtomic: 1n
    };
    expect(() => computeChargeBreakdown({ ...valid, grossAtomic: 0n })).toThrow('Invalid charge');
    expect(() => computeChargeBreakdown({ ...valid, networkFeeLamports: -1n })).toThrow('Invalid charge');
    expect(() => computeChargeBreakdown({ ...valid, solPriceAtomicPerSol: 0n })).toThrow('Invalid charge');
  });
});

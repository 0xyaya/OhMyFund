export type WeightedAsset = { assetId: string; variantId: string; weightBps: number };
export const RECURRING_FEE_BPS = 75 as const;

export function allocateAtomic(totalAtomic: bigint, assets: WeightedAsset[]) {
  if (totalAtomic <= 0n) throw new Error('Total amount must be positive.');
  if (assets.length < 2 || assets.length > 8) throw new Error('A basket must contain 2 to 8 assets.');
  if (assets.reduce((sum, asset) => sum + asset.weightBps, 0) !== 10_000) throw new Error('Weights must total 10000 basis points.');
  const rows = assets.map((asset, index) => {
    const numerator = totalAtomic * BigInt(asset.weightBps);
    return { ...asset, index, amountAtomic: numerator / 10_000n, remainder: numerator % 10_000n };
  });
  let remaining = totalAtomic - rows.reduce((sum, row) => sum + row.amountAtomic, 0n);
  for (const row of [...rows].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining === 0n) break;
    row.amountAtomic += 1n;
    remaining -= 1n;
  }
  return rows.sort((a, b) => a.index - b.index).map(({ remainder: _remainder, ...row }) => row);
}

export function feeAtomic(grossAtomic: bigint, feeBps: number = RECURRING_FEE_BPS) {
  if (grossAtomic < 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error('Invalid fee input.');
  return grossAtomic * BigInt(feeBps) / 10_000n;
}

export type ChargeBreakdownInput = {
  grossAtomic: bigint;
  networkFeeLamports: bigint;
  rentLamports: bigint;
  solPriceAtomicPerSol: bigint;
  maximumInfrastructureAtomic: bigint;
  minimumNetInvestmentAtomic: bigint;
  profitFeeBps?: number;
};

export type ChargeBreakdown = {
  grossAtomic: bigint;
  profitFeeAtomic: bigint;
  infrastructureFeeAtomic: bigint;
  feeTransferAtomic: bigint;
  netInvestmentAtomic: bigint;
  sponsoredLamports: bigint;
  solPriceAtomicPerSol: bigint;
};

const LAMPORTS_PER_SOL = 1_000_000_000n;

function divideRoundUp(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new Error('Invalid rounded division input.');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

export function sponsoredCostUsdcAtomic(networkFeeLamports: bigint, rentLamports: bigint, solPriceAtomicPerSol: bigint) {
  if (networkFeeLamports < 0n || rentLamports < 0n || solPriceAtomicPerSol <= 0n) throw new Error('Invalid sponsored-cost input.');
  return divideRoundUp((networkFeeLamports + rentLamports) * solPriceAtomicPerSol, LAMPORTS_PER_SOL);
}

/**
 * All returned values are integer atomic units. `solPriceAtomicPerSol` is the
 * number of atomic USDC units for one SOL, so no floating point value enters
 * the debit calculation.
 */
export function computeChargeBreakdown(input: ChargeBreakdownInput): ChargeBreakdown {
  const feeBps = input.profitFeeBps ?? RECURRING_FEE_BPS;
  if (input.grossAtomic <= 0n || input.networkFeeLamports < 0n || input.rentLamports < 0n ||
      input.solPriceAtomicPerSol <= 0n || input.maximumInfrastructureAtomic < 0n ||
      input.minimumNetInvestmentAtomic <= 0n) {
    throw new Error('Invalid charge breakdown input.');
  }
  const profitFeeAtomic = feeAtomic(input.grossAtomic, feeBps);
  const sponsoredLamports = input.networkFeeLamports + input.rentLamports;
  const infrastructureFeeAtomic = sponsoredCostUsdcAtomic(input.networkFeeLamports, input.rentLamports, input.solPriceAtomicPerSol);
  if (infrastructureFeeAtomic > input.maximumInfrastructureAtomic) throw new Error('Infrastructure reimbursement exceeds the approved maximum.');
  const feeTransferAtomic = profitFeeAtomic + infrastructureFeeAtomic;
  const netInvestmentAtomic = input.grossAtomic - profitFeeAtomic - input.maximumInfrastructureAtomic;
  if (netInvestmentAtomic <= 0n) throw new Error('Fees consume the approved purchase amount.');
  if (netInvestmentAtomic < input.minimumNetInvestmentAtomic) throw new Error('Net investment is below the approved minimum.');
  return {
    grossAtomic: input.grossAtomic,
    profitFeeAtomic,
    infrastructureFeeAtomic,
    feeTransferAtomic,
    netInvestmentAtomic,
    sponsoredLamports,
    solPriceAtomicPerSol: input.solPriceAtomicPerSol
  };
}

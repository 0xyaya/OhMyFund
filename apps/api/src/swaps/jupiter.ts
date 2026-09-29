import { z } from 'zod';
import { createHash } from 'node:crypto';
import { vendorCall } from '../vendor-call.js';

export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const ALLOWED_TOP_LEVEL_PROGRAMS = new Set([
  JUPITER_PROGRAM,
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
]);

const accountSchema = z.object({ pubkey: z.string().min(32).max(44), isSigner: z.boolean(), isWritable: z.boolean() });
export const apiInstructionSchema = z.object({ programId: z.string().min(32).max(44), accounts: z.array(accountSchema), data: z.string() });
export const jupiterBuildSchema = z.object({
  inputMint: z.string(), outputMint: z.string(), inAmount: z.string().regex(/^\d+$/), outAmount: z.string().regex(/^\d+$/), otherAmountThreshold: z.string().regex(/^\d+$/),
  swapMode: z.string(), slippageBps: z.number().int(), platformFee: z.object({ amount: z.string().regex(/^\d+$/), feeBps: z.number().int() }).optional(),
  routePlan: z.array(z.object({ percent: z.number().optional(), bps: z.number().optional(), swapInfo: z.object({ ammKey: z.string(), label: z.string(), inputMint: z.string(), outputMint: z.string(), inAmount: z.string(), outAmount: z.string() }) })),
  computeBudgetInstructions: z.array(apiInstructionSchema), setupInstructions: z.array(apiInstructionSchema), swapInstruction: apiInstructionSchema,
  cleanupInstruction: apiInstructionSchema.nullable(), otherInstructions: z.array(apiInstructionSchema), tipInstruction: apiInstructionSchema.nullable(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullable(),
  blockhashWithMetadata: z.object({ blockhash: z.array(z.number().int().min(0).max(255)).length(32), lastValidBlockHeight: z.number().int().positive() })
});
export type JupiterBuild = z.infer<typeof jupiterBuildSchema>;

export type BuildSwapInput = { inputMint: string; outputMint: string; amountAtomic: string; taker: string; payer: string; sourceTokenAccount: string; destinationTokenAccount: string; destinationTokenProgram: string; feeAccount: string; feeBps: 0 | 75; slippageBps: number };

export function assertJupiterFallbackPrice(firstMinimumOutput: bigint, candidate: JupiterBuild, maximumDegradationBps = 0) {
  if (!Number.isInteger(maximumDegradationBps) || maximumDegradationBps < 0 || maximumDegradationBps > 10_000) {
    throw new Error('The Jupiter fallback degradation limit is invalid.');
  }
  const minimumAllowedOutput = firstMinimumOutput * BigInt(10_000 - maximumDegradationBps);
  if (BigInt(candidate.otherAmountThreshold) * 10_000n < minimumAllowedOutput) {
    throw new Error('The alternate Jupiter route is below the allowed minimum output.');
  }
}

const discriminator = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const ROUTE = discriminator('route');
const SHARED_ROUTE = discriminator('shared_accounts_route');
const ROUTE_V2 = discriminator('route_v2');
const SHARED_ROUTE_V2 = discriminator('shared_accounts_route_v2');

export function assertPolicyInspectableJupiterBuild(build: JupiterBuild) {
  const discriminator = Buffer.from(build.swapInstruction.data, 'base64').subarray(0, 8);
  if (!discriminator.equals(ROUTE_V2) && !discriminator.equals(SHARED_ROUTE_V2)) {
    throw new Error('Jupiter returned a route version that the recurring policy cannot inspect.');
  }
}

function validateSwapInstruction(build: JupiterBuild, expected: BuildSwapInput) {
  const instruction = build.swapInstruction;
  const data = Buffer.from(instruction.data, 'base64');
  if (data.length < 8) throw new Error('Jupiter swap instruction is too short.');
  const route = data.subarray(0, 8).equals(ROUTE);
  const shared = data.subarray(0, 8).equals(SHARED_ROUTE);
  const routeV2 = data.subarray(0, 8).equals(ROUTE_V2);
  const sharedV2 = data.subarray(0, 8).equals(SHARED_ROUTE_V2);
  if (!route && !shared && !routeV2 && !sharedV2) throw new Error('Jupiter returned an unsupported swap instruction.');
  const minimumLength = sharedV2 ? 28 : routeV2 ? 26 : 27;
  if (data.length < minimumLength) throw new Error('Jupiter swap instruction is too short.');
  // Shared-accounts V2 has a one-byte route id before its fixed swap fields.
  const amount = sharedV2 ? data.readBigUInt64LE(9) : routeV2 ? data.readBigUInt64LE(8) : data.readBigUInt64LE(data.length - 19);
  const quotedOutput = sharedV2 ? data.readBigUInt64LE(17) : routeV2 ? data.readBigUInt64LE(16) : data.readBigUInt64LE(data.length - 11);
  const slippage = sharedV2 ? data.readUInt16LE(25) : routeV2 ? data.readUInt16LE(24) : data.readUInt16LE(data.length - 3);
  const fee = sharedV2 ? data.readUInt8(27) : routeV2 ? 0 : data.readUInt8(data.length - 1);
  if (amount !== BigInt(expected.amountAtomic) || quotedOutput !== BigInt(build.outAmount) || slippage > expected.slippageBps || fee !== expected.feeBps) throw new Error('Jupiter instruction data does not match the mandate.');
  const accounts = instruction.accounts;
  const exact = (index: number, value: string) => accounts[index]?.pubkey === value;
  const validAccounts = route
    ? exact(1, expected.taker) && exact(2, expected.sourceTokenAccount) && exact(3, expected.destinationTokenAccount) && exact(5, expected.outputMint) && exact(6, expected.feeAccount)
    : shared ? exact(2, expected.taker) && exact(3, expected.sourceTokenAccount) && exact(6, expected.destinationTokenAccount) && exact(7, expected.inputMint) && exact(8, expected.outputMint) && exact(9, expected.feeAccount)
      : routeV2 ? exact(0, expected.taker) && exact(1, expected.sourceTokenAccount) && exact(2, expected.destinationTokenAccount) && exact(3, expected.inputMint) && exact(4, expected.outputMint) && exact(7, expected.destinationTokenAccount)
        : exact(1, expected.taker) && exact(2, expected.sourceTokenAccount) && exact(5, expected.destinationTokenAccount) && exact(6, expected.inputMint) && exact(7, expected.outputMint);
  if (!validAccounts) throw new Error('Jupiter swap accounts do not match the mandate.');
  const roleIndexes = route ? { signer: 1, source: 2, destination: 3, mint: 5, fee: 6 }
    : shared ? { signer: 2, source: 3, destination: 6, mint: 8, fee: 9 }
      : routeV2 ? { signer: 0, source: 1, destination: 7, mint: 4, fee: -1 }
        : { signer: 1, source: 2, destination: 5, mint: 7, fee: -1 };
  if (!accounts[roleIndexes.signer]?.isSigner || accounts[roleIndexes.signer]?.isWritable ||
      !accounts[roleIndexes.source]?.isWritable || !accounts[roleIndexes.destination]?.isWritable ||
      accounts[roleIndexes.mint]?.isWritable || (roleIndexes.fee >= 0 && !accounts[roleIndexes.fee]?.isWritable) ||
      accounts.some((account, index) => account.isSigner && index !== roleIndexes.signer)) {
    throw new Error('Jupiter swap account permissions do not match the mandate.');
  }
}

export function validateJupiterBuild(build: JupiterBuild, expected: BuildSwapInput) {
  if (build.inputMint !== expected.inputMint || build.outputMint !== expected.outputMint || build.inAmount !== expected.amountAtomic) throw new Error('Jupiter returned different swap terms.');
  if (build.slippageBps > expected.slippageBps || build.swapMode !== 'ExactIn') throw new Error('Jupiter returned unsafe slippage or swap mode.');
  const quotedOutput = BigInt(build.outAmount);
  const threshold = BigInt(build.otherAmountThreshold);
  const minimumThreshold = (quotedOutput * BigInt(10_000 - build.slippageBps) + 9_999n) / 10_000n;
  if (quotedOutput <= 0n || threshold !== minimumThreshold) throw new Error('Jupiter returned an inconsistent minimum output.');
  const expectedFee = BigInt(expected.amountAtomic) * BigInt(expected.feeBps) / 10_000n;
  if (expected.feeBps === 0) {
    if (build.platformFee && (build.platformFee.feeBps !== 0 || BigInt(build.platformFee.amount) !== 0n)) throw new Error('Jupiter returned an unexpected platform fee.');
  } else if (!build.platformFee || build.platformFee.feeBps !== expected.feeBps || BigInt(build.platformFee.amount) !== expectedFee) {
    throw new Error('Jupiter did not apply the required platform fee.');
  }
  if (build.swapInstruction.programId !== JUPITER_PROGRAM) throw new Error('Jupiter returned an unexpected swap program.');
  const instructions = [...build.computeBudgetInstructions, ...build.setupInstructions, build.swapInstruction, ...(build.cleanupInstruction ? [build.cleanupInstruction] : []), ...build.otherInstructions, ...(build.tipInstruction ? [build.tipInstruction] : [])];
  if (instructions.some(instruction => !ALLOWED_TOP_LEVEL_PROGRAMS.has(instruction.programId))) throw new Error('Jupiter returned an unexpected top-level program.');
  if (build.tipInstruction || build.cleanupInstruction || build.otherInstructions.length) throw new Error('Jupiter returned unsupported auxiliary instructions.');
  if (build.computeBudgetInstructions.some(instruction => instruction.programId !== 'ComputeBudget111111111111111111111111111111' || instruction.accounts.some(account => account.isSigner))) throw new Error('Jupiter returned an invalid compute instruction.');
  if (build.setupInstructions.length > 1 || build.setupInstructions.some(instruction => {
    const accounts = instruction.accounts;
    return instruction.programId !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' || instruction.data !== 'AQ==' ||
      accounts[0]?.pubkey !== expected.payer || !accounts[0]?.isSigner || !accounts[0]?.isWritable ||
      accounts[1]?.pubkey !== expected.destinationTokenAccount || !accounts[1]?.isWritable || accounts[2]?.pubkey !== expected.taker ||
      accounts[3]?.pubkey !== expected.outputMint || accounts[4]?.pubkey !== '11111111111111111111111111111111' || accounts[5]?.pubkey !== expected.destinationTokenProgram ||
      accounts.some((account, index) => account.isSigner && index !== 0);
  })) throw new Error('Jupiter returned an unsupported setup instruction.');
  validateSwapInstruction(build, expected);
  return build;
}

export async function fetchJupiterBuild(input: BuildSwapInput, apiKey: string, fetcher: typeof fetch = fetch, maxAccounts = 40, excludedDexes: readonly string[] = []) {
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 64) throw new Error('Jupiter max accounts is invalid.');
  if (excludedDexes.length > 8 || excludedDexes.some(label => !label.trim() || label.length > 100)) throw new Error('Jupiter excluded DEX list is invalid.');
  const query = new URLSearchParams({
    inputMint: input.inputMint, outputMint: input.outputMint, amount: input.amountAtomic, taker: input.taker,
    slippageBps: String(input.slippageBps),
    destinationTokenAccount: input.destinationTokenAccount, wrapAndUnwrapSol: 'false', payer: input.payer, skipUserAccountsRpcCalls: 'true',
    onlyDirectRoutes: 'true', maxAccounts: String(maxAccounts)
  });
  if (excludedDexes.length) query.set('excludeDexes', [...new Set(excludedDexes)].join(','));
  if (input.feeBps > 0) {
    query.set('platformFeeBps', String(input.feeBps));
    query.set('feeAccount', input.feeAccount);
  }
  const response = await vendorCall('Jupiter', async signal => {
    const result = await fetcher(`https://api.jup.ag/swap/v2/build?${query}`, { signal, headers: { 'x-api-key': apiKey, accept: 'application/json' } });
    if (!result.ok) throw new Error(`Jupiter build failed with status ${result.status}.`);
    return result;
  }, { timeoutMs: 10_000, retries: 2 });
  const build = validateJupiterBuild(jupiterBuildSchema.parse(await response.json()), input);
  assertPolicyInspectableJupiterBuild(build);
  return { ...build, setupInstructions: [] };
}

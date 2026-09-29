import { expect, it, vi } from 'vitest';
import { assertJupiterFallbackPrice, assertPolicyInspectableJupiterBuild, fetchJupiterBuild, JUPITER_PROGRAM, validateJupiterBuild, type BuildSwapInput, type JupiterBuild } from './jupiter.js';

const input: BuildSwapInput = { inputMint: 'USDCmint111111111111111111111111111111111', outputMint: 'OutputMint1111111111111111111111111111111', amountAtomic: '1000000', taker: 'Taker1111111111111111111111111111111111111', payer: 'Payer11111111111111111111111111111111111111', sourceTokenAccount: 'SourceATA11111111111111111111111111111111111', destinationTokenAccount: 'DestATA111111111111111111111111111111111111', destinationTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', feeAccount: 'FeeAccount11111111111111111111111111111111', feeBps: 75, slippageBps: 100 };
const routeData = Buffer.alloc(27);
routeData.set(Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]), 0);
routeData.writeBigUInt64LE(1_000_000n, 8);
routeData.writeBigUInt64LE(10n, 16);
routeData.writeUInt16LE(100, 24);
routeData.writeUInt8(75, 26);
const routeAccounts = ['TokenProgram1111111111111111111111111111111', input.taker, input.sourceTokenAccount, input.destinationTokenAccount, 'Optional111111111111111111111111111111111', input.outputMint, input.feeAccount];
const instruction = { programId: JUPITER_PROGRAM, accounts: routeAccounts.map((pubkey, index) => ({ pubkey, isSigner: index === 1, isWritable: [2, 3, 4, 6].includes(index) })), data: routeData.toString('base64') };
const build: JupiterBuild = { inputMint: input.inputMint, outputMint: input.outputMint, inAmount: input.amountAtomic, outAmount: '10', otherAmountThreshold: '10', swapMode: 'ExactIn', slippageBps: 100, platformFee: { amount: '7500', feeBps: 75 }, routePlan: [], computeBudgetInstructions: [], setupInstructions: [], swapInstruction: instruction, cleanupInstruction: null, otherInstructions: [], tipInstruction: null, addressesByLookupTableAddress: null, blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 1 } };
const zeroFeeInput = { ...input, feeBps: 0 as const };
const v2Data = Buffer.alloc(26);
v2Data.set(Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]), 0);
v2Data.writeBigUInt64LE(1_000_000n, 8); v2Data.writeBigUInt64LE(10n, 16); v2Data.writeUInt16LE(100, 24);
const v2Accounts = [input.taker, input.sourceTokenAccount, input.destinationTokenAccount, input.inputMint, input.outputMint,
  'ProgramSource1111111111111111111111111111111', 'ProgDst1111111111111111111111111111111111', input.destinationTokenAccount]
  .map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: [1, 2, 5, 6, 7].includes(index) }));
const v2Build = { ...build, platformFee: undefined, swapInstruction: { programId: JUPITER_PROGRAM, accounts: v2Accounts, data: v2Data.toString('base64') } };

it('accepts an exact fee-bearing Jupiter build', () => expect(validateJupiterBuild(build, input)).toBe(build));
it('enforces the configured fallback price degradation limit', () => {
  expect(() => assertJupiterFallbackPrice(10n, build)).not.toThrow();
  expect(() => assertJupiterFallbackPrice(10_000n, { ...build, otherAmountThreshold: '9990' }, 10)).not.toThrow();
  expect(() => assertJupiterFallbackPrice(10_000n, { ...build, otherAmountThreshold: '9989' }, 10)).toThrow('below the allowed minimum output');
  expect(() => assertJupiterFallbackPrice(10_000n, { ...build, otherAmountThreshold: '100' }, 10)).toThrow('below the allowed minimum output');
});
it('accepts a zero-platform-fee build for a locally composed fee transfer', () => {
  const zeroFeeInput = { ...input, feeBps: 0 as const };
  const data = Buffer.from(build.swapInstruction.data, 'base64');
  data[data.length - 1] = 0;
  const zeroFeeBuild = { ...build, platformFee: undefined, swapInstruction: { ...build.swapInstruction, data: data.toString('base64') } };
  expect(validateJupiterBuild(zeroFeeBuild, zeroFeeInput)).toBe(zeroFeeBuild);
});
it('accepts current Jupiter V2 route layouts with leading exact-in amounts', () => {
  expect(validateJupiterBuild(v2Build, zeroFeeInput)).toBe(v2Build);
  expect(() => assertPolicyInspectableJupiterBuild(v2Build)).not.toThrow();
  expect(() => assertPolicyInspectableJupiterBuild(build)).toThrow('route version');
  expect(() => validateJupiterBuild({ ...v2Build, swapInstruction: { ...v2Build.swapInstruction, accounts: v2Build.swapInstruction.accounts.map((account, index) => index === 2 ? { ...account, pubkey: 'WrongDest1111111111111111111111111111111111' } : account) } }, zeroFeeInput)).toThrow('accounts do not match');
  expect(() => validateJupiterBuild({ ...v2Build, swapInstruction: { ...v2Build.swapInstruction, accounts: v2Build.swapInstruction.accounts.map((account, index) => index === 7 ? { ...account, pubkey: 'WrongDest1111111111111111111111111111111111' } : account) } }, zeroFeeInput)).toThrow('accounts do not match');
});
it('accepts shared-accounts V2 using its route-id-prefixed data layout', () => {
  const zeroFeeInput = { ...input, feeBps: 0 as const };
  const data = Buffer.alloc(28);
  data.set(Buffer.from([209, 152, 83, 147, 124, 254, 216, 233]), 0);
  data.writeUInt8(6, 8);
  data.writeBigUInt64LE(1_000_000n, 9);
  data.writeBigUInt64LE(10n, 17);
  data.writeUInt16LE(100, 25);
  data.writeUInt8(0, 27);
  const accounts = [
    'ProgramAuthority11111111111111111111111111111', input.taker, input.sourceTokenAccount,
    'ProgramSource1111111111111111111111111111111', 'ProgramDest11111111111111111111111111111111111',
    input.destinationTokenAccount, input.inputMint, input.outputMint
  ].map((pubkey, index) => ({ pubkey, isSigner: index === 1, isWritable: [2, 3, 4, 5].includes(index) }));
  const sharedV2 = { ...build, platformFee: undefined, swapInstruction: { programId: JUPITER_PROGRAM, accounts, data: data.toString('base64') } };
  expect(validateJupiterBuild(sharedV2, zeroFeeInput)).toBe(sharedV2);
  expect(() => assertPolicyInspectableJupiterBuild(sharedV2)).not.toThrow();
  const changed = Buffer.from(data); changed.writeBigUInt64LE(999_999n, 9);
  expect(() => validateJupiterBuild({ ...sharedV2, swapInstruction: { ...sharedV2.swapInstruction, data: changed.toString('base64') } }, zeroFeeInput)).toThrow('does not match the mandate');
});
it('accepts the shared-accounts route only with its exact account layout', () => {
  const sharedData = Buffer.from(routeData);
  sharedData.set(Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]), 0);
  const sharedAccounts = [
    'TokenProgram1111111111111111111111111111111',
    'Authority1111111111111111111111111111111111', input.taker, input.sourceTokenAccount,
    'ProgramSource1111111111111111111111111111111', 'ProgramDest11111111111111111111111111111111111',
    input.destinationTokenAccount, input.inputMint, input.outputMint, input.feeAccount
  ];
  const sharedInstruction = { programId: JUPITER_PROGRAM, accounts: sharedAccounts.map((pubkey, index) => ({ pubkey, isSigner: index === 2, isWritable: [3, 4, 5, 6, 9].includes(index) })), data: sharedData.toString('base64') };
  expect(validateJupiterBuild({ ...build, swapInstruction: sharedInstruction }, input)).toBeTruthy();
  expect(() => validateJupiterBuild({ ...build, swapInstruction: { ...sharedInstruction, accounts: sharedInstruction.accounts.map((account, index) => index === 9 ? { ...account, pubkey: 'WrongFee11111111111111111111111111111111111' } : account) } }, input)).toThrow('accounts do not match');
});
it('rejects an extra top-level program', () => expect(() => validateJupiterBuild({ ...build, otherInstructions: [{ ...instruction, programId: 'BadProgram111111111111111111111111111111111' }] }, input)).toThrow('unexpected top-level program'));
it('rejects a wrong fee account', () => expect(() => validateJupiterBuild(build, { ...input, feeAccount: 'OtherFee1111111111111111111111111111111111' })).toThrow('accounts do not match'));
it('rejects a wrong fee amount', () => expect(() => validateJupiterBuild({ ...build, platformFee: { amount: '7499', feeBps: 75 } }, input)).toThrow('required platform fee'));
it('rejects unsafe swap account permissions', () => expect(() => validateJupiterBuild({ ...build, swapInstruction: { ...instruction, accounts: instruction.accounts.map((account, index) => index === 2 ? { ...account, isWritable: false } : account) } }, input)).toThrow('permissions'));
it('rejects any unexpected Jupiter signer account', () => expect(() => validateJupiterBuild({ ...build, swapInstruction: { ...instruction, accounts: instruction.accounts.map((account, index) => index === 4 ? { ...account, isSigner: true } : account) } }, input)).toThrow('permissions'));
it('rejects all Jupiter setup instructions because ATA creation is composed locally', () => expect(() => validateJupiterBuild({ ...build, setupInstructions: [{ programId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', accounts: [], data: '' }] }, input)).toThrow('unsupported setup instruction'));
it('rejects unsafe slippage, swap mode, and missing fee metadata', () => {
  expect(() => validateJupiterBuild({ ...build, slippageBps: 101 }, input)).toThrow('unsafe slippage');
  expect(() => validateJupiterBuild({ ...build, swapMode: 'ExactOut' }, input)).toThrow('unsafe slippage');
  expect(() => validateJupiterBuild({ ...build, platformFee: undefined }, input)).toThrow('required platform fee');
});
it('rejects unsupported swap instruction data and changed mandate amounts', () => {
  const unsupported = { ...instruction, data: Buffer.alloc(27).toString('base64') };
  expect(() => validateJupiterBuild({ ...build, swapInstruction: unsupported }, input)).toThrow('unsupported swap instruction');
  const changed = Buffer.from(routeData); changed.writeBigUInt64LE(999_999n, 8);
  expect(() => validateJupiterBuild({ ...build, swapInstruction: { ...instruction, data: changed.toString('base64') } }, input)).toThrow('does not match the mandate');
});
it('rejects changed quoted output and inconsistent minimum output', () => {
  const changed = Buffer.from(routeData); changed.writeBigUInt64LE(1n, 16);
  expect(() => validateJupiterBuild({ ...build, swapInstruction: { ...instruction, data: changed.toString('base64') } }, input)).toThrow('does not match the mandate');
  expect(() => validateJupiterBuild({ ...build, otherAmountThreshold: '8' }, input)).toThrow('inconsistent minimum output');
});
it('rejects tips, cleanup instructions, and non-compute budget instructions', () => {
  expect(() => validateJupiterBuild({ ...build, tipInstruction: instruction }, input)).toThrow('unsupported auxiliary');
  expect(() => validateJupiterBuild({ ...build, cleanupInstruction: instruction }, input)).toThrow('unsupported auxiliary');
  expect(() => validateJupiterBuild({ ...build, computeBudgetInstructions: [{ ...instruction, programId: JUPITER_PROGRAM }] }, input)).toThrow('invalid compute instruction');
});
it('builds the exact Jupiter request and validates the response', async () => {
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(v2Build), { status: 200 }));
  await expect(fetchJupiterBuild(zeroFeeInput, 'secret', fetcher)).resolves.toBeTruthy();
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).not.toContain('platformFeeBps');
  expect(String(url)).toContain(`destinationTokenAccount=${input.destinationTokenAccount}`);
  expect(String(url)).toContain('wrapAndUnwrapSol=false');
  expect(String(url)).toContain(`payer=${input.payer}`);
  expect(String(url)).toContain('onlyDirectRoutes=true');
  expect(String(url)).toContain('maxAccounts=40');
  expect(options?.headers).toMatchObject({ 'x-api-key': 'secret' });
});
it('rejects a fetched legacy route even when its amounts and accounts are otherwise valid', async () => {
  const data = Buffer.from(build.swapInstruction.data, 'base64'); data[data.length - 1] = 0;
  const legacyBuild = { ...build, platformFee: undefined, swapInstruction: { ...build.swapInstruction, data: data.toString('base64') } };
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(legacyBuild), { status: 200 }));
  await expect(fetchJupiterBuild(zeroFeeInput, 'secret', fetcher)).rejects.toThrow('route version');
});
it('excludes DEXes that failed a previous route simulation', async () => {
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(v2Build), { status: 200 }));
  await fetchJupiterBuild(zeroFeeInput, 'secret', fetcher, 40, ['GoonFi V2', 'Deriverse']);
  expect(String(fetcher.mock.calls[0][0])).toContain('excludeDexes=GoonFi+V2%2CDeriverse');
});
it('fails closed when Jupiter returns an HTTP error', async () => {
  const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('', { status: 429 }));
  await expect(fetchJupiterBuild(input, 'secret', fetcher)).rejects.toThrow('status 429');
});

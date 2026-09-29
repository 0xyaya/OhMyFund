import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction,
  compressTransactionMessageUsingAddressLookupTables, createTransactionMessage,
  createSolanaRpc, fetchAddressesForLookupTables,
  getBase58Decoder, getBase64Codec, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type AddressesByLookupTableAddress, type Base64EncodedBytes,
  type Blockhash, type Instruction
} from '@solana/kit';
import { createHash } from 'node:crypto';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { ExtensionType, GET_ACCOUNT_DATA_SIZE_DISCRIMINATOR } from '@solana-program/token-2022';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { JupiterBuild } from './swaps/jupiter.js';

export class SolanaSimulationError extends Error {
  constructor(readonly cause: unknown) {
    super('Solana simulation failed.');
    this.name = 'SolanaSimulationError';
  }
}

export function isJupiterSlippageSimulationError(error: unknown) {
  if (!(error instanceof SolanaSimulationError)) return false;
  const encoded = JSON.stringify(error.cause);
  return encoded.includes('"Custom":6001') || encoded.includes('"Custom": 6001');
}
import { vendorCall } from './vendor-call.js';

const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_COMPUTE_UNIT_PRICE = 1_000_000n;
const MAX_TRANSACTION_BYTES = 1_232;
export const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

function instruction(raw: JupiterBuild['swapInstruction']): Instruction {
  return {
    programAddress: address(raw.programId),
    accounts: raw.accounts.map(account => ({
      address: address(account.pubkey),
      role: account.isSigner && account.isWritable ? AccountRole.WRITABLE_SIGNER
        : account.isSigner ? AccountRole.READONLY_SIGNER
          : account.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
    })),
    data: Uint8Array.from(getBase64Codec().encode(raw.data as Base64EncodedBytes))
  };
}

function computeLimitInstruction(units: number): Instruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array(data) };
}

function computePriceInstruction(microLamports: number): Instruction {
  if (!Number.isSafeInteger(microLamports) || microLamports < 0 || BigInt(microLamports) > MAX_COMPUTE_UNIT_PRICE) throw new Error('Setup compute price exceeds the configured cap.');
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(microLamports), 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array(data) };
}

export function assertComputePrice(build: JupiterBuild) {
  for (const raw of build.computeBudgetInstructions) {
    const data = Buffer.from(raw.data, 'base64');
    if (data[0] === 2 && data.length === 5) {
      if (data.readUInt32LE(1) > MAX_COMPUTE_UNITS) throw new Error('Jupiter compute limit exceeds the configured cap.');
      continue;
    }
    if (data[0] === 3 && data.length === 9) {
      if (data.readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE) throw new Error('Jupiter compute price exceeds the configured cap.');
      continue;
    }
    throw new Error('Jupiter returned an unsupported compute instruction.');
  }
}

export function assertLookupTablesMatch(claimed: AddressesByLookupTableAddress, fetched: AddressesByLookupTableAddress) {
  const entries = Object.entries(claimed);
  if (entries.length !== Object.keys(fetched).length || entries.some(([table, values]) => {
    const actual = fetched[table as Address];
    return !actual || actual.length !== values.length || values.some((value, index) => actual[index] !== value);
  })) throw new Error('Jupiter lookup-table contents do not match Solana.');
}

export async function verifiedLookupTables(build: JupiterBuild, rpcUrl: string) {
  const claimed: AddressesByLookupTableAddress = Object.fromEntries(Object.entries(build.addressesByLookupTableAddress ?? {}).map(([key, values]) => [address(key), values.map(value => address(value))]));
  const keys = Object.keys(claimed).map(value => address(value));
  if (!keys.length) return claimed;
  const fetched = await vendorCall('Solana RPC lookup tables', () => fetchAddressesForLookupTables(keys, createSolanaRpc(rpcUrl), { commitment: 'confirmed' }), { timeoutMs: 10_000, retries: 2 });
  assertLookupTablesMatch(claimed, fetched);
  return fetched;
}

export function tokenTransferCheckedInstruction(input: { source: string; mint: string; destination: string; owner: string; amountAtomic: bigint; decimals?: number }): Instruction {
  if (input.amountAtomic <= 0n) throw new Error('USDC fee transfer must be positive.');
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(input.amountAtomic, 1);
  data.writeUInt8(input.decimals ?? 6, 9);
  return { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [
    { address: address(input.source), role: AccountRole.WRITABLE },
    { address: address(input.mint), role: AccountRole.READONLY },
    { address: address(input.destination), role: AccountRole.WRITABLE },
    { address: address(input.owner), role: AccountRole.READONLY_SIGNER }
  ], data: new Uint8Array(data) };
}

export function createAssociatedTokenAccountInstruction(input: { payer: string; account: string; owner: string; mint: string; tokenProgram: string }): Instruction {
  return { programAddress: ASSOCIATED_TOKEN_PROGRAM, accounts: [
    { address: address(input.payer), role: AccountRole.WRITABLE_SIGNER },
    { address: address(input.account), role: AccountRole.WRITABLE },
    { address: address(input.owner), role: AccountRole.READONLY },
    { address: address(input.mint), role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: address(input.tokenProgram), role: AccountRole.READONLY }
  ], data: new Uint8Array([1]) };
}

function compile(build: JupiterBuild, payer: string, units: number, lookupTables: AddressesByLookupTableAddress = {}, localInstructions: Instruction[] = [], staticAccountsOnly = false) {
  assertComputePrice(build);
  const normal = [
    ...build.setupInstructions, build.swapInstruction,
    ...(build.cleanupInstruction ? [build.cleanupInstruction] : []),
    ...build.otherInstructions
  ].map(instruction);
  if (!staticAccountsOnly && Object.keys(build.addressesByLookupTableAddress ?? {}).length && !Object.keys(lookupTables).length) throw new Error('Verified Solana lookup tables are required.');
  const lifetime = {
    blockhash: getBase58Decoder().decode(Uint8Array.from(build.blockhashWithMetadata.blockhash)) as Blockhash,
    lastValidBlockHeight: BigInt(build.blockhashWithMetadata.lastValidBlockHeight)
  };
  return pipe(
    createTransactionMessage({ version: 0 }),
    message => appendTransactionMessageInstructions([computeLimitInstruction(units), ...build.computeBudgetInstructions.filter(raw => Buffer.from(raw.data, 'base64')[0] !== 2).map(instruction), ...localInstructions, ...normal], message),
    message => staticAccountsOnly ? message : compressTransactionMessageUsingAddressLookupTables(message, lookupTables),
    message => setTransactionMessageFeePayer(address(payer) as Address, message),
    message => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
    message => compileTransaction(message)
  );
}

function compiled(build: JupiterBuild, payer: string, units = MAX_COMPUTE_UNITS, lookupTables: AddressesByLookupTableAddress = {}, localInstructions: Instruction[] = [], staticAccountsOnly = false) {
  return compile(build, payer, units, lookupTables, localInstructions, staticAccountsOnly);
}

export function unsignedTransactionBase64(build: JupiterBuild, payer: string, units = MAX_COMPUTE_UNITS, lookupTables: AddressesByLookupTableAddress = {}, localInstructions: Instruction[] = [], staticAccountsOnly = false) {
  const encoded = getBase64EncodedWireTransaction(compile(build, payer, units, lookupTables, localInstructions, staticAccountsOnly));
  if (Buffer.from(encoded, 'base64').length > MAX_TRANSACTION_BYTES) throw new Error('The Jupiter route exceeds Solana transaction size limits.');
  return encoded;
}

export function unsignedTransactionHex(build: JupiterBuild, payer: string, units = MAX_COMPUTE_UNITS, lookupTables: AddressesByLookupTableAddress = {}, localInstructions: Instruction[] = [], staticAccountsOnly = false) {
  return Buffer.from(unsignedTransactionBase64(build, payer, units, lookupTables, localInstructions, staticAccountsOnly), 'base64').toString('hex');
}

export type SetupTransactionAccount = { account: string; owner: string; mint: string; tokenProgram: string };
export type SetupTransactionInput = {
  sponsor: string; user: string; sourceTokenAccount: string; usdcMint: string; feeTokenAccount: string;
  reimbursementAtomic: bigint; accounts: SetupTransactionAccount[]; blockhash: string; lastValidBlockHeight: number;
  computeUnits: number; computeUnitPriceMicroLamports: number;
};

function compileSetupTransaction(input: SetupTransactionInput) {
  if (input.accounts.length < 1 || input.accounts.length > 8) throw new Error('Setup must create from one to eight token accounts.');
  if (!Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight <= 0) throw new Error('Setup blockhash lifetime is invalid.');
  const instructions = [
    computeLimitInstruction(input.computeUnits),
    ...(input.computeUnitPriceMicroLamports ? [computePriceInstruction(input.computeUnitPriceMicroLamports)] : []),
    ...input.accounts.map(accountInput => createAssociatedTokenAccountInstruction({ payer: input.sponsor, ...accountInput })),
    tokenTransferCheckedInstruction({ source: input.sourceTokenAccount, mint: input.usdcMint, destination: input.feeTokenAccount, owner: input.user, amountAtomic: input.reimbursementAtomic })
  ];
  return pipe(
    createTransactionMessage({ version: 0 }),
    message => appendTransactionMessageInstructions(instructions, message),
    message => setTransactionMessageFeePayer(address(input.sponsor), message),
    message => setTransactionMessageLifetimeUsingBlockhash({
      blockhash: getBase58Decoder().decode(bs58.decode(input.blockhash)) as Blockhash,
      lastValidBlockHeight: BigInt(input.lastValidBlockHeight)
    }, message),
    message => compileTransaction(message)
  );
}

export function setupTransactionBase64(input: SetupTransactionInput) {
  const encoded = getBase64EncodedWireTransaction(compileSetupTransaction(input));
  if (Buffer.from(encoded, 'base64').length > MAX_TRANSACTION_BYTES) throw new Error('The account-setup transaction exceeds Solana v0 size limits.');
  return encoded;
}

export function setupTransactionHex(input: SetupTransactionInput) {
  const hex = Buffer.from(setupTransactionBase64(input), 'base64').toString('hex');
  assertRequiredSigners(hex, [input.sponsor, input.user]);
  return hex;
}

export function transactionMessageFingerprint(transactionHex: string) {
  const transaction = transactionParts(transactionHex);
  return createHash('sha256').update(transaction.bytes.subarray(transaction.messageOffset)).digest('hex');
}

function transactionParts(transactionHex: string) {
  const bytes = Buffer.from(transactionHex, 'hex');
  if (!bytes.length || transactionHex.length !== bytes.length * 2) throw new Error('Solana transaction encoding is invalid.');
  let signatureCount = 0;
  let shift = 0;
  let prefixLength = 0;
  for (; prefixLength < Math.min(bytes.length, 3); prefixLength++) {
    const byte = bytes[prefixLength];
    signatureCount |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) { prefixLength++; break; }
    shift += 7;
  }
  if (!prefixLength || prefixLength > 3 || signatureCount < 1 || signatureCount > 32) throw new Error('Solana transaction signature count is invalid.');
  const messageOffset = prefixLength + signatureCount * 64;
  if (bytes.length <= messageOffset) throw new Error('Solana transaction signature layout is invalid.');
  return { bytes, signatureCount, prefixLength, messageOffset };
}

function readShortU16(bytes: Buffer, offset: number) {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 3; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw new Error('Solana transaction message is truncated.');
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, length: index + 1 };
    shift += 7;
  }
  throw new Error('Solana transaction message has an invalid compact length.');
}

function signerAddresses(transactionHex: string) {
  const transaction = transactionParts(transactionHex);
  const message = transaction.bytes.subarray(transaction.messageOffset);
  const versioned = (message[0] & 0x80) !== 0;
  const headerOffset = versioned ? 1 : 0;
  const required = message[headerOffset];
  if (required !== transaction.signatureCount) throw new Error('Solana transaction signer count does not match its message.');
  const accounts = readShortU16(message, headerOffset + 3);
  const start = headerOffset + 3 + accounts.length;
  if (accounts.value < required || start + accounts.value * 32 > message.length) throw new Error('Solana transaction account list is invalid.');
  return Array.from({ length: required }, (_, index) => bs58.encode(message.subarray(start + index * 32, start + (index + 1) * 32)));
}

export function assertRequiredSigners(transactionHex: string, expectedSigners: string[]) {
  const actual = signerAddresses(transactionHex);
  if (actual.length !== expectedSigners.length || actual.some((signer, index) => signer !== expectedSigners[index])) {
    throw new Error('The Solana transaction does not have the exact required signers in order.');
  }
}

/**
 * Signing slots for sponsored recurring buys:
 *
 *   slot 0  sponsor fee payer  -> Solana transaction ID
 *   slot 1  user wallet        -> Jupiter + USDC authority
 *            | same immutable message bytes |
 */
export function assertSignatureAddedBy(unsignedOrPartialHex: string, signedHex: string, expectedSigner: string) {
  const before = transactionParts(unsignedOrPartialHex);
  const after = transactionParts(signedHex);
  if (before.signatureCount !== after.signatureCount || before.bytes.length !== after.bytes.length ||
      !after.bytes.subarray(after.messageOffset).equals(before.bytes.subarray(before.messageOffset))) {
    throw new Error('Turnkey returned a transaction with a changed Solana message.');
  }
  const signers = signerAddresses(unsignedOrPartialHex);
  const expectedIndex = signers.indexOf(expectedSigner);
  if (expectedIndex < 0 || signers.lastIndexOf(expectedSigner) !== expectedIndex) throw new Error('The expected Turnkey signer is not a unique required signer.');
  for (let index = 0; index < before.signatureCount; index++) {
    const start = before.prefixLength + index * 64;
    const prior = before.bytes.subarray(start, start + 64);
    const next = after.bytes.subarray(start, start + 64);
    if (index === expectedIndex) {
      if (!prior.every(value => value === 0) || next.every(value => value === 0)) throw new Error('Turnkey did not add the expected signature.');
      if (!nacl.sign.detached.verify(before.bytes.subarray(before.messageOffset), next, bs58.decode(expectedSigner))) throw new Error('Turnkey returned an invalid signer signature.');
    } else if (!next.equals(prior)) throw new Error('Turnkey changed another signer slot.');
  }
}

export function transactionIdFromSignedHex(signedHex: string) {
  const transaction = transactionParts(signedHex);
  const signature = transaction.bytes.subarray(transaction.prefixLength, transaction.prefixLength + 64);
  if (signature.every(value => value === 0)) throw new Error('The sponsor fee-payer signature is missing.');
  return bs58.encode(signature);
}

export function assertSignedTransactionMatches(unsignedHex: string, signedHex: string) {
  const unsigned = transactionParts(unsignedHex);
  const signed = transactionParts(signedHex);
  const unsignedSignatures = unsigned.bytes.subarray(unsigned.prefixLength, unsigned.messageOffset);
  const signedSignatures = signed.bytes.subarray(signed.prefixLength, signed.messageOffset);
  if (signed.signatureCount !== unsigned.signatureCount || signed.bytes.length !== unsigned.bytes.length ||
      !unsignedSignatures.every(value => value === 0) || signedSignatures.every(value => value === 0) ||
      !signed.bytes.subarray(signed.messageOffset).equals(unsigned.bytes.subarray(unsigned.messageOffset))) {
    throw new Error('Turnkey returned a transaction that does not match the validated message.');
  }
}

export function mergeSignedTransactions(unsignedHex: string, ...signedTransactions: string[]) {
  if (signedTransactions.length < 2) throw new Error('At least two partial signatures are required.');
  const unsigned = transactionParts(unsignedHex);
  const merged = Buffer.from(unsigned.bytes);
  for (const signedHex of signedTransactions) {
    assertSignedTransactionMatches(unsignedHex, signedHex);
    const signed = transactionParts(signedHex);
    for (let index = 0; index < unsigned.signatureCount; index++) {
      const start = unsigned.prefixLength + index * 64;
      const end = start + 64;
      const candidate = signed.bytes.subarray(start, end);
      if (candidate.every(value => value === 0)) continue;
      const current = merged.subarray(start, end);
      if (!current.every(value => value === 0) && !current.equals(candidate)) throw new Error('Turnkey returned conflicting signatures for the same signer.');
      candidate.copy(merged, start);
    }
  }
  if (merged.subarray(unsigned.prefixLength, unsigned.messageOffset).some((value, index) => index % 64 === 0 && merged.subarray(unsigned.prefixLength + index, unsigned.prefixLength + index + 64).every(byte => byte === 0))) {
    throw new Error('The Solana transaction is missing a required signature.');
  }
  return merged.toString('hex');
}

type RpcResult<T> = { result?: T; error?: { message?: string } };
async function rpc<T>(rpcUrl: string, method: string, params: unknown[], fetcher: typeof fetch = fetch): Promise<T> {
  const response = await vendorCall(`Solana RPC ${method}`, async signal => {
    const result = await fetcher(rpcUrl, { signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!result.ok) throw new Error(`Solana RPC ${method} failed with status ${result.status}.`);
    return result;
  }, { timeoutMs: 10_000, retries: method === 'sendTransaction' ? 0 : 2 });
  const body = await response.json() as RpcResult<T>;
  if (body.error || body.result === undefined) throw new Error(`Solana RPC ${method} failed${body.error?.message ? `: ${body.error.message}` : '.'}`);
  return body.result;
}

export async function tokenProgramsForMints(mints: string[], rpcUrl: string, fetcher: typeof fetch = fetch) {
  const unique = [...new Set(mints)];
  if (!unique.length) return new Map<string, Address>();
  if (unique.length > 100) throw new Error('Too many token mints for one Solana preflight.');
  const result = await rpc<{ value: ({ owner: string } | null)[] }>(rpcUrl, 'getMultipleAccounts', [unique, { encoding: 'base64', commitment: 'confirmed' }], fetcher);
  if (result.value.length !== unique.length) throw new Error('Solana returned an incomplete token-mint preflight.');
  return new Map(unique.map((mint, index) => {
    const account = result.value[index];
    if (!account) throw new Error(`Token mint ${mint} does not exist.`);
    if (account.owner !== TOKEN_PROGRAM_ADDRESS && account.owner !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error(`Token mint ${mint} has an unsupported owner program.`);
    return [mint, address(account.owner)];
  }));
}

export async function tokenProgramForMint(mint: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  return (await tokenProgramsForMints([mint], rpcUrl, fetcher)).get(mint)!;
}

const TOKEN_ACCOUNT_SIZE = 165;
const SIMULATION_BLOCKHASH = '11111111111111111111111111111111' as Blockhash;

export async function tokenAccountSizeForMint(mint: string, tokenProgram: Address, rpcUrl: string, feePayer: string, fetcher: typeof fetch = fetch) {
  if (tokenProgram === TOKEN_PROGRAM_ADDRESS) return TOKEN_ACCOUNT_SIZE;
  if (tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error('Unsupported token program for account sizing.');
  // Associated Token Account initializes ImmutableOwner for Token-2022 accounts,
  // so include that extension in the program's authoritative size calculation.
  const sizeData = Buffer.alloc(3);
  sizeData.writeUInt8(GET_ACCOUNT_DATA_SIZE_DISCRIMINATOR, 0);
  sizeData.writeUInt16LE(ExtensionType.ImmutableOwner, 1);
  const sizeInstruction: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [{ address: address(mint), role: AccountRole.READONLY }],
    data: new Uint8Array(sizeData)
  };
  const transaction = pipe(
    createTransactionMessage({ version: 0 }),
    message => appendTransactionMessageInstructions([sizeInstruction], message),
    message => setTransactionMessageFeePayer(address(feePayer), message),
    message => setTransactionMessageLifetimeUsingBlockhash({ blockhash: SIMULATION_BLOCKHASH, lastValidBlockHeight: 0n }, message),
    message => compileTransaction(message)
  );
  const encoded = getBase64EncodedWireTransaction(transaction);
  const result = await rpc<{ value: { err: unknown; returnData?: { programId: string; data: [string, string] } | null } }>(rpcUrl, 'simulateTransaction', [encoded, {
    encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true
  }], fetcher);
  const returned = result.value.returnData;
  if (result.value.err || !returned || returned.programId !== TOKEN_2022_PROGRAM_ADDRESS || returned.data[1] !== 'base64') {
    throw new Error('Token-2022 account-size simulation failed.');
  }
  const data = Buffer.from(returned.data[0], 'base64');
  if (data.length !== 8) throw new Error('Token-2022 returned an invalid account size.');
  const size = data.readBigUInt64LE();
  if (size < BigInt(TOKEN_ACCOUNT_SIZE) || size > 10_000n) throw new Error('Token-2022 returned an invalid account size.');
  return Number(size);
}

export async function existingAccounts(accounts: string[], rpcUrl: string, fetcher: typeof fetch = fetch) {
  const unique = [...new Set(accounts)];
  if (!unique.length) return new Set<string>();
  if (unique.length > 100) throw new Error('Too many Solana accounts for one preflight.');
  const result = await rpc<{ value: (object | null)[] }>(rpcUrl, 'getMultipleAccounts', [unique, { encoding: 'base64', commitment: 'confirmed' }], fetcher);
  if (result.value.length !== unique.length) throw new Error('Solana returned an incomplete account preflight.');
  return new Set(unique.filter((_, index) => result.value[index] !== null));
}

export async function associatedTokenAccount(owner: string, mint: string, tokenProgram: Address) {
  const [account] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram });
  return account;
}

export async function estimateComputeUnits(build: JupiterBuild, payer: string, rpcUrl: string, fetcher: typeof fetch = fetch, lookupTables: AddressesByLookupTableAddress = {}, localInstructions: Instruction[] = [], staticAccountsOnly = false) {
  const result = await rpc<{ value: { err: unknown; unitsConsumed?: number } }>(rpcUrl, 'simulateTransaction', [unsignedTransactionBase64(build, payer, MAX_COMPUTE_UNITS, lookupTables, localInstructions, staticAccountsOnly), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }], fetcher);
  if (result.value.err) throw new SolanaSimulationError(result.value.err);
  return result.value.unitsConsumed ? Math.min(Math.ceil(result.value.unitsConsumed * 1.2), MAX_COMPUTE_UNITS) : MAX_COMPUTE_UNITS;
}

export async function transactionFeeLamports(build: JupiterBuild, payer: string, units: number, rpcUrl: string, fetcher: typeof fetch = fetch, lookupTables: AddressesByLookupTableAddress = {}, localInstructions: Instruction[] = [], staticAccountsOnly = false) {
  const message = compiled(build, payer, units, lookupTables, localInstructions, staticAccountsOnly).messageBytes;
  const result = await rpc<{ value: number | null }>(rpcUrl, 'getFeeForMessage', [Buffer.from(message).toString('base64'), { commitment: 'confirmed' }], fetcher);
  if (result.value === null || !Number.isSafeInteger(result.value) || result.value < 0) throw new Error('Solana could not calculate the transaction fee.');
  return BigInt(result.value);
}

export async function estimateSetupComputeUnits(input: SetupTransactionInput, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ value: { err: unknown; unitsConsumed?: number } }>(rpcUrl, 'simulateTransaction', [setupTransactionBase64({ ...input, computeUnits: MAX_COMPUTE_UNITS }), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true
  }], fetcher);
  if (result.value.err) throw new Error('Account-setup simulation failed.');
  return result.value.unitsConsumed ? Math.min(Math.ceil(result.value.unitsConsumed * 1.2), MAX_COMPUTE_UNITS) : MAX_COMPUTE_UNITS;
}

export async function setupTransactionFeeLamports(input: SetupTransactionInput, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ value: number | null }>(rpcUrl, 'getFeeForMessage', [Buffer.from(compileSetupTransaction(input).messageBytes).toString('base64'), { commitment: 'confirmed' }], fetcher);
  if (result.value === null || !Number.isSafeInteger(result.value) || result.value < 0) throw new Error('Solana could not calculate the account-setup transaction fee.');
  return BigInt(result.value);
}

export async function rentExemptionLamports(space: number, rpcUrl: string, fetcher: typeof fetch = fetch) {
  if (!Number.isSafeInteger(space) || space <= 0) throw new Error('Invalid Solana account size.');
  return BigInt(await rpc<number>(rpcUrl, 'getMinimumBalanceForRentExemption', [space, { commitment: 'confirmed' }], fetcher));
}

export async function nativeBalanceLamports(account: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ value: number }>(rpcUrl, 'getBalance', [account, { commitment: 'confirmed' }], fetcher);
  if (!Number.isSafeInteger(result.value) || result.value < 0) throw new Error('Solana returned an invalid native balance.');
  return BigInt(result.value);
}

export async function parsedTokenAccount(account: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ value: { owner: string; data: { parsed?: { info?: { mint?: string; owner?: string }; type?: string } } } | null }>(rpcUrl, 'getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }], fetcher);
  const info = result.value?.data.parsed?.info;
  if (!result.value || result.value.data.parsed?.type !== 'account' || !info?.mint || !info.owner ||
      (result.value.owner !== TOKEN_PROGRAM_ADDRESS && result.value.owner !== TOKEN_2022_PROGRAM_ADDRESS)) {
    throw new Error('Solana fee token account is missing or invalid.');
  }
  return { mint: info.mint, authority: info.owner, tokenProgram: result.value.owner };
}

export async function tokenAccountBalanceAtomic(account: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ value: { amount: string; decimals: number } }>(rpcUrl, 'getTokenAccountBalance', [account, { commitment: 'confirmed' }], fetcher);
  if (!/^\d+$/.test(result.value.amount) || !Number.isInteger(result.value.decimals) || result.value.decimals < 0 || result.value.decimals > 18) {
    throw new Error('Solana returned an invalid token-account balance.');
  }
  return { amountAtomic: BigInt(result.value.amount), decimals: result.value.decimals };
}

export async function submitSignedTransaction(signedTransactionHex: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  return rpc<string>(rpcUrl, 'sendTransaction', [Buffer.from(signedTransactionHex, 'hex').toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }], fetcher);
}

export async function signatureStatus(signature: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ value: ({ confirmationStatus: string | null; err: unknown } | null)[] }>(rpcUrl, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }], fetcher);
  return result.value[0];
}

export async function currentBlockHeight(rpcUrl: string, fetcher: typeof fetch = fetch) {
  return rpc<number>(rpcUrl, 'getBlockHeight', [{ commitment: 'confirmed' }], fetcher);
}

export async function currentSlot(rpcUrl: string, fetcher: typeof fetch = fetch) {
  return rpc<number>(rpcUrl, 'getSlot', [{ commitment: 'confirmed' }], fetcher);
}

export async function latestBlockhash(rpcUrl: string, fetcher: typeof fetch = fetch) {
  const result = await rpc<{ context: { slot: number }; value: { blockhash: string; lastValidBlockHeight: number } }>(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }], fetcher);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.value.blockhash) || !Number.isSafeInteger(result.value.lastValidBlockHeight) || result.value.lastValidBlockHeight <= 0) {
    throw new Error('Solana returned an invalid latest blockhash.');
  }
  return { blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight, slot: result.context.slot };
}

export function assertFreshBlockhash(currentHeight: number, lastValidBlockHeight: number) {
  if (!Number.isSafeInteger(currentHeight) || !Number.isSafeInteger(lastValidBlockHeight) || currentHeight >= lastValidBlockHeight) {
    throw new Error('Jupiter returned an expired or unsafe transaction blockhash.');
  }
}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type ParsedTransaction = { meta: { err: unknown; fee?: number; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null; transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } } };

export async function confirmedSwapAmounts(signature: string, wallet: string, inputMint: string, outputMint: string, feeAccount: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const transaction = await rpc<ParsedTransaction | null>(rpcUrl, 'getTransaction', [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], fetcher);
  if (!transaction?.meta || transaction.meta.err) return null;
  const keys = transaction.transaction.message.accountKeys.map(key => typeof key === 'string' ? key : key.pubkey);
  const pre = transaction.meta.preTokenBalances ?? [];
  const post = transaction.meta.postTokenBalances ?? [];
  const amount = (rows: TokenBalance[], predicate: (row: TokenBalance) => boolean) => rows.filter(predicate).reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
  const ownerInput = (row: TokenBalance) => row.owner === wallet && row.mint === inputMint;
  const ownerOutput = (row: TokenBalance) => row.owner === wallet && row.mint === outputMint;
  const fee = (row: TokenBalance) => keys[row.accountIndex] === feeAccount && row.mint === inputMint;
  return {
    filledInputAtomic: amount(pre, ownerInput) - amount(post, ownerInput),
    filledOutputAtomic: amount(post, ownerOutput) - amount(pre, ownerOutput),
    feeAtomic: amount(post, fee) - amount(pre, fee),
    networkFeeLamports: BigInt(transaction.meta.fee ?? 0),
    outputDecimals: [...post, ...pre].find(ownerOutput)?.uiTokenAmount.decimals
  };
}

export async function confirmedSetupAmounts(signature: string, feeAccount: string, usdcMint: string, rpcUrl: string, fetcher: typeof fetch = fetch) {
  const transaction = await rpc<ParsedTransaction | null>(rpcUrl, 'getTransaction', [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], fetcher);
  if (!transaction?.meta || transaction.meta.err) return null;
  const keys = transaction.transaction.message.accountKeys.map(key => typeof key === 'string' ? key : key.pubkey);
  const amount = (rows: TokenBalance[]) => rows.filter(row => keys[row.accountIndex] === feeAccount && row.mint === usdcMint)
    .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
  return {
    reimbursementAtomic: amount(transaction.meta.postTokenBalances ?? []) - amount(transaction.meta.preTokenBalances ?? []),
    networkFeeLamports: BigInt(transaction.meta.fee ?? 0)
  };
}

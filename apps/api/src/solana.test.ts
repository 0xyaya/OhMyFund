import { describe, expect, it, vi } from 'vitest';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole } from '@solana/kit';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { assertComputePrice, assertFreshBlockhash, assertLookupTablesMatch, assertRequiredSigners, assertSignatureAddedBy, assertSignedTransactionMatches, associatedTokenAccount, confirmedSwapAmounts, createAssociatedTokenAccountInstruction, currentBlockHeight, currentSlot, estimateComputeUnits, existingAccounts, isJupiterSlippageSimulationError, mergeSignedTransactions, nativeBalanceLamports, rentExemptionLamports, setupTransactionHex, signatureStatus, submitSignedTransaction, tokenAccountSizeForMint, tokenProgramForMint, tokenProgramsForMints, tokenTransferCheckedInstruction, transactionIdFromSignedHex, transactionMessageFingerprint, unsignedTransactionHex, TOKEN_2022_PROGRAM_ADDRESS } from './solana.js';
import type { JupiterBuild } from './swaps/jupiter.js';

const instruction = (data: Buffer) => ({ programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: data.toString('base64') });
const build = (data: Buffer): JupiterBuild => ({ computeBudgetInstructions: [instruction(data)] } as unknown as JupiterBuild);

describe('Solana transaction controls', () => {
  it('rejects a blockhash at or behind the current chain height', () => {
    expect(() => assertFreshBlockhash(99, 100)).not.toThrow();
    expect(() => assertFreshBlockhash(100, 100)).toThrow('expired or unsafe');
    expect(() => assertFreshBlockhash(101, 100)).toThrow('expired or unsafe');
  });

  it('rejects lookup tables that differ from the current on-chain contents', () => {
    const claimed = { Table11111111111111111111111111111111111: ['Account111111111111111111111111111111111'] } as never;
    expect(() => assertLookupTablesMatch(claimed, claimed)).not.toThrow();
    expect(() => assertLookupTablesMatch(claimed, { Table11111111111111111111111111111111111: ['Attacker11111111111111111111111111111111'] } as never)).toThrow('do not match Solana');
  });

  it('accepts only a signature change from the signer', () => {
    const message = Buffer.from('validated-message');
    const unsigned = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
    const signed = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), message]);
    expect(() => assertSignedTransactionMatches(unsigned.toString('hex'), signed.toString('hex'))).not.toThrow();
    const changed = Buffer.from(signed); changed[changed.length - 1] ^= 1;
    expect(() => assertSignedTransactionMatches(unsigned.toString('hex'), changed.toString('hex'))).toThrow('does not match');
  });

  it('requires exactly the sponsor and user signer slots in order', () => {
    const sponsor = nacl.sign.keyPair();
    const user = nacl.sign.keyPair();
    const message = Buffer.concat([Buffer.from([0x80, 2, 0, 0, 2]), Buffer.from(sponsor.publicKey), Buffer.from(user.publicKey), Buffer.alloc(32), Buffer.from([0, 0])]);
    const transaction = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]);
    expect(() => assertRequiredSigners(transaction.toString('hex'), [bs58.encode(sponsor.publicKey), bs58.encode(user.publicKey)])).not.toThrow();
    expect(() => assertRequiredSigners(transaction.toString('hex'), [bs58.encode(user.publicKey), bs58.encode(sponsor.publicKey)])).toThrow('exact required signers');
    expect(() => assertRequiredSigners(transaction.toString('hex'), [bs58.encode(sponsor.publicKey)])).toThrow('exact required signers');
  });

  it('merges two Turnkey signatures only when every required signer is present', () => {
    const message = Buffer.from('validated-two-signer-message');
    const unsigned = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]);
    const user = Buffer.from(unsigned); user.fill(3, 1, 65);
    const sponsor = Buffer.from(unsigned); sponsor.fill(7, 65, 129);
    const merged = Buffer.from(mergeSignedTransactions(unsigned.toString('hex'), user.toString('hex'), sponsor.toString('hex')), 'hex');
    expect(merged.subarray(1, 65)).toEqual(Buffer.alloc(64, 3));
    expect(merged.subarray(65, 129)).toEqual(Buffer.alloc(64, 7));
    expect(merged.subarray(129)).toEqual(message);
    expect(() => mergeSignedTransactions(unsigned.toString('hex'), user.toString('hex'), user.toString('hex'))).toThrow('missing a required signature');
    const changed = Buffer.from(sponsor); changed[changed.length - 1] ^= 1;
    expect(() => mergeSignedTransactions(unsigned.toString('hex'), user.toString('hex'), changed.toString('hex'))).toThrow('does not match');
  });

  it('accepts only the expected valid signature slot and derives the sponsor transaction ID', () => {
    const sponsor = nacl.sign.keyPair();
    const user = nacl.sign.keyPair();
    const message = Buffer.concat([Buffer.from([0x80, 2, 0, 0, 2]), Buffer.from(sponsor.publicKey), Buffer.from(user.publicKey), Buffer.alloc(32), Buffer.from([0, 0])]);
    const unsigned = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]);
    const userSigned = Buffer.from(unsigned);
    Buffer.from(nacl.sign.detached(message, user.secretKey)).copy(userSigned, 65);
    expect(() => assertSignatureAddedBy(unsigned.toString('hex'), userSigned.toString('hex'), bs58.encode(user.publicKey))).not.toThrow();
    const sponsorSigned = Buffer.from(userSigned);
    const sponsorSignature = Buffer.from(nacl.sign.detached(message, sponsor.secretKey));
    sponsorSignature.copy(sponsorSigned, 1);
    expect(() => assertSignatureAddedBy(userSigned.toString('hex'), sponsorSigned.toString('hex'), bs58.encode(sponsor.publicKey))).not.toThrow();
    expect(transactionIdFromSignedHex(sponsorSigned.toString('hex'))).toBe(bs58.encode(sponsorSignature));
    const wrongSlot = Buffer.from(unsigned); sponsorSignature.copy(wrongSlot, 1);
    expect(() => assertSignatureAddedBy(unsigned.toString('hex'), wrongSlot.toString('hex'), bs58.encode(user.publicKey))).toThrow('another signer slot');
    const changedMessage = Buffer.from(userSigned); changedMessage[changedMessage.length - 1] ^= 1;
    expect(() => assertSignatureAddedBy(unsigned.toString('hex'), changedMessage.toString('hex'), bs58.encode(user.publicKey))).toThrow('changed Solana message');
  });

  it('builds exact local fee-transfer and sponsor-paid ATA instructions', () => {
    const fee = tokenTransferCheckedInstruction({ source: '11111111111111111111111111111111', mint: 'So11111111111111111111111111111111111111112', destination: 'ComputeBudget111111111111111111111111111111', owner: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', amountAtomic: 123n });
    expect(Buffer.from(fee.data!)).toEqual(Buffer.from([12, 123, 0, 0, 0, 0, 0, 0, 0, 6]));
    expect(fee.accounts?.[3].role).toBe(AccountRole.READONLY_SIGNER);
    const ata = createAssociatedTokenAccountInstruction({ payer: 'ComputeBudget111111111111111111111111111111', account: '11111111111111111111111111111111', owner: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', mint: 'So11111111111111111111111111111111111111112', tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    expect(Buffer.from(ata.data!)).toEqual(Buffer.from([1]));
    expect(ata.accounts?.[0].role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(ata.accounts?.[2].role).toBe(AccountRole.READONLY);
  });

  it('accepts capped compute prices and rejects excessive or unknown instructions', () => {
    const allowed = Buffer.alloc(9); allowed[0] = 3; allowed.writeBigUInt64LE(1_000_000n, 1);
    expect(() => assertComputePrice(build(allowed))).not.toThrow();
    const excessive = Buffer.from(allowed); excessive.writeBigUInt64LE(1_000_001n, 1);
    expect(() => assertComputePrice(build(excessive))).toThrow('exceeds');
    expect(() => assertComputePrice(build(Buffer.from([4])))).toThrow('unsupported');
    const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(1_400_001, 1);
    expect(() => assertComputePrice(build(limit))).toThrow('limit exceeds');
  });

  it('rejects a compiled Jupiter transaction above Solana wire-size limits', () => {
    const oversized = {
      computeBudgetInstructions: [], setupInstructions: [],
      swapInstruction: { programId: '11111111111111111111111111111111', accounts: [], data: Buffer.alloc(1_100).toString('base64') },
      cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
      blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 1 }
    } as unknown as JupiterBuild;
    expect(() => unsignedTransactionHex(oversized, 'So11111111111111111111111111111111111111112')).toThrow('transaction size limits');
  });

  it('can compile Jupiter accounts statically while the default path requires verified lookup tables', () => {
    const withLookupMetadata = {
      computeBudgetInstructions: [], setupInstructions: [],
      swapInstruction: { programId: '11111111111111111111111111111111', accounts: [], data: '' },
      cleanupInstruction: null, otherInstructions: [],
      addressesByLookupTableAddress: { So11111111111111111111111111111111111111112: ['11111111111111111111111111111111'] },
      blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 1 }
    } as unknown as JupiterBuild;
    const payer = 'So11111111111111111111111111111111111111112';
    expect(() => unsignedTransactionHex(withLookupMetadata, payer)).toThrow('Verified Solana lookup tables are required');
    expect(() => unsignedTransactionHex(withLookupMetadata, payer, 1_400_000, {}, [], true)).not.toThrow();
  });

  it('keeps the maximum eight-account setup atomic and below the v0 wire limit', () => {
    const key = () => bs58.encode(nacl.sign.keyPair().publicKey);
    const sponsor = key();
    const user = key();
    const transaction = setupTransactionHex({
      sponsor, user, sourceTokenAccount: key(), usdcMint: key(), feeTokenAccount: key(), reimbursementAtomic: 12345n,
      accounts: Array.from({ length: 8 }, () => ({ account: key(), owner: user, mint: key(), tokenProgram: TOKEN_PROGRAM_ADDRESS })),
      blockhash: key(), lastValidBlockHeight: 123, computeUnits: 200_000, computeUnitPriceMicroLamports: 1_000
    });
    expect(Buffer.from(transaction, 'hex').length).toBeLessThanOrEqual(1_232);
    expect(transactionMessageFingerprint(transaction)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => setupTransactionHex({
      sponsor, user, sourceTokenAccount: key(), usdcMint: key(), feeTokenAccount: key(), reimbursementAtomic: 1n,
      accounts: Array.from({ length: 9 }, () => ({ account: key(), owner: user, mint: key(), tokenProgram: TOKEN_PROGRAM_ADDRESS })),
      blockhash: key(), lastValidBlockHeight: 123, computeUnits: 200_000, computeUnitPriceMicroLamports: 0
    })).toThrow('one to eight');
  });

  it('derives distinct associated accounts for classic Token and Token-2022', async () => {
    const owner = '11111111111111111111111111111111';
    const mint = 'So11111111111111111111111111111111111111112';
    expect(await associatedTokenAccount(owner, mint, TOKEN_PROGRAM_ADDRESS)).not.toBe(await associatedTokenAccount(owner, mint, TOKEN_2022_PROGRAM_ADDRESS));
  });

  it('accepts only supported token mint owner programs from RPC', async () => {
    const response = (owner: string) => vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: [{ owner }] } }), { status: 200 }));
    await expect(tokenProgramForMint('mint', 'https://rpc.invalid', response(TOKEN_PROGRAM_ADDRESS))).resolves.toBe(TOKEN_PROGRAM_ADDRESS);
    await expect(tokenProgramForMint('mint', 'https://rpc.invalid', response('11111111111111111111111111111111'))).rejects.toThrow('unsupported');
    const missing = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: [null] } }), { status: 200 }));
    await expect(tokenProgramForMint('mint', 'https://rpc.invalid', missing)).rejects.toThrow('does not exist');
  });

  it('asks Token-2022 for the exact account size so new mint extensions remain supported', async () => {
    const response = (size: bigint, err: unknown = null) => vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [, init] = args;
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe('simulateTransaction');
      expect(request.params[1]).toMatchObject({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true });
      const data = Buffer.alloc(8); data.writeBigUInt64LE(size);
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: { err, returnData: { programId: TOKEN_2022_PROGRAM_ADDRESS, data: [data.toString('base64'), 'base64'] } } } }), { status: 200 });
    });
    const payer = '11111111111111111111111111111111';
    await expect(tokenAccountSizeForMint('mint', TOKEN_PROGRAM_ADDRESS, 'https://rpc.invalid', payer)).resolves.toBe(165);
    await expect(tokenAccountSizeForMint('11111111111111111111111111111111', TOKEN_2022_PROGRAM_ADDRESS, 'https://rpc.invalid', payer, response(187n))).resolves.toBe(187);
    await expect(tokenAccountSizeForMint('11111111111111111111111111111111', TOKEN_2022_PROGRAM_ADDRESS, 'https://rpc.invalid', payer, response(187n, { custom: 1 }))).rejects.toThrow('simulation failed');
  });

  it('batches mint programs and account existence into one RPC call each', async () => {
    const mintRpc = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe('getMultipleAccounts');
      expect(request.params[0]).toEqual(['mint-a', 'mint-b']);
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: [{ owner: TOKEN_PROGRAM_ADDRESS }, { owner: TOKEN_2022_PROGRAM_ADDRESS }] } }), { status: 200 });
    });
    const programs = await tokenProgramsForMints(['mint-a', 'mint-b', 'mint-a'], 'https://rpc.invalid', mintRpc as typeof fetch);
    expect([...programs]).toEqual([['mint-a', TOKEN_PROGRAM_ADDRESS], ['mint-b', TOKEN_2022_PROGRAM_ADDRESS]]);
    expect(mintRpc).toHaveBeenCalledTimes(1);

    const accountRpc = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: [{ data: [] }, null] } }), { status: 200 }));
    await expect(existingAccounts(['ata-a', 'ata-b', 'ata-a'], 'https://rpc.invalid', accountRpc)).resolves.toEqual(new Set(['ata-a']));
    expect(accountRpc).toHaveBeenCalledTimes(1);
  });

  it('fails closed on RPC transport and JSON-RPC errors', async () => {
    const httpError = vi.fn(async () => new Response('', { status: 503 }));
    await expect(currentBlockHeight('https://rpc.invalid', httpError)).rejects.toThrow('status 503');
    const rpcError = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { message: 'rate limited' } }), { status: 200 }));
    await expect(signatureStatus('sig', 'https://rpc.invalid', rpcError)).rejects.toThrow('rate limited');
    const slot = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: 1234 }), { status: 200 }));
    await expect(currentSlot('https://rpc.invalid', slot)).resolves.toBe(1234);
    const balance = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: 12345 } }), { status: 200 }));
    await expect(nativeBalanceLamports('wallet', 'https://rpc.invalid', balance)).resolves.toBe(12345n);
    const rent = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: 2039280 }), { status: 200 }));
    await expect(rentExemptionLamports(165, 'https://rpc.invalid', rent)).resolves.toBe(2039280n);
  });

  it('rejects failed simulations and caps estimated compute units', async () => {
    const rpcBuild = {
      computeBudgetInstructions: [], setupInstructions: [],
      swapInstruction: { programId: '11111111111111111111111111111111', accounts: [], data: '' },
      cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
      blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 1 }
    } as unknown as JupiterBuild;
    const failed = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: { err: { code: 1 } } } }), { status: 200 }));
    const payer = 'So11111111111111111111111111111111111111112';
    const failedSimulation = await estimateComputeUnits(rpcBuild, payer, 'https://rpc.invalid', failed).catch(error => error);
    expect(failedSimulation).toBeInstanceOf(Error);
    expect(isJupiterSlippageSimulationError(failedSimulation)).toBe(false);
    const slippage = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: { err: { InstructionError: [3, { Custom: 6001 }] } } } }), { status: 200 }));
    const slippageSimulation = await estimateComputeUnits(rpcBuild, payer, 'https://rpc.invalid', slippage).catch(error => error);
    expect(isJupiterSlippageSimulationError(slippageSimulation)).toBe(true);
    const high = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { value: { err: null, unitsConsumed: 1_300_000 } } }), { status: 200 }));
    await expect(estimateComputeUnits(rpcBuild, payer, 'https://rpc.invalid', high)).resolves.toBe(1_400_000);
  });

  it('submits signed hex and returns confirmed ledger deltas', async () => {
    const send = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.params[0]).toBe(Buffer.from('00ff', 'hex').toString('base64'));
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: 'signature' }), { status: 200 });
    });
    await expect(submitSignedTransaction('00ff', 'https://rpc.invalid', send as typeof fetch)).resolves.toBe('signature');

    const transaction = {
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 0, mint: 'usdc', owner: 'wallet', uiTokenAmount: { amount: '1000', decimals: 6 } },
          { accountIndex: 1, mint: 'asset', owner: 'wallet', uiTokenAmount: { amount: '10', decimals: 8 } },
          { accountIndex: 2, mint: 'usdc', uiTokenAmount: { amount: '1', decimals: 6 } }
        ],
        postTokenBalances: [
          { accountIndex: 0, mint: 'usdc', owner: 'wallet', uiTokenAmount: { amount: '100', decimals: 6 } },
          { accountIndex: 1, mint: 'asset', owner: 'wallet', uiTokenAmount: { amount: '30', decimals: 8 } },
          { accountIndex: 2, mint: 'usdc', uiTokenAmount: { amount: '8', decimals: 6 } }
        ]
      },
      transaction: { message: { accountKeys: ['source', { pubkey: 'destination' }, 'fee'] } }
    };
    const ledger = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: transaction }), { status: 200 }));
    await expect(confirmedSwapAmounts('sig', 'wallet', 'usdc', 'asset', 'fee', 'https://rpc.invalid', ledger)).resolves.toEqual({ filledInputAtomic: 900n, filledOutputAtomic: 20n, feeAtomic: 7n, networkFeeLamports: 0n, outputDecimals: 8 });
    const failedLedger = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { ...transaction, meta: { ...transaction.meta, err: 'failed' } } }), { status: 200 }));
    await expect(confirmedSwapAmounts('sig', 'wallet', 'usdc', 'asset', 'fee', 'https://rpc.invalid', failedLedger)).resolves.toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { copyPublicFundInputSchema, copyPublicFundResultSchema, createFundSchema, planInputSchema, publicFundsSchema, publishFundInputSchema, recurringMandateFingerprint, recurringMandatePolicyInputSchema, setupQuoteSchema, submitSetupSchema, turnkeyMandatePolicy, turnkeyPolicyFingerprint, turnkeyRecurringPolicy, turnkeySetupSponsorPolicy, turnkeySponsorMandatePolicy } from './index';

describe('fund inputs', () => {
  const assets = [{ assetId: 'solana', variantId: 'solana:wSOL', weightBps: 5000 }, { assetId: 'usd-coin', variantId: 'usd-coin:USDC', weightBps: 5000 }];
  it('accepts an exact full allocation', () => expect(createFundSchema.safeParse({ name: 'Core', assets }).success).toBe(true));
  it('rejects a partial allocation', () => expect(createFundSchema.safeParse({ name: 'Core', assets: assets.map(a => ({ ...a, weightBps: 4000 })) }).success).toBe(false));
  it('rejects duplicate assets', () => expect(createFundSchema.safeParse({ name: 'Core', assets: [assets[0], { ...assets[0] }] }).success).toBe(false));
});
it('requires a weekday for weekly plans', () => expect(planInputSchema.safeParse({ amountAtomic: '1000000', cadence: 'weekly', localTime: '12:00', timezone: 'UTC', weekday: null }).success).toBe(false));

it('validates public fund names and compact leaderboard rows', () => {
  const assets = [{ assetId: 'solana', variantId: 'solana:wSOL', weightBps: 5000 }, { assetId: 'usd-coin', variantId: 'usd-coin:USDC', weightBps: 5000 }];
  expect(publishFundInputSchema.parse({ publisherName: '  Yann  ' }).publisherName).toBe('Yann');
  expect(publishFundInputSchema.safeParse({ publisherName: 'Bad\u0000name' }).success).toBe(false);
  const row = { rank: 1, publicId: crypto.randomUUID(), fundName: 'Core', publisherName: 'Yann', topAssets: assets.map(asset => ({ ...asset, symbol: asset.assetId.toUpperCase() })), assetCount: 2, copyCount: 0, basketUpdatedAt: new Date().toISOString() };
  expect(publicFundsSchema.parse({ funds: [row] }).funds[0].rank).toBe(1);
});

it('validates a snapshot-copy result', () => {
  const assets = [{ assetId: 'solana', variantId: 'solana:wSOL', weightBps: 5000 }, { assetId: 'usd-coin', variantId: 'usd-coin:USDC', weightBps: 5000 }];
  const now = new Date().toISOString();
  const fund = { id: crypto.randomUUID(), name: 'Core copy', version: 1, assets, createdAt: now, updatedAt: now };
  expect(copyPublicFundResultSchema.parse({ fund, sourceVersion: 3, alreadyCopied: false }).sourceVersion).toBe(3);
});

it('rejects misleading control characters in public copy names', () => {
  expect(copyPublicFundInputSchema.safeParse({ name: 'Trusted\u202Ename' }).success).toBe(false);
});

it('builds a wallet, delegate, fee, and program-restricted Turnkey policy', () => {
  const wallet = '11111111111111111111111111111111';
  const delegate = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fee = 'So11111111111111111111111111111111111111112';
  const policy = turnkeyRecurringPolicy(wallet, delegate, fee);
  expect(policy.effect).toBe('EFFECT_ALLOW');
  expect(policy.consensus).toContain(delegate);
  expect(policy.condition).toContain(`wallet_account.address == '${wallet}'`);
  expect(policy.condition).toContain(`i.accounts[6].account_key == '${fee}'`);
  expect(policy.condition).toContain('solana.tx.transfers.count() == 0');
  expect(() => turnkeyRecurringPolicy("bad' || true", delegate, fee)).toThrow('Invalid Turnkey policy identifier');
});

it('fingerprints Turnkey policy fields deterministically', async () => {
  const policy = turnkeyRecurringPolicy('11111111111111111111111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'So11111111111111111111111111111111111111112');
  const fingerprint = await turnkeyPolicyFingerprint(policy);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  await expect(turnkeyPolicyFingerprint({ ...policy })).resolves.toBe(fingerprint);
  await expect(turnkeyPolicyFingerprint({ ...policy, notes: `${policy.notes} changed` })).resolves.not.toBe(fingerprint);
});

const mandatePolicyInput = {
  mandateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', planRevision: 2, fundVersion: 3,
  walletAddress: '11111111111111111111111111111111', sponsorAddress: 'So11111111111111111111111111111111111111112',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sourceTokenAccount: 'SourceATA11111111111111111111111111111111111',
  feeTokenAccount: 'FeeAccount11111111111111111111111111111111', maximumOccurrenceDebitAtomic: '10000000',
  basket: [
    { outputMint: 'So11111111111111111111111111111111111111112', destinationTokenAccount: '11111111111111111111111111111111', tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as const, grossAllocationAtomic: '6000000', fixedSwapInputAtomic: '5700000', maximumFeeTransferAtomic: '300000' },
    { outputMint: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', destinationTokenAccount: 'ComputeBudget111111111111111111111111111111', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as const, grossAllocationAtomic: '4000000', fixedSwapInputAtomic: '3800000', maximumFeeTransferAtomic: '200000' }
  ]
};

it('canonicalizes mandate fingerprints and builds exact mint, amount, account, and sponsor restrictions', async () => {
  const parsed = recurringMandatePolicyInputSchema.parse(mandatePolicyInput);
  const fingerprint = await recurringMandateFingerprint(parsed);
  expect(fingerprint).toBe('6a85d47f13135ad53acf348e45ed0392d67e33259d512916ccc879e8f1507b6b');
  await expect(recurringMandateFingerprint({ ...parsed, basket: [...parsed.basket].reverse() })).resolves.toBe(fingerprint);
  const policy = turnkeyMandatePolicy(parsed, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', fingerprint);
  expect(policy.condition).toContain(`solana.tx.account_keys[0] == '${parsed.sponsorAddress}'`);
  expect(policy.condition).toContain(`transfer.from == '${parsed.sourceTokenAccount}'`);
  expect(policy.condition).toContain(`transfer.to == '${parsed.feeTokenAccount}'`);
  const inputAmount = Buffer.alloc(8); inputAmount.writeBigUInt64LE(5_700_000n);
  expect(policy.condition).toContain(`instruction_data_hex[16..32] == '${inputAmount.toString('hex')}'`);
  expect(policy.condition).toContain(`instruction_data_hex[18..34] == '${inputAmount.toString('hex')}'`);
  expect(policy.condition).toContain("instruction_data_hex[0..16] == 'd19853937cfed8e9'");
  expect(policy.condition).toContain(`i.accounts[2].account_key == '${parsed.sourceTokenAccount}'`);
  expect(policy.condition).toContain(`i.accounts[6].account_key == '${parsed.usdcMint}'`);
  expect(policy.condition).not.toContain('parsed_instruction_data');
  expect(policy.condition).not.toContain(`i.accounts[4].account_key == '${parsed.basket[1].outputMint}'`);
  expect(policy.condition).not.toContain(`i.accounts[7].account_key == '${parsed.basket[1].outputMint}'`);
  expect(policy.condition).toContain(`i.accounts[2].account_key == '${parsed.basket[1].destinationTokenAccount}'`);
  expect(policy.condition).toContain(`i.accounts[7].account_key == '${parsed.basket[1].destinationTokenAccount}'`);
  expect(policy.condition).toContain('solana.tx.instructions.count() == 4');
  expect(policy.condition).toContain("i.program_key == 'ComputeBudget111111111111111111111111111111').count() == 2");
  expect(policy.condition).not.toContain('solana.tx.instructions.all');
  expect(policy.condition).not.toContain('solana.tx.program_keys.all');
  expect(policy.condition).toContain("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL').count() == 0");
  expect(policy.condition).not.toContain("i.program_key == 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'");
  expect(policy.notes).toContain(fingerprint);
  const sponsorPolicy = turnkeySponsorMandatePolicy(parsed, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fingerprint);
  expect(sponsorPolicy.condition).toContain(`wallet_account.address == '${parsed.sponsorAddress}'`);
  expect(sponsorPolicy.condition).toContain(`i.accounts[1].account_key == '${parsed.walletAddress}'`);
});

it('validates setup quotes and signed submissions', () => {
  const quote = {
    attemptId: crypto.randomUUID(), planId: crypto.randomUUID(), purpose: 'initial', status: 'awaiting_user_signature',
    missingAccounts: [{ mint: 'So11111111111111111111111111111111111111112', tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', address: '11111111111111111111111111111111', size: 165, rentLamports: '2039280' }],
    reimbursementAtomic: '4200', rentLamports: '2039280', networkFeeLamports: '10000', expiresAt: new Date().toISOString(), unsignedTransactionHex: '00aa'
  } as const;
  expect(setupQuoteSchema.parse(quote).missingAccounts).toHaveLength(1);
  expect(setupQuoteSchema.safeParse({ ...quote, missingAccounts: Array.from({ length: 9 }, () => quote.missingAccounts[0]) }).success).toBe(false);
  expect(submitSetupSchema.safeParse({ expectedRevision: 1, attemptId: quote.attemptId, userSignedTransactionHex: 'zz' }).success).toBe(false);
});

it('builds a separate capped sponsor policy for one-time account setup', () => {
  const policy = turnkeySetupSponsorPolicy({
    sponsorAddress: 'So11111111111111111111111111111111111111112',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeTokenAccount: 'FeeAccount11111111111111111111111111111111',
    maximumReimbursementAtomic: '500000'
  }, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  expect(policy.condition).toContain('count() <= 8');
  expect(policy.condition).toContain('transfer.amount <= 500000');
  expect(policy.condition).toContain("account_keys[1] == solana.tx.spl_transfers[0].owner");
  expect(policy.condition).not.toContain('JUP6Lkb');
});

it('rejects a mandate whose swap and fee authority exceeds its approved allocation', () => {
  const invalid = structuredClone(mandatePolicyInput);
  invalid.basket[0].fixedSwapInputAtomic = '5900000';
  invalid.basket[0].maximumFeeTransferAtomic = '200000';
  expect(recurringMandatePolicyInputSchema.safeParse(invalid).success).toBe(false);
});

import { z } from 'zod';

export const errorCodeSchema = z.enum(['UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION', 'CONFLICT', 'NOT_FOUND', 'ASSET_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT', 'SELF_COPY', 'TEMPORARY_UNAVAILABLE']);
export const errorSchema = z.object({ error: z.object({ code: errorCodeSchema, message: z.string(), fields: z.record(z.string(), z.string()).optional() }) });
export const operationResultSchema = z.object({ ok: z.literal(true) });
export type ApiError = z.infer<typeof errorSchema>;

export const assetSelectionSchema = z.object({ assetId: z.string().min(1).max(120), variantId: z.string().min(1).max(160), weightBps: z.number().int().positive().max(10000) });
export const fundNameSchema = z.string().trim().min(1).max(64).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Remove control characters.').transform(value => value.normalize('NFC'));
export const fundInputSchema = z.object({ name: fundNameSchema, assets: z.array(assetSelectionSchema).min(2).max(8) }).superRefine((value, ctx) => {
  if (value.assets.reduce((sum, asset) => sum + asset.weightBps, 0) !== 10000) ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Weights must total 100%.' });
  if (new Set(value.assets.map(asset => asset.assetId)).size !== value.assets.length) ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Choose each asset only once.' });
});
export const createFundSchema = fundInputSchema;
export const replaceFundSchema = fundInputSchema.safeExtend({ expectedVersion: z.number().int().positive() });
export const publisherNameSchema = z.string().trim().min(1).max(40).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Remove control characters.').transform(value => value.normalize('NFC'));
export const publishFundInputSchema = z.object({ publisherName: publisherNameSchema });
export const publishFundSchema = z.object({ publicId: z.uuid(), publisherName: publisherNameSchema, publishedAt: z.string() });
export const fundSchema = z.object({ id: z.uuid(), name: z.string(), version: z.number().int(), assets: z.array(assetSelectionSchema), publication: publishFundSchema.nullable().default(null), createdAt: z.string(), updatedAt: z.string() });
export const fundsSchema = z.object({ funds: z.array(fundSchema) });
export const publicFundAssetSchema = z.object({ assetId: z.string(), variantId: z.string(), symbol: z.string(), weightBps: z.number().int().positive().max(10000) });
export const publicFundAllocationSchema = publicFundAssetSchema.extend({ name: z.string(), issuer: z.string().optional() });
export const publicFundRowSchema = z.object({ rank: z.number().int().positive(), publicId: z.uuid(), fundName: z.string(), publisherName: publisherNameSchema, topAssets: z.array(publicFundAssetSchema).max(3), assetCount: z.number().int().min(2).max(8), copyCount: z.number().int().nonnegative(), basketUpdatedAt: z.string() });
export const publicFundsSchema = z.object({ funds: z.array(publicFundRowSchema).max(50) });
export const publicFundDetailSchema = z.object({ publicId: z.uuid(), fundName: z.string(), publisherName: publisherNameSchema, assets: z.array(publicFundAllocationSchema).min(2).max(8), assetCount: z.number().int().min(2).max(8), copyCount: z.number().int().nonnegative(), basketUpdatedAt: z.string() });
export const copyPublicFundInputSchema = z.object({ name: fundNameSchema });
export const copyPublicFundResultSchema = z.object({ fund: fundSchema, sourceVersion: z.number().int().positive(), alreadyCopied: z.boolean() });
export const fundEditSchema = z.object({ id: z.uuid(), kind: z.enum(['created', 'updated']), version: z.number().int().positive(), before: fundInputSchema.nullable(), after: fundInputSchema, occurredAt: z.string() });
export const purchaseStatusSchema = z.enum(['due', 'claimed', 'executing', 'confirming', 'confirmed', 'failed', 'partial', 'unknown']);
export const fundActivitySchema = z.object({ edits: z.array(fundEditSchema), payments: z.array(z.object({
  id: z.uuid(), signature: z.string(), amountAtomic: z.string(), investedAtomic: z.string(), feeAtomic: z.string(), profitFeeAtomic: z.string(), infrastructureFeeAtomic: z.string(), sponsoredLamports: z.string(), ataCreated: z.boolean(),
  outputAtomic: z.string(), outputDecimals: z.number().int().min(0).max(18), outputMint: z.string(), status: z.literal('confirmed'), occurredAt: z.string()
})) });

export const planInputSchema = z.object({
  amountAtomic: z.string().regex(/^[1-9]\d{0,17}$/),
  cadence: z.enum(['daily', 'weekly']),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  weekday: z.number().int().min(0).max(6).nullable()
}).superRefine((value, ctx) => {
  if ((value.cadence === 'weekly') !== (value.weekday !== null)) ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Choose a weekday for weekly plans only.' });
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Choose a valid timezone.' }); }
});
export const updatePlanSchema = planInputSchema.safeExtend({ expectedRevision: z.number().int().positive() });
export const planStatusSchema = z.enum(['draft', 'approval_required', 'active', 'paused', 'cancelled']);
export const planSchema = z.object({
  id: z.uuid(), fundId: z.uuid(), amountAtomic: z.string(), cadence: z.enum(['daily', 'weekly']), localTime: z.string(), timezone: z.string(), weekday: z.number().int().min(0).max(6).nullable(),
  status: planStatusSchema, revision: z.number().int(), nextRunAt: z.string().nullable(), pauseReason: z.string().nullable(), pauseCode: z.enum(['user', 'execution_failure', 'terms_changed', 'approval_required', 'account_setup_required', 'sponsor_policy_revocation_required']).nullable(), feeBps: z.literal(75), slippageBps: z.number().int().min(1).max(300), createdAt: z.string()
});
export const plansSchema = z.object({ plans: z.array(planSchema) });
export const planActionSchema = z.object({ expectedRevision: z.number().int().positive() });
export const authorizationIntentSchema = planActionSchema.extend({ delegatedUserId: z.uuid() });
export const policyFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const recurringPolicyVersionSchema = z.literal('recurring-mandate-v2');
export const authorizePlanSchema = planActionSchema.extend({ delegatedUserId: z.uuid(), policyIds: z.array(z.uuid()).length(1),
  policyFingerprint: policyFingerprintSchema, policyVersion: recurringPolicyVersionSchema });
export const recurringConfigurationSchema = z.object({
  available: z.boolean(), executionEnabled: z.boolean(), feeBps: z.literal(75), defaultSlippageBps: z.number().int().min(1).max(300),
  delegatedPublicKey: z.string().regex(/^[0-9a-fA-F]{66}$/).nullable(), feeAccount: z.string().min(32).max(44).nullable(),
  maxOccurrenceAtomic: z.string().regex(/^\d+$/), unavailableReason: z.string().nullable()
});
export const mandateSchema = z.object({
  id: z.uuid(), planId: z.uuid(), planRevision: z.number().int().positive(), fundVersion: z.number().int().positive(), amountAtomic: z.string(),
  cadence: z.enum(['daily', 'weekly']), localTime: z.string(), timezone: z.string(), weekday: z.number().int().min(0).max(6).nullable(), feeBps: z.literal(75),
  slippageBps: z.number().int().min(1).max(300), termsVersion: z.string(), basket: z.array(assetSelectionSchema.extend({ mint: z.string().min(32).max(44) })).min(2).max(8), authorizedAt: z.string().nullable()
});
export const preparePlanResultSchema = z.object({ plan: planSchema, mandate: mandateSchema });
export const planAuthorizationSchema = z.object({ delegatedUserId: z.uuid().nullable(), policyIds: z.array(z.uuid()), policyFingerprint: policyFingerprintSchema.nullable() });
const atomicAmountSchema = z.string().regex(/^\d+$/);
const solanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const transactionHexSchema = z.string().regex(/^(?:[0-9a-fA-F]{2})+$/).max(8192);

export const setupPurposeSchema = z.enum(['initial', 'repair']);
export const setupStatusSchema = z.enum(['preparing', 'awaiting_user_signature', 'user_signed', 'submitted', 'confirming', 'confirmed', 'failed', 'expired', 'unknown']);
export const setupAccountSchema = z.object({
  mint: solanaAddressSchema,
  tokenProgram: z.enum(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']),
  address: solanaAddressSchema,
  size: z.number().int().min(165).max(10_000),
  rentLamports: atomicAmountSchema
});
export const setupQuoteSchema = z.object({
  attemptId: z.uuid(), planId: z.uuid(), purpose: setupPurposeSchema, status: setupStatusSchema,
  missingAccounts: z.array(setupAccountSchema).max(8), reimbursementAtomic: atomicAmountSchema,
  rentLamports: atomicAmountSchema, networkFeeLamports: atomicAmountSchema,
  expiresAt: z.string().nullable(), unsignedTransactionHex: transactionHexSchema.nullable()
});
export const submitSetupSchema = planActionSchema.extend({ attemptId: z.uuid(), userSignedTransactionHex: transactionHexSchema });
export const setupResultSchema = z.object({
  attemptId: z.uuid(), planId: z.uuid(), purpose: setupPurposeSchema, status: setupStatusSchema,
  missingAccountCount: z.number().int().min(0).max(8), reimbursementAtomic: atomicAmountSchema,
  transactionSignature: z.string().min(32).max(88).nullable(), message: z.string().max(240).nullable()
});
export const setupSponsorPolicyInputSchema = z.object({
  sponsorAddress: solanaAddressSchema, usdcMint: solanaAddressSchema, feeTokenAccount: solanaAddressSchema,
  maximumReimbursementAtomic: z.string().regex(/^[1-9]\d{0,17}$/)
});
export type SetupSponsorPolicyInput = z.infer<typeof setupSponsorPolicyInputSchema>;
export const recurringMandatePolicyInputSchema = z.object({
  mandateId: z.uuid(), planId: z.uuid(), planRevision: z.number().int().positive(), fundVersion: z.number().int().positive(),
  walletAddress: solanaAddressSchema, sponsorAddress: solanaAddressSchema,
  usdcMint: solanaAddressSchema, sourceTokenAccount: solanaAddressSchema, feeTokenAccount: solanaAddressSchema,
  maximumOccurrenceDebitAtomic: atomicAmountSchema,
  basket: z.array(z.object({
    outputMint: solanaAddressSchema, destinationTokenAccount: solanaAddressSchema,
    tokenProgram: z.enum(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']),
    grossAllocationAtomic: atomicAmountSchema, fixedSwapInputAtomic: atomicAmountSchema, maximumFeeTransferAtomic: atomicAmountSchema
  })).min(2).max(8)
}).superRefine((value, ctx) => {
  if (new Set(value.basket.map(item => item.outputMint)).size !== value.basket.length) ctx.addIssue({ code: 'custom', path: ['basket'], message: 'Each mandate output mint must be unique.' });
  if (new Set(value.basket.map(item => item.destinationTokenAccount)).size !== value.basket.length) ctx.addIssue({ code: 'custom', path: ['basket'], message: 'Each mandate destination account must be unique.' });
  const gross = value.basket.reduce((sum, item) => sum + BigInt(item.grossAllocationAtomic), 0n);
  if (gross !== BigInt(value.maximumOccurrenceDebitAtomic)) ctx.addIssue({ code: 'custom', path: ['maximumOccurrenceDebitAtomic'], message: 'Mandate leg allocations must equal the occurrence debit.' });
  value.basket.forEach((item, index) => {
    if (BigInt(item.fixedSwapInputAtomic) <= 0n || BigInt(item.fixedSwapInputAtomic) + BigInt(item.maximumFeeTransferAtomic) > BigInt(item.grossAllocationAtomic)) {
      ctx.addIssue({ code: 'custom', path: ['basket', index], message: 'Mandate swap and fee limits exceed the leg allocation.' });
    }
  });
});
export type RecurringMandatePolicyInput = z.infer<typeof recurringMandatePolicyInputSchema>;
export const turnkeyPolicyDefinitionSchema = z.object({
  policyName: z.string().min(1).max(128), notes: z.string().max(1_000), effect: z.literal('EFFECT_ALLOW'),
  consensus: z.string().min(1).max(2_000), condition: z.string().min(1).max(50_000)
});
export type TurnkeyPolicyDefinition = z.infer<typeof turnkeyPolicyDefinitionSchema>;
export const authorizationIntentResultSchema = planAuthorizationSchema.extend({
  delegatedUserId: z.uuid(), policyFingerprint: policyFingerprintSchema, mandatePolicyInput: recurringMandatePolicyInputSchema,
  policyVersion: recurringPolicyVersionSchema, policy: turnkeyPolicyDefinitionSchema
});
export const purchaseLegSchema = z.object({ id: z.uuid(), index: z.number().int().nonnegative(), assetId: z.string(), variantId: z.string(), outputMint: z.string(), grossAmountAtomic: z.string(), filledInputAtomic: z.string().nullable(), filledOutputAtomic: z.string().nullable(), feeAtomic: z.string().nullable(), signature: z.string().nullable(), status: z.enum(['pending', 'building', 'signing', 'submitted', 'confirming', 'confirmed', 'failed', 'unknown']) });
export const purchaseAttemptSchema = z.object({ id: z.uuid(), number: z.number().int().positive(), provider: z.enum(['turnkey', 'moonpay']), grossAmountAtomic: z.string(), confirmedGrossAtomic: z.string(), feeAtomic: z.string(), status: z.enum(['building', 'signing', 'submitted', 'confirming', 'confirmed', 'failed', 'partial', 'unknown']), legs: z.array(purchaseLegSchema) });
export const purchaseOccurrenceSchema = z.object({ id: z.uuid(), planId: z.uuid(), scheduledFor: z.string(), status: purchaseStatusSchema, attempts: z.array(purchaseAttemptSchema), createdAt: z.string(), updatedAt: z.string() });
export const purchaseOccurrencesSchema = z.object({ occurrences: z.array(purchaseOccurrenceSchema).max(100), truncated: z.boolean() });

const TURNKEY_ALLOWED_SOLANA_PROGRAMS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
] as const;
const safePolicyIdentifier = (value: string) => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid Turnkey policy identifier.');
  return value;
};
export function turnkeyRecurringPolicy(walletAddress: string, delegatedUserId: string, feeAccount: string) {
  const wallet = safePolicyIdentifier(walletAddress);
  const user = safePolicyIdentifier(delegatedUserId);
  const fee = safePolicyIdentifier(feeAccount);
  const programs = TURNKEY_ALLOWED_SOLANA_PROGRAMS.map(value => `'${value}'`).join(', ');
  return {
    policyName: `OhMyFund recurring buys ${wallet.slice(0, 8)}`,
    notes: 'Restricted OhMyFund recurring-buy signing. Revoke this policy to stop backend signing.',
    effect: 'EFFECT_ALLOW' as const,
    consensus: `approvers.any(user, user.id == '${user}')`,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet_account.address == '${wallet}' && solana.tx.transfers.count() == 0 && solana.tx.spl_transfers.count() == 0 && solana.tx.program_keys.all(p, p in [${programs}]) && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[0]}').count() == 1 && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[0]}').all(i, ((i.instruction_data_hex[0..16] == 'e517cb977ae3ad2a' && i.accounts[1].account_key == '${wallet}' && i.accounts[6].account_key == '${fee}') || (i.instruction_data_hex[0..16] == 'c1209b3341d69c81' && i.accounts[2].account_key == '${wallet}' && i.accounts[9].account_key == '${fee}')))`
  };
}

function canonicalMandate(input: RecurringMandatePolicyInput) {
  const parsed = recurringMandatePolicyInputSchema.parse(input);
  return { ...parsed, basket: [...parsed.basket].sort((a, b) => a.outputMint.localeCompare(b.outputMint) || a.destinationTokenAccount.localeCompare(b.destinationTokenAccount)) };
}

export async function recurringMandateFingerprint(input: RecurringMandatePolicyInput) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['turnkey-policy-v7', canonicalMandate(input)])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function u64LittleEndianHex(value: string) {
  const amount = BigInt(value);
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error('Mandate swap input exceeds a Solana u64.');
  return Array.from({ length: 8 }, (_, index) => Number(amount >> BigInt(index * 8) & 0xffn).toString(16).padStart(2, '0')).join('');
}

function buildTurnkeyMandatePolicy(input: RecurringMandatePolicyInput, delegatedUserId: string, mandateFingerprint: string, signer: 'user' | 'sponsor') {
  const mandate = canonicalMandate(input);
  const user = safePolicyIdentifier(delegatedUserId);
  if (!/^[0-9a-f]{64}$/.test(mandateFingerprint)) throw new Error('Invalid mandate fingerprint.');
  const routeBranches = mandate.basket.map(item => {
    const destination = safePolicyIdentifier(item.destinationTokenAccount);
    const inputAmount = u64LittleEndianHex(item.fixedSwapInputAtomic);
    return `(((i.instruction_data_hex[0..16] == 'bb64facc31c4af14' && i.instruction_data_hex[16..32] == '${inputAmount}' && i.accounts[0].account_key == '${mandate.walletAddress}' && i.accounts[1].account_key == '${mandate.sourceTokenAccount}' && i.accounts[2].account_key == '${destination}' && i.accounts[3].account_key == '${mandate.usdcMint}' && i.accounts[7].account_key == '${destination}') || (i.instruction_data_hex[0..16] == 'd19853937cfed8e9' && i.instruction_data_hex[18..34] == '${inputAmount}' && i.accounts[1].account_key == '${mandate.walletAddress}' && i.accounts[2].account_key == '${mandate.sourceTokenAccount}' && i.accounts[5].account_key == '${destination}' && i.accounts[6].account_key == '${mandate.usdcMint}')) && solana.tx.spl_transfers[0].amount <= ${item.maximumFeeTransferAtomic})`;
  }).join(' || ');
  return {
    policyName: `OhMyFund ${signer} mandate ${mandate.mandateId.slice(0, 8)}`,
    notes: `OhMyFund ${signer} mandate ${mandate.mandateId}; fingerprint ${mandateFingerprint}`,
    effect: 'EFFECT_ALLOW' as const,
    consensus: `approvers.any(user, user.id == '${user}')`,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet_account.address == '${signer === 'user' ? mandate.walletAddress : mandate.sponsorAddress}' && solana.tx.account_keys[0] == '${mandate.sponsorAddress}' && solana.tx.address_table_lookups.count() == 0 && solana.tx.transfers.count() == 0 && solana.tx.instructions.count() == 4 && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[0]}').count() == 1 && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[0]}').all(i, ${routeBranches}) && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[1]}').count() == 2 && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[2]}').count() == 0 && solana.tx.instructions.filter(i, i.program_key == '${TURNKEY_ALLOWED_SOLANA_PROGRAMS[3]}').count() == 1 && solana.tx.spl_transfers.count() == 1 && solana.tx.spl_transfers.all(transfer, transfer.from == '${mandate.sourceTokenAccount}' && transfer.to == '${mandate.feeTokenAccount}' && transfer.owner == '${mandate.walletAddress}' && transfer.token_mint == '${mandate.usdcMint}' && transfer.amount > 0)`
  };
}

export function turnkeyMandatePolicy(input: RecurringMandatePolicyInput, delegatedUserId: string, mandateFingerprint: string) {
  return buildTurnkeyMandatePolicy(input, delegatedUserId, mandateFingerprint, 'user');
}

export function turnkeySponsorMandatePolicy(input: RecurringMandatePolicyInput, sponsorDelegatedUserId: string, mandateFingerprint: string) {
  return buildTurnkeyMandatePolicy(input, sponsorDelegatedUserId, mandateFingerprint, 'sponsor');
}

export function turnkeySetupSponsorPolicy(input: SetupSponsorPolicyInput, sponsorDelegatedUserId: string) {
  const parsed = setupSponsorPolicyInputSchema.parse(input);
  const sponsor = safePolicyIdentifier(parsed.sponsorAddress);
  const user = safePolicyIdentifier(sponsorDelegatedUserId);
  const usdc = safePolicyIdentifier(parsed.usdcMint);
  const fee = safePolicyIdentifier(parsed.feeTokenAccount);
  const ata = TURNKEY_ALLOWED_SOLANA_PROGRAMS[2];
  const token = TURNKEY_ALLOWED_SOLANA_PROGRAMS[3];
  const token2022 = TURNKEY_ALLOWED_SOLANA_PROGRAMS[4];
  const programs = [`'${TURNKEY_ALLOWED_SOLANA_PROGRAMS[1]}'`, `'${ata}'`, `'${token}'`].join(', ');
  return {
    policyName: `OhMyFund account setup ${sponsor.slice(0, 8)}`,
    notes: 'Restricted OhMyFund account-setup sponsorship. User co-signature and exact USDC reimbursement required.',
    effect: 'EFFECT_ALLOW' as const,
    consensus: `approvers.any(user, user.id == '${user}')`,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet_account.address == '${sponsor}' && solana.tx.account_keys[0] == '${sponsor}' && solana.tx.account_keys[1] == solana.tx.spl_transfers[0].owner && solana.tx.transfers.count() == 0 && solana.tx.program_keys.all(p, p in [${programs}]) && solana.tx.instructions.filter(i, i.program_key == '${ata}').count() > 0 && solana.tx.instructions.filter(i, i.program_key == '${ata}').count() <= 8 && solana.tx.instructions.filter(i, i.program_key == '${ata}').all(i, i.instruction_data_hex == '01' && i.accounts[0].account_key == '${sponsor}' && i.accounts[2].account_key == solana.tx.spl_transfers[0].owner && i.accounts[4].account_key == '11111111111111111111111111111111' && (i.accounts[5].account_key == '${token}' || i.accounts[5].account_key == '${token2022}')) && solana.tx.instructions.filter(i, i.program_key == '${token}').count() == 1 && solana.tx.spl_transfers.count() == 1 && solana.tx.spl_transfers.all(transfer, transfer.to == '${fee}' && transfer.token_mint == '${usdc}' && transfer.amount > 0 && transfer.amount <= ${parsed.maximumReimbursementAtomic})`
  };
}

type TurnkeyRecurringPolicy = ReturnType<typeof turnkeyRecurringPolicy>;

export async function turnkeyPolicyFingerprint(policy: TurnkeyRecurringPolicy) {
  const canonical = JSON.stringify([policy.policyName, policy.notes, policy.effect, policy.consensus, policy.condition]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const challengeRequestSchema = z.object({ address: z.string().min(32).max(44) });
export const bindRequestSchema = z.object({ challengeId: z.uuid(), signature: z.string().min(80).max(128), organizationId: z.uuid(), walletId: z.uuid(), address: z.string().min(32).max(44) });
export const sessionSchema = z.object({ user: z.object({ id: z.uuid(), address: z.string(), organizationId: z.uuid() }), csrfToken: z.string() });
export const catalogItemSchema = z.object({ assetId: z.string(), variantId: z.string(), symbol: z.string(), name: z.string(), mint: z.string(), kind: z.string(), issuer: z.string().optional() });
export const catalogSchema = z.object({ assets: z.array(catalogItemSchema) });
export const snapshotSchema = z.object({ source: z.string(), retrievedAt: z.string(), chartsFetchedAt: z.string().nullable() });
export const screenerMarketSchema = z.object({ price: z.number().nullable(), priceChange24hPercent: z.number().nullable(), volume24hUSD: z.number().nullable(), liquidity: z.number().nullable(), lastFetchedAt: z.number().nullable(), lastTradeAt: z.number().nullable() });
export const screenerChartSchema = z.object({ status: z.string(), from: z.number().nullable(), to: z.number().nullable(), candles: z.array(z.object({ time: z.number(), close: z.number() })) });
export const screenerVariantSchema = catalogItemSchema.extend({ issuer: z.string(), tokenSymbol: z.string(), tokenName: z.string(), advisory: z.string().nullable(), market: screenerMarketSchema, chart: screenerChartSchema });
export const screenerRowSchema = z.object({ assetId: z.string(), name: z.string(), symbol: z.string(), category: z.enum(['crypto', 'currency', 'treasury', 'etf', 'commodity', 'equity']), imageUrl: z.string().nullable(), primaryVariantId: z.string(), variantCount: z.number().int(), variant: screenerVariantSchema });
export const screenerListSchema = z.object({ rows: z.array(screenerRowSchema), total: z.number().int(), page: z.number().int(), pageCount: z.number().int(), snapshot: snapshotSchema });
export const screenerDetailSchema = z.object({ assetId: z.string(), name: z.string(), symbol: z.string(), category: z.enum(['crypto', 'currency', 'treasury', 'etf', 'commodity', 'equity']), imageUrl: z.string().nullable(), primaryVariantId: z.string(), variants: z.array(screenerVariantSchema), snapshot: snapshotSchema });
export const balancesSchema = z.object({ address: z.string(), cluster: z.string(), solLamports: z.string(), usdcAtomic: z.string(), retrievedAt: z.string() });

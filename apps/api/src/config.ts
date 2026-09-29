const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
};
const atomic = (name: string, fallback: string) => {
  const value = process.env[name] ?? fallback;
  if (!/^[1-9]\d{0,17}$/.test(value)) throw new Error(`${name} must be a positive atomic-unit integer`);
  return BigInt(value);
};
const optional = (name: string) => process.env[name]?.trim() || null;
const webOrigins = required('WEB_ORIGIN').split(',').map(value => value.trim()).filter(Boolean);
if (!webOrigins.length || webOrigins.some(value => {
  try { const url = new URL(value); return url.origin !== value; } catch { return true; }
})) throw new Error('WEB_ORIGIN must contain exact comma-separated origins');

export const config = {
  port: Number(process.env.PORT ?? 4310),
  databaseUrl: required('DATABASE_URL'),
  webOrigins: new Set(webOrigins),
  publicApiHost: required('PUBLIC_API_HOST'),
  trustedProxySecret: process.env.TRUSTED_PROXY_SECRET || null,
  turnkeyOrganizationId: required('TURNKEY_ORGANIZATION_ID'),
  turnkeyApiPublicKey: required('TURNKEY_API_PUBLIC_KEY'),
  turnkeyApiPrivateKey: required('TURNKEY_API_PRIVATE_KEY'),
  solanaCluster: process.env.SOLANA_CLUSTER ?? 'mainnet-beta',
  solanaRpcUrl: required('SOLANA_RPC_URL'),
  usdcMint: required('USDC_MINT'),
  executionEnabled: process.env.EXECUTION_ENABLED === 'true',
  setupExecutionEnabled: process.env.SETUP_EXECUTION_ENABLED === 'true',
  recurringBuysAvailable: process.env.RECURRING_BUYS_AVAILABLE === 'true',
  jupiterApiKey: process.env.JUPITER_API_KEY || null,
  jupiterFeeAccount: process.env.JUPITER_FEE_ACCOUNT || null,
  jupiterFeeAccountAuthority: optional('JUPITER_FEE_ACCOUNT_AUTHORITY'),
  turnkeySponsorOrganizationId: optional('TURNKEY_SPONSOR_ORGANIZATION_ID'),
  turnkeySponsorWalletId: optional('TURNKEY_SPONSOR_WALLET_ID'),
  turnkeySponsorWalletAddress: optional('TURNKEY_SPONSOR_WALLET_ADDRESS'),
  turnkeySponsorApiPublicKey: optional('TURNKEY_SPONSOR_API_PUBLIC_KEY'),
  turnkeySponsorApiPrivateKey: optional('TURNKEY_SPONSOR_API_PRIVATE_KEY'),
  turnkeySponsorDelegatedUserId: optional('TURNKEY_SPONSOR_DELEGATED_USER_ID'),
  turnkeySetupSponsorPolicyId: optional('TURNKEY_SETUP_SPONSOR_POLICY_ID'),
  policyProvisionerUrl: optional('POLICY_PROVISIONER_URL'),
  policyProvisionerSharedSecret: optional('POLICY_PROVISIONER_SHARED_SECRET'),
  turnkeyPolicyProvisionerApiPublicKey: optional('TURNKEY_POLICY_PROVISIONER_API_PUBLIC_KEY'),
  recurringDefaultSlippageBps: integer('RECURRING_DEFAULT_SLIPPAGE_BPS', 100, 1, 300),
  recurringWorkerConcurrency: integer('RECURRING_WORKER_CONCURRENCY', 2, 1, 10),
  recurringAllowlistUserIds: new Set((process.env.RECURRING_ALLOWLIST_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean)),
  recurringMaxOccurrenceAtomic: atomic('RECURRING_MAX_OCCURRENCE_ATOMIC', '10000000'),
  recurringMaxDailyAtomic: atomic('RECURRING_MAX_DAILY_ATOMIC', '20000000'),
  recurringMaxNetworkFeeAtomic: atomic('RECURRING_MAX_NETWORK_FEE_ATOMIC', '50000'),
  recurringMinimumNetInvestmentAtomic: atomic('RECURRING_MINIMUM_NET_INVESTMENT_ATOMIC', '1000000'),
  recurringMaxSponsoredLamportsPerTransaction: atomic('RECURRING_MAX_SPONSORED_LAMPORTS_PER_TRANSACTION', '3000000'),
  recurringMaxSponsoredLamportsPerUserDaily: atomic('RECURRING_MAX_SPONSORED_LAMPORTS_PER_USER_DAILY', '10000000'),
  recurringMaxSponsoredLamportsGlobalDaily: atomic('RECURRING_MAX_SPONSORED_LAMPORTS_GLOBAL_DAILY', '100000000'),
  recurringSponsorMinimumBalanceLamports: atomic('RECURRING_SPONSOR_MINIMUM_BALANCE_LAMPORTS', '10000000'),
  recurringSolPriceMaximumAgeSlots: integer('RECURRING_SOL_PRICE_MAXIMUM_AGE_SLOTS', 150, 1, 10_000),
  setupMaxReimbursementAtomic: atomic('SETUP_MAX_REIMBURSEMENT_ATOMIC', '5000000'),
  setupMaxSponsoredLamportsPerTransaction: atomic('SETUP_MAX_SPONSORED_LAMPORTS_PER_TRANSACTION', '30000000'),
  setupMaxSponsoredLamportsPerUserDaily: atomic('SETUP_MAX_SPONSORED_LAMPORTS_PER_USER_DAILY', '60000000'),
  setupMaxSponsoredLamportsGlobalDaily: atomic('SETUP_MAX_SPONSORED_LAMPORTS_GLOBAL_DAILY', '300000000'),
  setupComputeUnitPriceMicroLamports: integer('SETUP_COMPUTE_UNIT_PRICE_MICROLAMPORTS', 1_000, 0, 1_000_000),
  production: process.env.NODE_ENV === 'production'
};

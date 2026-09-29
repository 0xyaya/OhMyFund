import { config } from './config.js';
import { ApiFailure } from './auth.js';
import { devWalletEnabled } from './dev-wallet.js';

const cache = new Map<string, { expires: number; value: { address: string; cluster: string; solLamports: string; usdcAtomic: string; retrievedAt: string } }>();
async function rpc(method: string, params: unknown[]) {
  const response = await fetch(config.solanaRpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error('RPC HTTP error');
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error || !body.result) throw new Error('RPC error');
  return body.result;
}
export async function getBalances(address: string, refresh = false) {
  // Balances are mainnet-only so a test network can never be presented as real money.
  // The local devnet path is the one documented exception and dies with DEV_WALLET_AUTH.
  const mainnet = config.solanaCluster === 'mainnet-beta' && config.usdcMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const localDevnet = devWalletEnabled && config.solanaCluster === 'devnet';
  if (!mainnet && !localDevnet) throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Wallet balance network is not configured.');
  const cached = cache.get(address);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  try {
    const [sol, tokens] = await Promise.all([
      rpc('getBalance', [address, { commitment: 'confirmed' }]) as Promise<{ value: number }>,
      rpc('getTokenAccountsByOwner', [address, { mint: config.usdcMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]) as Promise<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>
    ]);
    if (!Number.isSafeInteger(sol.value) || !Array.isArray(tokens.value)) throw new Error('Malformed RPC response');
    const usdcAtomic = tokens.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n).toString();
    const value = { address, cluster: config.solanaCluster, solLamports: String(sol.value), usdcAtomic, retrievedAt: new Date().toISOString() };
    cache.set(address, { expires: Date.now() + (refresh ? 15_000 : 30_000), value });
    return value;
  } catch { if (cached) return cached.value; throw new ApiFailure(503, 'TEMPORARY_UNAVAILABLE', 'Wallet balances are unavailable. Please retry.'); }
}

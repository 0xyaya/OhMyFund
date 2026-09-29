import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { sessionSchema } from '@ohmyfund/contracts';
import { api } from './browser-api';

// Local-only browser-wallet login for devnet testing. Mirrors apps/api/src/dev-wallet.ts.
// Off unless NEXT_PUBLIC_DEV_WALLET=1; the API refuses the binding unless it also has
// DEV_WALLET_AUTH=1 and is not running in production.
export const devWalletEnabled = process.env.NEXT_PUBLIC_DEV_WALLET === '1';

type Provider = {
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
};

export type DevWalletName = 'Phantom' | 'Solflare';

export function availableDevWallets(): DevWalletName[] {
  if (typeof window === 'undefined') return [];
  const w = window as unknown as { phantom?: { solana?: Provider }; solflare?: Provider };
  const found: DevWalletName[] = [];
  if (w.phantom?.solana) found.push('Phantom');
  if (w.solflare) found.push('Solflare');
  return found;
}

function provider(name: DevWalletName): Provider {
  const w = window as unknown as { phantom?: { solana?: Provider }; solflare?: Provider };
  const found = name === 'Phantom' ? w.phantom?.solana : w.solflare;
  if (!found) throw new Error(`${name} is not installed in this browser.`);
  return found;
}

async function uuidFrom(scope: string, address: string) {
  const bytes = new TextEncoder().encode(`ohmyfund-dev:${scope}:${address}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const h = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function connectDevWallet(name: DevWalletName) {
  const wallet = provider(name);
  const { publicKey } = await wallet.connect();
  const address = publicKey.toString();

  const challenge = await api('/auth/challenge', { parse: (v: unknown) => v as { challengeId: string; message: string } }, { method: 'POST', body: JSON.stringify({ address }) });
  const signed = await wallet.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
  const signature = signed instanceof Uint8Array ? signed : signed.signature;

  return api('/auth/bind', sessionSchema, { method: 'POST', body: JSON.stringify({
    challengeId: challenge.challengeId,
    signature: bs58.encode(signature),
    organizationId: await uuidFrom('org', address),
    walletId: await uuidFrom('wallet', address),
    address,
  }) });
}

/** Release whichever browser wallet is connected. Safe to call when none is. */
export async function disconnectDevWallet() {
  for (const name of availableDevWallets()) {
    try { await provider(name).disconnect?.(); } catch { /* signing out locally matters more */ }
  }
}

const FAKE_WALLET_STORAGE_KEY = 'ohmyfund-fake-wallet-secret';

function fakeWalletKeypair(): nacl.SignKeyPair {
  try {
    const stored = localStorage.getItem(FAKE_WALLET_STORAGE_KEY);
    if (stored) return nacl.sign.keyPair.fromSecretKey(bs58.decode(stored));
  } catch { /* fall through and mint a new one for this session */ }
  const keypair = nacl.sign.keyPair();
  try { localStorage.setItem(FAKE_WALLET_STORAGE_KEY, bs58.encode(keypair.secretKey)); } catch { /* still usable for this connect */ }
  return keypair;
}

/**
 * A synthetic Solana keypair generated and kept in this browser's localStorage, signing
 * the same challenge a real Phantom/Solflare would. Lets the connect-wallet flow be
 * tested end to end on a device or browser with no wallet extension installed. Only
 * reachable when devWalletEnabled, so it never exists outside local/devnet testing.
 */
export async function connectFakeWallet() {
  const keypair = fakeWalletKeypair();
  const address = bs58.encode(keypair.publicKey);

  const challenge = await api('/auth/challenge', { parse: (v: unknown) => v as { challengeId: string; message: string } }, { method: 'POST', body: JSON.stringify({ address }) });
  const signature = nacl.sign.detached(new TextEncoder().encode(challenge.message), keypair.secretKey);

  return api('/auth/bind', sessionSchema, { method: 'POST', body: JSON.stringify({
    challengeId: challenge.challengeId,
    signature: bs58.encode(signature),
    organizationId: await uuidFrom('org', address),
    walletId: await uuidFrom('wallet', address),
    address,
  }) });
}

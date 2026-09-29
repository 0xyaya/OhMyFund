import { createHash } from 'node:crypto';
import { config } from './config.js';

// Local-only browser-wallet login (Phantom / Solflare) for devnet testing.
//
// This does NOT weaken the login proof: /api/auth/bind still issues a challenge and
// still verifies the ed25519 signature against the claimed address. The only step it
// replaces is the Turnkey sub-organization ownership lookup, which cannot run without
// Turnkey credentials.
//
// It is off unless DEV_WALLET_AUTH=1 AND the process is not production. Both must hold.
export const devWalletEnabled = !config.production && process.env.DEV_WALLET_AUTH === '1';

/** Deterministic namespaced UUID so one address always maps to one user row. */
function uuidFrom(scope: string, address: string) {
  const h = createHash('sha256').update(`ohmyfund-dev:${scope}:${address}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const devOrganizationId = (address: string) => uuidFrom('org', address);
export const devWalletId = (address: string) => uuidFrom('wallet', address);

/**
 * True only when the caller presented exactly the identifiers this address derives to.
 * A dev client therefore cannot claim someone else's organization, and a real Turnkey
 * organization id can never satisfy this check.
 */
export function isDevWalletBinding(input: { address: string; organizationId: string; walletId: string }) {
  return devWalletEnabled
    && input.organizationId === devOrganizationId(input.address)
    && input.walletId === devWalletId(input.address);
}

'use client';

import { TurnkeyProvider } from '@turnkey/react-wallet-kit';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { devWalletEnabled } from './dev-wallet';

const organizationId = process.env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID;
const authProxyConfigId = process.env.NEXT_PUBLIC_TURNKEY_AUTH_PROXY_ID;
// Local devnet testing signs in with a browser wallet, so Turnkey is never called.
// The provider still has to mount because the tree calls useTurnkey(); these
// placeholders keep it inert rather than hiding the workaround in an env file.
const devPlaceholder = '00000000-0000-4000-8000-000000000000';

export function Providers({ children }: { children: ReactNode }) {
  // Sign-in itself needs Turnkey, but a visitor should still be able to find their way
  // to the parts of the product that don't: the Screener and the public leaderboard
  // render without this provider at all (see leaderboard/page.tsx, turnkey-config.ts).
  // The dev-wallet path still needs this provider mounted (useTurnkey() is called
  // unconditionally downstream) even though it never actually calls Turnkey.
  if ((!organizationId || !authProxyConfigId) && !devWalletEnabled) return <div className="setup"><h1>Sign-in is not configured yet</h1><p>Creating or editing funds needs sign-in, which is not available right now.</p><nav aria-label="Main"><Link href="/screener">Browse the screener</Link><Link href="/leaderboard">Browse public funds</Link></nav></div>;
  return <TurnkeyProvider config={{
    organizationId: organizationId || devPlaceholder,
    authProxyConfigId: authProxyConfigId || devPlaceholder,
    apiBaseUrl: 'https://api.turnkey.com',
    auth: { createSuborgParams: { emailOtpAuth: { customWallet: { walletName: 'OhMyFund Solana', walletAccounts: [{ curve: 'CURVE_ED25519', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/501'/0'/0'", addressFormat: 'ADDRESS_FORMAT_SOLANA' }] } } } },
    ui: { authModal: { methods: { emailOtpAuthEnabled: true, smsOtpAuthEnabled: false, passkeyAuthEnabled: false, walletAuthEnabled: false, googleOauthEnabled: false, appleOauthEnabled: false, xOauthEnabled: false, discordOauthEnabled: false, facebookOauthEnabled: false }, methodOrder: ['email'] } }
  }}>{children}</TurnkeyProvider>;
}

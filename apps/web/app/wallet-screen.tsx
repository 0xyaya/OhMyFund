'use client';

import { usdc, sol, type Balances, type Session } from './fund-types';
import { PitchDeckLink } from './pitch-deck-link';

export function WalletScreen({ session, balances, busy, copied, onCopyAddress, onRefresh, onSignOut }: {
  session: Session;
  balances: Balances | null;
  busy: boolean;
  copied: boolean;
  onCopyAddress: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const address = session.user.address;
  const half = Math.ceil(address.length / 2);
  return <section className="wallet-screen" aria-labelledby="wallet-title">
    <h1 id="wallet-title" className="sr-only">Wallet</h1>
    <div className="wallet-summary">
      <p className="wallet-label">Available USDC</p>
      <strong className={`wallet-amount${balances ? '' : ' wallet-amount-pending'}`}>{balances ? usdc(balances.usdcAtomic) : 'Not available'}</strong>
      <p className="wallet-help">{balances ? 'Separate from fund holdings.' : 'The balance could not be loaded. Refresh to retry.'}</p>
      {balances && <dl className="wallet-metrics">
        <div><dt>SOL</dt><dd>{sol(balances.solLamports)}</dd></div>
        <div><dt>Updated</dt><dd>{new Date(balances.retrievedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd></div>
      </dl>}
    </div>
    <div className="wallet-address-section">
      <h2>Solana address</h2>
      <code className="wallet-address" aria-label={address}><span>{address.slice(0, half)}</span><span>{address.slice(half)}</span></code>
      <div className="wallet-screen-actions">
        <button onClick={onCopyAddress}>{copied ? 'Copied' : 'Copy address'}</button>
        <button onClick={onRefresh} disabled={busy}>Refresh</button>
      </div>
    </div>
    <PitchDeckLink className="wallet-pitch-link">Pitch deck <span aria-hidden="true">↗</span></PitchDeckLink>
    <button className="wallet-sign-out" onClick={onSignOut}>Sign out</button>
  </section>;
}

'use client';

import { useDialog } from './use-dialog';
import type { DevWalletName } from './dev-wallet';

/** Local devnet only: picks a browser wallet in place of Turnkey sign-in. */
export function DevWalletDialog({ devWallets, onClose, onSignIn }: {
  devWallets: DevWalletName[];
  onClose: () => void;
  onSignIn: (name: DevWalletName | 'Fake') => void;
}) {
  const containerRef = useDialog(onClose);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={containerRef} className="modal wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-title" tabIndex={-1}><div className="section-head"><h2 id="wallet-title">Sign in</h2><button className="icon" aria-label="Close sign-in" onClick={onClose}>×</button></div><p className="muted">Devnet test mode.</p><div className="wallet-dialog-actions">{devWallets.length ? devWallets.map(name => <button key={name} className="primary" onClick={() => onSignIn(name)}>{`Connect ${name}`}</button>) : <p className="small muted">Install Phantom or Solflare, set it to devnet, then reopen this dialog.</p>}</div><div className="wallet-dialog-fake"><button onClick={() => onSignIn('Fake')}>Connect fake wallet (test)</button></div></div></div>;
}

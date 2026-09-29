'use client';

import { AssetAvatar } from './asset-avatar';
import { type Catalog, type Fund } from './fund-types';
import { useDialog } from './use-dialog';

export function AddAssetDialog({ asset, assetId, sessionReady, funds, error, busy, onClose, onSignIn, onNewFund, onChooseFund }: {
  asset: Catalog[number] | null;
  assetId: string;
  sessionReady: boolean;
  funds: Fund[];
  error: string;
  busy: boolean;
  onClose: () => void;
  onSignIn: () => void;
  onNewFund: () => void;
  onChooseFund: (fund: Fund) => void;
}) {
  const containerRef = useDialog(onClose);
  const eligible = funds.filter(fund => fund.assets.length < 8 && !fund.assets.some(item => item.assetId === assetId));
  return <div className="modal-backdrop add-asset-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={containerRef} className="modal add-asset-dialog" role="dialog" aria-modal="true" aria-labelledby="add-asset-title" tabIndex={-1}>
      <div className="add-asset-dialog-head"><button className="icon" aria-label="Close asset selection" onClick={onClose}>×</button></div>
      <div className="add-asset-dialog-identity"><AssetAvatar asset={asset ?? undefined} fallback={assetId} /><div><h2 id="add-asset-title">{!asset ? 'Loading asset…' : sessionReady ? `Add ${asset.symbol} to a fund` : `Sign in to add ${asset.symbol}`}</h2><p>{asset?.name ?? 'Checking the approved asset catalog'}</p></div></div>
      {!sessionReady ? <><p className="add-asset-dialog-note">Your selection will be ready after sign in. Nothing will be purchased.</p>{error && <p className="error" role="alert">{error}</p>}<div className="add-asset-dialog-footer"><button className="primary" onClick={onSignIn} disabled={!asset || busy}>{busy ? 'Verifying…' : 'Sign in to continue'}</button><button onClick={onClose}>Not now</button></div></>
        : <><p className="add-asset-dialog-note">Choose where this asset belongs. You can review the target weight before saving.</p><div className="add-asset-dialog-options"><button className="add-asset-new" onClick={onNewFund}>Create a new fund <span aria-hidden="true">→</span></button>{eligible.length > 0 && <div className="add-asset-existing"><strong>Or add to an existing fund</strong>{eligible.map(fund => <button key={fund.id} onClick={() => onChooseFund(fund)}><span>{fund.name}<small>{fund.assets.length} of 8 assets</small></span><span aria-hidden="true">→</span></button>)}</div>}{funds.length > 0 && !eligible.length && <p className="small muted">Your current funds already contain this asset or have eight assets.</p>}</div></>}
    </div>
  </div>;
}

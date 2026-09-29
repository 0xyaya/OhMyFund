'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { publicFundDetailSchema, publicFundsSchema } from '@ohmyfund/contracts';
import { BrandLogo } from '../brand-logo';
import { useDialog } from '../use-dialog';
import { BottomNav } from '../bottom-nav';

type Listing = typeof publicFundsSchema._output['funds'];
type Detail = typeof publicFundDetailSchema._output;

function DetailDialog({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useDialog(onClose, closeRef);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={containerRef} className="modal leaderboard-detail" role="dialog" aria-modal="true" aria-labelledby="public-fund-title"><div className="section-head"><div><p className="eyebrow">by {detail.publisherName}</p><h2 id="public-fund-title">{detail.fundName}</h2></div><button ref={closeRef} className="icon" aria-label="Close" onClick={onClose}>×</button></div><p className="muted">{detail.copyCount} copies · Basket updated {new Date(detail.basketUpdatedAt).toLocaleDateString()}</p><div className="leaderboard-allocations">{detail.assets.map(asset => <div key={`${asset.assetId}:${asset.variantId}`}><span><strong>{asset.symbol}</strong><small>{asset.name}</small></span><strong>{asset.weightBps / 100}%</strong></div>)}</div><p className="small muted">Sign-in is not configured right now, so copying this basket is unavailable.</p></div></div>;
}

/**
 * Public browsing only, with no dependency on TurnkeyProvider: used when Turnkey env
 * vars are missing so a broken/unset auth config doesn't also take down public
 * discovery and share links (see providers.tsx / leaderboard/page.tsx). Copying a
 * basket needs a signed-in session, so that action is not offered here.
 */
export function PublicLeaderboardFallback({ initialPublicId }: { initialPublicId?: string }) {
  const [funds, setFunds] = useState<Listing>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/public/funds').then(async response => {
      if (!response.ok) throw new Error('Could not load the leaderboard.');
      return publicFundsSchema.parse(await response.json());
    }).then(value => { setFunds(value.funds); setError(''); }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load the leaderboard.')).finally(() => setLoading(false));
  }, []);

  async function open(publicId: string) {
    try {
      const response = await fetch(`/api/public/funds/${publicId}`);
      if (!response.ok) throw new Error('Could not load this fund.');
      setDetail(publicFundDetailSchema.parse(await response.json()));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load this fund.'); }
  }
  useEffect(() => { if (initialPublicId) void open(initialPublicId); }, [initialPublicId]);

  return <><a className="skip" href="#content">Skip to content</a><header className="topbar leaderboard-topbar"><div className="shell topbar-inner"><Link className="brand" href="/" aria-label="OhMyFund home"><BrandLogo /></Link><nav aria-label="Main"><Link href="/">Portfolio</Link><Link href="/screener">Screener</Link><Link className="active" aria-current="page" href="/leaderboard">Leaderboard</Link></nav></div></header>
    <main id="content" className="shell main leaderboard-main"><div className="leaderboard-heading"><div><h1>Fund leaderboard</h1><p>Public baskets, ranked by how often people copy them.</p></div>{funds.length > 0 && <span>{`Top ${funds.length}`} · Copies</span>}</div>
      <p className="small muted">Sign-in is not configured right now. You can browse public baskets; copying one is unavailable until it is.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="leaderboard-list" aria-busy={loading}><div className="leaderboard-columns" aria-hidden="true"><span>Rank</span><span>Fund</span><span>Target basket</span><span>Copies</span><span /></div><ol>{funds.map(fund => <li className="leaderboard-row" key={fund.publicId}><span className="leaderboard-rank" aria-label={`Rank ${fund.rank}`}>{String(fund.rank).padStart(2, '0')}</span><button className="leaderboard-name" onClick={() => void open(fund.publicId)}><strong>{fund.fundName}</strong><small>{fund.publisherName} · {fund.assetCount} assets <span className="leaderboard-mobile-copies">· {fund.copyCount} copies</span></small></button><div className="leaderboard-assets" aria-label="Target basket">{fund.topAssets.map(asset => <span key={`${asset.assetId}:${asset.variantId}`}><strong>{asset.symbol}</strong> {asset.weightBps / 100}%</span>)}{fund.assetCount > fund.topAssets.length && <span aria-label={`${fund.assetCount - fund.topAssets.length} more assets`}>+{fund.assetCount - fund.topAssets.length}</span>}</div><div className="leaderboard-copy-count" aria-label={`${fund.copyCount} copies`}><strong>{fund.copyCount}</strong></div><span /></li>)}</ol>{!loading && !error && !funds.length && <div className="leaderboard-empty"><strong>No public funds yet</strong><p>Publish one of your funds to start the list.</p><Link href="/">Open portfolio</Link></div>}{loading && <div className="leaderboard-skeleton" role="status" aria-label="Loading funds">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>}</div>
    </main>
    <BottomNav active="leaderboard" signedIn={false} />
    {detail && <DetailDialog detail={detail} onClose={() => setDetail(null)} />}
  </>;
}

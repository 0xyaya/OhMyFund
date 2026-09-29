'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PitchDeckLink } from './pitch-deck-link';
import { AssetAvatar } from './asset-avatar';
import { PortfolioCopyIcon, PortfolioPlusIcon } from './icons';
import { assetKey, knownPortfolioTotal, usdc, type Balances, type Catalog, type Fund, type Session } from './fund-types';

/** Keep the page shape stable while session and funds load. */
export function PortfolioSkeleton() {
  return <div className="portfolio-page-skeleton" role="status" aria-live="polite">
    <div className="portfolio-skeleton-summary" />
    <div className="portfolio-skeleton-heading" />
    <div className="portfolio-skeleton-row" />
    <span className="sr-only">Loading portfolio…</span>
  </div>;
}

export function Portfolio({ session, funds, balances, catalogByVariant, busy, walletAuthenticated, hasAccount, devWalletMode, onVerifyWallet, onConnectWallet, onCreateFund, onOpenFund }: {
  session: Session | null;
  funds: Fund[];
  balances: Balances | null;
  catalogByVariant: Map<string, Catalog[number]>;
  busy: boolean;
  walletAuthenticated: boolean;
  hasAccount: boolean;
  devWalletMode: boolean;
  onVerifyWallet: () => void;
  onConnectWallet: () => void;
  onCreateFund: () => void;
  onOpenFund: (fund: Fund) => void;
}) {
  if (!session) {
    const verification = !devWalletMode && walletAuthenticated && hasAccount
      ? <button className="primary" onClick={onVerifyWallet} disabled={busy}>{busy ? 'Finishing sign-in…' : 'Retry sign-in'}</button>
      : <button className="primary" onClick={onConnectWallet} disabled={busy}>{busy ? 'Signing in…' : 'Start your fund'}</button>;
    return <div className="portfolio-signed-out">
      <section className="portfolio-welcome" aria-labelledby="portfolio-welcome-title">
        <div className="portfolio-welcome-copy">
          <h1 id="portfolio-welcome-title">One fund.<br />More markets.</h1>
          <p className="portfolio-welcome-intro">One basket across crypto, stocks, metals and ETFs, with your own target weights.</p>
          <div className="portfolio-welcome-actions">{verification}<Link className={verification ? undefined : 'portfolio-welcome-primary'} href="/screener">Explore markets <span aria-hidden="true">→</span></Link></div>
          <PitchDeckLink className="portfolio-pitch-link">See our pitch deck <span aria-hidden="true">↗</span></PitchDeckLink>
          {!devWalletMode && walletAuthenticated && !hasAccount && <p className="small muted">No Solana wallet was found in this Turnkey account. Please contact support before continuing.</p>}
        </div>
        <ul className="portfolio-market-art" aria-label="Available markets">
          <li className="portfolio-market-tile"><img src="/logos/solana.png" alt="" width="32" height="32" /><span>Crypto</span></li>
          <li className="portfolio-market-tile"><img src="/logos/AAPLx.png" alt="" width="32" height="32" /><span>Stocks</span></li>
          <li className="portfolio-market-tile"><img src="/logos/gold.png" alt="" width="32" height="32" /><span>Metals</span></li>
          <li className="portfolio-market-tile"><img src="/logos/TQQQx.png" alt="" width="32" height="32" /><span>ETFs</span></li>
        </ul>
      </section>
      <section className="portfolio-how" aria-labelledby="portfolio-how-title"><h2 id="portfolio-how-title">How it works</h2><PitchDeckLink className="portfolio-pitch-mobile">Pitch deck <span aria-hidden="true">↗</span></PitchDeckLink><ol className="portfolio-how-grid">
        <li><span className="portfolio-how-number" aria-hidden="true">1</span><h3>Sign in with your wallet</h3></li>
        <li><span className="portfolio-how-number" aria-hidden="true">2</span><h3>Pick 2–8 assets and set weights</h3></li>
        <li><span className="portfolio-how-number" aria-hidden="true">3</span><h3>Plan recurring buys, when you approve</h3></li>
      </ol></section>
    </div>;
  }
  return <PortfolioSignedIn funds={funds} balances={balances} catalogByVariant={catalogByVariant} onCreateFund={onCreateFund} onOpenFund={onOpenFund} />;
}

function PortfolioSignedIn({ funds, balances, catalogByVariant, onCreateFund, onOpenFund }: {
  funds: Fund[];
  balances: Balances | null;
  catalogByVariant: Map<string, Catalog[number]>;
  onCreateFund: () => void;
  onOpenFund: (fund: Fund) => void;
}) {
  const [query, setQuery] = useState('');
  const filteredFunds = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return trimmed ? funds.filter(fund => fund.name.toLowerCase().includes(trimmed)) : funds;
  }, [funds, query]);
  const total = knownPortfolioTotal(funds, balances);
  return <section className="portfolio-page portfolio-with-funds" aria-labelledby="portfolio-title">
    <section className="portfolio-summary" aria-labelledby="portfolio-title">
      <h1 id="portfolio-title" className="portfolio-label">Total value</h1>
      {total ? <strong className="portfolio-total">{total}</strong> : <strong className="portfolio-total portfolio-total-pending">Not available yet</strong>}
      <p className="portfolio-help">{funds.length ? 'Only wallet USDC is tracked for now.' : balances ? 'Wallet USDC' : 'Wallet balance is unavailable. Open Wallet to retry.'}</p>
      {funds.length > 0 && <dl className="portfolio-metrics">
        <div><dt>Available USDC</dt><dd>{balances ? usdc(balances.usdcAtomic) : '—'}</dd></div>
        <div><dt>Funds</dt><dd>{funds.length}</dd></div>
        {/* TODO(fund-valuation): show gain/loss once fund cost basis exists. See TODOS.md "Fund value and gain/loss". */}
        <div><dt>Gain / loss</dt><dd>—</dd></div>
      </dl>}
    </section>
    <header className="portfolio-list-heading"><h2>Your funds</h2>{funds.length > 0 && <span>{funds.length}</span>}</header>
    {/* Fund actions sit with the list they act on; phones hide them because the bottom-bar + covers both. */}
    <div className="portfolio-list-toolbar">
    {funds.length > 1 && <div className="portfolio-search"><svg className="search-glyph" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg><label><span className="sr-only">Search your funds</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your funds" /></label></div>}
    <div className="portfolio-quick-actions">
      <button className="primary" onClick={onCreateFund}><span className="portfolio-action-icon"><PortfolioPlusIcon /></span>Create fund</button>
      <Link href="/leaderboard"><span className="portfolio-action-icon"><PortfolioCopyIcon /></span>Copy a public fund</Link>
    </div>
    </div>
    {!funds.length ? <p className="portfolio-empty-line">No funds yet.<span className="portfolio-empty-hint"> Tap + to create one.</span></p> : <>
    {filteredFunds.length ? <div className="portfolio-fund-list">{filteredFunds.map(fund => <button className="portfolio-fund-row" key={fund.id} onClick={() => onOpenFund(fund)}><span className="portfolio-fund-assets" aria-hidden="true">{fund.assets.slice(0, 3).map(asset => <AssetAvatar key={assetKey(asset.assetId, asset.variantId)} asset={catalogByVariant.get(assetKey(asset.assetId, asset.variantId))} fallback={asset.assetId} />)}{fund.assets.length > 3 && <span className="portfolio-asset-count">+{fund.assets.length - 3}</span>}</span><span className="fund-info"><strong>{fund.name}</strong><small>{fund.assets.length} assets{fund.publication ? ' · Published' : ''}</small></span><svg className="portfolio-row-chevron" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg></button>)}</div> : <p className="portfolio-empty-line">No funds match “{query.trim()}”.</p>}
    </>}
  </section>;
}

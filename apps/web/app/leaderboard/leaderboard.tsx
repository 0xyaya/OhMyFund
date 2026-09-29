'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import { AuthState, useTurnkey } from '@turnkey/react-wallet-kit';
import { copyPublicFundResultSchema, publicFundDetailSchema, publicFundsSchema, sessionSchema } from '@ohmyfund/contracts';
import { api, bindTurnkeySession, isUnauthenticated } from '../browser-api';
import { BrandLogo } from '../brand-logo';
import { PitchDeckLink } from '../pitch-deck-link';
import { useDialog } from '../use-dialog';
import { shortAddress } from '../fund-types';
import { clearPrivateView, readCachedSession, readKnownPortfolioTotal, saveCachedSession } from '../private-view-cache';
import { WalletIcon } from '../icons';
import { BottomNav } from '../bottom-nav';
import { markWalletNavigationIntent } from '../wallet-navigation-intent';
import { bindIntentPublicId, copyRequestFor, defaultCopyName, publicIdFromLeaderboardPath, type CopyRequest } from './leaderboard-state';

type Listing = typeof publicFundsSchema._output['funds'];
type Detail = typeof publicFundDetailSchema._output;
type Session = typeof sessionSchema._output;
let cachedPublicFunds: Listing | null = null;

function FundDetailDialog({ detail, onClose, onCopy, returnFocusTo }: { detail: Detail; onClose: () => void; onCopy: (publicId: string) => void; returnFocusTo: RefObject<HTMLElement | null> }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useDialog(onClose, closeRef, returnFocusTo);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={containerRef} className="modal leaderboard-detail" role="dialog" aria-modal="true" aria-labelledby="public-fund-title"><div className="section-head"><div><p className="eyebrow">by {detail.publisherName}</p><h2 id="public-fund-title">{detail.fundName}</h2></div><button ref={closeRef} className="icon" aria-label="Close" onClick={onClose}>×</button></div><p className="muted">{detail.copyCount} copies · Basket updated {new Date(detail.basketUpdatedAt).toLocaleDateString()}</p><div className="leaderboard-allocations">{detail.assets.map(asset => <div key={`${asset.assetId}:${asset.variantId}`}><span><strong>{asset.symbol}</strong><small>{asset.name}</small></span><strong>{asset.weightBps / 100}%</strong></div>)}</div><button className="primary leaderboard-detail-copy" onClick={() => onCopy(detail.publicId)}>Copy this fund</button></div></div>;
}

function CopyDialog({ target, name, busy, error, onNameChange, onClose, onCopy, returnFocusTo }: { target: Detail; name: string; busy: boolean; error: string; onNameChange: (value: string) => void; onClose: () => void; onCopy: () => void; returnFocusTo: RefObject<HTMLElement | null> }) {
  const nameRef = useRef<HTMLInputElement>(null);
  const containerRef = useDialog(onClose, nameRef, returnFocusTo);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={containerRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="copy-title"><div className="section-head"><h2 id="copy-title">Copy {target.fundName}</h2><button className="icon" aria-label="Close" onClick={onClose}>×</button></div><p className="muted">This creates your own independent basket. Later changes to the original will not affect it.</p><label htmlFor="copy-name">Name your copy<input ref={nameRef} id="copy-name" value={name} maxLength={64} onChange={event => onNameChange(event.target.value)} /></label>{error && <p className="error" role="alert">{error}</p>}<div className="modal-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !name.trim()} onClick={onCopy}>{busy ? 'Copying…' : 'Copy fund'}</button></div></div></div>;
}

export function Leaderboard({ initialPublicId }: { initialPublicId?: string }) {
  const tk = useTurnkey();
  const [funds, setFunds] = useState<Listing>(() => cachedPublicFunds ?? []);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [copyTarget, setCopyTarget] = useState<Detail | null>(null);
  const [copyName, setCopyName] = useState('');
  const [session, setSession] = useState<Session | null>(readCachedSession);
  const [pendingPublicId, setPendingPublicId] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => cachedPublicFunds === null);
  const [busy, setBusy] = useState(false);
  const [loadingPublicId, setLoadingPublicId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const binding = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const detailRequest = useRef(0);
  const copyRequest = useRef<CopyRequest | null>(null);
  const wallet = useMemo(() => tk.wallets.find(w => w.source === 'embedded' && w.accounts.some(a => a.addressFormat === 'ADDRESS_FORMAT_SOLANA')), [tk.wallets]);
  const account = wallet?.accounts.find(a => a.addressFormat === 'ADDRESS_FORMAT_SOLANA');
  const totalCopies = funds.reduce((sum, fund) => sum + fund.copyCount, 0);

  async function loadDetail(publicId: string, forCopy = false) {
    const request = ++detailRequest.current;
    setLoadingPublicId(publicId); setError('');
    try {
      const value = await api(`/public/funds/${publicId}`, publicFundDetailSchema);
      if (request !== detailRequest.current) return null;
      if (forCopy) { setCopyTarget(value); setCopyName(defaultCopyName(value.fundName)); copyRequest.current = null; }
      else setDetail(value);
      return value;
    } catch (cause) {
      if (request === detailRequest.current) setError(cause instanceof Error ? cause.message : 'Could not load this fund.');
      return null;
    }
    finally { if (request === detailRequest.current) setLoadingPublicId(null); }
  }
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api('/public/funds', publicFundsSchema, { signal: controller.signal }).then(value => {
        if (!controller.signal.aborted) { cachedPublicFunds = value.funds; setFunds(value.funds); }
      }),
      api('/session', sessionSchema, { signal: controller.signal }).then(current => {
        if (!controller.signal.aborted) { saveCachedSession(current); setSession(current); }
      }).catch(cause => {
        if (!controller.signal.aborted && isUnauthenticated(cause)) { clearPrivateView(); setSession(null); }
      })
    ]).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load the leaderboard.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    if (initialPublicId) void loadDetail(initialPublicId);
    try {
      const intent = JSON.parse(sessionStorage.getItem('ohmyfund-copy-intent') ?? 'null') as { publicId?: string; at?: number } | null;
      if (intent?.publicId && intent.at && Date.now() - intent.at < 15 * 60_000) setPendingPublicId(intent.publicId);
      else sessionStorage.removeItem('ohmyfund-copy-intent');
    } catch { sessionStorage.removeItem('ohmyfund-copy-intent'); }
    return () => controller.abort();
  }, [initialPublicId]);

  useEffect(() => {
    function syncDetailWithHistory() {
      const publicId = publicIdFromLeaderboardPath(window.location.pathname);
      if (publicId) void loadDetail(publicId);
      else { detailRequest.current += 1; setDetail(null); }
    }
    window.addEventListener('popstate', syncDetailWithHistory);
    return () => window.removeEventListener('popstate', syncDetailWithHistory);
  }, []);

  async function bindPending(explicitPublicId?: string) {
    if (!account || !wallet || !tk.session || binding.current) return;
    const copyPublicId = bindIntentPublicId(explicitPublicId, pendingPublicId);
    binding.current = true; setBusy(true); setError('');
    try {
      const current = await bindTurnkeySession({ address: account.address, organizationId: tk.session.organizationId, walletId: wallet.walletId, token: tk.session.token });
      saveCachedSession(current);
      setSession(current);
      if (copyPublicId) {
        const loaded = await loadDetail(copyPublicId, true);
        if (loaded) { setPendingPublicId(null); sessionStorage.removeItem('ohmyfund-copy-intent'); }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not verify your wallet.'); }
    finally { binding.current = false; setBusy(false); }
  }
  useEffect(() => { if (!session && pendingPublicId && tk.authState === AuthState.Authenticated && account) void bindPending(); }, [session, pendingPublicId, tk.authState, account]);

  async function beginCopy(publicId: string) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (session) { await loadDetail(publicId, true); return; }
    setPendingPublicId(publicId); sessionStorage.setItem('ohmyfund-copy-intent', JSON.stringify({ publicId, at: Date.now() }));
    if (tk.authState === AuthState.Authenticated && account) await bindPending(publicId);
    else await tk.handleLogin();
  }
  async function copy() {
    if (!session || !copyTarget || !copyName.trim()) return;
    setBusy(true); setError('');
    try {
      copyRequest.current = copyRequestFor(copyRequest.current, copyTarget.publicId, copyName, () => crypto.randomUUID());
      const result = await api(`/public/funds/${copyTarget.publicId}/copy`, copyPublicFundResultSchema, { method: 'POST', headers: { 'Idempotency-Key': copyRequest.current.key }, body: JSON.stringify({ name: copyName.trim() }) }, session.csrfToken);
      window.location.assign(`/?fund=${encodeURIComponent(result.fund.id)}&copied=1`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not copy this fund.'); setBusy(false); }
  }

  function closeDetail() {
    detailRequest.current += 1; setDetail(null); history.replaceState(null, '', '/leaderboard');
  }
  function closeCopy() {
    setCopyTarget(null); copyRequest.current = null;
  }

  return <><a className="skip" href="#content">Skip to content</a><header className="topbar leaderboard-topbar"><div className="shell topbar-inner"><Link className="brand" href="/" aria-label="OhMyFund home"><BrandLogo /></Link><nav aria-label="Main"><Link href="/">Portfolio</Link><Link href="/screener">Screener</Link><Link className="active" aria-current="page" href="/leaderboard">Leaderboard</Link><PitchDeckLink>Pitch deck ↗</PitchDeckLink></nav><Link className="account-control" href="/?wallet=1" onClick={() => markWalletNavigationIntent()}><WalletIcon /><span className={`account-control-text${session ? ' account-control-address' : ''}`}>{session ? shortAddress(session.user.address) : 'Sign in'}</span></Link></div></header>
    <main id="content" className="shell main leaderboard-main"><div className="leaderboard-heading"><div><span className="leaderboard-eyebrow">Community funds</span><h1>Find a basket you can make your own.</h1><p>Compare public target allocations, see who shared them, then copy one into your private portfolio.</p></div>{funds.length > 0 && <div className="leaderboard-summary" aria-label={`${funds.length} public funds and ${totalCopies} total copies`}><span><strong>{funds.length}</strong> public funds</span><span><strong>{totalCopies}</strong> total copies</span></div>}</div>
      <p className="leaderboard-disclosure">These are target weights for future buys. Public pages never show another person’s balance, plan, or activity.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="leaderboard-list" aria-busy={loading}><ol className="leaderboard-items">{funds.map(fund => <li className="leaderboard-item" key={fund.publicId}>
        <span className="leaderboard-item-rank" aria-label={`Rank ${fund.rank}`}>{fund.rank}</span>
        <a className="leaderboard-item-name" href={`/leaderboard/${fund.publicId}`} onClick={event => { event.preventDefault(); returnFocus.current = event.currentTarget; history.pushState(null, '', `/leaderboard/${fund.publicId}`); void loadDetail(fund.publicId); }}><strong>{fund.fundName}</strong><small>by {fund.publisherName} · {fund.copyCount} {fund.copyCount === 1 ? 'copy' : 'copies'}</small></a>
        <button className="leaderboard-copy leaderboard-item-copy" aria-label={`Copy ${fund.fundName}`} data-state={loadingPublicId === fund.publicId ? 'loading' : undefined} onClick={() => void beginCopy(fund.publicId)} disabled={loadingPublicId === fund.publicId}>{loadingPublicId === fund.publicId ? 'Wait…' : 'Copy'}</button>
        <p className="leaderboard-item-weights" aria-label={`${fund.fundName} target basket`}>{fund.topAssets.map(asset => `${asset.symbol} ${asset.weightBps / 100}%`).join(' · ')}{fund.assetCount > fund.topAssets.length ? ` · +${fund.assetCount - fund.topAssets.length}` : ''}</p>
      </li>)}</ol>{!loading && !error && !funds.length && <div className="leaderboard-empty"><strong>No public funds yet</strong><p>Publish one of your funds to start the list.</p><Link href="/">Open portfolio</Link></div>}{loading && <div className="leaderboard-skeleton" role="status" aria-label="Loading funds">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>}</div>
    </main>
    <BottomNav active="leaderboard" signedIn={!!session} balance={readKnownPortfolioTotal(session) ?? undefined} />
    {detail && !copyTarget && <FundDetailDialog detail={detail} onClose={closeDetail} onCopy={publicId => void beginCopy(publicId)} returnFocusTo={returnFocus} />}
    {copyTarget && <CopyDialog target={copyTarget} name={copyName} busy={busy} error={error} onNameChange={setCopyName} onClose={closeCopy} onCopy={() => void copy()} returnFocusTo={returnFocus} />}
  </>;
}

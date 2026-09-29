'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import { screenerDetailSchema, screenerListSchema, sessionSchema } from '@ohmyfund/contracts';
import logos from './logos.json';
import { BrandLogo } from '../brand-logo';
import { PitchDeckLink } from '../pitch-deck-link';
import { issuerLabel, variantLabel } from '../variant-label';
import { useDialog } from '../use-dialog';
import { api, isUnauthenticated } from '../browser-api';
import { shortAddress } from '../fund-types';
import { clearPrivateView, readCachedSession, readKnownPortfolioTotal, saveCachedSession } from '../private-view-cache';
import { WalletIcon } from '../icons';
import { BottomNav } from '../bottom-nav';
import { markWalletNavigationIntent } from '../wallet-navigation-intent';

type Session = typeof sessionSchema._output;

type Listing = typeof screenerListSchema._output;
type Detail = typeof screenerDetailSchema._output;
type Category = 'crypto' | 'currency' | 'treasury' | 'etf' | 'commodity' | 'equity';
type Sort = 'name' | 'price' | 'priceChange24hPercent' | 'volume24hUSD';
type ScreenerView = { category: Category; query: string; sort: Sort; direction: 'asc' | 'desc'; page: number; listing: Listing };
let cachedScreenerView: ScreenerView | null = null;
const listingCache = new Map<string, Listing>();
const listingKey = (category: Category, query: string, sort: Sort, direction: 'asc' | 'desc', page: number) =>
  new URLSearchParams({ category, q: query, sort, direction, page: String(page) }).toString();
const categories: { id: Category; label: string }[] = [{ id: 'crypto', label: 'Crypto' }, { id: 'currency', label: 'Currencies' }, { id: 'treasury', label: 'Treasuries' }, { id: 'etf', label: 'ETFs' }, { id: 'commodity', label: 'Metals' }, { id: 'equity', label: 'Stocks' }];
const money = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);
const compact = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n);
const percent = (n: number | null) => n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
function SortHeader({ label, shortLabel, field, sort, direction, onSort }: { label: string; shortLabel?: string; field: Sort; sort: Sort; direction: 'asc' | 'desc'; onSort: (field: Sort) => void }) {
  const active = sort === field;
  return <th scope="col" aria-sort={active ? direction === 'asc' ? 'ascending' : 'descending' : undefined}><button className="screener-sort" onClick={() => onSort(field)} aria-label={`Sort by ${label}${active ? `, currently ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}`}><span className={shortLabel ? 'desktop-label' : ''}>{label}</span>{shortLabel && <span className="mobile-label">{shortLabel}</span>}<span aria-hidden="true">{active ? direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>;
}

function Sparkline({ candles, symbol }: { candles: { time: number; close: number }[]; symbol: string }) {
  if (candles.length < 2) return <span className="chart-missing" aria-label="Chart unavailable">—</span>;
  const values = candles.map(c => c.close);
  const low = Math.min(...values), range = Math.max(...values) - low || 1;
  const start = candles[0].time, span = candles[candles.length - 1].time - start || 1;
  const segments: string[][] = [[]];
  candles.forEach((c, i) => {
    if (i && c.time - candles[i - 1].time > 5400) segments.push([]);
    segments[segments.length - 1].push(`${4 + (c.time - start) / span * 152},${44 - (c.close - low) / range * 36}`);
  });
  return <svg className={`screener-sparkline ${candles[candles.length - 1].close >= candles[0].close ? 'trend-up' : 'trend-down'}`} viewBox="0 0 160 52" role="img" aria-label={`${symbol} saved price trend`}>{segments.filter(s => s.length > 1).map((s, i) => <polyline key={i} points={s.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.7" />)}</svg>;
}

function AssetDetailDialog({ detail, onClose, returnFocusTo }: { detail: Detail; onClose: () => void; returnFocusTo: RefObject<HTMLElement | null> }) {
  const [variantId, setVariantId] = useState(detail.primaryVariantId);
  const selected = detail.variants.find(variant => variant.variantId === variantId);
  const candles = selected?.chart.candles ?? [];
  const closes = candles.map(c => c.close);
  const low = Math.min(...closes); const high = Math.max(...closes);
  const points = candles.map((c, i) => `${(i / Math.max(1, candles.length - 1)) * 100},${90 - ((c.close - low) / Math.max(high - low, 0.000001)) * 80}`).join(' ');
  const closeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useDialog(onClose, closeRef, returnFocusTo);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={containerRef} className="modal screener-detail" role="dialog" aria-modal="true" aria-labelledby="asset-title"><div className="section-head"><div><p className="eyebrow">{detail.category}</p><h2 id="asset-title">{detail.name}</h2></div><button ref={closeRef} className="icon" aria-label="Close" onClick={onClose}>×</button></div><label>Token version<select value={variantId} onChange={event => setVariantId(event.target.value)}>{detail.variants.map(variant => <option key={variant.variantId} value={variant.variantId}>{variantLabel({ symbol: variant.tokenSymbol, issuer: variant.issuer, mint: variant.mint })}</option>)}</select></label>{selected && <><div className="detail-price"><strong>{money(selected.market.price)}</strong><span>{percent(selected.market.priceChange24hPercent)} in 24h</span></div>{candles.length > 1 ? <svg className="price-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Historical price chart"><polyline fill="none" stroke="#202124" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={points} /></svg> : <div className="chart-empty">No chart is available for this token.</div>}<div className="detail-facts"><span>24h volume<strong>{compact(selected.market.volume24hUSD)}</strong></span><span>Liquidity<strong>{compact(selected.market.liquidity)}</strong></span></div><p className="small muted">Mint: <code>{selected.mint}</code></p><p className="small muted">Snapshot from {new Date(detail.snapshot.retrievedAt).toLocaleDateString()}, not a live quote.</p><Link className="button primary" href={`/?add=${encodeURIComponent(detail.assetId)}.${encodeURIComponent(selected.variantId)}`}>Add to fund</Link></>}</div></div>;
}

export function Screener() {
  const [category, setCategory] = useState<Category>(() => cachedScreenerView?.category ?? 'crypto');
  const [queryInput, setQueryInput] = useState(() => cachedScreenerView?.query ?? '');
  const [query, setQuery] = useState(() => cachedScreenerView?.query ?? '');
  const [sort, setSort] = useState<Sort>(() => cachedScreenerView?.sort ?? 'volume24hUSD');
  const [direction, setDirection] = useState<'asc' | 'desc'>(() => cachedScreenerView?.direction ?? 'desc');
  const [page, setPage] = useState(() => cachedScreenerView?.page ?? 1);
  const [loaded, setLoaded] = useState<{ key: string; listing: Listing } | null>(() => cachedScreenerView ? {
    key: listingKey(cachedScreenerView.category, cachedScreenerView.query, cachedScreenerView.sort, cachedScreenerView.direction, cachedScreenerView.page),
    listing: cachedScreenerView.listing,
  } : null);
  const [updating, setUpdating] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [suggestedCategory, setSuggestedCategory] = useState<Category | null>(null);
  const [session, setSession] = useState<Session | null>(readCachedSession);
  const key = listingKey(category, query, sort, direction, page);
  // Never show rows from a different tab or filter while its request is pending.
  const listing = loaded?.key === key ? loaded.listing : listingCache.get(key) ?? null;
  // Session refresh is best-effort; this public market snapshot works independently.
  useEffect(() => {
    const controller = new AbortController();
    api('/session', sessionSchema, { signal: controller.signal }).then(current => {
      if (!controller.signal.aborted) { saveCachedSession(current); setSession(current); }
    }).catch(cause => {
      if (!controller.signal.aborted && isUnauthenticated(cause)) { clearPrivateView(); setSession(null); }
    });
    return () => controller.abort();
  }, []);
  // Debounce typing so a fetch doesn't fire on every keystroke, especially on a
  // mobile keyboard where each tap would otherwise start a new request.
  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput), 300);
    return () => clearTimeout(id);
  }, [queryInput]);
  const detailRequest = useRef(0);
  // The row button disables itself while its fetch is in flight (see `open`), which
  // blurs it — so by the time the dialog mounts, document.activeElement is already
  // <body>. Capture the real trigger at click time instead of relying on that.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  function changeSort(field: Sort) {
    setDirection(current => sort === field ? current === 'asc' ? 'desc' : 'asc' : field === 'name' ? 'asc' : 'desc');
    setSort(field); setPage(1);
  }
  const [reloadToken, setReloadToken] = useState(0);
  const handledReload = useRef(0);
  useEffect(() => {
    const retry = reloadToken !== handledReload.current;
    handledReload.current = reloadToken;
    if (listingCache.has(key) && !retry) { setUpdating(false); setError(''); return; }
    const controller = new AbortController();
    setUpdating(true);
    setError('');
    fetch(`/api/screener?${key}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load the screener.');
      return screenerListSchema.parse(await response.json());
    }).then(value => { if (!controller.signal.aborted) { cachedScreenerView = { category, query, sort, direction, page, listing: value }; listingCache.set(key, value); setLoaded({ key, listing: value }); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load assets.'); }).finally(() => { if (!controller.signal.aborted) setUpdating(false); });
    return () => controller.abort();
  }, [category, query, sort, direction, page, key, reloadToken]);
  // Search only ever filters within the active category tab (the API takes one
  // required category). A miss here can look like "not supported" when the asset is
  // just in a different tab, so probe the others and point at the first real hit.
  useEffect(() => {
    if (!listing || listing.rows.length || !query.trim()) { setSuggestedCategory(null); return; }
    const controller = new AbortController();
    (async () => {
      for (const candidate of categories.filter(item => item.id !== category)) {
        if (controller.signal.aborted) return;
        try {
          const params = new URLSearchParams({ category: candidate.id, q: query, sort: 'volume24hUSD', direction: 'desc', page: '1' });
          const response = await fetch(`/api/screener?${params}`, { signal: controller.signal });
          if (!response.ok) continue;
          const value = screenerListSchema.parse(await response.json());
          if (value.total > 0) { setSuggestedCategory(candidate.id); return; }
        } catch { /* try the next category */ }
      }
      if (!controller.signal.aborted) setSuggestedCategory(null);
    })();
    return () => controller.abort();
  }, [listing, query, category]);
  async function open(assetId: string) {
    const request = ++detailRequest.current;
    setOpeningId(assetId); setError('');
    try {
      const response = await fetch(`/api/screener/${encodeURIComponent(assetId)}`);
      if (!response.ok) throw new Error('Could not load this asset.');
      const value = screenerDetailSchema.parse(await response.json());
      // A newer open()/closeDetail() call already moved on; this response is stale.
      if (request !== detailRequest.current) return;
      setDetail(value);
    } catch (cause) { if (request === detailRequest.current) setError(cause instanceof Error ? cause.message : 'Could not load this asset.'); }
    finally { if (request === detailRequest.current) setOpeningId(null); }
  }
  function closeDetail() { detailRequest.current += 1; setDetail(null); }
  return <><a className="skip" href="#content">Skip to content</a><header className="topbar"><div className="shell topbar-inner"><Link className="brand" href="/" aria-label="OhMyFund home"><BrandLogo /></Link><nav aria-label="Main"><Link href="/">Portfolio</Link><Link className="active" aria-current="page" href="/screener">Screener</Link><Link href="/leaderboard">Leaderboard</Link><PitchDeckLink>Pitch deck ↗</PitchDeckLink></nav><Link className="account-control" href="/?wallet=1" onClick={() => markWalletNavigationIntent()}><WalletIcon /><span className={`account-control-text${session ? ' account-control-address' : ''}`}>{session ? shortAddress(session.user.address) : 'Sign in'}</span></Link></div></header>
    <main id="content" className="shell main screener-main"><h1 className="sr-only">Screener</h1>
      <div className="screener-toolbar"><label><span className="sr-only">Search assets</span><span className="search-glyph" aria-hidden="true">⌕</span><input type="search" value={queryInput} onChange={event => { setQueryInput(event.target.value); setPage(1); }} placeholder={`Search ${categories.find(item => item.id === category)?.label}`} /></label></div>
      <p className="small muted screener-freshness" role="status">{listing ? <>Snapshot from {new Date(listing.snapshot.retrievedAt).toLocaleDateString()} · not a live trading screen{updating ? ' · Updating…' : ''}</> : error ? 'Market snapshot unavailable' : 'Loading market snapshot…'}</p>
      <div className="screener-tabs" role="group" aria-label="Asset category">{categories.map(item => <button key={item.id} aria-pressed={category === item.id} className={category === item.id ? 'active' : ''} onClick={() => { setCategory(item.id); setPage(1); }}>{item.label}</button>)}</div>
      {error && <p className="error" role="alert">{error} <button type="button" className="screener-empty-link" onClick={() => setReloadToken(value => value + 1)}>Retry</button></p>}
      <div className="screener-table-wrap" aria-busy={updating || (!listing && !error)}><table className="screener-table"><caption className="sr-only">Asset screener market snapshot</caption><thead><tr><SortHeader label="Token name" field="name" sort={sort} direction={direction} onSort={changeSort} /><SortHeader label="Price" field="price" sort={sort} direction={direction} onSort={changeSort} /><SortHeader label="24h change" shortLabel="24h" field="priceChange24hPercent" sort={sort} direction={direction} onSort={changeSort} /><th scope="col" className="chart-col">Last 24h</th><SortHeader label="24h volume" field="volume24hUSD" sort={sort} direction={direction} onSort={changeSort} /><th scope="col" className="action-col"><span className="sr-only">Add to fund</span></th></tr></thead><tbody>{!listing && !error && Array.from({ length: 8 }, (_, index) => <tr className="screener-loading-row" key={index} aria-hidden="true"><td><span className="screener-loading-identity"><span className="screener-loading-avatar" /><span className="screener-loading-lines"><span /><span /></span></span></td><td className="numeric"><span className="screener-loading-value" /></td><td className="numeric"><span className="screener-loading-value" /></td><td className="chart-col"><span className="screener-loading-value" /></td><td className="volume-col"><span className="screener-loading-value" /></td><td className="action-col" /></tr>)}{listing?.rows.map(row => { const logo = (logos as Record<string, string>)[row.variant.mint] ?? row.imageUrl; return <tr key={row.assetId}><td><button className="screener-identity" data-state={openingId === row.assetId ? 'loading' : undefined} disabled={openingId === row.assetId} onClick={event => { returnFocusTo.current = event.currentTarget; void open(row.assetId); }} aria-label={`View ${row.name} details`}><span className="screener-avatar" aria-hidden="true">{row.symbol.slice(0, 2)}{logo && <img src={logo} alt="" width="28" height="28" onError={event => { event.currentTarget.style.display = 'none'; }} />}</span><span className="screener-name"><span><strong>{row.name}</strong><small>{row.symbol}</small></span><span className="screener-issuer">{issuerLabel(row.variant.issuer)}{row.variantCount > 1 ? ` · ${row.variantCount} versions` : ''}</span></span></button></td><td className="numeric">{money(row.variant.market.price)}</td><td className={`numeric ${row.variant.market.priceChange24hPercent !== null && row.variant.market.priceChange24hPercent < 0 ? 'negative' : 'positive'}`}>{percent(row.variant.market.priceChange24hPercent)}</td><td className="chart-col"><Sparkline candles={row.variant.chart.candles} symbol={row.symbol} /></td><td className="numeric volume-col">{compact(row.variant.market.volume24hUSD)}</td><td className="action-col"><Link className="screener-add" href={`/?add=${encodeURIComponent(row.assetId)}.${encodeURIComponent(row.primaryVariantId)}`} aria-label={`Add ${row.symbol} to fund`} title="Add to fund">+</Link></td></tr>; })}</tbody></table>{listing && !listing.rows.length && <div className="empty"><h2>No matching assets</h2><p>{!query.trim() ? 'Try a company name or ticker.' : <>No results in {categories.find(item => item.id === category)?.label}.{suggestedCategory && <> Try <button type="button" className="screener-empty-link" onClick={() => { setCategory(suggestedCategory); setPage(1); }}>{categories.find(item => item.id === suggestedCategory)?.label}</button>.</>}</>}</p></div>}{!listing && !error && <span className="sr-only" role="status">Loading {categories.find(item => item.id === category)?.label} assets…</span>}</div>
      {listing && <div className="screener-pagination"><button className="screener-page-arrow" aria-label="Previous page" disabled={listing.page <= 1} onClick={() => setPage(value => value - 1)}><span aria-hidden="true">←</span></button><span>{listing.total ? `${(listing.page - 1) * 20 + 1}–${Math.min(listing.page * 20, listing.total)} of ${listing.total}` : '0 assets'}</span><button className="screener-page-arrow" aria-label="Next page" disabled={listing.page >= listing.pageCount} onClick={() => setPage(value => value + 1)}><span aria-hidden="true">→</span></button></div>}
    </main>
    <BottomNav active="screener" signedIn={!!session} balance={readKnownPortfolioTotal(session) ?? undefined} />
    {detail && <AssetDetailDialog detail={detail} onClose={closeDetail} returnFocusTo={returnFocusTo} />}
  </>;
}

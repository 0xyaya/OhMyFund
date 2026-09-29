> Superseded scope: the user requested all issuers. Delivered Screener has 395 equity rows and 502 selectable variants; see DESIGN.md.

# Backpack Securities screener plan

Status: local screener delivered, 2026-09-15. User selected local preview only. Live server adapter and public deployment remain deferred.

## Outcome

Add a **Stocks** tab where users can browse Backpack Securities stocks, compare market data, and add a stock to a basket draft. Browsing requires no wallet connection. Keep the hackathon scope to one screener and one small detail panel.

Navigation: Portfolio · Stocks · Activity. Page heading: Backpack Securities stocks.

## Reference and verified API facts

- [Sunrise Tokens](https://sunrise.xyz/tokens): inspected its loaded desktop page. Compact rows show identity, price, 1D change, last-24h sparkline, volume, and market cap. Its list also contains crypto and ETFs; our stock-only scope must be explicit.
- [Tokens quickstart](https://docs.tokens.xyz/v1/quickstart): v1 requires an `x-api-key` kept server-side. Canonical assets can contain several Solana token variants. Mint-specific OHLCV is available; canonical price charts may use underlying stock data.
- [Assets collection reference](https://docs.tokens.xyz/v1/endpoints/assets): curated stock discovery supports mint grouping and pagination. Variant records expose issuer metadata and mint-specific market fields. Canonical `stats` can aggregate across variants even in mint-grouped results.
- Authenticated API responses and Backpack's exact issuer identifier have not yet been checked. No claim that the live catalog is complete or that every mint has chart coverage.

## 1. Establish the stock catalog and data contract first

1. Use `GET /v1/assets/curated?list=stocks&groupBy=mint&limit=100`; follow `pagination.nextOffset` until complete.
2. Select only Solana Backpack Securities equity mints. Verify exact issuer metadata against official Backpack mint information before defining the predicate. Do not match names containing “Backpack” or assume `primaryVariant` is the desired issuer in canonical-grouped responses.
3. Exclude crypto, ETFs, other issuers, and ambiguous classifications. This is stock-only, as requested. If the catalog lacks reliable issuer metadata, use a small official-mint allowlist for the demo and label catalog coverage; do not guess identities.
4. Deduplicate by mint. Keep both `assetId` for data lookup and `mint` for basket identity. The asset picker and screener share this catalog; adding a stock must never substitute another issuer's token.
5. Normalize to an app-owned shape:

   `mint, assetId, ticker, companyName, logoUrl, issuer, priceUsd, change24hPct, volume24hUsd, liquidityUsd, marketAsOf, fetchedAt, sparkline, chartAsOf, availability`

6. Use the selected variant's `market` values, not canonical `stats`, for the screener's price/change/volume. Validate numeric values and nullable fields. Missing data stays unavailable.

Acceptance: mixed-issuer and mixed-category fixtures yield only verified Backpack stock mints; all discovery pages are processed. Identity does not change when liquidity rankings change.

## 2. Build the Sunrise-style screen

- Retain OhMyFund's Geist typography, warm neutral surface, and coral accent.
- One heading and a short scope label; then search and sort controls, followed by a compact table. No promotional cards.
- Search company name or ticker within the approved catalog.
- Default sort: company name A–Z, avoiding an implied recommendation. Allow sorting by price, 24h change, and 24h volume; nulls always last and ties stable.
- Desktop columns: **Stock · Price · 24h change · Last 24h · 24h volume · Add to fund**.
- Stock cell: logo, ticker, company name. State Backpack once in the page heading instead of repeating a long issuer suffix in every row.
- Use signed change values as well as color. Render sparklines from real mint-specific data only; show an em dash when absent. Each sparkline uses its own range and is a trend cue, not a shared price scale.
- Omit market cap from the first version: a token's circulating value is easy to confuse with the company's market cap. Show liquidity in the detail panel instead.
- Mobile: stock name/ticker, price and 24h change remain visible. A row opens details with chart, volume, liquidity and Add to fund. Desktop search/sort capabilities remain available through a compact Sort control. No page-wide horizontal scroll.
- Paginate 20 rows at a time; show total matching stocks and a clear no-results state.

Acceptance: desktop resembles Sunrise's information hierarchy while remaining visually part of OhMyFund. At 375px users can identify a stock, see its price/change and reach Add to fund.

## 3. Connect discovery to basket creation

- Add to fund opens a chooser for an existing editable, active fund or Create new fund.
- Open the existing basket editor with the selected mint added to a draft. Require the user to set weights or use Equal split, then save. Never silently alter a fund's saved weights or schedule.
- A duplicate stock shows Already in this fund. Fixed and archived funds cannot be edited; explain why in the chooser.
- Disconnected users can browse and select a stock. Preserve the pending selection through connection, then open the chooser. In the design prototype, clearly label this as a simulated transition rather than pretending Privy works.
- No direct Buy button, new DCA page, or subscription feature. The existing optional recurring-buy step handles scheduling.

Acceptance: choosing a stock preserves the exact Backpack mint; cancelling leaves the original fund unchanged; existing schedules remain intact after basket edits.

## 4. Wire market data with a small server adapter

- Production app: `GET /api/stocks` serves the normalized catalog/market rows. `GET /api/stocks/:mint/chart` accepts only catalog mints. Keep `TOKENS_API_KEY` in server configuration; never embed it in the HTML preview.
- Curated rows already include market data. Use that first; refresh selected mints with `GET /v1/assets/variant-markets?mints=...` in batches of at most 50 when needed.
- For charts use `GET /v1/assets/:assetId/ohlcv?mint=...&interval=1H&from=...&to=...` for the past 24 hours. Do not silently substitute canonical company-price candles. Check the documented response shape before mapping it.
- Fetch charts only for the visible desktop page or opened mobile detail, with bounded concurrency (e.g. 4). Avoid fetching charts for the whole universe.
- Proposed cache: catalog 15 minutes; market responses 60 seconds; charts 5 minutes. Refresh market data only while the page is visible. These are app refresh targets, not guarantees about upstream freshness.
- Preserve provider timestamps. Keep fetch time separate from market observation time. Show stale data clearly; unknown observation age is not “live.”
- Loading: skeleton rows. No results: reset-search action. API failure with prior data: retain labelled stale rows and show Retry. No prior data: unavailable state. Never silently replace a failed live request with sample prices.
- Bound retries and respect 429 backoff. Keep the proxy limited to approved endpoints/mints rather than accepting arbitrary upstream URLs.

The repository currently contains a static prototype, not an application backend. Implement UI states with explicitly labelled fixtures first; live data requires the server adapter and a working API key. Do not expose a key to make `file://` previews fetch directly.

## 5. Verify and hand off

- Data checks: mixed issuers, ETFs, duplicate mints, canonical-vs-mint metrics, pagination, null prices, stale timestamps, API errors, and chart gaps.
- Flow checks: search, sort, page changes, details, add to new/existing fund, duplicate prevention, immutable/archived funds, and cancellation without mutation.
- Layout checks: 320/375/414/768px and desktop; keyboard row/detail access, semantic table headers, labelled sort state, readable changes, and 44px touch targets.
- Keep existing portfolio/basket regression checks passing. Confirm a stock-only screener does not remove SOL from the existing general basket picker.
- Update DESIGN.md, prototype validation notes, and screenshot evidence.

## Delivery order and timebox

1. Verify one authenticated catalog response, Backpack issuer identity, and one mint chart response.
2. Implement the screen and fund-draft handoff with labelled fixtures.
3. Connect the cached server adapter when app scaffolding/API credentials are available.
4. Test responsive layouts, data boundaries, and existing fund flows.

Budget: approximately half a day once API access and the app server exist. If coverage or integration takes longer, complete the labelled prototype and report the exact live-data gap. Keep watchlists, sector filters, fundamentals, news, multi-period charts, and company market cap for later.

Token-2022 behavior checks remain in the existing TODO as agreed. Catalog identity filtering is needed to satisfy Backpack-only scope; it does not reopen those deferred behavior checks.

## Retrieved catalog update

The saved Tokens `category=equity` snapshot contains 395 canonical assets. Filtering now produces **32 equities with one Backpack-attributed mint each**, with no ambiguous multi-mint matches. Use `data/backpack-equities.json` for the proposed screener fixture; rerun `python3 scripts/filter-backpack-equities.py` against an updated source snapshot.

Tokens often omits `issuer`. Attribution uses exact issuer, exact provider label/tag, or an exact ` - Backpack Securities` name suffix corroborated by an HTTPS logo on `backpack.exchange` or `metadata.backpack.exchange`. An explicit conflicting issuer is excluded. Evidence is recorded per row; this is provider metadata attribution, not independent mint verification. Equities without a match are excluded, never replaced with another issuer. The prototype UI is not wired to this catalog yet.

## Local delivery evidence

Implemented `stocks.js`, a generated offline `stocks-data.js` bundle, and Stocks navigation in `simple.html`. All 32 stocks have mint-specific chart snapshots. `scripts/build-stock-preview.py` rebuilds chart snapshots from the publicly readable Tokens website endpoint; this is not a supported authenticated production API adapter.

19 screener regression checks and all 15 prior UX regression checks pass. Responsive checks pass at 320/375/414/768px with no horizontal overflow or undersized visible screener controls. Desktop/mobile/detail screenshots are saved beside the prototype. The local version uses ticker initials instead of external logos. No Git initialization, push, or deployment was performed.

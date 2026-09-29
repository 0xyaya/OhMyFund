# Design check — 2026-09-15

Scope: interactive design prototype, not production application QA.

## Verified

- Fund creation from Portfolio through the two-step form.
- A second recurring plan on the same fund; pause updates the intended plan.
- Blank-name validation blocks progression and focuses the name field.
- Native dialogs provide modal behavior; visible focus styles, reduced-motion CSS, and 44px+ controls are present.
- Portfolio and fund detail inspected at 320, 375, 414, and 768px; no horizontal page overflow. Main button/nav clipping checks returned no failures.
- Native dialog inspected at 320px. Shortened asset labels to fit.
- JavaScript syntax check passed; no application console errors observed.
- Token contrast measured in browser: ink/paper 16.37:1, muted/paper 5.64:1, muted/secondary-paper 5.26:1, ink/accent 5.02:1. Focus adjusted after an initial failure: now 3.17:1 against ink, 5.16:1 against paper.
- Local Geist font files loaded for rendered weights, with OFL license included. The browser's generic 400-weight font check initially reported false because that unused face was not loaded; this was not proof of a font network failure.

## Hallmark application

Stat-Led adapted to portfolio value; Coral palette and Geist type; simple N1 navigation and Ft2 footer; no imagery or marketing sections. First Hallmark run, so no rotation constraint. No invented balances/returns: values are unavailable placeholders. Sample amounts are labelled example configuration. Six-axis self-review is stamped in CSS.

Reviewed the Hallmark gates as a manual design checklist. Do not describe this as an automated 58/58 certification. Marketing-specific layout requirements do not govern the product UI. Business-state wiring, a full screen-reader audit, arbitrary long-input coverage, and live financial feedback states remain implementation work.

## Prototype limits

- Changes reset on reload; no API, signing, persistence, or live metrics.
- Three sample assets; no complete searchable mint directory.
- Schedule times are illustrative, not a scheduler calculation.
- Activity and holdings now have explicitly labelled illustrative sample states. Real receipts, market prices, PnL and transaction outcomes remain application work.
- Permanent locking and plan cancellation use native confirmation prompts in this preview. The production flow must include the real wallet confirmation and must not silently confirm a chain operation.

## UX improvement verification — 2026-09-15

- 15 browser regression assertions passed. Reusable checks: `docs/designs/checks/ux-regression.js`; run with `browse eval docs/designs/checks/ux-regression.js` after navigating to the prototype, then reload.
- Covers equal splits for 1/2/3 assets, removal/remainder, summary input/reset, create with schedule, multiple schedules, shared-cash accounting, selected-plan pause, archive cancellation, retained holdings/history, and visible archive result link.
- Portfolio width/target checks passed at 320, 375, 414, 768 and 1280px. The intentionally hidden skip link is excluded from visible target results. Long-name fund detail had no horizontal page overflow at 320px.
- Fresh desktop/mobile screenshots visually inspected. At 375×812, fund next-plan Pause bottom measured 655px (including preview controls). Allocation dialog inspected at 320px.
- Blank-name and duplicate-asset validation tested; focus moves to the name or allocation group. Native Escape closes the dialog; Tab reaches asset selection inside the modal. This is a focused keyboard check, not a full screen-reader audit.
- Disconnected and first-fund scenario rendering checked.
- Existing color tokens retained; earlier measured contrast ratios still apply. No full new contrast audit claimed.
- `node --check docs/designs/simple.js` passed. No new application console errors observed during the pass.
- Before evidence: `simple-desktop.png`, `simple-mobile.png`. After evidence: `improved-desktop.png`, `improved-mobile.png`, `improved-fund-mobile.png`, `improved-create.png`.

No live wallet or signing integration was added. Scenario changes reset preview data. Scheduled dates illustrate the next local 09:00 occurrence tomorrow; this is not a running scheduler. Funding checks cover the next occurrence per active plan.

## Stock screener verification — 2026-09-15

- 19 assertions in `checks/stocks-regression.js` passed: identity/count, pagination, company/ticker search, empty state, descending/null sorting, missing-chart state, duplicate/fixed/archived eligibility, draft cancellation, exact saved mint, preserved schedules, new fund flow, simulated disconnected continuation, and SOL availability.
- Existing 15 UX assertions still pass with the expanded picker.
- Layout/visible control sizes checked at 320/375/414/768px. Desktop, mobile, and detail dialog visually inspected. Escape closes the stock dialog.
- All 32 chart responses matched the requested mint and contained at least two valid hourly points. Chart gaps split paths. Snapshot and chart capture times are disclosed separately.
- Syntax checks pass for `simple.js`, `stocks.js`, and the generated data bundle.
- Local-only delivery. Data is saved, fund edits are in memory, and the connection continuation is explicitly simulated. No production API, persistence, signing, or deployment is claimed.

## All-issuer Screener verification

- 21 screener assertions and 15 prior UX assertions passed (36 total).
- New checks cover 395 canonical equities, 502 variants, selected-version market/mint switching, and exact chosen issuer mint in a new basket draft.
- Mobile rendering visually inspected at 375px; no horizontal overflow at 320/414/768/1280px. Desktop also visually inspected.
- Existing source classifications are preserved, including provider-labelled equity entries whose names describe ETFs; this UI is not an independently audited stock taxonomy.
- One row per canonical equity defaults to the provider's primary variant. No automatic Backpack preference. The legacy #stocks link still opens the Screener; navigation uses #screener.

## Tokens visual redesign verification

- Inspected Tokens.xyz and its MIT-licensed source table component.
- All 36 existing assertions passed after the table redesign. Sortable column-header interaction additionally checked.
- No page overflow or visible screener buttons below 44px at 320/375/414/768px. Desktop and mobile screenshots visually reviewed; shortened mobile change header to prevent crowding.
- Source attribution: `docs/designs/licenses/tokens-MIT.txt`; font license: `Inter-OFL.txt`. 113 local company logos with initials fallback.

## Category controls verification

41 assertions passed (15 existing UX + 26 screener), including category counts and removal of the visible title/sort controls. Desktop and mobile category layouts visually inspected. Search and table-header sorting remain available. Snapshot source covers Crypto, ETFs, Metals and Stocks only; no Currencies, Treasuries or Trending controls.

## Chart fetch expansion verification

- Requested all 640 distinct mints across 643 variant records. Validated response mint, finite positive closes, requested time window, sorted points and duplicate timestamps.
- 244 mints returned >=2 valid candles; 396 returned insufficient history. No request failures. Full report: `data/screener-chart-report.json`.
- All 41 UX/screener regression assertions passed. Chart-normalization, wrong-mint rejection, and empty-history checks also passed.
- Browser verification: all 20 first-page Stocks rows now render a chart. Screenshot: `screener-charts-complete.png`.
- Refresh script is repeatable, uses six concurrent requests, respects bounded retry delays, and updates the bundle atomically. No live auto-refresh is claimed.


## Shared visual style verification · 2026-09-15

- 41 existing behavioral checks passed (15 portfolio/UX, 26 screener).
- Portfolio, fund detail, activity, screener checked at 320, 375, 768, 1280px: no document overflow; main buttons and links at least 44px.
- Desktop and mobile screenshots reviewed, including fund editor, wallet, recurring buy, empty and disconnected states.
- App-wide Inter and neutral Tokens-inspired surfaces replace the earlier warm theme. No data or transaction behavior changed.

## Portfolio structure · 2026-09-16

- Portfolio shows aggregate fund holdings and estimated unrealized return, then the fund list. No wallet-wide allocation or routine next-purchase card.
- Global wallet control shows available USDC; wallet dialog explains deposits. Real wallet integration remains disabled.
- Fund detail shows performance, actual allocation, target weights and recurring buys. Allocation bars share a consistent scale and column width.
- Performance paths are explicitly illustrative demo fixtures, separate from token market charts. Empty funds show a history empty state.
- Browser validation: 15 UX checks and 26 screener checks passed. Portfolio checked at 320, 375, 768 and 1280px without document overflow; desktop/mobile portfolio and fund detail screenshots reviewed.

## Fund sharing · 2026-09-16

Fund details now include Share. The dialog renders the selected basket name, issuer labels and target weights into a local PNG and offers an X text draft. Balances and wallet addresses are not included. The user downloads and attaches the image manually; no post is sent by the app. Card and draft explicitly say design preview. Checked mobile dialog, PNG data URL, selected weights and encoded draft. Public fund URLs and automatic link-preview cards require hosting and remain deferred.

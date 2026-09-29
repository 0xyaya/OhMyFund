# Screener integration plan

Status: saved-snapshot Screener deployed and public flows production-verified 2026-09-18; authenticated Add to fund save remains unverified.  
Date: 2026-09-18  
Reviewed with: gstack `/plan-eng-review`  
Supersedes the production-integration parts of `stock-screener-plan.md`. The older Backpack-only scope is obsolete.

## Outcome and settled decisions

Ship the approved Screener from `DESIGN.md` as a public page in the deployed Next.js app. Keep the four categories, search, sorting, pagination, asset detail, issuer/variant selection, saved mint-specific charts, and Add to fund draft flow shown in `docs/designs/simple.html`. Browsing needs no Turnkey login. The page must never claim its saved prices are live.

`data/tokens-screener.json` is the approved Tokens.xyz asset and variant catalog for **fund configuration**: 455 assets, 643 source variant records (31 crypto, 25 ETFs, 4 metals/commodities, 395 stocks/equities), retrieved 2026-09-15. Do not invent a second three-asset approval list. Accept exact `(assetId, variantId)` pairs from this catalog when creating or replacing a fund. Preserve the selected variant's Solana mint as metadata; do not silently swap issuers or variants. Catalog approval does **not** assert swap availability or token-transfer compatibility. DCA execution remains out of scope.

The first integration serves the saved snapshot already approved in the prototype. Show its source and retrieval time, plus the selected variant's market observation/fetch time when available. Mark data older than 24 hours stale; show unknown or missing values as unavailable. Do not call the numbers live, use them for holdings/P&L, or derive a made-up price for a missing variant. Live Tokens.xyz refresh is a separate follow-up.

## What already exists

- `DESIGN.md`, `docs/designs/simple.html`, `docs/designs/stocks.js`, `docs/designs/screener.css`, and `docs/designs/checks/stocks-regression.js` define and test the approved local experience. Reuse behavior and visual tokens, not the prototype's in-memory fund state or DOM code.
- `data/tokens-screener.json` has the full catalog and source timestamp. `docs/designs/stocks-data.js` holds saved mint-specific chart coverage. The chart refresh script and report already exist.
- `apps/api/src/catalog.ts` and `/api/catalog` currently expose only three picker entries. `apps/api/src/funds.ts` validates that three-entry list. This is the production gap, not a product decision.
- `packages/contracts` holds shared Zod schemas. `apps/web/app/ui.tsx` has the fund editor and atomic full-set save flow. `apps/api/src/server.ts` has the Origin/host guard. The VPS API and Vercel web deploy paths already exist.

## Data and authority

```text
Tokens.xyz saved source JSON (455 assets / 643 variants)
       │ validated build artifact, no live provider call
       ▼
VPS API in-memory catalog index ── public paged Screener reads ──> Next.js /screener
       │ exact assetId + variantId membership
       ▼
fund create / full-set replace ── PostgreSQL transaction ──> saved target basket
```

1. Add a deterministic catalog build/validation step. Fail on duplicate asset IDs, conflicting mappings for one `(assetId, variantId)`, absent variant IDs/mints, mismatched asset/variant ownership, invalid category, malformed numbers/timestamps, or unexpected counts. The source has two exact repeated variant records (Uniswap and Roundhill Memory ETF) and one cross-asset mint alias (Tron/xStock Tron): retain 643 as the source count, collapse exact repeats to 641 selectable pairs, and retain both canonical asset pages for the shared mint. Never present one mint twice in a single fund; validate mint uniqueness as well as asset-ID uniqueness. Preserve the raw source URL and timestamps. Convert the existing chart cache to a clean JSON artifact keyed by mint; missing, insufficient-history, and failed chart states stay distinct. No `window.STOCK_SNAPSHOT` parsing at API runtime.
2. Copy the generated catalog and chart artifacts into the API Docker image. Load and index them once at startup. Fail API startup on malformed identity data so the previous image can remain serving; do not silently run with an empty approval catalog. The catalog is read-only until a later explicit refresh/release.
3. Use one server-side exact-pair lookup for both fund validation and screener detail. The database continues storing app-level `asset_id` and `variant_id`; the mint remains catalog metadata. Existing saved fund pairs must remain resolvable across catalog updates. A later catalog refresh must retain referenced variants or introduce an explicit retired-but-readable status before removing them.
4. Do not put 2 MB of raw source data or a provider API key into the browser bundle. Do not load the full screener on private Portfolio pages. The existing `/api/catalog` can remain as a three-entry compatibility endpoint during API-first rollout; new web code uses the full catalog endpoint. Remove the legacy endpoint only in a later compatible release.

## API and browser contract

- `GET /api/screener?category=crypto|etf|commodity|equity&q=&sort=volume24hUSD|name|price|priceChange24hPercent&direction=asc|desc&page=N` is public. Return 20 canonical asset rows, total count, page count, selected primary variant fields, snapshot source/timestamps, and compact chart data for visible rows. Default: Crypto, 24h volume descending. Invalid query values receive a stable validation error; clamp an out-of-range page to the last valid page. Null numeric values sort last in either direction, with a stable asset-ID tie-break.
- `GET /api/screener/:assetId` is public. Return the canonical asset and every exact variant with its own issuer, mint, market fields, advisory, and chart status/data. Never use canonical price or another issuer's chart as a substitute. Unknown asset IDs return 404.
- `GET /api/assets` returns the lightweight full selection list of all exact `(assetId, variantId)` pairs for the fund editor; no prices or charts. This is public reference data, not user data. Define all responses in `packages/contracts` and validate them at the API boundary and client boundary. Keep existing protected fund routes and version semantics unchanged.
- The API's current blanket Origin/Referer check blocks direct anonymous GETs. Explicitly permit only these new public, read-only catalog routes without a session while retaining host validation, request bounds, and protection on private routes. Never loosen auth on `/api/funds` or writes. Public snapshot responses may use a short cache; private responses stay `no-store`.
- Add the real Next.js `/screener` route and shared nav link. Fetch only when the route is open. Render loading, empty search, stale snapshot, missing field/chart, API error with retry, and offline states. Keep category/search/sort/page in the URL so back, reload, and direct links work. At 320–414px keep identity, price, change, and detail/Add actions usable without page-wide horizontal scroll. Use semantic table headers, announced sort, keyboard-accessible rows/dialogs, and visible focus.

## Add to fund: a draft, never an automatic mutation

```text
Screener variant → Add to fund → sign in if needed → choose new/existing fund
  → editor prefilled with exact assetId + variantId → review weights → Save
  → existing POST or versioned PUT → one PostgreSQL transaction
```

- Keep the selected pair in a validated URL parameter through Turnkey sign-in and return. Never trust the parameter as catalog authority; resolve it against the API catalog before opening the editor. Clear it after save/cancel. A direct link to a removed or malformed pair shows a recoverable error.
- For a new fund, preselect only the chosen asset and ask for at least one more; saving still requires 2–8 distinct assets and 10,000 basis points. Do not silently add SOL. For an existing fund, offer only the user's funds, fetch its latest version, reject duplicate assets or an eight-asset basket, and open the editor with the added variant and invalid/unallocated weights visible until the user fixes them. Do not change saved weights or plans before Save.
- On Save, use the existing create or expected-version full asset-set replacement path. Preserve plans. On 409 conflict, keep the draft and ask the user to reload/review the newer fund; never retry an overwrite automatically. Cancel or failed validation leaves the old basket unchanged.
- There is no Buy action, active DCA schedule, on-chain program, portfolio valuation, or implied tradeability. The UI should say selection configures a target basket only.

## Implementation order and release

1. **Catalog contract and tests:** normalize/validate the saved Tokens source and chart cache; define public response schemas and exact-pair index. Check 455 assets, 643 source records, 641 unique pairs, 640 unique mints, and category coverage. Keep existing saved fund IDs resolvable.
2. **Backward-compatible API:** add public paged/detail/assets reads and expand fund validation to the approved full catalog. Keep legacy `/api/catalog` temporarily. Add API tests before deployment. No database migration is required for this feature.
3. **Next.js route and style:** implement the approved Screener UI using real API responses, preserving the prototype's behavior and style. Keep charts lazy to visible rows/detail and avoid large initial payloads.
4. **Draft handoff:** connect exact variant selection to the existing editor. Refactor the editor only as needed for an initial selection and existing-fund choice; keep current PostgreSQL transaction/version checks.
5. **Ship API first:** inspect a clean VPS checkout with `ssh hetzner-neo`, deploy the backward-compatible API using the repo's `## Infra & tools` commands, and check readiness plus anonymous screener reads. Then test the fixed Vercel preview and promote the same SHA to `release`. Verify `/screener` on production, including logged-out browse and logged-in draft save. Keep the previous API image/SHA available for rollback. Update `CLAUDE.md` Infra & tools only if durable deployment facts change.

## Test coverage and failure modes

| Path | Required tests | Failure shown to user |
| --- | --- | --- |
| Catalog build/index | Unit: 455 assets/643 source records/641 selectable pairs/640 unique mints, all categories, repeat collapse, cross-asset alias, conflicting/missing IDs, variant ownership, null/invalid market data, snapshot timestamp, referenced old pairs | API startup fails before release; old API stays live |
| Public list/detail | API: category/search, stable sorts and nulls-last, 20-row bounds, last/empty page, invalid query, unknown ID, selected-variant metrics and charts, no auth needed | Empty/results/error/retry; no substituted value |
| Public/private boundary | API: anonymous new GETs work; fund and session routes still reject anonymous/foreign users; Origin/CSRF stays on writes | Sign-in or safe access error, no data leak |
| Screener UI | Unit/Playwright: category, search, sort, pagination, URL back/forward, detail variant switch, chart missing/failed/stale, keyboard, 320/375/414/768px/desktop | Honest stale/unavailable and recoverable errors |
| Add to fund | API/Playwright: logged-out selection survives login, new/existing fund, exact issuer pair, duplicate asset or mint alias/full basket, cancel, invalid weights, two-tab version conflict, plan preservation, failed save rollback | Draft retained; no silent mutation or purchase |
| Deployment | Preview/production smoke: API-first compatibility, source timestamp visible, `/screener` direct link, anonymous browse, one real signed-in save, prior Portfolio/Activity and fund edit regression | Roll back web/API without schema reversal |

Every new branch and visible error state should be covered by unit, API, or Playwright tests. The existing prototype regression script remains a visual/behavior reference, not a substitute for production tests. No real-money transaction is part of verification.

```text
CODE PATHS                                      USER FLOWS
[GAP] snapshot normalize/index                  [GAP] anonymous browse → search → detail
  ├─ exact repeat and mint alias                   ├─ stale/missing/failed market data
  └─ malformed source blocks deploy                └─ URL navigation + mobile + keyboard
[GAP] public list/detail/assets                  [GAP] select variant → login → draft
  ├─ query bounds and null-safe sort                ├─ new/existing fund + full basket
  └─ public GET / private write boundary           └─ cancel/conflict/retry without mutation
[GAP] fund exact-pair + mint checks              [GAP] production route + signed-in save
  └─ full-set transaction unchanged                └─ old-web/new-API compatibility
```

All paths are gaps in the production test suite today. The first implementation step adds tests alongside the contract; a green prototype test alone does not close a production gap.

## Implementation tasks

- [ ] **T1 (P1, human ~3h / agent-assisted ~45m):** Generate and validate a deployable catalog/chart snapshot; build exact-pair and mint indexes. Touch `data/`, `scripts/`, `apps/api/src/catalog.ts`, and API Docker packaging. Verify all identity counts and startup failure on malformed data.
- [ ] **T2 (P1, human ~3h / agent-assisted ~45m):** Add shared response schemas and public paged/detail/assets API routes. Touch `packages/contracts`, `apps/api/src/server.ts`, and API tests. Verify anonymous reads and private-route isolation.
- [ ] **T3 (P1, human ~5h / agent-assisted ~90m):** Build `/screener` and its responsive states from the approved prototype. Touch `apps/web/app/screener`, shared navigation/style, and web tests. Verify snapshots, variants, charts, URL state, and keyboard/mobile behavior.
- [ ] **T4 (P1, human ~4h / agent-assisted ~1h):** Connect exact-pair Add to fund through login and the existing editor. Touch web fund UI, API validation, and integration/E2E tests. Verify atomicity, duplicate-mint rejection, plans, cancel, and conflicts.
- [ ] **T5 (P1, human ~2h / agent-assisted ~30m):** Deploy API first, run preview E2E, promote web, and run production smoke. Use documented VPS/Vercel flow; verify matching SHA and rollback path.

T1 and the visual component work in T3 can begin together after the response shape is agreed. T2 and T4 share the API catalog/validation area and should be sequential. T5 waits for all prior tasks. The implementation spans more than eight files because it joins an existing prototype to two deployed apps; no new service, database table, or framework is introduced.

## NOT in scope

- Live Tokens.xyz polling, a production provider credential, and minute-by-minute prices. Saved data must be labelled; live refresh can be designed after this integration.
- DCA execution, swaps, delegated Turnkey signing, Token-2022 transfer compatibility, holdings, and P&L. Catalog inclusion is configuration permission only.
- Watchlists, recommendations, fundamentals, news, and multi-period charting. They are not in the approved screen.
- Separate catalog database tables or a new cache/queue service. This release uses a validated, versioned snapshot in the API image.

## Engineering review result

Architecture: one catalog identity index serves browsing and fund validation; public reads are narrow and private writes stay protected. Code quality: the prototype is a reference, not copied production state. Tests: the table above covers identity, UI, auth boundary, draft handoff, and release regressions. Performance: paged 20-row reads and lazy chart loading avoid shipping the whole 2 MB source to every page. The plan reuses the existing API, contracts, atomic fund transaction, Vercel route, and VPS deploy path. No new infrastructure service or database migration is needed. A nested Codex outside-voice pass was skipped because this review is already running in Codex.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Eng Review | `/plan-eng-review` | Architecture, code, tests, performance | 1 | READY TO IMPLEMENT | Catalog authority, public/private boundary, draft handoff, snapshot honesty, release order addressed |

**VERDICT:** Screener integration plan ready to implement. Production behavior is not yet verified.

NO UNRESOLVED DECISIONS

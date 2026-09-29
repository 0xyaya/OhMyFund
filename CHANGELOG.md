# Changelog

All notable changes to OhMyFund are documented here.

## Unreleased

## [0.2.2.5] - 2026-09-27

### Fixed

- Bind recurring outputs to their exact user token accounts, whose on-chain mint is immutable, to avoid Turnkey rejecting the Gold mint comparison.

## [0.2.2.4] - 2026-09-27

### Fixed

- Validate the exact recurring instruction count instead of using Turnkey's broad instruction iterator, which rejected Jupiter routes that reference Token-2022.

## [0.2.2.3] - 2026-09-27

### Fixed

- Validate only top-level recurring transaction programs in Turnkey, so safe Jupiter Token-2022 routes are not rejected because of internal route programs.

## [0.2.2.2] - 2026-09-27

### Fixed

- Allow Jupiter recurring swaps to reference Token-2022 output programs while still forbidding direct Token-2022 transfer instructions.

## [0.2.2.1] - 2026-09-27

### Fixed

- Complete recurring buys through a smaller valid Jupiter route when the first quote cannot fit in a Solana transaction, while limiting route-price degradation to 0.10%.

## [0.2.2.0] - 2026-09-26

### Fixed

- Approve and execute recurring buys without requiring a Jupiter contract interface in every user's Turnkey organization.

## [0.2.1.0] - 2026-09-26

### Fixed

- Complete recurring buys through a safe alternate Jupiter DEX when the first quoted route fails its pre-sign slippage check.

## [0.2.0.6] - 2026-09-26

### Fixed

- Rebuild a static Jupiter quote once when pre-sign simulation detects a stale route outside the user's slippage limit.

## [0.2.0.5] - 2026-09-26

### Fixed

- Retry a smaller static Jupiter route when a wider route requires an unapproved intermediate token account.

## [0.2.0.4] - 2026-09-26

### Fixed

- Compile recurring-buy Jupiter routes without address lookup tables so Turnkey can enforce exact account and mint policies.
- Retry smaller Jupiter account budgets when a static v0 transaction exceeds Solana's transaction-size limit.

## [0.2.0.3] - 2026-09-25

### Fixed

- Send a valid empty JSON body when starting recurring-authorization cleanup.

## [0.2.0.2] - 2026-09-25

### Fixed

- Let users reapprove a recurring buy immediately after an execution failure.

## [0.2.0.1] - 2026-09-25

### Fixed

- Let recurring buys run after sponsored token-account setup by tracking setup and swap daily sponsor budgets separately.
- Keep the shared sponsor-balance safety check across both setup and recurring transactions.

## [0.2.0.0] - 2026-09-22

### Added

- Create, review, authorize, pause, resume, cancel, and inspect recurring-buy plans backed by restricted Turnkey signing access.
- Execute scheduled multi-asset Jupiter purchases through a separate worker with exact fee accounting, durable attempts, transaction receipts, and manual reconciliation.
- Protect the controlled test launch with user allowlists, per-purchase and daily limits, idempotency, leases, policy-revocation checks, and disabled-by-default activation and execution flags.
- Show recurring-payment receipts, activation progress, clear amount limits, and accessible plan controls in the fund view.

### Changed

- Track bound wallets and plan-specific pending or active signer authorizations so failed activation and cancellation remain recoverable.
- Apply database migrations through a durable migration ledger and deploy the recurring worker with the API service.

### Fixed

- Prevent duplicate daylight-saving fallback purchases, stale occurrences from pausing newer mandates, and concurrent plans from sharing live wallet authorization.
- Validate Jupiter accounts, instruction data, lookup tables, quoted output, fee collection, signed messages, and confirmed ledger changes before recording a purchase.
- Preserve uncertain submitted transactions for reconciliation instead of treating network failures as definitive purchase failures.

## [0.1.3.0] - 2026-09-22

### Added

- Add the Orbit butterfly wordmark as the shared OhMyFund brand mark across portfolio, screener, and leaderboard views.

### Changed

- Cover every approved asset variant with a valid local logo mapping instead of only primary asset mints.
- Adapt the responsive header for the wider wordmark on tablet and mobile screens.

### Fixed

- Keep asset logos visible for non-primary variants used by copied and custom baskets.

## [0.1.2.0] - 2026-09-21

### Added

- Add the approved desktop and mobile Orbit composition to the repository and link the hackathon pitch deck from the design guide.
- Show local asset logos with resilient text fallbacks across portfolio and fund-detail views.
- Add focused tests for the Orbit default and asset identity rendering.

### Changed

- Rename the product, workspace packages, local runtime identifiers, browser storage, session cookie, and internal proxy headers from MyFund to OhMyFund.
- Preserve current production infrastructure identifiers until a separate controlled migration.
- Make Orbit the default theme and align its portfolio, performance, fund rows, target basket, and mobile actions with the approved reference.

### Fixed

- Avoid repeated catalog scans when rendering fund assets and load below-the-fold asset logos lazily.
- Keep the signed-out Orbit welcome screen consistent with the authenticated experience.

## [0.1.1.0] - 2026-09-21

### Added

- Start a persistent local PostgreSQL database, apply migrations, and reset only local data with documented root commands.
- Use one clear product, design, architecture, and contribution guide for repository decisions and setup.

### Changed

- Load local API configuration directly from `apps/api/.env` with Node 22 while keeping production environment injection unchanged.
- Verify typechecks, tests, production builds, and the complete local database lifecycle in CI.

### Removed

- Remove the unused fixed-preview authentication path so private API requests accept only the configured web origin.

## [0.1.0.0] - 2026-09-21

### Added

- Browse a compact, mobile-first leaderboard of public funds, inspect their target allocations, and copy a trusted basket into your own funds.
- Publish or unpublish a fund with a stable public link, creator name, copy count, and safe public response that excludes private balances, plans, and activity.
- Continue from a copied fund directly into its recurring-buy setup, including signed-out intent recovery after wallet authentication.

### Changed

- Share wallet-binding helpers across Portfolio and Leaderboard, and authenticate the visitor identity forwarded from Vercel to the API.
- Run contract, API, web, route, proxy, and PostgreSQL concurrency checks in the release test pipeline.

### Fixed

- Keep concurrent copies idempotent across request retries and different source funds, returning stable conflicts instead of duplicate funds or generic errors.
- Separate and bound public and authentication rate limits so one visitor cannot exhaust shared proxy buckets or spoof internal forwarding headers.
- Keep only one copy dialog active and preserve the selected fund through the authentication transition.

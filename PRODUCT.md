# OhMyFund product

## Purpose

OhMyFund is a saving app for people who want recurring exposure to a custom basket of assets. It should feel closer to a calm neobank than a trading terminal.

## Current user journey

1. Sign in by email through Turnkey and use the Solana wallet created for the account.
2. Browse the approved asset catalog in Screener.
3. Create a private fund with 2–8 assets whose target weights total 100%.
4. Optionally save one or more recurring-buy plans.
5. Review the fund's target basket, wallet balances, edit history, and plan state.
6. Publish a fund to Leaderboard or copy another published fund as an independent private snapshot.

## Product vocabulary

- **Fund:** a personal basket strategy. It is not pooled money, a legal investment fund, or a token.
- **Target basket:** the current asset identities and weights used for future purchases.
- **Holding:** a wallet balance attributed to the fund when reliable attribution exists.
- **Recurring-buy plan:** a saved amount and cadence. It stays a draft until the user accepts a versioned mandate and grants restricted signing access.
- **Published fund:** a public read-only view of target composition and publisher metadata.
- **Copied fund:** a private snapshot. It does not follow later edits to its source.

## Current capabilities

- Turnkey email authentication and Solana wallet binding.
- Private fund creation and full-basket replacement in one database transaction.
- Draft recurring-plan creation and updates, plus a disabled-by-default execution control plane.
- Saved Tokens.xyz asset screener with issuer-specific mint identities.
- Fund edit history.
- Public leaderboard, publishing, unpublishing, and idempotent copying.
- Read-only wallet balance lookup.

## Explicit non-goals for this MVP

- No public recurring-buy launch until restricted Turnkey delegated access, Jupiter credentials, the fee account, and controlled rollout checks are complete.
- No custom Solana program.
- No pooled custody or fund-share token.
- No archive feature or permanent composition lock.
- No claim that a saved plan will buy assets.
- No separate deployed development or staging environment during the hackathon.

## Trust rules

- Use exact language about draft plans and unavailable data.
- Never show fabricated balances, returns, transaction receipts, or execution status as live data.
- Keep private wallet credentials out of the browser, Git, logs, and Vercel.
- A user controls only records linked to their verified Turnkey wallet.

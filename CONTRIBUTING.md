# Contributing to OhMyFund

## Start here

Read [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), and [ARCHITECTURE.md](ARCHITECTURE.md). Use Node.js 22 or later and Docker Compose.

Create a branch from current `origin/main`:

```bash
git fetch origin main
git switch -c <short-name> origin/main
npm ci
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Follow the Turnkey credential rules in the README. Never send private keys through chat or commit them.

## Run locally

```bash
npm run db:up
npm run db:migrate
npm run dev:api   # terminal 1
npm run dev:web   # terminal 2
```

The local database uses the named Docker volume `ohmyfund_local_pgdata`. `npm run db:down` preserves it. `npm run db:reset` deletes only that local volume.

## Before opening a pull request

```bash
npm run verify
docker compose -p ohmyfund-local config --quiet
```

If recurring-plan controls changed, run the browser test too:

```bash
npx playwright install chromium
npm run test:e2e -w @ohmyfund/web
```

If database behavior changed, run the integration suite against a dedicated test database:

```bash
TEST_DATABASE_URL=postgres://ohmyfund_test@127.0.0.1:5432/ohmyfund_test \
  npm run test:integration -w @ohmyfund/api
```

Do not point `TEST_DATABASE_URL` at a database containing useful data.

## Change rules

- Keep pull requests focused and explain user-visible behavior.
- Update shared schemas before their API and UI consumers.
- Add tests for authorization, validation, transaction, and idempotency changes.
- Add SQL migrations; never edit a migration that has reached production.
- Keep public API responses free of private balances, plans, sessions, and activity.
- Do not describe draft recurring plans as executed purchases.
- Do not add dependencies when the platform or an existing package already solves the problem.

## Deployment ownership

Merging does not grant production access. A maintainer deploys the VPS API and promotes the Vercel `release` branch using the private operations runbook.

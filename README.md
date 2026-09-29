# OhMyFund

OhMyFund helps people build a long-term saving habit with custom baskets and recurring-buy plans. The repository includes a disabled-by-default recurring executor. Production does **not** execute purchases until delegated Turnkey authorization, Jupiter configuration, and both launch flags are enabled.

## Repository

- `apps/web`: Next.js app deployed on Vercel.
- `apps/api`: Fastify API deployed on the VPS.
- `packages/contracts`: shared request and response schemas.
- `compose.yaml`: local PostgreSQL only.
- `deploy/`: production API and PostgreSQL deployment.

Catalog source snapshots and mint evidence are documented in [data/tokens-equity.md](data/tokens-equity.md) and [data/backpack-equities.md](data/backpack-equities.md).

Read [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [CONTRIBUTING.md](CONTRIBUTING.md) before changing product behavior.

Release history is in [CHANGELOG.md](CHANGELOG.md), and deferred work is tracked in [TODOS.md](TODOS.md).
The reviewed design and rollout gates for sponsored recurring buys are in [docs/plans/sponsored-recurring-buys.md](docs/plans/sponsored-recurring-buys.md).
The reviewed one-time token-account setup design is in [docs/plans/recurring-account-setup.md](docs/plans/recurring-account-setup.md).

The current visual direction and the [Orbit pitch deck](https://myfund-slides.vercel.app/?theme=orbit#1) are linked from [DESIGN.md](DESIGN.md#visual-references).

## Local setup

Prerequisites:

- Node.js 22 or later
- npm
- Docker with Compose
- access to the OhMyFund Turnkey organization for the authenticated wallet flow

Install dependencies and create local configuration:

```bash
npm ci
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Generate one local proxy secret and put the same value in:

- `apps/api/.env` as `TRUSTED_PROXY_SECRET`
- `apps/web/.env.local` as `API_PROXY_SECRET`

Set `NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID` and `NEXT_PUBLIC_TURNKEY_AUTH_PROXY_ID` in `apps/web/.env.local`. Set the same parent organization ID as `TURNKEY_ORGANIZATION_ID` in `apps/api/.env`. For full authentication, generate a P-256 key on your own machine and ask the maintainer to register only its public key as a named, expiring, non-root API credential. Put the private key only in `apps/api/.env`. Never copy the deployed backend key to a developer machine.

Start and migrate PostgreSQL:

```bash
npm run db:up
npm run db:migrate
```

Run the API and web app in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Recurring policy provisioning also needs a separate process and credential. Copy `apps/api/.env.policy-provisioner.example` to `apps/api/.env.policy-provisioner`, fill it with a distinct Turnkey policy-mutation API key, and run `npm run dev:policy-provisioner`. Never put the provisioner private key in the API or worker environment.

Open `http://localhost:3000`. Local PostgreSQL data persists across `npm run db:down` and later restarts.

## Common commands

```bash
npm run db:up       # start local PostgreSQL and wait until healthy
npm run db:migrate  # apply all migrations to the local database
npm run db:down     # stop local containers and keep their data
npm run db:reset    # delete only the ohmyfund-local database volume, then rebuild it
npm run verify      # typecheck, unit tests, and production builds
npx playwright install chromium # install the browser once before local end-to-end tests
npm run test:e2e -w @ohmyfund/web # browser test for recurring-plan controls
```

`db:reset` is destructive for local data. It targets only the explicit `ohmyfund-local` Compose project.

## Troubleshooting

- Port `5432` busy: stop the other local PostgreSQL service, then run `npm run db:up` again.
- API says `.env` is missing: copy `apps/api/.env.example` to `apps/api/.env`.
- Login cannot start: confirm `http://localhost:3000` is an allowed Turnkey Auth Proxy origin.
- Wallet verification fails: confirm this machine's public API key is registered and the three Turnkey values in `apps/api/.env` belong to the same parent organization.
- Private API request returns `403`: `WEB_ORIGIN` must include the exact browser origin. Separate multiple trusted origins with commas; do not use wildcards.

## Deployment

Production is one environment during the hackathon: Vercel for the web app and the shared VPS for the API and PostgreSQL. Follow [ARCHITECTURE.md](ARCHITECTURE.md). Production operations are maintained privately. Deploy the API before promoting the web app when an API contract or environment requirement changes.

Recurring activation is separate from execution. The app creates the user's mandate policy, then the private VPS `policy-provisioner` creates and stores one exact sponsor policy for that mandate. The provisioner and transaction signer use different Turnkey API credentials in separate service environments. Keep `EXECUTION_ENABLED=false` until the credentialed Turnkey denial matrix, sponsored Jupiter simulation, fee account, sponsor limits, and explicitly approved capped mainnet proof are complete. Use only the allowlisted controlled-launch user until that proof is reviewed.

Fund activation now prepares all missing destination token accounts in one user-approved, sponsor-paid transaction. The same transaction reimburses the sponsor for exact rent and network cost in USDC; it does not charge the 0.75% recurring-buy fee. This path has its own `SETUP_EXECUTION_ENABLED` emergency stop and dedicated `TURNKEY_SETUP_SPONSOR_POLICY_ID`. Keep the setup flag disabled until that policy passes the credentialed Turnkey denial matrix.

Migration 004 expands recurring-plan states. After activation is enabled and any plan enters a new state, do not roll the API back directly to a pre-004 build. Disable activation and execution first, then deploy a compatibility build that understands the expanded states.

Migration 006 adds durable setup-attempt state and expands the recurring pause reasons. After it records setup attempts, use a compatibility build for rollback rather than a pre-006 API.

Migration 007 adds the per-mandate sponsor-policy lifecycle. It does not adopt the previous global policy. Existing active plans require approval again, and rollback requires a compatibility build that understands the new sponsor-policy states.

# OhMyFund architecture

## Runtime topology

```text
Local
Browser :3000 -> Next.js -> OhMyFund API :4310 -> PostgreSQL :5432
                    |              |
                    |              `-> Turnkey parent organization
                    `-> public Turnkey Auth Proxy configuration

Production
Browser -> Vercel web -> HTTPS -> VPS nginx -> API -> private PostgreSQL <- recurring worker
                                     |              ^                       |       |
                                     |              |                       |       `-> Solana RPC
                                     |       policy provisioner             `-> Turnkey + Jupiter
                                     |        (private network)
                                     `-> Turnkey ownership checks
```

The root `compose.yaml` is local-only and starts PostgreSQL. `deploy/compose.yaml` is production-only and uses the VPS secret file. The two Compose projects, volumes, credentials, and data are separate.

## Components

- `apps/web` renders the product and proxies same-origin `/api` requests to the configured API origin.
- `apps/api` owns authentication, authorization, funds, plans, activity, public funds, screener data, balance reads, and the disabled-by-default recurring executor.
- `policy-provisioner` is a separate VPS process. It accepts only authenticated mandate IDs on the private Compose network, rebuilds policies from PostgreSQL, and owns the distinct Turnkey policy-mutation credential.
- `packages/contracts` owns shared validation schemas and public types.
- PostgreSQL is the source of truth for users, sessions, funds, basket versions, versioned recurring mandates, occurrences, attempts, legs, edit events, and idempotency.
- Turnkey owns end-user sub-organizations and wallets. OhMyFund verifies ownership but does not store wallet private keys.

The recurring worker uses PostgreSQL leases and wallet advisory locks. It stores a signed transaction before submission and reconciles that exact signature after uncertain results. It runs only when `EXECUTION_ENABLED=true`; activation is separately gated by `RECURRING_BUYS_AVAILABLE=true`, an explicit user allowlist, and complete Jupiter fee configuration. Wallet identity and signer authorization are provider-neutral records; existing Turnkey user columns remain readable during migration.

## Authentication and trust boundaries

1. The browser signs a one-time OhMyFund login challenge with its Turnkey wallet.
2. The API verifies the signature and asks Turnkey whether the address and wallet belong to the claimed sub-organization.
3. The API creates an opaque, HTTP-only session and a separate CSRF token.
4. Private database queries are scoped by the verified OhMyFund user ID.

The API accepts private requests only from the exact configured `WEB_ORIGIN`. Vercel replaces visitor identity headers and authenticates them with `API_PROXY_SECRET`; the API trusts them only when `TRUSTED_PROXY_SECRET` matches. These secrets are separate from Turnkey credentials. The API reaches the policy provisioner through the private Compose network with another shared secret. The provisioner rejects raw policy input and loads the immutable mandate itself.

## Secret placement

| Value | Local web | Local API | Vercel | VPS services |
| --- | --- | --- | --- | --- |
| Turnkey organization/Auth Proxy IDs | yes, public | organization ID | yes, public | organization ID |
| Turnkey API private key | never | machine-specific non-root key | never | deployed non-root key |
| Turnkey policy-mutation private key | never | separate local provisioner only | never | `policy-provisioner.env` only |
| Proxy shared secret | matching local value | matching local value | production value | production value |
| Database password | never | none; localhost-only trust | never | `/home/neo/.config/myfund/api.env` |

Never share or copy the deployed Turnkey private key. Each developer generates a private key locally and sends only the public key to the maintainer for registration. Revoke temporary credentials after the hackathon.

## Data changes

SQL migrations live in `apps/api/sql` and run in filename order through `apps/api/src/migrate.ts`. The migrator records each applied filename in `schema_migrations`, so an existing migration is not run again. Migrations must be backward-compatible with the web version currently in production. Back up production PostgreSQL before migrations that touch user data.

Replacing a fund replaces its complete asset set and records the before/after edit event in the same PostgreSQL transaction. There is no on-chain fund state.

## Verification

- `npm run verify`: typecheck, unit tests, and production builds.
- CI runs `npm run verify`, then the PostgreSQL integration test against an isolated test database.
- Production release checks API liveness and readiness before the web app is promoted.

## Release order

1. Merge reviewed changes to `main`.
2. Back up PostgreSQL when the migration risk requires it.
3. Deploy the VPS API with `deploy/deploy-api.sh` and check both health endpoints.
4. Fast-forward the Vercel production branch `release` from `main`.
5. Smoke-test Portfolio, Leaderboard, Screener, login, and wallet binding.

Production hosts, paths, and credentials are maintained privately.

# OhMyFund repository cleanup: first clean version

Status: IMPLEMENTED — MANUAL TURNKEY SMOKE PENDING
Baseline: `origin/main` at `62afa0a` (leaderboard merge)
Source: gstack office-hours and engineering-review decisions recorded in this plan

## Goal

Make the repository clear, structured, and reproducible now. Production remains the only deployed application environment during the hackathon. Local work runs a local web app, local API, and local PostgreSQL while reusing the production Turnkey organization with a separate machine-specific non-root credential.

## Scope decision

Ship the functional baseline. Do not build the full onboarding system yet.

This pass includes:

- accurate canonical documentation;
- deterministic local PostgreSQL with persistent local data;
- explicit local API environment loading;
- standard database and verification commands;
- removal of the dormant fixed-preview authentication path;
- tests and a clean-checkout rehearsal.

## What already exists

| Need | Existing implementation | Plan |
| --- | --- | --- |
| npm monorepo | Root workspaces and build/test/typecheck scripts | Reuse and add small root aliases |
| PostgreSQL schema | `apps/api/sql/001` through `003` and `src/migrate.ts` | Reuse unchanged |
| Production database | PostgreSQL 16 in `deploy/compose.yaml` | Keep production-only and unchanged |
| Local configuration templates | API and web `.env.example` files | Correct and document them |
| API configuration validation | `apps/api/src/config.ts` fails on missing values | Reuse; load local `.env` explicitly |
| Test frameworks | Vitest, Node test runner, and PostgreSQL integration test | Reuse; add focused auth/config coverage |
| CI | GitHub Actions with PostgreSQL 16 | Reuse through the root verification command |
| Turnkey wallet binding | Signed challenge plus `getSubOrgIds` and `getWalletAccount` | Reuse with a separate local backend credential |
| Production deployment | Vercel web and VPS Docker Compose API | Preserve; update only obsolete preview configuration |

## Architecture

```text
LOCAL MACHINE

Browser :3000
    |
    | same-origin /api rewrite
    v
Next.js web ──────────────> OhMyFund API :4310 ──────> PostgreSQL :5432
    |                              |
    | public Turnkey config        | machine-specific non-root API key
    v                              v
Turnkey Auth Proxy          Production Turnkey organization


PRODUCTION

Browser -> Vercel web -> VPS API -> production PostgreSQL
             |             |
             |             `-> dedicated deployed non-root Turnkey key
             `-> public Turnkey organization/Auth Proxy identifiers only
```

Rules:

- Root `compose.yaml` is local-only and contains PostgreSQL only.
- `deploy/compose.yaml` remains production-only.
- Local and production database volumes, credentials, and data never overlap.
- Vercel never receives a Turnkey backend private key.
- The deployed backend key is never copied to another machine.
- Vercel preview builds receive no authenticated configuration and cannot call the production API.

## Implementation plan

### 1. Create the canonical documentation set

- Rewrite `README.md` as the short entry point: product status, prerequisites, exact local commands, repository map, checks, deployment pointer, and troubleshooting.
- Add `PRODUCT.md`: target user, current workflows, product vocabulary, live capabilities, and non-goals. State that recurring plans do not execute purchases.
- Rewrite `DESIGN.md` to describe only the current application UI and active Ledger/Orbit comparison. Remove archive, permanent lock, global Activity, and old prototype directions from canonical guidance.
- Add `ARCHITECTURE.md`: runtime topology, trust boundaries, request flow, database ownership, Turnkey roles, secret placement, migrations, testing, and production deployment order.
- Add `CONTRIBUTING.md`: branch and pull-request flow, local setup, command reference, migration rules, secret rules, and release ownership.
- Update `CLAUDE.md` links to the canonical documents. Keep `## Infra & tools` current and remove statements that describe fixed preview as an application environment.
- Add a visible archived notice to `docs/designs/personal-fund.md` pointing to `PRODUCT.md` and `ARCHITECTURE.md`. Do not move historical files in this pass.

### 2. Add isolated local PostgreSQL

Create root `compose.yaml` with:

- project name `ohmyfund-local`;
- PostgreSQL 16 Alpine;
- bind `127.0.0.1:5432` only;
- non-sensitive local defaults matching `apps/api/.env.example`;
- health check using `pg_isready`;
- persistent named volume `ohmyfund_local_pgdata`.

Add root scripts:

```text
npm run db:up       # start and wait for local PostgreSQL
npm run db:migrate  # run migrations using apps/api/.env
npm run db:down     # stop containers, preserve data
npm run db:reset    # remove only ohmyfund-local data, restart, migrate
```

`db:reset` must reference the root Compose project explicitly. It must never accept an arbitrary host, volume, or production environment file.

### 3. Load local API configuration explicitly

Use Node 22 native `--env-file=.env` support. Do not add `dotenv`.

- `apps/api` local `dev` loads `apps/api/.env` before importing the TypeScript server.
- Add a local migration command that loads the same file.
- Keep the externally configured migration command for CI and operational use.
- Keep production startup on `node dist/server.js`; Docker continues to inject its environment.
- Update `apps/api/.env.example` so its database credentials match root Compose and its comments distinguish public IDs from private keys.
- Keep `apps/web/.env.example` browser-safe: public Turnkey IDs, local API origin, and optional OhMyFund proxy secret only.

Local development remains two explicit terminals in this first pass:

```text
npm run dev:api
npm run dev:web
```

### 4. Remove dormant preview authentication

Remove `PREVIEW_ORIGIN`, `PREVIEW_USER_ID`, `previewOrigin`, `previewUserId`, and `isPreview` from:

- API configuration;
- origin checks and session enforcement;
- API and deployment environment examples;
- the VPS provisioning script;
- mocks and tests.

The API accepts exactly the configured `WEB_ORIGIN`. Local `.env` sets localhost; the VPS environment sets the production Vercel origin.

Do not change the deployed production origin, database, Turnkey credential, or proxy secret as part of this cleanup.

### 5. Unify verification without new orchestration

Add root `npm run verify` that runs the existing commands in order:

```text
typecheck -> unit tests -> production build
```

Update GitHub Actions to call `npm run verify`, then run the existing PostgreSQL integration test with its isolated CI database. Keep local integration-test database automation out of this pass; contributors may run the existing integration command when they provide a dedicated `TEST_DATABASE_URL`.

### 6. Rehearse the clean path

Use a fresh worktree from `origin/main`, not the current dirty feature worktree:

```text
npm ci
copy API and web environment examples
npm run db:up
npm run db:migrate
npm run dev:api          # terminal 1
npm run dev:web          # terminal 2
npm run verify
```

Then perform the manual authenticated smoke test:

1. Open `http://localhost:3000`.
2. Sign in through Turnkey using a normal app account.
3. Bind the wallet to the local API.
4. Create a fund and draft recurring plan.
5. Reload and confirm persistence from the local volume.
6. Stop and restart PostgreSQL without deleting the volume; confirm the data remains.
7. Sign out and confirm private routes are hidden.

## Turnkey credential procedure

The full local authenticated flow requires a machine-specific backend credential in the production OhMyFund Turnkey organization.

1. Generate the P-256 private key on the machine that will use it.
2. Send only the public key and credential name to the maintainer.
3. Register it under a separate named, expiring, non-root Turnkey user.
4. Confirm it can call only the ownership queries required by `auth.ts` and cannot sign, manage users, or change policies.
5. Store the private key only in ignored `apps/api/.env`, with local owner-only permissions.
6. Revoke it after the hackathon or immediately after suspected exposure.

If Turnkey cannot enforce this boundary, do not share or reuse the deployed backend key. Local authenticated setup remains blocked until an isolated key or owner-operated verification path exists.

## Test coverage plan

```text
CODE PATHS                                      USER FLOWS

[+] root compose.yaml                           [+] First local start
  ├── [PLANNED] valid config                      ├── [PLANNED] DB becomes healthy
  ├── [PLANNED] PostgreSQL health check           ├── [PLANNED] migrations complete
  ├── [PLANNED] named-volume persistence          └── [PLANNED] web/API start in two terminals
  └── [PLANNED] reset removes local volume only

[+] API local commands                          [+] Real wallet smoke [manual]
  ├── [PLANNED] .env present                      ├── sign in through Auth Proxy
  ├── [PLANNED] .env missing -> clear failure      ├── bind wallet through local API
  ├── [PLANNED] migration success                 ├── create fund and draft plan
  └── [PLANNED] migration failure -> non-zero      └── reload, persist, sign out

[+] single-origin authorization                 [+] Verification
  ├── [PLANNED] WEB_ORIGIN accepted               ├── [PLANNED] typecheck
  ├── [PLANNED] foreign origin rejected           ├── [PLANNED] unit tests
  └── [PLANNED] no preview bypass remains         ├── [PLANNED] production build
                                                  └── [EXISTING] CI PostgreSQL integration
```

Automated requirements:

- Extend API auth/server tests to accept only `WEB_ORIGIN` and reject a foreign origin.
- Remove preview mocks and assert no preview-only authorization branch remains.
- Run `docker compose config` in the implementation verification.
- Run the existing unit, typecheck, build, and CI integration suites.

Manual requirements:

- Confirm local data persists across `db:down` followed by `db:up`.
- Confirm `db:reset` affects only `ohmyfund-local` resources.
- Complete the real Turnkey wallet flow because email OTP and browser signing are user-controlled.

## Failure modes

| Failure | Coverage | Handling and visible result |
| --- | --- | --- |
| Port 5432 is occupied | Manual clean-checkout rehearsal | Compose exits non-zero; README gives the check and resolution |
| PostgreSQL is not healthy | Compose health test | `db:up` fails before migration; terminal shows the unhealthy service |
| `apps/api/.env` is missing | Local command smoke | Node exits immediately and names the missing file |
| Required API value is missing | Existing `config.ts` behavior | API exits immediately and names the variable |
| Turnkey credential is rejected | Manual wallet smoke | Wallet binding returns the existing retryable availability error |
| Localhost is absent from Auth Proxy origins | Manual wallet smoke | Login cannot complete; README points to the exact Turnkey setting |
| A foreign origin calls a private API route | Automated API test | API returns 403 |
| Local database is stopped and restarted | Persistence smoke | Named volume retains local user, fund, and plan data |
| `db:reset` is run accidentally | Command-boundary review | Only the explicit `ohmyfund-local` volume is removed; production is unreachable |

No planned failure is silent and unhandled without a test or manual verification step.

## Performance review

No production request path, query, cache, or bundle is added. Local PostgreSQL adds one small container. The verification command remains sequential and repeats some fast workspace work; measured repository checks are under one minute, so optimizing this is not part of the first pass.

## Parallelization

| Lane | Work | Modules | Depends on |
| --- | --- | --- | --- |
| A | Canonical documents | root docs, historical design banner | — |
| B | Local PostgreSQL and commands | root Compose, root/API package configuration | — |
| C | Remove preview authentication and update tests | API source/tests, deploy examples | — |
| D | Clean-checkout and wallet rehearsal | whole repository | A + B + C |

Lanes A, B, and C can run in parallel worktrees. Lane D runs after they merge. Lane A and C both update `CLAUDE.md` or deployment wording, so resolve that small documentation conflict when merging.

## NOT in scope

- Separate deployed development or staging environment: deferred until after the hackathon.
- Unified `npm run dev` process supervisor: two explicit terminals are clear enough for this pass.
- Automated `npm run onboard` preflight: useful later, not required once the README and local commands are correct.
- Automated disposable local integration database: CI already runs the PostgreSQL integration suite.
- Dev Containers or Codespaces: extra environment machinery for no current blocker.
- PR template and starter issue: collaboration workflow can improve after local setup works.
- Moving historical design files: add an archive banner now; reorganize later.
- DCA execution, transaction signing, Solana program, archive, or permanent composition lock: unrelated product scope.
- Production database, VPS access, or deployed backend-key sharing: never part of local setup.

## Implementation tasks

- [x] **T1 (P1, human: ~2h / CC: ~25min)** — Documentation — establish the five canonical root documents and correct `CLAUDE.md` links.
  - Surfaced by: Code quality review — current README mixes product, setup, deployment, and prototype history while `CLAUDE.md` points to obsolete architecture.
  - Files: `README.md`, `PRODUCT.md`, `DESIGN.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/designs/personal-fund.md`
  - Verify: every canonical link resolves; no canonical text claims Privy, Anchor, archive, permanent lock, or a deployed preview environment.
- [x] **T2 (P1, human: ~1h / CC: ~15min)** — Local database — add isolated root Compose and database commands.
  - Surfaced by: Architecture review — production Compose requires a VPS-only secret path and cannot be the local setup.
  - Files: `compose.yaml`, `package.json`, `apps/api/.env.example`
  - Verify: `docker compose config`, `npm run db:up`, readiness, migration, persistence, and local-only reset.
- [x] **T3 (P1, human: ~45min / CC: ~10min)** — API configuration — load local `.env` using Node 22 without changing production secret injection.
  - Surfaced by: Code quality review — API development currently reads shell state only.
  - Files: `apps/api/package.json`, `apps/api/.env.example`, `README.md`
  - Verify: missing `.env` fails clearly; valid `.env` starts API and runs migrations.
- [x] **T4 (P1, human: ~1h / CC: ~20min)** — Authentication boundary — remove the unused fixed-preview path.
  - Surfaced by: Architecture review — optional preview origin and user logic contradict production-only deployment.
  - Files: `apps/api/src/config.ts`, `apps/api/src/auth.ts`, `apps/api/src/server.ts`, related tests, environment examples, `deploy/provision-api-env.sh`
  - Verify: production/local configured origin accepted, foreign origin rejected, no preview variables or branches remain.
- [x] **T5 (P1, human: ~45min / CC: ~10min)** — Verification — expose one root verification command and use it in CI.
  - Surfaced by: Test review — checks exist but the entry point is fragmented.
  - Files: `package.json`, `.github/workflows/test.yml`, API auth/server tests
  - Verify: `npm run verify` plus CI PostgreSQL integration test pass.
- [ ] **T6 (P1, human: ~1h / CC: ~20min)** — Rehearsal — prove the documented path from a clean worktree and complete the real-wallet smoke test.
  - Surfaced by: Test review — configuration and authentication failures are visible only when the complete path is exercised.
  - Files: documentation corrections only if rehearsal finds drift
  - Verify: clean setup, persisted local fund/plan, sign-out behavior, and no secret in Git or logs.

## Release order

1. Implement from a fresh branch based on `origin/main`.
2. Run automated checks and the local clean-checkout rehearsal.
3. Review the diff for secrets and unrelated working-tree files.
4. Merge to `main`.
5. Deploy the VPS API first because preview-auth code changed.
6. Check API liveness/readiness and production authenticated login.
7. Promote the Vercel `release` branch from `main`.
8. Re-run production portfolio, leaderboard, screener, and wallet-binding smoke tests.

## Done when

- A new checkout reaches a persistent local PostgreSQL database using only documented commands.
- The API loads its local configuration without shell exports.
- The repository has one accurate product, design, architecture, and contribution story.
- Preview authentication code and variables are absent.
- `npm run verify` and CI pass.
- A real Turnkey wallet binds to the local API and local data survives restart.
- No Turnkey private key exists in Vercel, Git, chat, or another machine.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Not required for repository cleanup |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | CLEAR | In-host challenge found no new blocking issue |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | Prior design review remains current; this plan makes no UI change |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CONCERNS | Prior score 4.5/10; this plan addresses the local-stack blockers |

**CROSS-MODEL:** The engineering review and in-host challenge agree on the reduced functional baseline.

**VERDICT:** ENG CLEARED — ready to implement from `origin/main`.

NO UNRESOLVED DECISIONS

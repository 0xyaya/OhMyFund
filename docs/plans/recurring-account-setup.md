# Recurring-buy account setup

## Goal

Let a user activate a recurring-buy plan with USDC and no SOL. OhMyFund pays
the Solana rent and network fee needed to create every missing destination
token account. The user directly signs one atomic setup transaction that:

1. Creates all missing associated token accounts for the exact mandate basket.
2. Transfers the exact setup reimbursement in USDC to OhMyFund.
3. Uses the OhMyFund sponsor wallet as fee payer.

The recurring plan becomes active only after setup is confirmed and the user
approves the separate restricted Turnkey recurring-buy policy.

## User outcome

- Create a fund and recurring plan without holding SOL.
- See the one-time setup cost before signing.
- Confirm setup once, even when all eight supported token accounts are missing.
- Resume activation after a refresh, timeout, or failed policy creation without
  paying the setup charge twice.
- Repair a token account from the app if the user closes it later.
- Pay the 0.75% OhMyFund fee and network reimbursement on future buys, without
  reserving token-account rent on every occurrence.

## Decisions locked by this review

1. Setup runs during recurring-plan activation, not basic fund creation.
2. The user directly signs the setup transaction. Delegated recurring access
   never authorizes a setup-only USDC charge.
3. Use one atomic Solana v0 transaction for up to eight missing token accounts
   plus one USDC reimbursement transfer.
4. Reject the setup transaction before signing if it exceeds 1,232 bytes.
5. Persist and reconcile the exact signed transaction before allowing a retry.
6. Confirm setup before creating the recurring-buy Turnkey policy.
7. Keep plan status `approval_required` until both setup and recurring-policy
   authorization are complete.
8. Add `SETUP_EXECUTION_ENABLED`; never enable scheduled execution merely to
   test account setup.
9. Use a dedicated restricted sponsor setup policy. Keep the sponsor wallet's
   SOL balance intentionally small as a second blast-radius limit.
10. Extract a browser activation controller and a backend setup service instead
    of extending the existing monolithic activation functions.
11. Require unit, PostgreSQL integration, browser E2E, credentialed Turnkey
    allow/deny, read-only mainnet simulation, and one explicitly approved
    capped mainnet proof before general use.
12. Defer transaction v1. The exact eight-account v0 setup already fits and the
    current Turnkey and signature-verification path is v0-compatible.

## Verified feasibility

A read-only mainnet simulation used the current user wallet, sponsor wallet,
fee account, the five current fund mints, and three additional real catalog
mints. All eight destination token accounts were absent.

| Check | Result |
|---|---:|
| Missing associated token accounts | 8 of 8 |
| Setup instructions | 8 ATA + 1 USDC transfer |
| Total instructions including resource limits | 12 |
| Account addresses | 25 |
| Serialized v0 size | 1,125 / 1,232 bytes |
| Simulated compute | 144,585 / 200,000 units |
| Simulation result | success |

No transaction was signed or submitted. Pin this maximum-basket construction
as a regression test. The test must fail if future changes push the serialized
transaction above 1,232 bytes.

## What already exists

| Existing component | Reuse |
|---|---|
| Immutable `plan_mandates` basket snapshot | Defines the exact setup owner, mints, token programs, and destination ATAs |
| `preparePlan` and authorization intent | Keep as the start and final authorization stages |
| `tokenProgramsForMints` and `existingAccounts` | Batch mint-owner and ATA-existence reads |
| Token-2022 `GetAccountDataSize` simulation | Calculate the exact Token-2022 ATA rent space, including ImmutableOwner |
| `createAssociatedTokenAccountInstruction` | Build idempotent ATA creation with sponsor payer and user owner |
| `tokenTransferCheckedInstruction` | Build the exact classic USDC reimbursement transfer |
| v0 transaction signature verification helpers | Verify immutable message bytes, exact signer slots, and both signatures |
| Purchase attempt persistence pattern | Reuse the persist-before-submit and unknown-result recovery design, not its purchase tables |
| Recurring worker process | Reconcile setup attempts in the same deployed worker; do not add another service |
| Jupiter SOL price client | Convert deterministic lamport costs to USDC using a fresh price |
| Existing PostgreSQL and Playwright/Vitest harnesses | Extend them instead of adding a second test stack |

## Architecture

```text
INITIAL ACTIVATION

Browser controller
  │ POST prepare plan
  ▼
API plans.ts ── immutable mandate ──► recurring/setup.ts
                                         │
                                         ├─ batch mint + ATA reads
                                         ├─ exact Token / Token-2022 rent
                                         ├─ fresh SOL/USDC price
                                         ├─ build v0: resource limits
                                         │            + 1..8 ATA creates
                                         │            + 1 USDC transfer
                                         ├─ simulate and assert <= 1,232 bytes
                                         └─ store setup attempt + unsigned bytes
                                                      │
Browser shows exact reimbursement                      │
  │ user confirms                                      │
  ├─ Turnkey user signs exact v0 message ◄─────────────┘
  └─ POST user-signed bytes
              │
              ▼
recurring/setup.ts
  ├─ verify attempt, expiry, message bytes, user signature, and signer order
  ├─ reserve sponsor budget
  ├─ sponsor Turnkey signs under dedicated setup policy
  ├─ persist full signed bytes + transaction ID before submission
  ├─ submit to Solana
  └─ worker confirms or reconciles unknown result
              │
              ▼
setup confirmed
  │
  ├─ Browser creates restricted recurring policy
  ├─ API verifies exact policy ID + fingerprint
  └─ plan becomes active and receives next_run_at
```

### Closed token-account repair

```text
Recurring preflight finds an approved destination ATA missing
  │
  ├─ do not sign or submit the swap
  ├─ pause plan with account_setup_required
  └─ show "Repair token accounts"
              │
              ▼
same direct setup flow for only the missing approved ATAs
  │
  ├─ recurring policy remains unchanged
  └─ confirmed setup resumes the plan and recalculates next_run_at
```

No support ticket and no manual token-account creation are required.

## Trust boundaries

### User setup signature

The setup-only USDC charge is never available to the delegated backend user.
The browser asks the user's Turnkey wallet to sign the exact v0 transaction.
The API rejects a changed message, wrong signer slot, missing signature, expired
quote, different mandate, or different setup attempt.

### Dedicated sponsor setup policy

Create a separate parent-organization policy and configuration ID for setup.
It must allow only:

- `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` for the exact sponsor wallet.
- The sponsor as fee payer and exactly one additional required signer.
- One to eight idempotent Associated Token Account instructions.
- ATA instruction payer equal to the sponsor.
- ATA owners that are not the sponsor.
- Token programs limited to classic Token and Token-2022.
- Exactly one classic USDC transfer to the exact OhMyFund fee token account.
- A transfer amount greater than zero and no more than the configured maximum
  setup reimbursement.
- Support instructions limited to Compute Budget, Associated Token Account,
  Token, Token-2022, and System where required by the exact ATA instruction.
- Zero native SOL transfers and zero transfers from sponsor-owned token
  accounts.
- No Jupiter instruction.

Turnkey policies are stateless. A stolen sponsor API credential could repeat a
policy-valid request and waste the sponsor's SOL. Limit this residual risk with:

- A low sponsor SOL balance.
- Per-transaction, per-user daily, and global daily database reservations.
- A separate setup execution flag.
- An exact policy ID readiness check.
- Credentialed policy denial tests.

The user signature prevents a compromised sponsor credential from charging an
unwilling user. The low sponsor balance limits direct sponsor loss if backend
controls are bypassed.

### Recurring policy after setup

Remove ATA creation from recurring transactions. A recurring transaction must
contain zero ATA instructions. Replace the current infrastructure reserve with
a smaller network-only reserve. A mandate fingerprint includes that fixed
network reserve, so the current test plan must be revoked and reapproved after
deployment.

## Setup economics

Use integer arithmetic only.

```text
rent lamports       sum of exact rent exemption for each missing ATA
network lamports    getFeeForMessage(final message) + fixed priority fee
SOL price           fresh Jupiter SOL/USDC price
setup USDC          ceil((rent + network) × SOL price)
```

Rules:

- Setup reimbursement contains no 0.75% profit fee.
- Show the exact USDC charge and number of accounts before Turnkey signing.
- Store the SOL price, price block/slot, account sizes, rent, network fee, and
  conversion result with the attempt.
- Reject absent, stale, malformed, or non-positive prices.
- Reject charges above `SETUP_MAX_REIMBURSEMENT_ATOMIC`.
- Use a short quote and blockhash lifetime. If it expires before user signing,
  rebuild and ask for a new signature.
- Check the user's source USDC account against the exact reimbursement before
  returning a signable transaction.
- Rebuild the final transfer amount, simulate again, and assert that accounts,
  programs, signer order, serialized size, rent, and network fee did not change.
- If no destination ATA is missing, record setup as confirmed with zero charge
  and skip the transaction signature.
- If the atomic transaction fails, the ATA creations and USDC transfer both
  roll back. OhMyFund absorbs only the failed network fee.

## Data model

Add `apps/api/sql/006_recurring_account_setup.sql`.

### `mandate_setup_attempts`

- `id`, `owner_id`, `plan_id`, `mandate_id`, and `wallet_id`.
- `purpose`: `initial` or `repair`.
- `attempt_number` unique within a mandate.
- `status`: `preparing`, `awaiting_user_signature`, `user_signed`, `submitted`,
  `confirming`, `confirmed`, `failed`, `expired`, or `unknown`.
- Exact JSON snapshot of missing mints, token programs, destination ATAs,
  account sizes, and rent lamports.
- SOL price atomic value and price block/slot.
- Expected network lamports, rent lamports, and reimbursement USDC atomic.
- Unsigned transaction hex and its SHA-256 message fingerprint.
- User-signed and fully signed transaction hex while unresolved.
- Transaction signature and last valid block height.
- Error code/message, lease owner/expiry, and timestamps.

Constraints and indexes:

- One unresolved setup attempt per mandate with a partial unique index.
- Idempotency keys bind prepare and submit requests to the same plan, mandate,
  and attempt.
- A confirmed attempt cannot return to an unresolved state.
- User-only signed bytes may be cleared after the blockhash expires because the
  sponsor never signed or submitted that transaction. Fully signed bytes are
  cleared only after confirmed or conclusively failed accounting is durable.
- Index unresolved status/lease expiry for worker claims.

Do not add a token-account lifecycle table. Solana remains the source of truth
for whether each ATA exists. Keep confirmed setup attempts as the payment and
recovery audit trail.

### Sponsor reservations

Extend `sponsor_fee_reservations` so a reservation belongs to either a purchase
leg or a setup attempt. Make the existing purchase-leg foreign keys nullable,
add the nullable setup-attempt foreign key, and enforce exactly one owner with
an exclusive check constraint. Reuse the existing per-user and global daily
limits. Reserve the setup network fee plus rent before sponsor signing. Keep
unknown fully signed submissions reserved until reconciliation.

## API and shared contracts

Add shared schemas for:

- Setup status and purpose.
- Setup quote: attempt ID, missing account count, exact reimbursement, rent,
  network fee, expiry, and unsigned transaction hex.
- Setup submission: attempt ID and user-signed transaction hex.
- Setup result: status, transaction signature, and recoverable user message.
- `account_setup_required` as a plan pause code.

Routes:

- `POST /api/plans/:id/setup/prepare`
- `POST /api/plans/:id/setup/submit`
- `GET /api/plans/:id/setup`

All routes require the authenticated owner, CSRF protection for writes,
expected plan revision, an idempotency key, the exact active mandate, and the
allowlisted controlled-launch user.

## Backend setup state machine

```text
prepare
  ├─ existing confirmed attempt + all ATAs exist ─► confirmed
  ├─ fully signed/submitted attempt ─► reconcile, never rebuild
  ├─ user-only signed attempt + live blockhash ─► resume sponsor step
  ├─ user-only signed attempt + expired blockhash ─► expired ─► rebuild
  ├─ unsubmitted expired attempt ─► expired ─► rebuild
  └─ fresh attempt
       ├─ no missing ATA ─► confirmed with zero charge
       └─ build + simulate ─► awaiting_user_signature

submit user signature
  ├─ stale/changed/wrong signature ─► reject without sponsor signing
  └─ persist user-signed bytes
       ├─ setup disabled ─► keep resumable, do not sponsor-sign
       └─ reserve sponsor budget
            ├─ sponsor policy denial ─► failed/recoverable
            └─ persist full signed bytes + tx ID
                 ├─ submission returns expected ID ─► confirming
                 └─ timeout/different ID ─► unknown

worker reconcile
  ├─ confirmed + exact ATA/USDC effects ─► confirmed
  ├─ on-chain error ─► failed
  ├─ fully signed, expired, and absent ─► failed, allow a new attempt
  └─ still uncertain ─► unknown, retain bytes and reservation
```

An unknown fully signed result never triggers an automatic replacement
transaction. The worker checks the stored signature and exact transaction until
the result is conclusive or requires operator review. A user-only signature is
different: it cannot reach the chain without the sponsor signature, so an
expired partial transaction is safe to replace with a fresh user approval.

## Browser activation controller

Create a focused controller outside `ui.tsx`. It owns:

1. Plan preparation.
2. Setup status recovery.
3. Exact setup review text.
4. Direct Turnkey transaction signing.
5. Setup submission and polling.
6. Delegated user creation.
7. Recurring policy creation.
8. Policy cleanup when authorization fails.
9. Final plan activation.

The dashboard provides dependencies, renders progress, and replaces the final
plan. Use explicit progress states:

- Checking token accounts
- Review one-time setup cost
- Waiting for setup signature
- Creating token accounts
- Confirming setup
- Creating recurring signer
- Approving recurring access
- Activating plan

If setup is already confirmed, resume at recurring signer creation. If policy
creation failed after setup, never prepare or charge setup again.

## Configuration and readiness

Add:

- `SETUP_EXECUTION_ENABLED=false` by default.
- `TURNKEY_SPONSOR_SETUP_POLICY_ID`.
- `SETUP_MAX_REIMBURSEMENT_ATOMIC`.
- `RECURRING_MAX_NETWORK_ATOMIC` to replace token-rent reservation in recurring
  mandate calculations.

Setup readiness separately verifies:

- Fee token account mint and authority.
- Sponsor wallet custody and API credential.
- Exact sponsor setup policy ID, condition, consensus, notes, and effect.
- Sponsor SOL minimum balance.
- Solana RPC v0 simulation support.

The recurring worker loop may reconcile setup attempts when
`SETUP_EXECUTION_ENABLED=true` even while `EXECUTION_ENABLED=false`. It must not
enqueue or claim purchase occurrences unless recurring execution is enabled.

Update `CLAUDE.md` with the durable environment variables, readiness checks,
worker behavior, and emergency shutdown commands.

## Test coverage

```text
CODE PATHS                                      USER FLOWS

Setup quote                                     Activation
├── no missing accounts → no charge             ├── 8 accounts → sign → policy → active [E2E]
├── 1..8 missing → exact rent + network          ├── no missing accounts → skip charge [E2E]
├── insufficient USDC                           ├── user rejects setup signature [E2E]
├── stale/malformed SOL price                    ├── refresh after setup confirmation [E2E]
├── reimbursement cap exceeded                  └── double-click activation [E2E]
└── transaction > 1,232 bytes → reject

Signing and submission                          Recovery
├── exact v0 message + user signature accepted  ├── submit timeout but transaction lands
├── changed message/signers rejected            ├── signed transaction expires absent
├── disabled flag stops before sponsor signing  ├── confirmed setup resumes policy creation
├── sponsor policy allow/deny matrix             └── policy creation failure never recharges
├── persist full signed bytes before submission
└── exact ATA + USDC effects reconciled
```

### Unit tests

- Shared schemas accept every state and reject malformed hex, negative amounts,
  too many accounts, and unsupported pause codes.
- Pure setup charge math covers rounding, zero rent, mixed Token/Token-2022,
  stale price, cap boundary, and insufficient balance.
- Solana builder pins the eight-missing-account transaction below 1,232 bytes,
  exact signer order, exact programs/accounts/data, no Jupiter instruction,
  and a single USDC transfer.
- Mutation tests reject wrong payer, owner, ATA, mint, token program, source,
  fee destination, transfer amount, extra instruction, missing instruction,
  wrong blockhash, and changed message bytes.
- Browser controller covers every resume point, user cancellation, API error,
  double submit, stale plan revision, policy cleanup, and cleanup failure.

### PostgreSQL integration tests

- Migration constraints and one-unresolved-attempt uniqueness.
- Concurrent prepare requests return the same attempt.
- User-signed bytes persist before sponsor signing.
- A user-only signed transaction resumes while its blockhash is live and safely
  expires and rebuilds after the blockhash expires.
- Fully signed bytes and transaction ID persist before submission.
- Submission timeout becomes `unknown` and cannot rebuild.
- Confirmed, failed, and expired reconciliation paths.
- Sponsor reservation release/retention for failed and unknown transactions.
- Setup confirmation followed by policy failure resumes without a new charge.
- Closed-ATA repair pauses and resumes the existing mandate.
- Worker reconciles setup while recurring execution remains disabled.

### Browser E2E

- Full activation with eight missing accounts.
- Zero-account activation skips setup signing.
- Rejecting the setup signature leaves the plan safely approval-required.
- Reload after confirmed setup resumes at recurring policy creation.
- Rapid double-click creates one setup attempt and one charge.
- Clear messages for insufficient USDC, expired quote, policy denial, and
  unknown confirmation.

### Credentialed Turnkey policy gate

Before enabling setup execution, prove against Turnkey that the sponsor policy:

- Allows the exact two-signer v0 setup transaction.
- Allows classic Token and Token-2022 ATA combinations from one to eight.
- Denies wrong sponsor, fee destination, token mint, ATA shape, native transfer,
  sponsor-owned SPL transfer, Jupiter instruction, ninth ATA, second transfer,
  transfer above the cap, extra program, and missing user signer.

Do not submit these policy-test transactions. A signing test still requires an
explicit transaction summary and approval under the Solana safety rules.

### Final controlled proof

1. Keep `EXECUTION_ENABLED=false`.
2. Enable setup only for the single allowlisted user.
3. Display the exact accounts, USDC reimbursement, sponsor fee, cluster, and
   simulation result.
4. Obtain explicit approval.
5. Submit one capped mainnet setup transaction.
6. Verify the signature, eight ATAs, exact USDC transfer, sponsor lamport debit,
   database state, and browser resume.
7. Disable setup execution while reviewing the receipt.

Run `npm run verify` and the PostgreSQL integration suite before this proof.

## Failure modes

| Codepath | Production failure | Test | Handling | User result |
|---|---|---|---|---|
| Account preflight | RPC timeout or incomplete batch | Unit/integration | No attempt becomes signable | Retry message |
| Token-2022 sizing | Program return data missing | Unit | Reject quote | Retry message |
| Price conversion | Stale or malformed SOL price | Unit | Reject quote | Price unavailable message |
| Transaction build | Maximum basket exceeds 1,232 bytes | Regression | Reject before signature | Setup unavailable message |
| User signing | User cancels Turnkey | Browser E2E | Keep awaiting signature or expire | Activation remains safe |
| Partial signing | User-only signed blockhash expires | Integration/E2E | Expire partial bytes and build a fresh approval | Sign again message |
| Signature upload | Message or signer changed | Mutation/unit | Reject before sponsor signing | Restart message |
| Sponsor signing | Policy denies or Turnkey times out | Integration/policy | Failed or recoverable state | Retry message |
| Submission | RPC times out after accepting tx | Integration | Mark unknown, reconcile exact ID | Confirming message |
| Confirmation | Signed tx expires absent | Integration | Mark failed, release reservation | Retry setup |
| Reconciliation | Effects differ from stored quote | Integration | Keep unknown, operator review | Clear delayed message |
| Policy creation | Setup confirmed but policy fails | Controller/E2E | Resume after setup | Retry recurring approval only |
| Closed ATA | User closes an approved account | Integration/E2E | Pause and offer repair | One-click repair, no support |

No failure mode is silent. Unknown signed transactions are never replaced
automatically.

## Performance

- Keep the hard maximum of eight assets.
- Batch mint-owner and ATA-existence reads with `getMultipleAccounts`.
- Run Token-2022 size simulations with bounded concurrency.
- Query rent once per unique account size.
- Use one setup-attempt query and one batched status claim per worker tick.
- Poll setup status at a modest interval; no WebSocket or new queue is needed.
- Do not add a cache. Setup is rare and chain state must be fresh before signing.

## Implementation Tasks

Synthesized from this review's findings. Checkbox each task as it ships.

- [ ] **T1 (P1, human: ~1 day / CC: ~45 min)** — Contracts and policy — define setup contracts and the restricted sponsor policy.
  - Surfaced by: Architecture review — setup reimbursement needs a separate, narrowly scoped mandate.
  - Files: `packages/contracts/src/index.ts`, contract tests.
  - Verify: contract unit tests plus the credentialed Turnkey allow/deny matrix.
- [ ] **T2 (P1, human: ~1 day / CC: ~45 min)** — Database — persist setup attempts and setup-linked sponsor reservations.
  - Surfaced by: Architecture review — signed transactions must be durable and idempotent across retries.
  - Files: `apps/api/sql/006_recurring_account_setup.sql`, PostgreSQL integration tests.
  - Verify: migration constraints, concurrency, partial-signature expiry, and reconciliation tests.
- [ ] **T3 (P1, human: ~2 days / CC: ~2 h)** — Solana setup service — build and reconcile the atomic v0 setup transaction.
  - Surfaced by: Architecture and test reviews — up to eight ATAs and the exact USDC reimbursement must remain atomic.
  - Files: `apps/api/src/recurring/setup.ts`, `apps/api/src/solana.ts`, setup unit and integration tests.
  - Verify: mutation tests, a pinned 1,232-byte regression, partial-signature expiry, and PostgreSQL integration tests.
- [ ] **T4 (P1, human: ~1 day / CC: ~1 h)** — API and worker — expose resumable setup routes behind a separate execution gate.
  - Surfaced by: Code quality review — setup orchestration needs one backend state machine rather than route-level branching.
  - Files: `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/worker.ts`, route tests.
  - Verify: route and worker tests pass while recurring execution remains disabled.
- [ ] **T5 (P1, human: ~1 day / CC: ~1 h)** — Browser controller — extract resumable activation and setup signing from `ui.tsx`.
  - Surfaced by: Code quality review — the current activation callback already mixes too many responsibilities.
  - Files: `apps/web/app/ui.tsx`, new activation controller and browser tests.
  - Verify: controller tests and Playwright flows cover every resume point and error state.
- [ ] **T6 (P1, human: ~0.5 day / CC: ~30 min)** — Recurring economics — remove ATA creation from recurring swaps.
  - Surfaced by: Architecture review — setup-only spending must not remain in the reusable recurring delegation.
  - Files: `packages/contracts/src/index.ts`, `apps/api/src/plans.ts`, `apps/api/src/recurring/executor.ts`, regression tests.
  - Verify: policy and executor tests use network-only reserve; the current active plan is marked for reapproval.
- [ ] **T7 (P1, human: ~0.5 day / CC: ~30 min)** — Live gates — validate Turnkey compatibility and one capped setup proof.
  - Surfaced by: Test review — local policy generation does not prove Turnkey accepts the exact two-signer v0 transaction.
  - Files: credentialed test harness and deployment configuration only.
  - Verify: inspect the approved transaction receipt, ATAs, USDC transfer, sponsor debit, database state, and browser resume.
- [ ] **T8 (P2, human: ~30 min / CC: ~10 min)** — Operations — document flags, policy IDs, stops, and recovery commands.
  - Surfaced by: Failure-mode review — operators need explicit controls for unknown results and sponsor exposure.
  - Files: repository infrastructure documentation and deployment runbook.
  - Verify: execute the read-only checks from a clean operator shell.

_No new tasks from Performance Review._

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Contracts and sponsor policy | `packages/contracts/` | — |
| Database migration | `apps/api/sql/`, recurring integration harness | — |
| Setup service and Solana builder | `apps/api/src/recurring/`, `apps/api/src/solana.ts` | Contracts + migration |
| API, worker, readiness | `apps/api/src/` | Setup service |
| Browser activation controller | `apps/web/app/` | Contracts + API response shapes |
| Recurring reserve change | contracts, plans, recurring executor | Contracts |
| Live gates and operations | deployment configuration and docs | All implementation lanes |

Parallel lanes:

- Lane A: contracts and sponsor policy → recurring reserve change.
- Lane B: database migration.
- Merge A + B, then Lane C: setup service → API/worker/readiness.
- Lane D: browser controller starts after contract schemas stabilize and runs in
  parallel with Lane C against mocked API responses.
- Merge C + D, then run live gates and operations documentation.

Conflict flags:

- Contracts and recurring reserve work share `packages/contracts`; keep them in
  one lane.
- Setup service and API integration share `apps/api/src`; keep them sequential.
- Browser work is independent after response schemas are fixed.

## NOT in scope

- Transaction v1 migration: v0 already fits; migrate only after Turnkey policy
  parsing and the local signature verifier support v1.
- Jupiter recurring execution enablement: this plan keeps
  `EXECUTION_ENABLED=false` through setup verification.
- Custom on-chain paymaster or cadence program: controlled launch keeps
  stateful limits in PostgreSQL and a low-balance sponsor wallet.
- Multiple concurrent active recurring plans per wallet: the controlled-launch
  single-plan rule remains.
- Fiat onramp/offramp or MoonPay: this flow uses Turnkey wallets and deposited
  USDC only.
- Token-account lifecycle ledger: current on-chain ATA state is authoritative.
- Automatic notification service: the existing app status is sufficient for
  the controlled launch.

## Release and rollback

1. Merge with both execution flags off.
2. Back up production PostgreSQL, deploy the migration and API, and verify
   liveness/readiness.
3. Deploy the web preview using the stable preview alias.
4. Create and credential-test the dedicated sponsor setup policy.
5. Configure its exact policy ID and setup cap on the VPS.
6. Revoke the current user's old recurring policy because the mandate policy
   removes ATA creation and changes its network reserve.
7. Enable setup only for the allowlisted user and perform the approved proof.
8. Disable setup, inspect the receipt, then re-enable setup if checks pass.
9. Keep recurring execution disabled until its separate live policy gate passes.

Rollback:

- Set `SETUP_EXECUTION_ENABLED=false` and redeploy the worker/API environment.
- Keep unresolved signed attempts for reconciliation; never delete or rebuild
  them during rollback.
- The migration is additive. Old application code ignores the new table and
  columns.
- Revoke the dedicated sponsor setup policy if setup is abandoned.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 25 issues, 0 critical gaps; all decisions folded into the plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS

# Sponsored Solana Fees for Recurring Buys

Status: Core execution is implemented behind disabled execution; automatic per-mandate sponsor-policy provisioning is planned and remains required before multi-user execution
Branch: `feature/turnkey-recurring-buys`  
Date: 2026-09-23  
Owner: OhMyFund

## Objective

Let a Turnkey user fund their wallet with USDC only and run scheduled recurring buys without holding SOL. OhMyFund pays Solana network and token-account creation costs from a Turnkey-managed sponsor wallet. Every successful leg collects the 0.75% OhMyFund profit fee plus that leg's infrastructure reimbursement in USDC, inside the same atomic transaction.

The user's configured amount is a maximum total USDC debit per occurrence. Fees reduce the amount invested. They never increase the debit above the approved amount.

## Success criteria

- A user with USDC and zero SOL can complete a recurring-buy occurrence.
- The sponsor is the Solana fee payer and the user remains the owner of every purchased token.
- A successful leg satisfies `USDC fee transfer + Jupiter input <= approved leg allocation`.
- Failed transactions charge no USDC because all token changes roll back; OhMyFund absorbs the failed transaction's network fee.
- Missing destination token accounts are recreated automatically. Their rent is reimbursed only by a successful transaction that creates them.
- The user signs once for a versioned mandate. Changing assets, weights, amount, cadence, or schedule requires a new signature and a replacement policy.
- A live catalog update never expands an existing user's authority.
- Execution remains disabled until automated checks pass and Yann explicitly approves one capped mainnet transaction.

## Decisions locked by this review

1. Keep Turnkey as the wallet and signing provider. MoonPay is not part of this feature.
2. Hold the sponsor wallet in the Turnkey parent organization. Never store a raw Solana private key on the VPS.
3. Keep the 0.75% fee as profit. Reimburse network, priority, and token-account rent separately in USDC.
4. Collect profit and reimbursement through one tightly constrained top-level USDC transfer to the exact OhMyFund fee token account.
5. Treat the scheduled amount as a maximum total debit, not an amount to which fees are added.
6. Recreate a missing user token account automatically. Do not ask the user to create it or contact support.
7. Generate a deterministic Turnkey policy from one immutable user mandate. Restrict approved mints, per-leg amounts, the USDC source, the fee destination, the sponsor payer, and allowed programs.
8. Store and verify exact Turnkey policy IDs and a policy fingerprint. Never recover authorization by matching policy text.
9. Use a generic multi-signature transaction verifier. Verify the user and sponsor signature slots and preserve the exact message bytes.
10. Use a fresh Jupiter SOL price to convert deterministic lamport costs into USDC. Reject stale or missing prices.
11. Use short database reservations plus a lease heartbeat. Do not hold PostgreSQL locks during external calls.
12. Batch Solana account checks and use only short-lived safe caches.
13. Keep stateful cadence enforcement in PostgreSQL for the controlled launch. Revisit an on-chain program before expanding the cohort.
14. Make one capped mainnet proof instead of a devnet proof. This is allowed only after tests and explicit approval.

`gstack-shortcut(dec-fde91038-bd56-420f-a5b6-23cff1464c02): 6/10, upgrade when recurring buys expand beyond the single allowlisted test user.`

## What already exists

| Existing component | Current value | Plan |
|---|---|---|
| `plan_mandates` | Immutable basket, amount, schedule, fee, and slippage snapshot | Extend as the canonical authorization input |
| `signer_authorizations` | Stores delegated Turnkey user and policy IDs | Bind to one mandate ID and policy fingerprint |
| `purchase_occurrences`, attempts, and legs | Durable execution ledger and partial/unknown states | Extend with sponsor reservations and charge breakdowns |
| `recurring/queue.ts` | `SKIP LOCKED` claiming and occurrence leases | Add ownership-safe heartbeat and lease-loss handling |
| `recurring/executor.ts` | Builds, signs, submits, confirms, and reconciles each leg | Refactor into explicit sponsored execution stages |
| `swaps/jupiter.ts` | Validates Jupiter program, accounts, amounts, slippage, and fee account | Add sponsor payer and composed fee-transfer validation |
| `solana.ts` | Compiles transactions, reads RPC state, simulates, and submits | Add batched account reads and multi-signature support |
| `turnkeyRecurringPolicy` | Broad Jupiter policy for one wallet and fee account | Replace with canonical mandate-specific policy generation |
| Existing tests | Money, policy, Jupiter, Solana, PostgreSQL executor, queue, and Playwright coverage | Extend these suites instead of creating a second harness |
| Runtime flags | Activation enabled for one allowlisted user; execution disabled | Keep execution disabled through implementation and review |

## Architecture

```text
USER APPROVAL

Browser
  │ prepare immutable mandate
  ▼
API + PostgreSQL ── mandate ID + fingerprint ──► Browser
  ▲                                                   │
  │                                                   │ user signs once
  │                                                   ▼
  └──── exact Turnkey policy ID ◄──────── User Turnkey sub-organization
             │
             └── wallet + USDC source + approved mints/amounts
                 + exact fee destination + exact sponsor payer


SCHEDULED EXECUTION, ONE LEG AT A TIME

Worker claims occurrence
  │
  ├─► short DB transaction: verify mandate/policy, reserve sponsor budget
  │
  ├─► batched Solana preflight: mint programs, ATAs, balances, rent
  ├─► Jupiter: fresh SOL price + sponsored swap build
  ├─► compute charge breakdown and compose exact USDC fee transfer
  ├─► validate every program, account, mint, amount, signer, and message byte
  │
  ├─► User Turnkey signs its expected slot
  ├─► Sponsor Turnkey signs the fee-payer slot
  ├─► verify both signatures and unchanged message
  │
  ├─► persist signed bytes and transaction ID before submission
  ├─► submit to Solana
  ├─► confirm or mark unknown for reconciliation
  │
  └─► reconcile user debit, output, fee transfer, lamport cost, and receipt
```

### Trust boundaries

```text
User Turnkey sub-org
  can sign only the current mandate policy
  cannot authorize another catalog mint automatically

Sponsor Turnkey parent org
  can pay fees for validated co-signed transactions
  cannot transfer sponsor SPL assets or native SOL

OhMyFund backend
  chooses timing and builds transactions
  cannot exceed the transaction policy without Turnkey rejecting the signature
  can still repeat an allowed transaction if fully compromised
  └── controlled by DB idempotency, allowlist, daily budgets, and sponsor balance
      (stateful on-chain enforcement is deferred)
```

## Mandate and Turnkey policies

### Canonical mandate input

Create a typed `RecurringMandatePolicyInput` in `packages/contracts` containing:

- Mandate ID, plan ID, plan revision, and fund version.
- User wallet and exact USDC associated token account.
- Delegated backend Turnkey user ID.
- Exact sponsor fee-payer address.
- Exact OhMyFund USDC fee token account.
- Sorted and deduplicated basket entries: output mint, destination ATA, token program, weight, and approved leg allocation.
- Maximum total occurrence debit and per-leg debit.
- Maximum infrastructure reimbursement per leg and minimum net investment.
- Allowed slippage and terms version.
- Cadence, local time, timezone, and weekday for the signed product mandate, even though backend scheduling enforces time.

Serialize this input canonically and hash it. Store the fingerprint beside the exact Turnkey policy ID. Basket order in the UI must not change the fingerprint.

### User policy

The generated user policy must prove, through credentialed Turnkey policy tests, all of the following before execution can be enabled:

- The signing wallet is the exact user's wallet.
- The backend delegated user is the only policy approver.
- The sponsor is the exact transaction fee payer.
- Native SOL transfers are absent.
- Exactly one supported Jupiter route instruction exists per transaction.
- Input mint and source token account are the user's exact USDC accounts.
- The destination token account matches one approved mandate leg. Its on-chain mint is immutable, so the exact destination also binds the approved output mint.
- The Jupiter input plus the fee transfer cannot exceed that leg's approved gross allocation.
- The only top-level SPL transfer is USDC from the user's source account to the exact OhMyFund fee account and stays within the mandate's fee cap.
- Token-account creation is excluded from recurring swap transactions and remains a separate sponsored setup flow.
- Each transaction has exactly four top-level instructions: two Compute Budget instructions, one validated Jupiter route, and one exact legacy SPL Token USDC fee transfer. The exact count blocks extra top-level instructions while allowing Jupiter to reference Token-2022 internally.

Turnkey's documented policy grammar supports comparisons but no integer arithmetic, so it cannot directly prove `swap input + fee transfer <= gross allocation`. Use a conservative per-leg reserve instead: authorize a fixed swap input equal to `gross allocation - profit fee - maximum infrastructure reserve`, plus a fee transfer capped at `profit fee + maximum infrastructure reserve`. Charge only the actual infrastructure cost and leave any unused reserve as USDC in the user's wallet. This proves the maximum total debit without overcharging the user. Add credentialed denial tests for wrong destination, wrong mint, excess fee, changed swap input, extra instruction, and changed sponsor payer. Keep `EXECUTION_ENABLED=false` until these tests pass. Do not rely only on backend validation for this boundary.

### Sponsor policy

Create a separate parent-organization API user and policy for the sponsor wallet:

- It may sign only for the exact sponsor wallet acting as fee payer.
- It requires the expected user wallet as another signer.
- It allows only the same validated program and instruction shapes as the user policy.
- It forbids native and SPL transfers from sponsor-owned accounts.
- Sponsor spend remains guarded by backend per-transaction, per-user daily, global daily, and minimum-balance circuit breakers.

The VPS stores only Turnkey API credentials. It never stores the sponsor wallet private key.

### Policy replacement

```text
active mandate v1
  │ user edits assets, weights, amount, cadence, or schedule
  ▼
plan = approval_required; execution stops
  │
  ├─► user revokes exact Turnkey policy ID for v1
  ├─► backend confirms v1 no longer exists or is inactive
  ├─► browser creates canonical policy for mandate v2
  ├─► backend verifies exact v2 policy ID + fingerprint
  ▼
activate mandate v2
```

Never infer authority by searching for a policy with matching text. If Turnkey is unavailable, keep the plan paused.

## Transaction economics

### Pure charge calculation

Add one pure `computeChargeBreakdown` function. Use integer arithmetic only.

For each leg:

```text
gross allocation                    user-approved maximum for this leg
profit fee                          floor(gross × 75 / 10,000)
network lamports                    getFeeForMessage + fixed priority fee
token-account rent lamports         exact rent only when ATA creation is present
SOL price                           fresh Jupiter Price API V3 value
infrastructure reimbursement USDC   ceil(total lamports × SOL/USDC price)
fee transfer                        profit fee + infrastructure reimbursement
Jupiter input                       gross allocation - fee transfer
total user debit                    fee transfer + Jupiter input <= gross allocation
```

Rules:

- Round the 0.75% profit fee down, matching the existing fee behavior.
- Round infrastructure reimbursement up to one atomic USDC unit.
- Store the Jupiter price, its block reference or timestamp, and the conversion inputs in the ledger.
- Reject stale, absent, non-positive, or malformed prices before either signature.
- Enforce the configured infrastructure cap and minimum net investment. If either fails, postpone or pause without signing.
- Compute and collect charges per successful leg. A partial occurrence never collects fees for an unexecuted leg.
- A failed Solana transaction rolls back the USDC transfer and swap. The sponsor absorbs that failed transaction's network fee.
- No token-account lifecycle ledger is needed. Check the ATA on-chain before each occurrence; if it was closed, recreate it and charge rent again.

Build each leg in two deterministic passes:

1. Compose the final instruction shape with the fee transfer set to its authorized maximum, including ATA creation when required.
2. Simulate to choose the compute limit, then obtain the base fee, priority fee, and rent.
3. Convert those lamports with the fresh SOL price and calculate the exact fee transfer. Keep the Jupiter input fixed at the mandate's reserved net amount; unused infrastructure reserve remains as USDC.
4. Rebuild the same instruction shape with the exact amounts, simulate again, and assert signer count, compute limit, fee, rent, and serialized size remain within the first-pass authorization.
5. Only then request user and sponsor signatures.

Changing numeric amounts must not change the signer set or account list. Any second-pass structural difference restarts preflight with a fresh blockhash and price.

### Jupiter integration compatibility gate

The current adapter uses Swap V2 `/build` instructions and compiles the final Solana message locally. Keep fee-payer selection under OhMyFund's compiler: set the sponsor as the message fee payer and keep the user as Jupiter's taker. When the destination ATA is missing, compose the idempotent ATA creation instruction locally with sponsor payer, user owner, approved mint, and expected token program. Pass the explicit destination ATA to Jupiter and reject any unexpected Jupiter setup instruction.

Run a live read-only compatibility check proving that V2 `/build` returns a route that remains valid when OhMyFund sets the sponsor fee payer locally and supplies the explicit destination ATA. If Jupiter introduces a setup instruction, different signer, or incompatible payer assumption, keep execution disabled and update the adapter. Do not depend on an undocumented V2 request parameter. Also prove that Turnkey can add the user and sponsor signatures sequentially to the same partially signed transaction.

## Database changes

Add `apps/api/sql/005_sponsored_execution.sql`.

### `signer_authorizations`

- Add `mandate_id` referencing `plan_mandates`.
- Add `policy_fingerprint`.
- Keep exact `policy_ids`, but require exactly one active policy for this flow.
- Add a uniqueness rule preventing two live authorizations for one wallet or mandate.

### `purchase_attempts`

- Add total profit fee, infrastructure reimbursement, net investment, sponsored lamports, and SOL price metadata.
- Preserve the approved gross amount as the maximum occurrence debit.

### `purchase_legs`

- Add profit fee, infrastructure reimbursement, net input, expected network fee, expected rent, actual network fee, fee-transfer amount, ATA-created flag, sponsor reservation ID, and sponsor/user signer addresses.
- Store final transaction ID separately from signed transaction bytes.
- Keep signed bytes until final reconciliation; clear them only after confirmed accounting is durable.

### `sponsor_fee_reservations`

Create an append-only reservation ledger with:

- User, occurrence, attempt, and leg IDs.
- Reserved lamports and final charged lamports.
- Status: `reserved`, `submitted`, `confirmed`, `failed`, `released`, or `unknown`.
- Unique leg reservation.
- Timestamps and transaction ID.

Use short serializable or advisory-locked database transactions only while checking and reserving:

- Maximum SOL per transaction.
- Per-user rolling 24-hour sponsored lamports.
- Global rolling 24-hour sponsored lamports.
- Minimum sponsor SOL balance after reservation.

Release unused reservations only when chain outcome is conclusively failed or expired. Keep unknown submissions reserved until reconciliation.

## Execution state machine

```text
due
 └─► claimed
      └─► reserving
           ├─ rejected by policy/budget ─► paused
           └─► building
                ├─ vendor/preflight failure before signing ─► retryable
                └─► signing_user
                     ├─ rejected ─► paused
                     └─► signing_sponsor
                          ├─ rejected ─► paused
                          └─► signed_persisted
                               └─► submitted
                                    ├─ confirmed ─► reconciled
                                    ├─ chain failure ─► failed
                                    └─ uncertain ─► unknown ─► reconciler
```

Implementation rules:

- Claim work with `FOR UPDATE SKIP LOCKED` as today.
- Reserve sponsor budget in a short transaction, then release every database lock.
- Start a lease heartbeat owned by the worker. Update only when `lease_owner` still matches.
- Abort before signing if the lease is lost.
- Once signed bytes are persisted, never build a replacement transaction until the original is conclusively failed or expired.
- Persist the expected transaction ID before submission.
- Treat submission timeout as unknown, never failed.
- Reconcile by transaction ID and exact token balance changes.
- Do not retry a confirmed leg. Continue an occurrence only from its first unfinished leg.
- One transaction contains one asset swap and that leg's fee transfer. This preserves the current partial-execution model and avoids Solana account/size limits for 2–8 asset baskets.

## Multi-signature transaction handling

Replace one-signature byte-offset helpers with a parser based on the serialized Solana transaction layout.

Required checks:

1. Compile once with sponsor as fee payer and user as required signer.
2. Record the signer public keys, signer indexes, message bytes, and empty signature slots.
3. Send the same unsigned bytes to the user's Turnkey sub-organization.
4. Accept only the expected user signature slot changing.
5. Send those exact bytes to the sponsor's Turnkey signer.
6. Accept only the expected sponsor slot changing.
7. Verify both Ed25519 signatures over the unchanged message locally.
8. Extract the Solana transaction ID from the fee payer's first signature.
9. Reject missing, extra, reordered, duplicated, or mutated signatures.

Add an inline ASCII signing diagram in `apps/api/src/solana.ts` because signer order and transaction-ID extraction are security-sensitive.

## Solana and Jupiter validation

Extend the existing validator. It must reject:

- A payer other than the configured sponsor.
- A missing or writable user signer role that differs from the approved shape.
- A different USDC source account.
- A destination mint or ATA outside the mandate.
- A fee transfer with the wrong mint, source, destination, authority, or amount.
- More than one fee transfer or more than one Jupiter route instruction.
- A Jupiter input plus fee transfer above the leg allocation.
- ATA creation paid by the user, owned by anyone except the user, or targeting an unapproved mint/account.
- Unapproved programs, cleanup, tips, arbitrary Token instructions, or native transfers.
- Excess compute price, compute limit, slippage, stale blockhash, stale price, or altered lookup tables.

Use `getMultipleAccounts` once per occurrence for output mints and expected ATAs. Cache immutable mint program ownership briefly. Check ATA existence fresh. Cache sponsor readiness for no more than 30 seconds.

## Readiness and operations

When execution is enabled, `/api/health/ready` must verify:

- Jupiter API credentials are present.
- User policy fee account exists, is an initialized USDC token account, and has the configured authority.
- Sponsor address belongs to the expected Turnkey parent wallet.
- Sponsor signing credential and policy are accessible.
- Sponsor SOL balance is above the circuit-breaker minimum.
- Solana cluster, USDC mint, fee account, and sponsor wallet all target the same configured environment.

Return only safe reason codes. Never return credentials or raw vendor errors.

Add structured logs and counters for claims, lease loss, policy rejection, budget rejection, user-sign failure, sponsor-sign failure, submission uncertainty, confirmations, failed fees absorbed, ATA recreation, profit collected, reimbursement collected, and sponsor balance.

Emergency stop remains `EXECUTION_ENABLED=false`. The worker must check it before every claim and before signing each leg.

## Implementation steps

### 1. Configuration and compatibility proof

- Add sponsor Turnkey identifiers, sponsor limits, price freshness, reimbursement cap, and minimum-investment configuration.
- Add strict configuration parsing and safe readiness reason codes.
- Validate Jupiter V2 custom payer behavior with a read-only live request.
- Validate Turnkey policy expressions with credentialed allow and deny cases.

### 2. Contracts and canonical policies

- Extend mandate and authorization schemas in `packages/contracts`.
- Replace `turnkeyRecurringPolicy(wallet, user, fee)` with a typed canonical builder.
- Add policy fingerprinting, sorted/deduplicated basket handling, and exact sponsor/fee constraints.
- Add the separate sponsor policy builder.

### 3. Migration and ledger

- Add migration `005_sponsored_execution.sql`.
- Bind authorization to mandate and fingerprint.
- Add charge and sponsor reservation columns/tables.
- Update row mappers and API schemas.

### 4. Money and price conversion

- Add pure integer `computeChargeBreakdown` and tests.
- Add Jupiter SOL price retrieval with freshness validation.
- Add deterministic base/priority/rent calculation and USDC rounding.

### 5. Solana transaction primitives

- Add batched account reads.
- Add sponsor fee-payer compilation and exact fee-transfer instruction.
- Implement generic signer-slot parsing, mutation checks, local signature verification, and transaction-ID extraction.

### 6. Jupiter validation

- Set the sponsor payer in OhMyFund's compiled message and reject payer assumptions from Jupiter.
- Compose and validate sponsored ATA setup locally.
- Validate the composed fee transfer and total debit.
- Retain sequential build/sign/submit per leg.

### 7. Authorization lifecycle

- Create policies from the prepared mandate.
- Store exact policy ID and fingerprint.
- Remove policy-text rediscovery.
- Require confirmed old-policy revocation before replacement activation.
- Make every mandate change return the plan to `approval_required`.

### 8. Executor and reconciler

- Refactor the executor into reserve, preflight, build, validate, sign user, sign sponsor, persist, submit, confirm, and reconcile stages.
- Add lease heartbeat and ownership checks.
- Add sponsor reservation recovery for failed, expired, and unknown transactions.
- Persist and expose the full charge receipt.

### 9. Web UX

- Keep SOL, gas, and token-account setup hidden from onboarding.
- Explain once that the scheduled amount is the maximum debit and includes OhMyFund and infrastructure fees.
- Show the mandate's assets, weights, amount, and schedule before the approval signature.
- Require a new approval after any mandate change.
- Show each occurrence's invested amount, 0.75% fee, infrastructure reimbursement, total debit, and status.

### 10. Verification and rollout

- Run all unit, integration, contract, and browser tests.
- Run `npm run verify` and the PostgreSQL integration suite.
- Deploy with execution disabled.
- Confirm production readiness and sponsor circuit breakers.
- Ask Yann for explicit approval immediately before one capped mainnet transaction.
- Turn execution off again after the proof and reconcile the on-chain receipt manually.
- Keep the cohort at the single allowlisted user until the proof is reviewed.

## Test coverage plan

```text
CODE PATHS                                             USER FLOWS
[+] charge-breakdown.ts                                [+] Approve recurring mandate
  ├── [GAP→TEST] no ATA rent                             ├── [GAP→E2E] first approval
  ├── [GAP→TEST] ATA rent included                       ├── [GAP→E2E] asset/weight change
  ├── [GAP→TEST] USDC rounding                           ├── [GAP→E2E] amount change
  ├── [GAP→TEST] cap/minimum rejection                   └── [GAP→E2E] schedule change
  └── [GAP→TEST] total never exceeds gross

[+] policy builder                                     [+] Zero-SOL recurring purchase
  ├── [GAP→TEST] canonical order                         ├── [GAP→E2E] existing ATA
  ├── [GAP→TEST] exact mint/account/amount               ├── [GAP→E2E] missing ATA recreated
  ├── [GAP→TEST] exact sponsor and fee destination       ├── [GAP→E2E] partial occurrence
  └── [GAP→CREDENTIAL] every denial case                 └── [GAP→E2E] clear fee receipt

[+] solana.ts                                          [+] Recoverable failures
  ├── [GAP→TEST] two blank signer slots                  ├── [GAP→INTEGRATION] vendor timeout before sign
  ├── [GAP→TEST] user signature only                     ├── [GAP→INTEGRATION] lease lost
  ├── [GAP→TEST] sponsor signature only                  ├── [GAP→INTEGRATION] submission unknown
  ├── [GAP→TEST] both signatures valid                   ├── [GAP→INTEGRATION] chain failure
  ├── [GAP→TEST] wrong slot/message mutation             └── [GAP→INTEGRATION] reconciler recovery
  └── [GAP→TEST] sponsor signature is transaction ID

[+] executor + sponsor ledger                          [+] Operational safety
  ├── [GAP→INTEGRATION] reserve/confirm/release           ├── [GAP→TEST] execution flag off
  ├── [GAP→INTEGRATION] per-tx/user/global limits         ├── [GAP→TEST] readiness failure
  ├── [GAP→INTEGRATION] minimum sponsor balance           └── [GAP→MANUAL] capped mainnet proof
  ├── [GAP→INTEGRATION] duplicate worker/idempotency
  └── [GAP→INTEGRATION] failed tx sponsor loss
```

### Unit tests

- `apps/api/src/money.test.ts`: profit, infrastructure, rounding, no-rent/rent, cap, minimum, zero/invalid price, and total-debit invariants.
- `packages/contracts/src/index.test.ts`: canonical policy equality, sorting, deduplication, fingerprint changes, all approved mints, and no catalog expansion.
- `apps/api/src/solana.test.ts`: every two-signature slot and mutation case, composed transfer parsing, fee calculation, batched accounts, and transaction-ID extraction.
- `apps/api/src/swaps/jupiter.test.ts`: sponsor payer, ATA payer/owner, approved and forbidden mints, fee source/destination/amount, combined debit, programs, slippage, blockhash, lookup tables, and malformed responses.
- Readiness tests: invalid sponsor custody, invalid fee account mint/authority, low balance, vendor timeout, cache hit, and cache expiry.

### PostgreSQL integration tests

- Extend `recurring/executor.integration.test.ts` with realistic serialized two-signer transactions.
- Prove one reservation per leg and atomic per-user/global budget enforcement under concurrent workers.
- Prove the lease heartbeat prevents reclaim and lease loss stops before a new signature.
- Prove signed bytes are durable before submit and unknown submission is never rebuilt.
- Prove existing ATA, missing ATA, closed/recreated ATA, partial occurrence, failed chain transaction, and reconciler recovery.
- Prove policy replacement cannot activate while the old exact policy ID remains active.

### Browser tests

- Extend `apps/web/e2e/recurring.spec.ts` for first approval, mandate edits requiring reapproval, revoked-policy blocking, zero-SOL messaging, automatic ATA behavior, and fee receipt display.
- Continue mocking vendor calls in Playwright. Credentialed Turnkey and mainnet checks remain explicit gated tests.

### Credentialed checks

- Run Turnkey allow/deny policy tests using a disposable controlled wallet.
- Run one Jupiter sponsored build and simulation without submission.
- Never place private keys, signed transactions, or API keys in fixtures or logs.

## Production failure modes

| Code path | Real failure | Test | Handling | User result |
|---|---|---|---|---|
| Sponsor readiness | Wrong wallet, fee account, or low SOL | Yes | Readiness fails closed | Recurring execution unavailable before a purchase starts |
| SOL price | Missing or stale Jupiter price | Yes | No signing; retry later | Purchase delayed with a clear temporary status |
| Sponsor budget | Concurrent workers exceed daily cap | Yes | Atomic reservation rejects one worker | Plan pauses or retries without user debit |
| Lease | Worker stalls or loses ownership | Yes | Heartbeat detects loss; stop before signing | No duplicate transaction |
| Jupiter build | Wrong payer, mint, program, or amount | Yes | Validator rejects before signing | No user debit |
| User Turnkey sign | Policy rejects or vendor times out | Yes | Pause/retry before sponsor sign | No transaction submitted |
| Sponsor Turnkey sign | Sponsor policy rejects | Yes | Persist failure and release safe reservation | No transaction submitted |
| Submission | RPC timeout after send | Yes | Mark unknown and reconcile by transaction ID | Status remains pending, never duplicate-buy |
| Chain execution | Transaction fails | Yes | Mark failed; sponsor fee loss recorded | No USDC fee or swap; clear failure |
| Confirmation | RPC cannot determine finality | Yes | Keep signed bytes and reservation; reconcile | Pending/unknown, not silently failed |
| Accounting | On-chain amounts differ | Yes | Pause as unknown and alert | Receipt withheld until reviewed |
| ATA closure | User closed destination ATA | Yes | Recreate automatically with sponsor payer | Purchase continues; rent reimbursement shown |
| Policy replacement | Turnkey unavailable during revoke | Yes | Keep old plan paused; do not activate new mandate | User can retry later |

No silent failure path may both lack error handling and lack a test. Critical gaps after implementation must remain zero.

## Rollout

1. Keep `EXECUTION_ENABLED=false` and the existing single-user allowlist.
2. Apply the database migration with a verified backup and rollback instructions.
3. Create the Turnkey sponsor wallet API user and restricted sponsor policy.
4. Deploy code and confirm readiness remains unavailable until every sponsor setting is valid.
5. Run the complete automated suite and credentialed policy denial suite.
6. Run a Jupiter sponsored build plus Solana simulation without submission.
7. Review the exact prepared mainnet transaction, charge breakdown, sponsor maximum, and user maximum.
8. Ask Yann for explicit approval to enable execution for one occurrence.
9. Submit one capped mainnet occurrence for the allowlisted user.
10. Disable execution immediately after the proof.
11. Reconcile balances, signatures, fee transfer, sponsor lamports, receipt, and logs.
12. Fix any discrepancy before enabling another occurrence or another user.

## Deployment and rollback

- Update the VPS deployment documentation in `CLAUDE.md` with new durable environment variables and exact health commands during implementation.
- Deploy through the existing Docker Compose API and worker services on `ssh hetzner-neo`.
- Do not change the Vercel preview architecture; it remains a frontend preview using the production backend by the explicit hackathon decision.
- Rollback order: set `EXECUTION_ENABLED=false`, restart the worker, verify no claim is possible, reconcile unknown transactions, then roll back application code. Keep additive ledger columns and rows; do not destructively roll back financial history.

## Retrospective note

This branch already shipped the controlled recurring-buy foundation, then added stable-preview and activation-only test fixes. Those commits proved the mandate, ledger, preview, and feature-flag paths, but they deliberately left execution disabled and the Turnkey policy broad. This plan reuses that foundation and concentrates extra review on the same prior risk areas: policy scope, preview-versus-production configuration, unknown transaction recovery, and the execution flag boundary.

## NOT in scope

- MoonPay embedded wallets or MoonPay fiat on/off-ramp integration. Turnkey remains the only wallet provider in this feature.
- A custom Solana enforcement program. Revisit before expanding beyond the controlled allowlist.
- Multiple active recurring plans per wallet. The existing single-live-plan constraint remains.
- Atomic purchase of all 2–8 assets in one Solana transaction. Account and size limits make one validated transaction per leg safer.
- Charging users for failed transactions. OhMyFund absorbs failed network fees.
- Asking users to hold SOL, create token accounts, or contact support for a closed ATA.
- A separate token-account lifecycle ledger. Fresh on-chain checks are the source of truth.
- General validation of every catalog asset's liquidity and execution behavior. The existing asset-variant TODO remains.
- Public production rollout. This plan ends with one allowlisted proof and execution disabled again.

## Parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Contracts and policies | `packages/contracts/` | Compatibility proof |
| Database and ledger | `apps/api/sql/`, recurring persistence | Canonical data fields agreed |
| Money and price | API money/vendor modules | Configuration |
| Solana primitives | API Solana module | Compatibility proof |
| Jupiter validator | API swaps module | Solana primitives |
| Authorization lifecycle | API plans, web approval flow | Contracts + database |
| Executor and reconciler | API recurring modules | Database + money + Solana + Jupiter |
| Receipt UX and E2E | Web app and E2E | Contracts + executor response shape |
| Deployment proof | VPS and Vercel configuration | All implementation and tests |

Parallel lanes:

- Lane A: contracts and canonical policy builders → authorization lifecycle.
- Lane B: migration and sponsor reservation ledger → executor persistence.
- Lane C: money/price calculation + Solana multi-signature primitives → Jupiter validation.
- Lane D: receipt UI test fixtures, starting after response schemas stabilize.

Launch A, B, and the independent parts of C in parallel worktrees. Merge them before executor integration. Lane D can start after contracts merge. Deployment waits for every lane and the complete test suite.

Conflict flags:

- Lane B and executor integration both touch `apps/api/src/recurring/`; sequence those commits.
- Lane C components share `apps/api/src/solana.ts` and should stay in one worktree.
- Authorization and UI both consume `packages/contracts`; merge contract schemas first.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~4h / Codex: ~25min)** — contracts — Build canonical mandate-specific user and sponsor Turnkey policies.
  - Surfaced by: Architecture review — live catalog entries must not expand existing authority.
  - Files: `packages/contracts/src/`, `apps/api/src/plans.ts`, `apps/web/app/ui.tsx`
  - Verify: contract unit tests plus credentialed Turnkey allow/deny suite.
- [ ] **T2 (P1, human: ~3h / Codex: ~20min)** — authorization — Bind exact policy IDs and fingerprints to mandates and remove policy-text matching.
  - Surfaced by: Code quality review — `apps/api/src/plans.ts:106,272` can rediscover stale policy text.
  - Files: `apps/api/sql/`, `apps/api/src/plans.ts`, contracts
  - Verify: plan integration tests for activation, replacement, revocation, and Turnkey outage.
- [ ] **T3 (P1, human: ~4h / Codex: ~25min)** — money — Add one integer charge-breakdown function and fresh SOL/USDC conversion.
  - Surfaced by: Code quality review — financial calculations would otherwise span executor and Jupiter validation.
  - Files: API money and Jupiter price modules
  - Verify: money invariant and price freshness unit tests.
- [ ] **T4 (P1, human: ~6h / Codex: ~40min)** — Solana — Implement sponsored payer compilation and generic two-signature verification.
  - Surfaced by: Code quality review — `apps/api/src/solana.ts:101` assumes one signature.
  - Files: `apps/api/src/solana.ts`, Solana tests
  - Verify: serialized transaction signer-slot, mutation, and transaction-ID tests.
- [ ] **T5 (P1, human: ~5h / Codex: ~35min)** — Jupiter — Compose and validate the exact fee transfer, sponsor ATA payer, and total debit.
  - Surfaced by: Architecture review — exact reimbursement conflicts with the current no-transfer policy.
  - Files: `apps/api/src/swaps/`, Solana compiler
  - Verify: Jupiter validator denial matrix and sponsored simulation.
- [ ] **T6 (P1, human: ~1d / Codex: ~1h)** — recurring executor — Replace long advisory locks with reservations and lease heartbeat.
  - Surfaced by: Performance review — `executor.ts:53-139` holds a DB lock across vendor calls.
  - Files: `apps/api/src/recurring/`, migration
  - Verify: concurrent PostgreSQL integration tests and lease-loss recovery.
- [ ] **T7 (P1, human: ~4h / Codex: ~25min)** — readiness — Verify sponsor custody, fee account, balance, and cluster before execution.
  - Surfaced by: Code quality review — `server.ts:81` verifies only configuration presence.
  - Files: API readiness/configuration modules
  - Verify: readiness failure and short-cache tests.
- [ ] **T8 (P2, human: ~4h / Codex: ~25min)** — RPC efficiency — Batch basket mint and ATA checks.
  - Surfaced by: Performance review — one mint RPC currently runs per leg.
  - Files: API Solana and executor modules
  - Verify: RPC call-count and cache-expiry tests.
- [ ] **T9 (P1, human: ~2d / Codex: ~2h)** — tests — Add the full unit, PostgreSQL integration, browser, and credentialed test matrix.
  - Surfaced by: Test review — sponsored execution and two-signature rejection paths are untested.
  - Files: contract, API, and web test suites
  - Verify: `npm run verify`, API integration command, and Playwright recurring suite.
- [ ] **T10 (P1, human: ~3h / Codex: ~20min)** — rollout — Execute one explicitly approved capped mainnet proof and disable execution again.
  - Surfaced by: Architecture review — mainnet was chosen instead of devnet for the final proof.
  - Files: deployment configuration and durable infra docs
  - Verify: on-chain receipt, sponsor ledger, user balances, logs, and disabled worker state.

## Review completion summary

- Step 0: Scope Challenge — full sponsored-fee scope accepted; custom on-chain program deferred.
- Architecture Review: 4 material issues resolved: custody, reimbursement mechanism, per-user mandate scope, and stateless cadence risk.
- Code Quality Review: 4 issues resolved: centralized money math, multi-signature verification, readiness validation, and exact policy identity.
- Test Review: coverage diagram produced; 36 planned branches and user-flow gaps identified and required.
- Performance Review: 2 issues resolved: long database locks and per-leg RPC fan-out.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 1 item approved.
- Failure modes: 0 accepted silent critical gaps; every listed failure requires a test and explicit handling.
- Outside voice: skipped because the session already runs under Codex.
- Parallelization: 4 lanes; 3 can start in parallel, then merge before executor integration.
- Lake Score: 11/11 review choices selected the recommended complete option.

## Automatic per-mandate sponsor-policy provisioning

### Result

Replace the single global `TURNKEY_SPONSOR_POLICY_ID` with an exact sponsor policy stored beside each mandate authorization. Creating, editing, reapproving, or cancelling a recurring plan must manage that sponsor policy automatically. The global `TURNKEY_SETUP_SPONSOR_POLICY_ID` remains unchanged because token-account setup uses one reusable policy with a different purpose.

The controlled-launch security model uses two distinct Turnkey API identities:

- the existing sponsor signer may sign only policy-approved sponsor-wallet transactions;
- a policy provisioner may create and revoke sponsor policies but is not used by the recurring worker for transaction signing.

These credentials must not share one process environment. The provisioner runs behind a private internal boundary and accepts only a mandate identifier, never caller-supplied Turnkey policy text. It loads the immutable mandate, builds the canonical policy with `turnkeySponsorMandatePolicy`, and verifies the user policy before creating the sponsor policy.

This is defense in depth, not protection from full VPS compromise. Turnkey does not expose created policy contents or deleted policy IDs through `activity.params`, so its policy engine cannot restrict a provisioner to the OhMyFund template. Keep the sponsor SOL balance low during the controlled launch. Stronger isolation or root/quorum approval is recorded in `TODOS.md` before broader use.

### What already exists

| Existing component | Reuse |
|---|---|
| `turnkeySponsorMandatePolicy` | Generates the exact sponsor policy from the immutable mandate and fingerprint |
| `signer_authorizations` | Remains the one row binding the user and sponsor policies to a mandate |
| `verifyDelegatedAccess` | Continues to verify the exact user policy before sponsor provisioning starts |
| `vendorCall` | Supplies bounded Turnkey timeouts and normalized retry behavior |
| `recurringExecutionReadiness` | Splits into global sponsor readiness and plan-specific policy validation |
| PostgreSQL advisory locks and idempotency keys | Fence concurrent activation and replacement requests |
| Existing Vitest, PostgreSQL, and Playwright suites | Extend the current harness instead of adding a second test system |

### Credential and service boundaries

```text
                         TURNKEY SPONSOR ORGANIZATION
                         ┌─────────────────────────────┐
                         │ One sponsor wallet with SOL │
                         │                             │
policy provisioner ─────►│ create/delete policies     │
credential               │                             │
                         │ exact mandate policy        │
sponsor signer ─────────►│ signs sponsor slot only     │
credential               └─────────────────────────────┘
       ▲
       │
private provisioner boundary
       │ mandate ID only
       ▼
API ─────────► PostgreSQL ◄──────── recurring worker
                  │                         │
                  │ exact sponsor policy ID │ signs transaction
                  │ + fingerprint + status  │
                  └─────────────────────────┘
```

Rules:

- Never send raw policy JSON across the internal provisioning boundary.
- The provisioner independently loads and validates the immutable mandate.
- The recurring worker receives no policy-provisioner credential.
- The policy provisioner is not used as a transaction signer by application code.
- Reject startup when signer and provisioner public keys are equal.
- Keep the existing setup sponsor policy and setup kill switch separate.
- Keep `EXECUTION_ENABLED=false` until the credentialed policy matrix and capped proof pass.

### Persistence

Add an expand-only migration, `apps/api/sql/007_sponsor_policy_lifecycle.sql`, extending `signer_authorizations` with:

- `sponsor_policy_id uuid`;
- `sponsor_policy_fingerprint text` with the existing 64-character lowercase SHA-256 constraint;
- `sponsor_policy_status` in `pending`, `provisioning`, `active`, `provisioning_unknown`, `revocation_pending`, `revoked`, or `failed`;
- `sponsor_policy_created_at` and `sponsor_policy_revoked_at`;
- `sponsor_policy_last_error_code`, containing a safe normalized code and never a raw vendor response.

Add a uniqueness rule for one non-revoked sponsor policy per mandate. Do not create a second authorization table: the user policy and sponsor policy are a one-to-one authorization pair for the same immutable mandate.

Existing authorizations remain non-executable after migration because no sponsor policy ID is backfilled. Remove `TURNKEY_SPONSOR_POLICY_ID` only after the new code is deployed with execution disabled.

### Activation flow

Use synchronous provisioning with durable states. Do not hold a database transaction or advisory lock during a Turnkey network call.

```text
browser creates exact user policy
  │
  ▼
API verifies user policy ID + fingerprint
  │
  ├─ short transaction: lock mandate and mark sponsor policy `provisioning`
  │
  ├─ provisioner builds canonical sponsor policy from the stored mandate
  ├─ Turnkey `createPolicies()` returns the exact policy ID
  ├─ provisioner fetches policies and verifies ID + effect + consensus + condition + notes
  │
  └─ short transaction: store ID/fingerprint, mark both authorizations active,
                        then activate the plan and calculate `next_run_at`
```

Activation invariants:

- The plan remains `approval_required` until both exact policies are verified.
- The authorization row is claimed with a compare-and-set transition from `pending` to `provisioning`.
- A repeated request seeing `active` returns the stored successful result.
- A repeated request seeing `provisioning` does not create another policy.
- A completed Turnkey response is stored by exact returned policy ID; policy text is never used to rediscover authorization.
- A timeout after submission sets `provisioning_unknown`, leaves the plan inactive, and requires exact operator reconciliation before retrying creation.
- A database failure after confirmed creation triggers a best-effort exact-ID revocation and leaves the plan inactive. Cleanup failure remains visible as `provisioning_unknown`.

### Edit, reapproval, and cancellation

Stop execution in PostgreSQL before contacting Turnkey:

```text
active
  └─► paused + pause_code=sponsor_policy_revocation_required
         ├─► delete exact stored sponsor policy ID
         ├─► verify the ID is absent
         └─► approval_required for edit/reapproval
              OR cancelled for cancellation
```

Rules:

- The browser still revokes the exact user policy before changed terms can be approved.
- The API automatically revokes the sponsor policy after execution is fenced.
- A Turnkey failure leaves the plan paused with a clear retry action.
- Never activate a replacement while the previous sponsor policy is not confirmed revoked.
- Never erase an old policy ID or fingerprint. Preserve the authorization row as revoked audit history.
- Reuse `paused`; do not add a top-level `revocation_pending` plan status.

### Readiness and execution

Split readiness into two levels:

1. Global readiness validates configuration, sponsor custody, fee account, sponsor SOL minimum, and access to Turnkey.
2. Plan readiness loads the stored sponsor policy ID and fingerprint for the claimed mandate, regenerates the exact expected policy, and verifies the live policy before the first signature.

One invalid policy pauses only its own plan. It must not make the global worker unready or block another user.

Cache one short-lived sponsor-organization policy snapshot as a map keyed by policy ID. Deduplicate concurrent refreshes and invalidate the cache after creation or revocation. A stale positive cache cannot bypass Turnkey because Turnkey still enforces the live policy when signing.

### Failure modes

| Failure | Test | Handling | User-visible result |
|---|---|---|---|
| Duplicate activation requests | PostgreSQL concurrency integration | One compare-and-set provisioning owner; no second create | One activation result |
| Turnkey create is denied | Adapter unit + credentialed test | Mark failed; plan remains inactive | Safe retry or configuration message |
| Turnkey create times out after submission | Integration fixture | Mark `provisioning_unknown`; never blind retry | Operator review required |
| Database commit fails after create | Integration fault injection | Revoke exact returned ID; retain unknown on cleanup failure | Plan stays inactive |
| Created policy body differs | Adapter unit + credentialed denial test | Revoke exact ID and fail activation | Restricted-policy verification error |
| Revocation fails during edit or cancel | PostgreSQL integration | Keep plan paused and preserve exact ID | Cleanup pending with retry |
| Two users execute concurrently | Executor integration | Validate each stored policy independently | Healthy user continues |
| Policy is externally revoked | Readiness + signer integration | Turnkey denies; pause only that plan | Reapproval required |
| Policy snapshot is stale | Cache unit test | Final Turnkey sign remains authoritative | No unsafe signature |
| Provisioner and signer keys match | Configuration unit test | Fail startup/readiness | Execution unavailable |

No new path may fail silently without both durable state and a safe user-facing reason.

### Test coverage

```text
CODE PATHS                                               USER FLOWS
[+] wallets/turnkey-policy                               [+] First activation
  ├── create + exact verify [UNIT + CREDENTIALED]          ├── success [INTEGRATION + E2E]
  ├── denied/pending/malformed result [UNIT]               ├── double click [E2E]
  ├── timeout before/after submission [UNIT]               └── Turnkey outage [E2E]
  └── revoke + verify absent [UNIT + CREDENTIALED]        [+] Edit and reapprove
[+] plans authorization lifecycle                          ├── stop before revoke [INTEGRATION]
  ├── pending → provisioning → active [INTEGRATION]        ├── failed cleanup + retry [E2E]
  ├── duplicate request and crash boundary [INTEGRATION]   └── replacement only after revoke [INTEGRATION]
  └── unknown creation reconciliation [INTEGRATION]      [+] Cancel
[+] readiness/executor                                     ├── successful cleanup [INTEGRATION + E2E]
  ├── global custody and balance [UNIT]                    └── failed cleanup remains paused [E2E]
  ├── exact per-mandate policy [UNIT + INTEGRATION]      [+] Multiple users
  ├── policy snapshot cache/invalidation [UNIT]            ├── independent policy validation [INTEGRATION]
  └── invalid user isolated [INTEGRATION]                  └── one invalid plan does not block another [INTEGRATION]
```

Required verification:

- `npm run verify`;
- `npm run test:integration -w @ohmyfund/api` against the dedicated test database;
- the recurring Playwright suite for loading, retry, and visible cleanup states;
- a credentialed disposable Turnkey test proving create, exact verification, denial cases, and exact revocation;
- a production-shaped dry run with `EXECUTION_ENABLED=false`;
- one separately approved capped proof only after every gate above passes.

### Implementation sequence

1. Add the migration and explicit sponsor-policy fields.
2. Add provisioner configuration and reject identical signer/provisioner keys.
3. Add `wallets/turnkey-policy.ts` for create, fetch, exact verification, revoke, normalized errors, and the short policy cache.
4. Add the private provisioning boundary using mandate IDs only and keep its credential out of the recurring worker environment.
5. Extend activation with durable provisioning states and exact-ID persistence.
6. Extend edit, reapproval, and cancellation with stop-first revocation and retry.
7. Split global readiness from plan-specific readiness and remove the one-active-plan assumption.
8. Add the complete unit, PostgreSQL, browser, and credentialed test matrix.
9. Update deployment configuration and durable infra documentation.
10. Deploy with both execution flags disabled, migrate, configure credentials, run gates, and request approval for the capped proof.

### Parallelization strategy

| Lane | Work | Depends on |
|---|---|---|
| A | Migration and persistence tests | — |
| B | Turnkey policy adapter and unit tests | — |
| C | Provisioning boundary and deployment secrets | Adapter interface |
| D | Plan lifecycle, readiness, and executor integration | A + B |
| E | Browser states and E2E | D API shape |

Launch lanes A and B in parallel. Start C after the adapter interface is fixed. Merge A, B, and C before D. Run E after the API state names are stable. `apps/api/src/plans.ts` and its integration suite remain one sequential lane to avoid conflicting state-machine edits.

### NOT in scope

- Changing the global token-account setup sponsor policy; it remains separate and reusable.
- Enabling execution or submitting the capped proof as part of this implementation.
- MoonPay, another wallet provider, or a generic policy-provider framework.
- A custom Solana enforcement program.
- Protection from full VPS root compromise; stronger isolation is a tracked follow-up.
- Multiple sponsor wallets or sponsor rotation.

### Implementation tasks

- [ ] **T11 (P1, human: ~4h / Codex: ~45min)** — persistence — Add per-mandate sponsor-policy identity and lifecycle fields.
  - Surfaced by: Architecture review — the global environment policy supports only one active mandate.
  - Files: `apps/api/sql/`, migration integration tests.
  - Verify: clean migration, upgrade migration, constraints, and no executable backfill.
- [ ] **T12 (P1, human: ~1d / Codex: ~2h)** — Turnkey adapter — Implement exact creation, verification, revocation, errors, and cache invalidation.
  - Surfaced by: Code quality and performance reviews — Turnkey calls are duplicated and per-occurrence policy listing will not scale.
  - Files: `apps/api/src/wallets/`, adapter unit tests.
  - Verify: complete adapter matrix plus disposable credentialed Turnkey checks.
- [ ] **T13 (P1, human: ~1d / Codex: ~2h)** — provisioning boundary — Isolate the policy credential from the recurring worker and accept mandate IDs only.
  - Surfaced by: Architecture review — storing both credentials in one process makes separation ineffective.
  - Files: API internal boundary, deployment configuration, secret provisioning scripts.
  - Verify: worker environment contains no provisioner key; raw policy input is rejected.
- [ ] **T14 (P1, human: ~1d / Codex: ~2h)** — authorization lifecycle — Provision once, persist exact identity, and fail closed across retries and crashes.
  - Surfaced by: Architecture review — a direct external call can leave duplicate or untracked policies.
  - Files: plan service and PostgreSQL integration tests.
  - Verify: success, duplicate, timeout, unknown, database failure, and cleanup cases.
- [ ] **T15 (P1, human: ~1d / Codex: ~2h)** — revocation lifecycle — Stop execution before exact sponsor-policy deletion and replacement.
  - Surfaced by: Architecture review — best-effort deletion leaves stale authority.
  - Files: plan transitions, API responses, web retry state, integration and E2E tests.
  - Verify: edit, reapproval, cancellation, outage, retry, and preserved audit history.
- [ ] **T16 (P1, human: ~6h / Codex: ~1h)** — readiness — Add global and per-mandate checks with isolated failures.
  - Surfaced by: Architecture review — current readiness rejects any active-plan count other than one.
  - Files: readiness, executor integration, readiness tests.
  - Verify: two active users, one invalid policy, healthy user still executes.
- [ ] **T17 (P1, human: ~1d / Codex: ~2h)** — verification — Complete local, PostgreSQL, browser, credentialed, and deployment-disabled checks.
  - Surfaced by: Test review — every new authority transition needs success and failure coverage.
  - Files: API/web test suites and durable deployment documentation.
  - Verify: all commands and gates in the Test coverage section.

### Review completion summary

- Step 0: Scope Challenge — full secure lifecycle accepted; stronger cross-host isolation deferred explicitly.
- Architecture Review: 5 issues resolved: credential boundary, persistence placement, durable activation, stop-first revocation, and per-plan readiness.
- Code Quality Review: 2 issues resolved: focused Turnkey adapter and reuse of paused state with a precise cleanup reason.
- Test Review: diagram produced; 19 new code and user-flow branches require coverage.
- Performance Review: 1 issue resolved: deduplicated short policy snapshot cache.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 1 security isolation item approved.
- Failure modes: 0 accepted silent critical gaps.
- Outside voice: nested Codex pass skipped because this session already runs under Codex.
- Parallelization: 5 lanes; persistence and adapter can begin in parallel, then converge on lifecycle work.
- Lake Score: 10/10 review decisions selected the recommended option; one controlled-launch security shortcut is explicitly tracked.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent second opinion | 0 | — | Nested pass skipped because this session runs under Codex |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 | CLEAR | Current pass resolved 9 issues and test gaps; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Backend-first delta; existing visible retry patterns reused |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement automatic sponsor-policy provisioning with execution disabled.

NO UNRESOLVED DECISIONS

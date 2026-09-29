# TODOS

Nợ sản phẩm dài hạn. Việc UI/UX đang xếp hàng để ship nằm ở [BACKLOG.md](BACKLOG.md).

## Local onboarding

### Complete the real Turnkey wallet smoke test

**What:** Register a machine-specific non-root Turnkey API credential, then verify local email sign-in, wallet binding, fund creation, persistence, and sign-out.

**Why:** Automated checks prove the local database and API paths, but only a real credential can prove the complete authenticated setup for a new machine.

**Context:** Deferred from `docs/plans/repository-cleanup.md` when the first clean repository version shipped. Generate the private key on the developer machine, register only its public key, and never reuse the deployed backend key.

**Effort:** S
**Priority:** P1
**Depends on:** Maintainer access to the OhMyFund Turnkey organization

## DCA execution

### Isolate Turnkey policy mutation from the main VPS

**What:** Move sponsor-policy creation and revocation to a separately trusted service or require Turnkey root/quorum approval for policy mutations before recurring buys expand beyond the controlled launch.

**Why:** The controlled-launch design separates the recurring signer and policy provisioner credentials, but a full compromise of the shared VPS could still reach both trust domains and change sponsor-wallet authority.

**Context:** Turnkey keeps the sponsor wallet private key inside Turnkey, while OhMyFund stores the API credentials that approve Turnkey activities. Turnkey policy conditions can target `CREATE_POLICIES` and `DELETE_POLICIES`, but policy contents and deleted policy IDs are not exposed through `activity.params`; the provisioner therefore remains powerful. During the controlled launch, keep the credentials in separate process environments, never pass raw policy text into the provisioner, regenerate policies from immutable mandates, reject identical signer and provisioner keys, keep a low sponsor SOL balance, and retain `EXECUTION_ENABLED=false` until the credentialed denial matrix passes. Revisit external isolation or root/quorum approval before adding users or increasing sponsor limits.

**Effort:** L
**Priority:** P1
**Depends on:** Automatic per-mandate sponsor-policy lifecycle in `docs/plans/sponsored-recurring-buys.md`

### Migrate setup transactions to Solana transaction v1

**What:** Move the atomic recurring-account setup transaction from v0 to v1 after the complete signing and policy stack supports v1.

**Why:** V1 raises the serialized transaction limit from 1,232 to 4,096 bytes and gives future setup changes more headroom. The current maximum eight-account setup already fits v0 at 1,125 bytes, so v1 is not required to ship.

**Context:** `@solana/kit` 8.3 can build v1 and the production RPC accepted a read-only v1 simulation. Before migration, prove that Turnkey user signing and sponsor policy parsing support v1, update the local transaction signature parser for signatures-at-the-tail, update readers to request `maxSupportedTransactionVersion: 1`, and add v1 wire-format tests. Keep Jupiter recurring swaps on v0 while they depend on address lookup tables because v1 does not support ALTs.

**Effort:** L
**Priority:** P2
**Depends on:** Shipped v0 recurring-account setup and confirmed Turnkey v1 transaction/policy support

### Validate the mandate policies before mainnet execution

**What:** Run credentialed allow and deny cases for the implemented user and sponsor mandate policies. Prove that wrong source, destination, mint, amount, payer, fee transfer, signer, and support instructions are denied. Then run the sponsored Jupiter build and Solana simulation without submitting it.

**Why:** Unit tests prove the generated policy text and application validator, but only Turnkey can prove how its live policy engine evaluates every expression.

**Context:** Production currently allows plan activation for one allowlisted test user but keeps `EXECUTION_ENABLED=false`. The worker also fails readiness unless the configured sponsor policy exactly matches the active mandate. Complete this external gate before the first explicitly approved capped mainnet proof, then disable execution again for receipt review.

**Effort:** L
**Priority:** P0
**Depends on:** Turnkey policy-language validation and a dedicated devnet credential

### Verify asset variants against the execution path

**What:** Verify selected Backpack Securities Token-2022 variants against the future swap, transfer, delegated-access, and receipt flow.

**Why:** Issuer trust alone does not prove that an asset works with the future purchase path.

**Context:** The execution path exists but remains disabled. Complete this verification with devnet test funds before production activation.

**Effort:** L
**Priority:** P2
**Depends on:** Approved DCA execution design

### Evaluate on-chain enforcement

**What:** Decide whether DCA execution needs a custom Solana program that enforces mandate cadence and cumulative spend independently of the backend.

**Why:** Turnkey policies are treated as stateless. They can restrict one transaction to approved mints, accounts, and amounts, but PostgreSQL currently enforces "once per scheduled occurrence." A fully compromised authorized backend credential could repeat an otherwise allowed transaction.

**Context:** Do not add a program for the controlled single-user launch. Re-evaluate before recurring buys expand beyond the allowlisted test cohort or before sponsor limits increase. Start from the versioned mandate, occurrence idempotency, sponsor-budget reservations, and exact Turnkey policy IDs described in `docs/plans/sponsored-recurring-buys.md`.

**Effort:** L
**Priority:** P2
**Depends on:** Working sponsored recurring-buy execution and an updated custody threat model

## Portfolio

### Fund value and gain/loss

**What:** Value each fund from its attributed holdings and show total value and gain/loss on Portfolio and fund detail.

**Why:** Portfolio is designed to lead with total value and gain/loss. Now that recurring buys can purchase assets, users need to see what their funds are worth.

**Context:** There is no fund-level valuation or cost basis yet. Until then the UI shows "Not available yet" and "—" rather than a made-up figure, per the trust rules in PRODUCT.md. Code TODOs mark the spots: `knownPortfolioTotal` in `apps/web/app/fund-types.ts`, the Gain / loss metric in `apps/web/app/portfolio.tsx`, and the value line in `apps/web/app/fund-detail.tsx`. Agreed with Yann on 2026-09-25 to handle this later.

**Effort:** M
**Priority:** P1
**Depends on:** Purchase attribution per fund and a price source for held assets

### Reconcile external wallet activity

**What:** Detect and reconcile wallet transfers or trades made outside OhMyFund.

**Why:** External activity can make fund attribution and PnL inaccurate.

**Context:** Version one should flag mismatches and hide affected PnL until reconciliation is trustworthy.

**Effort:** L
**Priority:** P2
**Depends on:** Reliable purchase attribution and transaction history

## Social funds

### Follow another manager's basket

**What:** Let a user subscribe to another manager's basket while keeping assets in the user's own wallet.

**Why:** This extends the leaderboard from snapshot copying to an ongoing strategy relationship.

**Context:** Future purchases may follow the manager's latest weights when the basket is mutable. Managers must never be able to withdraw subscriber assets.

**Effort:** XL
**Priority:** P3
**Depends on:** DCA execution and delegated-access policy

## Completed

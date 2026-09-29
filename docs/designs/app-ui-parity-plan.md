# Production UI parity with the approved HTML

Status: production code deployed 2026-09-18; authenticated fund/plan write smoke and connected-page visual QA remain open. Do not call this a public launch.

## Goal and reference

Make the deployed Next.js app follow the approved `docs/designs/simple.html` and the latest decisions in `DESIGN.md`. The latest shared screener style (Inter, neutral surfaces, compact divided rows) supersedes the older Coral/Geist direction. Use the prototype's hierarchy, interaction patterns, and responsive behavior. Do not copy its in-memory sample holdings, prices, P&L, receipts, or simulated connection into production.

The app still has no DCA execution. A saved plan is a draft, not an upcoming purchase. Real wallet SOL/USDC balances are separate from fund holdings. Without a purchase ledger, fund value, return, performance chart, actual allocation, and transaction receipts are unavailable. Preserve their layout hierarchy with truthful no-purchases states; do not substitute wallet balances or market snapshots.

## Page and feature map

```text
Persistent header: ohmyfund | Portfolio | Screener | Activity | Wallet
  Portfolio (home)
    1. Fund-holdings state, visually dominant; no invented value/return
    2. Your funds: compact rows and Create fund
    3. Wallet cash context and action-required messages, secondary
      └─ Fund detail: target basket → draft recurring buys → no-purchases state
  Screener: search → category pills → sortable results → variant detail
  Activity: purchase history when it exists; otherwise a clear empty state
  Wallet: address, real SOL/USDC balances, funding/copy help
```

The top three Portfolio facts are: what strategy value is known, which funds exist, and what the user can do next. Do not fill the missing-holdings area with a wallet balance, market snapshot, or a decorative card. When no purchases have occurred, say so plainly and give Create fund or Explore assets as the next action.

| Approved surface | Production gap | Target behavior now |
| --- | --- | --- |
| Shared shell | Portfolio and Activity only; no Screener link or wallet utility; style is partial | Portfolio · Screener · Activity nav, clear active state, shared Inter tokens, compact rows, mobile layout, Wallet utility with real address/balances and copy/funding help |
| Disconnected Portfolio | Generic marketing-like welcome and global notice | Approved quiet welcome with sign-in as primary action; no unavailable balance as hero; no fake sample data |
| Connected Portfolio | Title and wallet panel dominate; fund rows only show name and count | Stat-led portfolio area: no attributed holdings yet, return unavailable, no fake performance curve; create fund primary action; concise fund rows with target summary and draft-plan state; available USDC in Wallet utility, separate from strategy values |
| Fund detail | Target assets and draft plans only; hierarchy and next action differ | Name and status first, target basket, draft recurring buys, edit actions, no-purchases holdings state; preserve exact variant and issuer; no next-buy countdown or Pause while execution is absent |
| Screener | Not deployed | Implement `screener-integration-plan.md`: public categories, search, sort, pagination, detail/variants/charts, Add to fund draft |
| Activity | Bare empty panel | Approved page hierarchy and an honest no-purchases state; no sample receipts or transaction controls |
| Create/edit fund | Single modal with three-asset select; no optional plan step, no screener handoff | Approved two-step flow: choose name/assets/weights, then optional draft recurring buy; exact Tokens variant picker, Equal split, remaining/excess, inline validation, cancellation without mutation |
| Recurring buys | Create and cancel only; no edit | Draft list and create/edit/cancel with explicit Not active yet. Monthly spend may be an estimate, never an authorization cap. No Pause/Resume until plans can be active. |
| Archive and permanent lock | Prototype controls exist, production API has neither | Skip both in this release, as Yann decided. Do not show either control. Funds remain editable. |

## Interaction and state requirements

| Feature | Loading | Empty | Error | Success | Partial/stale |
| --- | --- | --- | --- | --- | --- |
| Portfolio | Stable shell and skeleton fund rows | “No funds yet” with Create fund; no holdings value inferred | Fund load fails: retry without signing out | Saved funds show target summaries and draft-plan labels | Balance data may be stale, labelled in Wallet; fund holdings stay unavailable |
| Fund detail | Name/shell stay visible while plans load | No draft plans: Add plan; no purchases: no holdings yet | Keep current fund visible and retry plans | Saved target weights and draft plans | Version conflict retains edit form and explains reload |
| Screener | Search/category controls stay visible; table skeleton | No matches: clear search | Retry with saved snapshot/error label | Detail shows selected exact variant | Stale source time; absent chart/price shown as unavailable |
| Activity | Stable heading | No purchases yet; link back to funds | Retry if history endpoint later exists | Receipts only after real execution | No simulated partial/failed receipt in this release |
| Wallet | Address stays visible while balances load | Zero SOL/USDC is a real zero, with funding guidance | RPC failure says unavailable and offers Refresh | Copy confirms, balances show retrieval time | Old balance labelled stale, not presented as current |
| Fund/plan form | Save disabled with progress | No selection: prompt asset choice | Field errors beside inputs; preserve values | Close only after server confirms save | If fund save succeeds but optional plan save fails, show saved fund and retry-plan action |

- Keep public screener browsing available without Turnkey. From Add to fund, preserve the exact asset/variant selection through sign-in and open a reviewable draft; no saved fund changes before Save.
- The create flow can save a fund without a plan. If the user elects a plan, save the fund first, then the draft plan; if the second request fails, keep the fund and show a clear retry path. Never imply the whole operation rolled back if it did not.
- Plan editing needs a protected `PUT /api/plans/:id` with `expectedRevision`; validate the same amount/cadence/timezone rules as creation, allow only the owning user to edit a `draft`, and return 409 on a stale or cancelled plan. Keep Cancel as a separate terminal action. Display cancelled plans only in a labelled history/disclosure, not among editable drafts.
- Existing fund edits send the complete asset set and expected version in one PostgreSQL transaction. A version conflict preserves the form and asks the user to reload/review. Existing draft plans survive composition edits.
- Opening a different fund while a plan request is pending must not attach the earlier fund's plans to the new fund. Key/abort the request or check the selected fund ID before applying its response. Sign-out clears private state.
- No-fund, no-plan, no-purchase, zero wallet balance, stale balance, API failure, expired session, invalid form, duplicate variant, eight-asset limit, and long fund-name states have clear copy and recovery actions.
- Wallet address copy has explicit success/error feedback. No withdrawal action, automation permission, next purchase, or active schedule control appears until the underlying capability exists.
- No Archive or permanent-lock control appears in this release. Do not implement a visual-only version of either feature.
- Load the full Tokens asset picker only when create/edit opens, with search by asset, symbol, and issuer. Do not render a 641-option native select in every row on Portfolio load. Selecting a different issuer updates the exact variant ID together with its displayed name and mint metadata.

## Visual and responsive contract

- Use `tokens.css` and the latest `DESIGN.md` section titled “Shared screener style” as source of truth. Self-host Inter in Next.js. `#fafafa` canvas, white panels, `#202124` ink, `#63666d` secondary text, `#e3e5e8` dividers; 18px panels, 8px inputs/buttons, pill navigation. No older coral accents or shadow-heavy card grid.
- Portfolio balance/holdings state is the visual anchor, with fund rows next. Wallet balance is available but secondary. Fund detail keeps its first viewport focused on the fund's next useful action, not technical IDs.
- Match the prototype at 320, 375, 414, 768px, and desktop. No horizontal page scroll. Visible 44px targets, 48px form controls, keyboard and screen-reader semantics, focus return from dialogs, and reduced-motion support.
- On desktop, keep the 1040px content measure and horizontal fund rows. At 768px, keep the three main nav items visible and reduce gutters. At 320–414px, place navigation on its own row, keep Wallet reachable, stack each fund row as identity then draft-plan status, and keep Create fund full-width only where space requires. Never hide a primary action behind hover or a menu.
- Forms have persistent labels, error text connected to the field, and an announced allocation total. Dialogs trap focus, close with Escape, and return focus to the invoking control. Do not rely on green/red alone for financial change. Text contrast must be at least 4.5:1. Current navigation uses `aria-current="page"`.
- Capture paired reference/prod screenshots for each page and main state. Compare structure, spacing, typography, hierarchy, and interactions, not just colors.

## User journey

| Step | User does | What the screen must communicate |
| --- | --- | --- |
| First visit | Lands on Portfolio without a session | “This is my personal fund app; sign-in creates access to my wallet.” No fake holdings or demand to fund first. |
| Finds assets | Opens public Screener | “I can compare saved token snapshots without connecting; prices are dated and not a buy quote.” |
| Starts a basket | Chooses a variant and signs in | “My exact selected token was kept; nothing was bought or saved yet.” |
| Saves a fund | Reviews weights and optional draft plan | “The basket is saved; the recurring buy is not active.” If plan save fails, the fund remains saved and recovery is clear. |
| Returns later | Opens Portfolio and fund detail | “My target strategy and drafts are here; wallet cash and actual fund holdings are different things.” |

The first five seconds should identify the product, current state, and one next action. The first five minutes should let a user create a fund without guessing how weights work. Over time, honest labels must keep trust when execution and holdings are added later.

## Build sequence

1. Establish a page/state inventory and reference screenshots from the HTML prototype and current production. Mark execution-only/sample-only elements explicitly.
2. Extract the shared shell and visual tokens, then repair disconnected/connected Portfolio, fund rows, Wallet utility, Fund detail, and Activity. Keep existing API contracts working.
3. Implement the approved Screener integration plan and exact-variant Add to fund handoff.
4. Rebuild create/edit as the approved two-step form and add draft-plan editing. Leave archive and permanent lock out of this release.
5. Add unit/integration tests for state and validation branches, Playwright flows for pages and dialogs, and responsive/keyboard visual QA. Deploy backward-compatible API changes to the VPS first, verify preview, then promote web to `release` and smoke production.

The new plan-edit endpoint and full catalog API deploy before the new web UI. Existing web requests must keep working during that interval. The draft edit uses the existing `dca_plans.revision` and `updated_at` columns, so no new database column is needed. If migrations become necessary during implementation, use an expand-only migration and verify a backup before applying it.

## What already exists

- `DESIGN.md` and the HTML/CSS/JS prototype define the approved navigation, hierarchy, typography, interaction patterns, and sample-only boundaries. The prototype's sample data is not production data.
- The production app already has Turnkey login, real wallet address/balance reads, fund creation and versioned full-set replacement, and draft-plan creation/cancellation. These should be restyled and extended, not rebuilt.
- The separate screener integration plan defines catalog authority, public reads, and exact-variant Add to fund. This plan owns the shared shell and cross-page parity; avoid duplicating screener data logic.

## Implementation tasks

- [ ] **T1 (P1, human ~4h / agent-assisted ~1h):** Match the shared shell, Portfolio, Wallet, and fund-row hierarchy to the live HTML reference while preserving honest no-holdings states. Verify desktop and 320/375/414/768px screenshots.
- [ ] **T2 (P1, human ~4h / agent-assisted ~1h):** Match Fund detail and Activity, with draft-only recurring buys and real empty/error states. Verify plan loading and no-purchases copy.
- [ ] **T3 (P1, human ~5h / agent-assisted ~90m):** Rebuild create/edit as the two-step flow with searchable exact-variant selection, Equal split, inline allocation feedback, and optional draft plan. Verify failures preserve entered values and partial fund/plan save is explained.
- [ ] **T4 (P1, human ~1d / agent-assisted ~3h):** Implement `screener-integration-plan.md` and Add to fund handoff. Public browse, exact variants, and pre-login selection preservation are production-verified; authenticated save remains.
- [ ] **T5 (P1, human ~3h / agent-assisted ~45m):** Add revision-checked draft-plan editing to API/contracts/UI. Verify ownership, cancelled-plan rejection, two-tab conflict, and request-race isolation when switching funds.
- [ ] **T6 (P1, human ~4h / agent-assisted ~1h):** Add API/UI/E2E tests and paired visual QA, then release API-first to the VPS and promote Vercel after preview smoke. Verify no fake financial values or execution controls reach production.

## NOT in scope

- Fake portfolio holdings, returns, charts, or receipts to match the prototype's sample mode.
- DCA execution, swaps, delegated backend signing, active schedules, Pause/Resume, or next-purchase funding forecasts.
- Public manager subscriptions, watchlists, or new discovery categories beyond the approved Tokens catalog.
- Archive and permanent composition lock. Yann explicitly deferred both on 2026-09-18; neither is needed for the no-execution MVP.

## Resolved scope decision

The HTML includes archive and permanent composition lock, but Yann chose to skip both for this release. Keep the approved visual hierarchy without those controls. The previous two-day backend deferment remains in force.

## Engineering review notes

- **Architecture:** Reuse the current one-repo Next.js/API/PostgreSQL split. Screener reads are public and paged; fund and plan writes remain session/CSRF protected. No new service or on-chain program.
- **Code quality:** Extract a shared catalog lookup and form state where needed. Do not port the prototype's global variables, sample fixture, or direct DOM handlers into React. Keep plan create/edit validation in one shared schema.
- **Tests:** Add API tests for exact catalog pairs and mint aliases, plan ownership/revision, atomic fund replacement, and public/private route separation. Add browser tests for all three pages, wallet utility, modal focus, optional-plan partial save, sign-in return, stale form conflict, and mobile widths. Existing Vitest tests cover only contracts/API; add a production browser test path rather than treating prototype scripts as E2E.
- **Performance:** Fetch only a page of screener rows, lazy-load charts/details, and fetch the lightweight full picker only when the editor opens. Do not load the raw 2 MB snapshot on Portfolio.
- **Failure modes:** A failed plan save after fund save leaves the fund intact and offers Retry plan. A stale plan edit returns 409 and preserves the form. A slow response from a previously selected fund cannot replace the current fund's plans. Catalog identity failure blocks the new API image at startup rather than allowing invalid writes.
- **Release:** API first, then preview, then production web. Keep old-web/new-API compatibility. No schema reversal is needed for rollback if no migration lands.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Design Review | `/plan-design-review` | Page hierarchy, states, journey, style, responsive behavior | 1 | CLEAR for this plan | Existing HTML is the fixed visual reference; honest no-execution states and archive/lock scope resolved |
| Eng Review | `/plan-eng-review` | API boundaries, writes, tests, release order | 1 | CLEAR for this plan | Plan edit revision, partial create/save, request race, catalog loading, and API-first release specified |

**VERDICT:** Design and engineering plan ready to implement. The approved HTML is the visual reference; no new mockup direction was generated.

NO UNRESOLVED DECISIONS

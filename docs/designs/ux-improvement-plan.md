# UI/UX improvement plan

Status: applied on 2026-09-15. Scope: one focused pass on the existing prototype.

## Goal

Users should quickly understand what they own, what will happen next, and whether they need to act. Keep Portfolio, Fund detail, and Activity. Preserve one wallet, multiple baskets, and multiple schedules per basket.

## 1. Make the overview useful

- Add two explicitly labelled preview scenarios: disconnected and sample portfolio. Keep the scenario selector in the design-preview banner, outside product navigation. All sample financial figures must be labelled illustrative.
- Disconnected: show Connect wallet as the primary action and a short explanation. Do not make an unavailable balance the dominant element. After connection, the first-fund state leads to Create fund; funding becomes the next action when needed.
- Sample portfolio: show total fund value, estimated unrealized return in dollars and percent, available USDC separately, and the next scheduled purchase across all funds.
- Show actual asset distribution in a compact list with percentages. Keep target weights on fund detail and label them explicitly; never present target weights as current holdings.
- Fund rows show value, next purchase, and active/paused plan counts. Display missing values as unavailable, not zero.
- Derive sample totals, returns, and allocation from one internally consistent fixture. Exclude available cash from fund return and distribution calculations; label the distribution as invested assets.

Acceptance: a user can find value, return, allocation, next purchase, and available cash without opening settings. Sample data cannot be mistaken for live wallet data.

## 2. Put upcoming purchases first on fund detail

- Order content: fund name → value and return → next purchase and funding status → recurring buys → holdings and target basket → advanced settings.
- Place Pause on the relevant next-plan summary. Label its scope as pausing that plan, not every plan in the fund. Keep all other plans reachable in the recurring-buy list.
- Show the next purchase in local time with a timezone label. Use the earliest active schedule; do not assume the first stored plan is next.
- For the shared wallet, assess available cash against upcoming scheduled commitments in execution order. If cash is short, identify the affected purchase and show Add USDC. Do not imply each fund has reserved cash.
- Show actual holdings and target weights with clear labels. Preserve the explanation that edits affect future buys and do not rebalance existing holdings.

Acceptance: at 375×812, the next purchase and its Pause action appear in the first viewport. A paused-only fund clearly shows no upcoming purchase. Multiple schedules remain supported.

## 3. Make basket creation easier

- Use direct headings: Choose assets and Set recurring buy.
- Label allocation inputs Weight (%).
- Add Equal split. Calculate in basis points and distribute rounding remainders deterministically so the total is exactly 100%.
- Show Remaining: 20% or Over by 5% while editing. Keep manual weights intact when assets are added or removed; users choose Equal split when wanted.
- Keep validation beside the allocation inputs and focus the relevant field or group on failure. Avoid byte-count language in the name error; say the name is too long.
- Keep optional recurring buys and permanent composition locking in their existing places. Preserve explicit confirmation before permanent locking.

Acceptance: users can build a three-asset basket without arithmetic. Test equal splits for one, two, and three assets, removal, duplicate selection, and an invalid total.

## 4. Repair summaries and action feedback

- Render purchase summaries from the current form values on open, reset, back, and every amount/frequency change.
- Include the first purchase time and an estimated monthly spend in schedule review. Label the estimate and its convention (daily × 30; weekly × 52 ÷ 12), not a spending cap.
- Confirm Archive with the fund name and consequence: stop future purchases; keep holdings and history. Keep archived records in state rather than deleting them. Show a visible result with a route to retained holdings/history. Financial totals must continue to include held assets from archived funds.
- For pause/resume, update only the intended plan and keep keyboard focus stable. Explain that a transaction already submitted may still finish in the production flow.

Acceptance: reopening after a 50-USDC weekly entry shows matching default fields and summary. Cancelling archive changes nothing. Confirming archive stops schedules without removing asset value or history.

## 5. Verify the complete pass

- Inspect desktop and 320/375/414/768px layouts with /browse.
- Walk through disconnected → first basket → recurring buy → funded sample overview → pause/resume → archive.
- Check keyboard navigation, dialog focus and Escape, visible validation, 44px touch targets, text contrast, and long fund names.
- Add narrow regression checks for stale summaries, equal-split rounding, and archive retaining holdings. Reuse an existing test setup if present; avoid introducing a large test framework for this prototype.
- Capture before/after screenshots. Update DESIGN.md and design-check.md to match the result and remaining prototype limits.

## Timebox and priorities

Target one half-day of the two-day hackathon, including verification. Implement in the order above. If time runs short, defer monthly-spend estimates and visual polish; keep the summary fix, archive correctness, financial labels, and mobile purchase controls.

This pass changes the design prototype only. Privy authorization, real balances, scheduler execution, transaction states, and persistence remain application implementation work. Subscriptions and Token-2022 behavior checks remain deferred as agreed.

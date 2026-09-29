import { expect, test } from '@playwright/test';

const fundId = '22222222-2222-4222-8222-222222222222';
const planId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-09-22T00:00:00.000Z').toISOString();
const fund = { id: fundId, name: 'Long term', version: 1, assets: [{ assetId: 'solana', variantId: 'solana:wSOL', weightBps: 5000 }, { assetId: 'apple', variantId: 'apple:xStock', weightBps: 5000 }], publication: null, createdAt: now, updatedAt: now };
const activePlan = { id: planId, fundId, amountAtomic: '10000000', cadence: 'daily', localTime: '09:00', timezone: 'UTC', weekday: null, status: 'active' as string, revision: 2, nextRunAt: '2026-09-23T09:00:00.000Z' as string | null, pauseReason: null as string | null, pauseCode: null as string | null, feeBps: 75, slippageBps: 100, createdAt: now };
let currentPlan = activePlan;
let payments: Record<string, unknown>[] = [];

test.beforeEach(async ({ page }) => {
  currentPlan = activePlan;
  payments = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/session') return route.fulfill({ json: { user: { id: '44444444-4444-4444-8444-444444444444', address: '11111111111111111111111111111111', organizationId: '11111111-1111-4111-8111-111111111111' }, csrfToken: 'csrf' } });
    if (path === '/api/funds') return route.fulfill({ json: { funds: [fund] } });
    if (path === '/api/balances') return route.fulfill({ json: { address: '11111111111111111111111111111111', cluster: 'devnet', solLamports: '0', usdcAtomic: '50000000', retrievedAt: now } });
    if (path === '/api/recurring/configuration') return route.fulfill({ json: { available: true, executionEnabled: true, feeBps: 75, defaultSlippageBps: 100, delegatedPublicKey: `02${'1'.repeat(64)}`, feeAccount: 'So11111111111111111111111111111111111111112', maxOccurrenceAtomic: '10000000', unavailableReason: null } });
    if (path === '/api/assets') return route.fulfill({ json: { assets: [{ ...fund.assets[0], symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', kind: 'crypto' }, { ...fund.assets[1], symbol: 'AAPLx', name: 'Apple', mint: '11111111111111111111111111111111', kind: 'equity' }] } });
    if (path === `/api/funds/${fundId}/plans`) return route.fulfill({ json: { plans: [currentPlan] } });
    if (path === `/api/funds/${fundId}/activity`) return route.fulfill({ json: { edits: [], payments } });
    if (path === `/api/plans/${planId}/authorization`) return route.fulfill({ json: { delegatedUserId: null, policyIds: [], policyFingerprint: null } });
    if (path === `/api/plans/${planId}/pause`) {
      currentPlan = { ...currentPlan, status: 'paused', revision: currentPlan.revision + 1, nextRunAt: null, pauseReason: 'Paused by user.', pauseCode: 'user' };
      return route.fulfill({ json: currentPlan });
    }
    if (path === `/api/plans/${planId}/resume`) {
      currentPlan = { ...currentPlan, status: 'active', revision: currentPlan.revision + 1, nextRunAt: '2026-09-24T09:00:00.000Z', pauseReason: null, pauseCode: null };
      return route.fulfill({ json: currentPlan });
    }
    if (path === `/api/plans/${planId}/cancel`) {
      currentPlan = { ...currentPlan, status: 'cancelled', revision: currentPlan.revision + 1, nextRunAt: null, pauseReason: null, pauseCode: null };
      return route.fulfill({ json: currentPlan });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked' } } });
  });
});

test('shows active state and pauses one plan with an idempotency key', async ({ page }) => {
  let pauseRequests = 0;
  page.on('request', request => { if (request.url().endsWith(`/api/plans/${planId}/pause`)) { pauseRequests++; expect(request.headers()['idempotency-key']).toBeTruthy(); } });
  await page.goto('/');
  await page.getByRole('button', { name: /Long term/ }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByText('Paused by user.')).toBeVisible();
  expect(pauseRequests).toBe(1);
});

test('resumes a user-paused plan and then keeps its cancellation in history', async ({ page }) => {
  currentPlan = { ...activePlan, status: 'paused', revision: 3, nextRunAt: null, pauseReason: 'Paused by user.', pauseCode: 'user' };
  const actionKeys: string[] = [];
  page.on('request', request => {
    if (/\/api\/plans\/[^/]+\/(resume|cancel)$/.test(new URL(request.url()).pathname)) actionKeys.push(request.headers()['idempotency-key']);
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Long term/ }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('1 cancelled plan', { exact: true })).toBeVisible();
  expect(actionKeys).toHaveLength(2);
  expect(actionKeys.every(Boolean)).toBe(true);
});

test('offers a clickable reapproval action after an execution failure', async ({ page }) => {
  currentPlan = { ...activePlan, status: 'paused', revision: 3, nextRunAt: null, pauseReason: 'The previous execution failed.', pauseCode: 'execution_failure' };
  await page.goto('/');
  await page.getByRole('button', { name: /Long term/ }).click();
  const reapprove = page.getByRole('button', { name: 'Reapprove', exact: true });
  await expect(reapprove).toBeVisible();
  await expect(reapprove).toBeEnabled();
  await reapprove.click();
  await expect(page.getByText('Reconnect your Turnkey wallet to approve recurring buys, then retry.', { exact: true })).toBeVisible();
});

test('explains zero-SOL sponsorship and shows the confirmed fee receipt', async ({ page }) => {
  payments = [{ id: '55555555-5555-4555-8555-555555555555', signature: 'signature', amountAtomic: '10000000', investedAtomic: '9910000', feeAtomic: '90000', profitFeeAtomic: '75000', infrastructureFeeAtomic: '15000', sponsoredLamports: '150000', ataCreated: true, outputAtomic: '123000000', outputDecimals: 8, outputMint: 'So11111111111111111111111111111111111111112', status: 'confirmed', occurredAt: now }];
  await page.goto('/');
  await page.getByRole('button', { name: /Long term/ }).click();
  await expect(page.getByText(/You do not need SOL/)).toBeVisible();
  await page.getByRole('tab', { name: 'Recurring payments' }).click();
  await expect(page.getByText(/OhMyFund fee 0.075 USDC/)).toBeVisible();
  await expect(page.getByText(/Network reimbursement 0.015 USDC/)).toBeVisible();
});

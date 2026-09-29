import { afterAll, beforeEach, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const publishFund = vi.fn();
const unpublishFund = vi.fn();
const copyPublicFund = vi.fn();
const preparePlan = vi.fn();
const authorizePlan = vi.fn();
const prepareAuthorizationCleanup = vi.fn();
const pausePlan = vi.fn();
const prepareAccountSetup = vi.fn();
const submitAccountSetup = vi.fn();
const getAccountSetup = vi.fn();
class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); }
}
vi.mock('./config.js', () => ({ config: { port: 4310, webOrigins: new Set(['http://localhost:3000']), trustedProxySecret: 'proxy-secret' } }));
vi.mock('./db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('./catalog.js', () => ({ approvedAssets: [], catalog: [] }));
vi.mock('./auth.js', () => ({
  ApiFailure,
  bindWallet: vi.fn(),
  bindTurnkeySession: vi.fn(),
  checkHost: vi.fn(),
  checkOrigin: vi.fn(),
  createChallenge: vi.fn(),
  logout: vi.fn(),
  requireSession: vi.fn(async (request: { headers: Record<string, string | string[] | undefined> }, csrf = false) => {
    if (request.headers['x-test-session'] !== 'valid') throw new ApiFailure(401, 'UNAUTHORIZED', 'Connect your wallet to continue.');
    if (csrf && request.headers['x-csrf-token'] !== 'csrf') throw new ApiFailure(403, 'FORBIDDEN', 'Refresh and try again.');
    return { userId: '00000000-0000-4000-8000-000000000001', address: 'wallet', organizationId: 'org', csrfToken: 'csrf' };
  })
}));
vi.mock('./funds.js', () => ({ createFund: vi.fn(), getFund: vi.fn(), listFundActivity: vi.fn(), listFunds: vi.fn(), replaceFund: vi.fn() }));
vi.mock('./plans.js', () => ({ authorizePlan, cancelPlan: vi.fn(), createAuthorizationIntent: vi.fn(), createPlan: vi.fn(), getPlanAuthorization: vi.fn(), listPlanOccurrences: vi.fn(), listPlans: vi.fn(), pausePlan, prepareAuthorizationCleanup, preparePlan, recurringConfiguration: vi.fn(() => ({ available: false })), resumePlan: vi.fn(), updatePlan: vi.fn() }));
vi.mock('./recurring/setup.js', () => ({ prepareAccountSetup, submitAccountSetup, getAccountSetup }));
vi.mock('./balances.js', () => ({ getBalances: vi.fn() }));
vi.mock('./screener.js', () => ({ listScreener: vi.fn(), screenerDetail: vi.fn() }));
vi.mock('./public-funds.js', () => ({ copyPublicFund, getPublicFund: vi.fn(), listPublicFunds: vi.fn(), publishFund, unpublishFund }));

const { app, clientIp, resetRateLimitsForTest } = await import('./server.js');
const fundId = '00000000-0000-4000-8000-000000000002';
const publicId = '00000000-0000-4000-8000-000000000003';
const requestKey = '00000000-0000-4000-8000-000000000004';
const authHeaders = { origin: 'http://localhost:3000', 'x-test-session': 'valid', 'x-csrf-token': 'csrf' };

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitsForTest();
  publishFund.mockResolvedValue({ firstPublication: true, publication: { publicId, publisherName: 'Yann', publishedAt: new Date().toISOString() } });
  unpublishFund.mockResolvedValue({ ok: true });
  copyPublicFund.mockResolvedValue({ fund: { id: fundId }, sourceVersion: 1, alreadyCopied: false });
  preparePlan.mockResolvedValue({ ok: true });
  authorizePlan.mockResolvedValue({ ok: true });
  prepareAuthorizationCleanup.mockResolvedValue(undefined);
  pausePlan.mockResolvedValue({ ok: true });
  prepareAccountSetup.mockResolvedValue({ ok: true });
  submitAccountSetup.mockResolvedValue({ ok: true });
  getAccountSetup.mockResolvedValue({ ok: true });
});

afterAll(async () => { await app.close(); });

it('requires authentication and CSRF for publication writes', async () => {
  const unauthenticated = await app.inject({ method: 'POST', url: `/api/funds/${fundId}/publish`, headers: { origin: authHeaders.origin }, payload: { publisherName: 'Yann' } });
  expect(unauthenticated.statusCode).toBe(401);
  const noCsrf = await app.inject({ method: 'POST', url: `/api/funds/${fundId}/publish`, headers: { origin: authHeaders.origin, 'x-test-session': 'valid' }, payload: { publisherName: 'Yann' } });
  expect(noCsrf.statusCode).toBe(403);
});

it('rejects private API requests from any other origin', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/funds', headers: { origin: 'https://preview.ohmyfund.example' } });
  expect(response.statusCode).toBe(403);
});

it('accepts the configured referer when Origin is absent', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/funds', headers: { referer: 'http://localhost:3000/portfolio' } });
  expect(response.statusCode).toBe(401);
});

it('rejects private API requests with no valid site header', async () => {
  const missing = await app.inject({ method: 'GET', url: '/api/funds' });
  expect(missing.statusCode).toBe(403);
  const malformed = await app.inject({ method: 'GET', url: '/api/funds', headers: { referer: 'not-a-url' } });
  expect(malformed.statusCode).toBe(403);
});

it('uses authenticated visitor IPs and ignores forged visitor headers', async () => {
  expect(clientIp({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20', 'x-ohmyfund-client-ip': '203.0.113.10', 'x-ohmyfund-proxy-secret': 'proxy-secret' } as never })).toBe('203.0.113.10');
  expect(clientIp({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20', 'x-ohmyfund-client-ip': '192.0.2.99', 'x-ohmyfund-proxy-secret': 'wrong-secret' } as never })).toBe('127.0.0.1');
});

it('keeps auth limits separate for visitors behind one Vercel egress', async () => {
  for (let index = 0; index < 11; index++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: authHeaders.origin, 'x-forwarded-for': '203.0.113.10, 198.51.100.20', 'x-ohmyfund-client-ip': `203.0.113.${index + 1}`, 'x-ohmyfund-proxy-secret': 'proxy-secret' }, payload: { address: `${String(index).padStart(2, '0')}${'A'.repeat(30)}` } });
    expect(response.statusCode).toBe(200);
  }
});

it('blocks repeated auth and public requests within their separate buckets', async () => {
  const address = `99${'B'.repeat(30)}`;
  for (let index = 0; index < 10; index++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: authHeaders.origin, 'x-forwarded-for': '198.51.100.30' }, payload: { address } });
    expect(response.statusCode).toBe(200);
  }
  const blockedAuth = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: authHeaders.origin, 'x-forwarded-for': '198.51.100.30' }, payload: { address } });
  expect(blockedAuth.statusCode).toBe(429);

  for (let index = 0; index < 120; index++) {
    const response = await app.inject({ method: 'GET', url: '/api/public/funds', headers: { 'x-vercel-forwarded-for': '203.0.113.50' } });
    expect(response.statusCode).toBe(200);
  }
  const blockedPublic = await app.inject({ method: 'GET', url: '/api/public/funds', headers: { 'x-vercel-forwarded-for': '203.0.113.50' } });
  expect(blockedPublic.statusCode).toBe(429);
});

it('blocks one proxy that rotates through many wallet addresses', async () => {
  for (let index = 0; index < 1_000; index++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: authHeaders.origin, 'x-forwarded-for': '198.51.100.40' }, payload: { address: `${String(index).padStart(4, '0')}${'C'.repeat(28)}` } });
    expect(response.statusCode).toBe(200);
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: authHeaders.origin, 'x-forwarded-for': '198.51.100.40' }, payload: { address: `${'D'.repeat(32)}` } });
  expect(blocked.statusCode).toBe(429);
});

it('requires authentication and CSRF for copy and unpublish writes', async () => {
  const requests = [
    { method: 'DELETE' as const, url: `/api/funds/${fundId}/publish` },
    { method: 'POST' as const, url: `/api/public/funds/${publicId}/copy`, headers: { 'idempotency-key': requestKey }, payload: { name: 'Copy' } }
  ];
  for (const request of requests) {
    const unauthenticated = await app.inject({ ...request, headers: { origin: authHeaders.origin, ...request.headers } });
    expect(unauthenticated.statusCode).toBe(401);
    const noCsrf = await app.inject({ ...request, headers: { origin: authHeaders.origin, 'x-test-session': 'valid', ...request.headers } });
    expect(noCsrf.statusCode).toBe(403);
  }
});

it('returns 201 for first publication and 200 for republishing', async () => {
  const first = await app.inject({ method: 'POST', url: `/api/funds/${fundId}/publish`, headers: authHeaders, payload: { publisherName: 'Yann' } });
  expect(first.statusCode).toBe(201);
  publishFund.mockResolvedValueOnce({ firstPublication: false, publication: { publicId, publisherName: 'Yann', publishedAt: new Date().toISOString() } });
  const repeated = await app.inject({ method: 'POST', url: `/api/funds/${fundId}/publish`, headers: authHeaders, payload: { publisherName: 'Yann' } });
  expect(repeated.statusCode).toBe(200);
});

it('rejects invalid copy route IDs, names, and idempotency keys', async () => {
  const invalidPublicId = await app.inject({ method: 'POST', url: '/api/public/funds/not-a-uuid/copy', headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { name: 'Copy' } });
  expect(invalidPublicId.statusCode).toBe(400);
  const invalidKey = await app.inject({ method: 'POST', url: `/api/public/funds/${publicId}/copy`, headers: { ...authHeaders, 'idempotency-key': 'bad' }, payload: { name: 'Copy' } });
  expect(invalidKey.statusCode).toBe(400);
  const invalidName = await app.inject({ method: 'POST', url: `/api/public/funds/${publicId}/copy`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { name: '' } });
  expect(invalidName.statusCode).toBe(400);
  expect(copyPublicFund).not.toHaveBeenCalled();
});

it('passes a validated idempotency key through the copy route', async () => {
  const response = await app.inject({ method: 'POST', url: `/api/public/funds/${publicId}/copy`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { name: 'Trusted copy' } });
  expect(response.statusCode).toBe(200);
  expect(copyPublicFund).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', publicId, 'Trusted copy', requestKey);
});

it('passes an authenticated unpublish request to the service', async () => {
  const response = await app.inject({ method: 'DELETE', url: `/api/funds/${fundId}/publish`, headers: authHeaders });
  expect(response.statusCode).toBe(200);
  expect(unpublishFund).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', fundId);
});

it('requires CSRF and a valid idempotency key for recurring actions', async () => {
  const noCsrf = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/prepare`, headers: { origin: authHeaders.origin, 'x-test-session': 'valid', 'idempotency-key': requestKey }, payload: { expectedRevision: 1 } });
  expect(noCsrf.statusCode).toBe(403);
  const badKey = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/prepare`, headers: { ...authHeaders, 'idempotency-key': 'bad' }, payload: { expectedRevision: 1 } });
  expect(badKey.statusCode).toBe(400);
  expect(preparePlan).not.toHaveBeenCalled();
});

it('passes validated recurring actions to the service', async () => {
  const response = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/pause`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { expectedRevision: 2 } });
  expect(response.statusCode).toBe(200);
  expect(pausePlan).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', fundId, 2, requestKey);
});

it('rejects stale recurring clients before recording authorization', async () => {
  const authorization = { expectedRevision: 2, delegatedUserId: publicId, policyIds: [requestKey], policyFingerprint: 'a'.repeat(64) };
  const stale = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/authorize`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: authorization });
  expect(stale.statusCode).toBe(400);
  expect(authorizePlan).not.toHaveBeenCalled();

  const current = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/authorize`, headers: { ...authHeaders, 'idempotency-key': requestKey },
    payload: { ...authorization, policyVersion: 'recurring-mandate-v2' } });
  expect(current.statusCode).toBe(200);
  expect(authorizePlan).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'org', fundId,
    { ...authorization, policyVersion: 'recurring-mandate-v2' }, requestKey);
});

it('cleans up both recurring authorization policies before reapproval', async () => {
  const noCsrf = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/authorization/cleanup`, headers: { origin: authHeaders.origin, 'x-test-session': 'valid' } });
  expect(noCsrf.statusCode).toBe(403);
  expect(prepareAuthorizationCleanup).not.toHaveBeenCalled();

  const response = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/authorization/cleanup`, headers: authHeaders, payload: {} });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(prepareAuthorizationCleanup).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', { planId: fundId });
});

it('requires CSRF and valid input for account setup writes', async () => {
  const noCsrf = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/setup/prepare`, headers: { origin: authHeaders.origin, 'x-test-session': 'valid', 'idempotency-key': requestKey }, payload: { expectedRevision: 1 } });
  expect(noCsrf.statusCode).toBe(403);
  const badTransaction = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/setup/submit`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { expectedRevision: 1, attemptId: publicId, userSignedTransactionHex: 'not-hex' } });
  expect(badTransaction.statusCode).toBe(400);
  expect(prepareAccountSetup).not.toHaveBeenCalled();
  expect(submitAccountSetup).not.toHaveBeenCalled();
});

it('passes validated account setup requests to the service', async () => {
  const prepared = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/setup/prepare`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { expectedRevision: 3 } });
  expect(prepared.statusCode).toBe(200);
  expect(prepareAccountSetup).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', fundId, 3, requestKey);

  const submitted = await app.inject({ method: 'POST', url: `/api/plans/${fundId}/setup/submit`, headers: { ...authHeaders, 'idempotency-key': requestKey }, payload: { expectedRevision: 3, attemptId: publicId, userSignedTransactionHex: '00aa' } });
  expect(submitted.statusCode).toBe(200);
  expect(submitAccountSetup).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', fundId, { expectedRevision: 3, attemptId: publicId, userSignedTransactionHex: '00aa' }, requestKey);

  const status = await app.inject({ method: 'GET', url: `/api/plans/${fundId}/setup`, headers: authHeaders });
  expect(status.statusCode).toBe(200);
  expect(getAccountSetup).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', fundId);
});

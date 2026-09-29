import Fastify, { type FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ZodError, z } from 'zod';
import { authorizationIntentSchema, authorizePlanSchema, bindRequestSchema, challengeRequestSchema, copyPublicFundInputSchema, createFundSchema, planActionSchema, planInputSchema, publishFundInputSchema, replaceFundSchema, submitSetupSchema, updatePlanSchema } from '@ohmyfund/contracts';
import { db } from './db.js';
import { config } from './config.js';
import { ApiFailure, bindTurnkeySession, bindWallet, checkHost, checkOrigin, createChallenge, logout, requireSession } from './auth.js';
import { approvedAssets, catalog } from './catalog.js';
import { createFund, getFund, listFundActivity, listFunds, replaceFund } from './funds.js';
import { authorizePlan, cancelPlan, createAuthorizationIntent, createPlan, getPlanAuthorization, listPlanOccurrences, listPlans, pausePlan, prepareAuthorizationCleanup, preparePlan, recurringConfiguration, resumePlan, updatePlan } from './plans.js';
import { getBalances } from './balances.js';
import { listScreener, screenerDetail } from './screener.js';
import { copyPublicFund, getPublicFund, listPublicFunds, publishFund, unpublishFund } from './public-funds.js';
import { recurringExecutionReadiness, setupExecutionReadiness } from './readiness.js';
import { getAccountSetup, prepareAccountSetup, submitAccountSetup } from './recurring/setup.js';

export const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { redact: ['req.headers.cookie', 'req.headers.x-csrf-token', 'req.headers.x-ohmyfund-proxy-secret', 'req.body.signature', 'req.body.message', 'req.body.userSignedTransactionHex'] }, bodyLimit: 64 * 1024, trustProxy: false });
const uuid = z.uuid();
const publicRate = new Map<string, { count: number; reset: number }>();
const authRate = new Map<string, { count: number; reset: number }>();
const authProxyRate = new Map<string, { count: number; reset: number }>();
export function resetRateLimitsForTest() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Rate limits can only be reset in tests.');
  publicRate.clear(); authRate.clear(); authProxyRate.clear();
}
function limit(store: Map<string, { count: number; reset: number }>, key: string, max: number, evictOldest = false) {
  const now = Date.now();
  const item = store.get(key);
  if (!item || item.reset < now) {
    if (!item && store.size >= 10_000) {
      for (const [candidate, value] of store) if (value.reset < now) store.delete(candidate);
      if (store.size >= 10_000 && evictOldest) store.delete(store.keys().next().value!);
      if (store.size >= 10_000) throw new ApiFailure(429, 'TEMPORARY_UNAVAILABLE', 'Too many requests. Please retry shortly.');
    }
    store.set(key, { count: 1, reset: now + 60_000 }); return;
  }
  item.count += 1;
  if (item.count > max) throw new ApiFailure(429, 'TEMPORARY_UNAVAILABLE', 'Too many requests. Please retry shortly.');
}
export function clientIp(request: Pick<FastifyRequest, 'ip' | 'headers'>) {
  const suppliedSecret = request.headers['x-ohmyfund-proxy-secret'];
  const secret = Array.isArray(suppliedSecret) ? suppliedSecret[0] : suppliedSecret;
  const expected = config.trustedProxySecret;
  const trusted = Boolean(secret && expected && secret.length === expected.length && timingSafeEqual(Buffer.from(secret), Buffer.from(expected)));
  const suppliedIp = request.headers['x-ohmyfund-client-ip'];
  const visitorIp = Array.isArray(suppliedIp) ? suppliedIp[0] : suppliedIp;
  return trusted && visitorIp && isIP(visitorIp) ? visitorIp : request.ip;
}
function site(request: { headers: { origin?: string; referer?: string } }) {
  if (request.headers.origin) return request.headers.origin;
  try { return new URL(request.headers.referer ?? '').origin; } catch { return null; }
}
function checkSite(request: Parameters<typeof checkHost>[0]) {
  const origin = site(request);
  if (!origin || !config.webOrigins.has(origin)) throw new ApiFailure(403, 'FORBIDDEN', 'Request site is not allowed.');
  return origin;
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiFailure(400, 'VALIDATION', 'Check the highlighted fields.', Object.fromEntries(result.error.issues.map(issue => [issue.path.join('.') || 'form', issue.message])));
  return result.data;
}

app.addHook('onRequest', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  checkHost(request);
  const path = request.url.split('?')[0];
  const publicRead = request.method === 'GET' && (path === '/api/assets' || path === '/api/screener' || path.startsWith('/api/screener/') || path === '/api/public/funds' || path.startsWith('/api/public/funds/'));
  if (request.url.startsWith('/api/') && !request.url.startsWith('/api/health/') && !publicRead) checkSite(request);
});
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiFailure) return reply.status(error.status).send({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } });
  if (error instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Invalid request.' } });
  request.log.error(error);
  return reply.status(503).send({ error: { code: 'TEMPORARY_UNAVAILABLE', message: 'Something is unavailable. Please retry.' } });
});

app.get('/api/health/live', async () => ({ status: 'ok' }));
app.get('/api/health/ready', async (_request, reply) => {
  try {
    await db.query('SELECT 1');
    if (config.executionEnabled) {
      const recurring = await recurringExecutionReadiness();
      if (!recurring.ok) return reply.status(503).send({ status: 'unavailable', reason: recurring.reason });
    }
    if (config.setupExecutionEnabled) {
      const setup = await setupExecutionReadiness();
      if (!setup.ok) return reply.status(503).send({ status: 'unavailable', reason: setup.reason });
    }
    return { status: 'ok' };
  } catch { return reply.status(503).send({ status: 'unavailable' }); }
});
app.get('/api/catalog', async () => ({ assets: catalog }));
app.get('/api/assets', async () => ({ assets: approvedAssets }));
app.get('/api/screener', async (request) => listScreener(request.query as Record<string, unknown>));
app.get('/api/screener/:assetId', async (request) => screenerDetail((request.params as { assetId: string }).assetId));
app.get('/api/public/funds', async (request) => { limit(publicRate, `${clientIp(request)}:public-funds`, 120, true); return listPublicFunds(); });
app.get('/api/public/funds/:publicId', async (request) => { limit(publicRate, `${clientIp(request)}:public-funds`, 120, true); return getPublicFund(parse(uuid, (request.params as { publicId: string }).publicId)); });
app.post('/api/auth/challenge', async (request) => {
  checkOrigin(request);
  const input = parse(challengeRequestSchema, request.body);
  const client = clientIp(request);
  limit(authProxyRate, `${client}:auth`, 1_000, true);
  limit(authRate, `${client}:challenge:${input.address}`, 10, true);
  return createChallenge(input.address, request.headers.origin!);
});
app.post('/api/auth/bind', async (request, reply) => {
  checkOrigin(request);
  const input = parse(bindRequestSchema, request.body);
  const client = clientIp(request);
  limit(authProxyRate, `${client}:auth`, 1_000, true);
  limit(authRate, `${client}:bind:${input.challengeId}`, 10, true);
  return bindWallet(input, request.headers.origin!, reply);
});
app.post('/api/auth/turnkey-session', async (request, reply) => {
  checkOrigin(request);
  const input = parse(z.object({ token: z.string().min(20).max(8192), organizationId: z.uuid(), walletId: z.uuid(), address: z.string().min(32).max(44) }), request.body);
  const client = clientIp(request);
  limit(authProxyRate, `${client}:auth`, 1_000, true);
  limit(authRate, `${client}:turnkey-session:${input.address}`, 10, true);
  limit(authRate, `token:${createHash('sha256').update(input.token).digest('hex')}`, 10, true);
  return bindTurnkeySession(input, reply);
});
app.get('/api/session', async (request) => {
  const session = await requireSession(request);
  return { user: { id: session.userId, address: session.address, organizationId: session.organizationId }, csrfToken: session.csrfToken };
});
app.post('/api/logout', async (request, reply) => logout(request, reply));
app.get('/api/funds', async (request) => listFunds((await requireSession(request)).userId));
app.post('/api/funds', async (request) => createFund((await requireSession(request, true)).userId, parse(createFundSchema, request.body)));
app.get('/api/funds/:id', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return getFund((await requireSession(request)).userId, id); });
app.get('/api/funds/:id/activity', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return listFundActivity((await requireSession(request)).userId, id); });
app.put('/api/funds/:id', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return replaceFund((await requireSession(request, true)).userId, id, parse(replaceFundSchema, request.body)); });
app.post('/api/funds/:id/publish', async (request, reply) => { const session = await requireSession(request, true); const id = parse(uuid, (request.params as { id: string }).id); const input = parse(publishFundInputSchema, request.body); const result = await publishFund(session.userId, id, input.publisherName); return reply.status(result.firstPublication ? 201 : 200).send(result.publication); });
app.delete('/api/funds/:id/publish', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return unpublishFund((await requireSession(request, true)).userId, id); });
app.post('/api/public/funds/:publicId/copy', async (request) => { const session = await requireSession(request, true); const publicId = parse(uuid, (request.params as { publicId: string }).publicId); const idempotencyKey = parse(uuid, request.headers['idempotency-key']); const input = parse(copyPublicFundInputSchema, request.body); return copyPublicFund(session.userId, publicId, input.name, idempotencyKey); });
app.get('/api/funds/:id/plans', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return listPlans((await requireSession(request)).userId, id); });
app.get('/api/plans/:id/occurrences', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return listPlanOccurrences((await requireSession(request)).userId, id); });
app.get('/api/plans/:id/authorization', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return getPlanAuthorization((await requireSession(request)).userId, id); });
app.post('/api/plans/:id/authorization/cleanup', async (request) => { const session = await requireSession(request, true); const id = parse(uuid, (request.params as { id: string }).id); await prepareAuthorizationCleanup(session.userId, { planId: id }); return { ok: true }; });
app.get('/api/recurring/configuration', async (request) => { const session = await requireSession(request); return recurringConfiguration(session.userId); });
app.post('/api/funds/:id/plans', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return createPlan((await requireSession(request, true)).userId, id, parse(planInputSchema, request.body)); });
app.put('/api/plans/:id', async (request) => { const id = parse(uuid, (request.params as { id: string }).id); return updatePlan((await requireSession(request, true)).userId, id, parse(updatePlanSchema, request.body)); });
app.post('/api/plans/:id/cancel', async (request) => { const session = await requireSession(request, true); const id = parse(uuid, (request.params as { id: string }).id); const key = request.headers['idempotency-key']; return key ? cancelPlan(session.userId, id, parse(planActionSchema, request.body).expectedRevision, parse(uuid, key)) : cancelPlan(session.userId, id); });
app.post('/api/plans/:id/prepare', async (request) => { const session = await requireSession(request, true); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return preparePlan(session.userId, id, parse(planActionSchema, request.body).expectedRevision, key); });
app.post('/api/plans/:id/setup/prepare', async (request) => { const session = await requireSession(request, true); limit(authRate, `${session.userId}:account-setup`, 10); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return prepareAccountSetup(session.userId, id, parse(planActionSchema, request.body).expectedRevision, key); });
app.post('/api/plans/:id/setup/submit', async (request) => { const session = await requireSession(request, true); limit(authRate, `${session.userId}:account-setup`, 10); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return submitAccountSetup(session.userId, id, parse(submitSetupSchema, request.body), key); });
app.get('/api/plans/:id/setup', async (request) => { const session = await requireSession(request); const id = parse(uuid, (request.params as { id: string }).id); return getAccountSetup(session.userId, id); });
app.post('/api/plans/:id/authorization-intent', async (request) => { const session = await requireSession(request, true); limit(authRate, `${session.userId}:recurring-authorize`, 5); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return createAuthorizationIntent(session.userId, session.organizationId, id, parse(authorizationIntentSchema, request.body), key); });
app.post('/api/plans/:id/authorize', async (request) => { const session = await requireSession(request, true); limit(authRate, `${session.userId}:recurring-authorize`, 5); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return authorizePlan(session.userId, session.organizationId, id, parse(authorizePlanSchema, request.body), key); });
app.post('/api/plans/:id/pause', async (request) => { const session = await requireSession(request, true); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return pausePlan(session.userId, id, parse(planActionSchema, request.body).expectedRevision, key); });
app.post('/api/plans/:id/resume', async (request) => { const session = await requireSession(request, true); const id = parse(uuid, (request.params as { id: string }).id); const key = parse(uuid, request.headers['idempotency-key']); return resumePlan(session.userId, id, parse(planActionSchema, request.body).expectedRevision, key); });
app.get('/api/balances', async (request) => { const session = await requireSession(request); limit(authRate, `${session.userId}:balance`, 12); return getBalances(session.address); });
app.post('/api/balances/refresh', async (request) => { const session = await requireSession(request, true); limit(authRate, `${session.userId}:balance-refresh`, 3); return getBalances(session.address, true); });

if (process.env.NODE_ENV !== 'test') await app.listen({ port: config.port, host: '0.0.0.0' });

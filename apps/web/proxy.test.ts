import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

test('proxies the full API path with authenticated visitor headers', async () => {
  process.env.API_ORIGIN = 'https://api.example';
  process.env.API_PROXY_SECRET = 'trusted-secret';
  const request = new NextRequest('https://web.example/api/public/funds?sort=copies', {
    method: 'POST',
    headers: {
      cookie: 'session=opaque',
      'x-csrf-token': 'csrf',
      'x-vercel-forwarded-for': '203.0.113.10',
      'x-ohmyfund-client-ip': '192.0.2.10',
      'x-ohmyfund-proxy-secret': 'forged-secret'
    },
    body: JSON.stringify({ name: 'Copy' })
  });

  const response = proxy(request);
  assert.equal(response.headers.get('x-middleware-rewrite'), 'https://api.example/api/public/funds?sort=copies');
  assert.equal(response.headers.get('x-middleware-request-cookie'), 'session=opaque');
  assert.equal(response.headers.get('x-middleware-request-x-csrf-token'), 'csrf');
  assert.equal(response.headers.get('x-middleware-request-x-ohmyfund-client-ip'), '203.0.113.10');
  assert.equal(response.headers.get('x-middleware-request-x-ohmyfund-proxy-secret'), 'trusted-secret');
  assert.equal(request.method, 'POST');
  assert.equal(await request.text(), JSON.stringify({ name: 'Copy' }));
});

test('drops forged internal headers when no platform visitor IP exists', () => {
  process.env.API_ORIGIN = 'https://api.example';
  process.env.API_PROXY_SECRET = 'trusted-secret';
  const request = new NextRequest('https://web.example/api/public/funds', { headers: { 'x-forwarded-for': '192.0.2.20', 'x-ohmyfund-client-ip': '192.0.2.10', 'x-ohmyfund-proxy-secret': 'forged-secret' } });
  const response = proxy(request);
  assert.equal(response.headers.get('x-middleware-request-x-ohmyfund-client-ip'), null);
  assert.equal(response.headers.get('x-middleware-request-x-ohmyfund-proxy-secret'), null);
});

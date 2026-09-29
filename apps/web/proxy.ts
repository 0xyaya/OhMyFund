import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const apiOrigin = process.env.API_ORIGIN;
  if (!apiOrigin) return NextResponse.next();
  const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, apiOrigin);
  const headers = new Headers(request.headers);
  headers.delete('x-ohmyfund-client-ip');
  headers.delete('x-ohmyfund-proxy-secret');
  const visitorIp = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  const secret = process.env.API_PROXY_SECRET;
  if (visitorIp && secret) {
    headers.set('x-ohmyfund-client-ip', visitorIp);
    headers.set('x-ohmyfund-proxy-secret', secret);
  }
  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = { matcher: '/api/:path*' };

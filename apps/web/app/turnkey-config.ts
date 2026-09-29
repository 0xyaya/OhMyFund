// NEXT_PUBLIC_* vars are inlined at build time, so this is safe to read from both
// server components (page.tsx route guards) and client components (providers.tsx).
export const turnkeyConfigured = Boolean(process.env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID && process.env.NEXT_PUBLIC_TURNKEY_AUTH_PROXY_ID);

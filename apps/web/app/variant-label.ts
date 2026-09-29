// The API fills a missing issuer with the literal string "Issuer unspecified" so the
// field is always present (see apps/api/src/catalog.ts). That sentinel is truthy, so a
// plain `issuer ?? fallback` never fires and every unidentified variant ends up sharing
// the exact same label. Treat the sentinel explicitly instead of trusting truthiness.
const UNKNOWN_ISSUER_SENTINELS = new Set(['Issuer unspecified', '']);

export function issuerLabel(issuer: string | undefined | null): string {
  if (!issuer || UNKNOWN_ISSUER_SENTINELS.has(issuer)) return 'Issuer not identified';
  return issuer;
}

export function shortMint(mint: string): string {
  return mint.length <= 10 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** A label that distinguishes variants sharing an issuer or symbol: symbol · issuer · short mint. */
export function variantLabel(item: { symbol: string; issuer?: string | null; mint: string }): string {
  return `${item.symbol} · ${issuerLabel(item.issuer)} · ${shortMint(item.mint)}`;
}

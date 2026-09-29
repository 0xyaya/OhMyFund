import { balancesSchema, catalogSchema, fundActivitySchema, fundSchema, planSchema, recurringConfigurationSchema, sessionSchema } from '@ohmyfund/contracts';

export type Fund = typeof fundSchema._output;
export type Plan = typeof planSchema._output;
export type Catalog = typeof catalogSchema._output['assets'];
export type Session = typeof sessionSchema._output;
export type Balances = typeof balancesSchema._output;
export type FundActivity = typeof fundActivitySchema._output;
export type FundEdit = FundActivity['edits'][number];
export type View = 'portfolio' | 'fund' | 'wallet';
export type RecurringConfiguration = typeof recurringConfigurationSchema._output;
/** A complete total is only known while the user has no fund holdings to value. */
// TODO(fund-valuation): add attributed fund holdings once fund valuation exists. See TODOS.md "Fund value and gain/loss".
export function knownPortfolioTotal(funds: Fund[], balances: Balances | null): string | null {
  if (funds.length || !balances) return null;
  const cents = (BigInt(balances.usdcAtomic) + 5_000n) / 10_000n;
  return `$${(cents / 100n).toLocaleString('en-US')}.${String(cents % 100n).padStart(2, '0')}`;
}

// Atomic amounts stay in BigInt so large balances and six-decimal USDC are exact.
export const atomicAmount = (value: string, decimals: number, shownDecimals: number) => {
  const amount = BigInt(value); const negative = amount < 0n; const absolute = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals); const whole = (absolute / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % base).toString().padStart(decimals, '0').slice(0, shownDecimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};
export const usdc = (atomic: string) => atomicAmount(atomic, 6, 2);
export const preciseUsdc = (atomic: string) => atomicAmount(atomic, 6, 6);
/** Atomic amount as a plain input value, e.g. "10000000" -> "10". */
export const atomicInput = (atomic: string, decimals: number) => {
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals); const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
};
/** Parse a typed USDC amount into atomic units, or null when it is not a positive amount. */
export const usdcAtomic = (value: string) => {
  const match = value.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!match) return null;
  const result = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return result > 0n && result <= 999_999_999_999_999_999n ? result.toString() : null;
};
export const shortAddress = (address: string) => address.length > 9 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
export const sol = (lamports: string) => atomicAmount(lamports, 9, 4);
export const assetKey = (assetId: string, variantId: string) => `${assetId}:${variantId}`;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** Spread 100% across every asset, giving the leftover basis points to the first rows. */
export const splitEqually = <T extends { weightBps: number }>(items: T[]): T[] => items.map((item, index) => ({ ...item, weightBps: Math.floor(10000 / items.length) + (index < 10000 % items.length ? 1 : 0) }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogItemSchema } from '@ohmyfund/contracts';

type Item = typeof catalogItemSchema._output;
type Market = { price: number | null; priceChange24hPercent: number | null; volume24hUSD: number | null; liquidity: number | null; lastFetchedAt: number | null; lastTradeAt: number | null };
type Chart = { status: string; from: number | null; to: number | null; candles: { time: number; close: number }[] };
export type Variant = Item & { issuer: string; tokenSymbol: string; tokenName: string; advisory: string | null; market: Market; chart: Chart };
export type ScreenerAsset = { assetId: string; name: string; symbol: string; category: 'crypto' | 'currency' | 'treasury' | 'etf' | 'commodity' | 'equity'; imageUrl: string | null; primaryVariantId: string; variants: Variant[] };

const root = new URL('../../../data/', import.meta.url);
const source = JSON.parse(readFileSync(fileURLToPath(new URL('tokens-screener.json', root)), 'utf8')) as Record<string, unknown>;
const chartSource = JSON.parse(readFileSync(fileURLToPath(new URL('screener-charts.json', root)), 'utf8')) as { chartsFetchedAt?: string; charts: Record<string, Chart> };
const categories = new Set(['crypto', 'currency', 'treasury', 'etf', 'commodity', 'equity']);
const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid screener ${field}`);
  return value;
};
const optionalNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const marketOf = (value: unknown): Market => {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    price: optionalNumber(row.price), priceChange24hPercent: optionalNumber(row.priceChange24hPercent),
    volume24hUSD: optionalNumber(row.volume24hUSD), liquidity: optionalNumber(row.liquidity),
    lastFetchedAt: optionalNumber(row.lastFetchedAt), lastTradeAt: optionalNumber(row.lastTradeAt)
  };
};
const emptyChart: Chart = { status: 'not_fetched', from: null, to: null, candles: [] };
if (!Array.isArray(source.assets) || source.assets.length !== 479 || typeof source.retrievedAt !== 'string' || Number.isNaN(Date.parse(source.retrievedAt)) || typeof source.source !== 'string') throw new Error('Invalid approved Tokens screener snapshot');

export const snapshotFor = (category: ScreenerAsset['category']) => ({
  source: category === 'currency' ? source.currenciesSource as string : category === 'treasury' ? source.treasuriesSource as string : source.source as string,
  retrievedAt: category === 'currency' ? source.currenciesRetrievedAt as string : category === 'treasury' ? source.treasuriesRetrievedAt as string : source.retrievedAt as string,
  chartsFetchedAt: chartSource.chartsFetchedAt ?? null
});
export const screenerAssets: ScreenerAsset[] = [];
export const approvedAssets: Item[] = [];
const pairs = new Map<string, Variant>();
const seenAssets = new Set<string>();
let sourceVariants = 0;
for (const raw of source.assets as Record<string, unknown>[]) {
  const assetId = required(raw.assetId, 'assetId');
  if (seenAssets.has(assetId)) throw new Error(`Duplicate screener asset ${assetId}`);
  seenAssets.add(assetId);
  const category = required(raw.category, 'category');
  if (!categories.has(category) || !Array.isArray(raw.variants)) throw new Error(`Invalid screener category or variants for ${assetId}`);
  const variants: Variant[] = [];
  for (const input of raw.variants as Record<string, unknown>[]) {
    sourceVariants++;
    const variantId = required(input.variantId, 'variantId');
    const mint = required(input.mint, 'mint');
    const key = `${assetId}\u0000${variantId}`;
    const previous = pairs.get(key);
    if (previous) {
      if (previous.mint !== mint) throw new Error(`Conflicting screener variant ${key}`);
      continue;
    }
    const chart = chartSource.charts[mint] ?? emptyChart;
    if (!Array.isArray(chart.candles)) throw new Error(`Invalid chart for ${mint}`);
    const variant: Variant = {
      assetId, variantId, mint, symbol: required(input.symbol, 'variant symbol'),
      name: required(raw.name, 'asset name'), kind: required(input.kind, 'variant kind'),
      issuer: typeof input.issuer === 'string' && input.issuer ? input.issuer : 'Issuer unspecified',
      tokenSymbol: required(input.symbol, 'token symbol'), tokenName: required(input.name, 'token name'),
      advisory: typeof input.advisory === 'string' ? input.advisory : null,
      market: marketOf(input.market), chart
    };
    pairs.set(key, variant);
    approvedAssets.push(catalogItemSchema.parse(variant));
    variants.push(variant);
  }
  if (!variants.length) throw new Error(`Screener asset has no variants: ${assetId}`);
  const primary = raw.primaryVariant as Record<string, unknown> | undefined;
  const selected = variants.find(v => v.variantId === primary?.variantId || v.mint === primary?.mint) ?? variants[0];
  screenerAssets.push({ assetId, name: required(raw.name, 'asset name'), symbol: typeof raw.symbol === 'string' && raw.symbol ? raw.symbol : selected.tokenSymbol, category: category as ScreenerAsset['category'], imageUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null, primaryVariantId: selected.variantId, variants });
}
if (sourceVariants !== 697 || approvedAssets.length !== 695 || new Set(approvedAssets.map(item => item.mint)).size !== 694) throw new Error('Approved screener identity counts changed; review the catalog before release');

const byId = new Map(screenerAssets.map(asset => [asset.assetId, asset]));
export const getScreenerAsset = (assetId: string) => byId.get(assetId) ?? null;
export const findSelection = (assetId: string, variantId: string) => pairs.get(`${assetId}\u0000${variantId}`) ?? null;
export const isCuratedSelection = (assetId: string, variantId: string) => findSelection(assetId, variantId) !== null;

// Legacy endpoint stays small until the old production web has been replaced.
export const catalog: Item[] = [
  approvedAssets.find(item => item.assetId === 'solana' && item.variantId === 'solana:wSOL')!,
  approvedAssets.find(item => item.assetId === 'apple' && item.variantId === 'apple:xStock')!,
  approvedAssets.find(item => item.assetId === 'nasdaq' && item.symbol === 'QQQx')!
];
if (catalog.some(item => !item)) throw new Error('Legacy catalog entries are missing');

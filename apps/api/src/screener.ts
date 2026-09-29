import { ApiFailure } from './auth.js';
import { getScreenerAsset, screenerAssets, snapshotFor, type ScreenerAsset, type Variant } from './catalog.js';

type Sort = 'name' | 'price' | 'priceChange24hPercent' | 'volume24hUSD';
type Direction = 'asc' | 'desc';
type Query = { category?: unknown; q?: unknown; sort?: unknown; direction?: unknown; page?: unknown };
const categories = ['crypto', 'currency', 'treasury', 'etf', 'commodity', 'equity'] as const;
const sorts: Sort[] = ['name', 'price', 'priceChange24hPercent', 'volume24hUSD'];
const badQuery = () => new ApiFailure(400, 'VALIDATION', 'Check the screener filters.');
const selected = (asset: ScreenerAsset): Variant => asset.variants.find(v => v.variantId === asset.primaryVariantId)!;

export function listScreener(input: Query) {
  const category = input.category ?? 'crypto';
  const sort = input.sort ?? 'volume24hUSD';
  const direction = input.direction ?? 'desc';
  const q = input.q ?? '';
  const rawPage = input.page ?? '1';
  if (!categories.includes(category as typeof categories[number]) || !sorts.includes(sort as Sort) || (direction !== 'asc' && direction !== 'desc') || typeof q !== 'string' || q.length > 80 || !/^[1-9]\d{0,5}$/.test(String(rawPage))) throw badQuery();
  const query = q.trim().toLocaleLowerCase();
  const matching = screenerAssets.filter(asset => asset.category === category && `${asset.name} ${asset.symbol} ${asset.variants.map(v => `${v.tokenSymbol} ${v.issuer}`).join(' ')}`.toLocaleLowerCase().includes(query));
  const value = (asset: ScreenerAsset): string | number | null => sort === 'name' ? asset.name.toLocaleLowerCase() : selected(asset).market[sort as Exclude<Sort, 'name'>];
  matching.sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const comparison = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : typeof av === 'number' && typeof bv === 'number' ? av - bv : 0;
    return (direction === 'asc' ? comparison : -comparison) || a.assetId.localeCompare(b.assetId);
  });
  const pageCount = Math.max(1, Math.ceil(matching.length / 20));
  const page = Math.min(Number(rawPage), pageCount);
  return {
    rows: matching.slice((page - 1) * 20, page * 20).map(asset => ({ assetId: asset.assetId, name: asset.name, symbol: asset.symbol, category: asset.category, imageUrl: asset.imageUrl, primaryVariantId: asset.primaryVariantId, variantCount: asset.variants.length, variant: selected(asset) })),
    total: matching.length, page, pageCount, snapshot: snapshotFor(category as ScreenerAsset['category'])
  };
}

export function screenerDetail(assetId: string) {
  const asset = getScreenerAsset(assetId);
  if (!asset) throw new ApiFailure(404, 'NOT_FOUND', 'Asset not found.');
  return { ...asset, snapshot: snapshotFor(asset.category) };
}

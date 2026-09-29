import logos from './screener/logos.json';

type AssetIdentity = {
  mint: string;
  name: string;
  symbol: string;
};

export function AssetAvatar({ asset, fallback }: { asset?: AssetIdentity; fallback: string }) {
  const logo = asset ? (logos as Record<string, string>)[asset.mint] : undefined;
  const label = asset?.symbol ?? fallback;

  return <span className="asset-avatar" aria-hidden="true">
    <span>{label.slice(0, 2).toUpperCase()}</span>
    {logo && <img src={logo} alt="" width="36" height="36" loading="lazy" decoding="async" onError={event => { event.currentTarget.style.display = 'none'; }} />}
  </span>;
}

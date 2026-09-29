/** Cache approved catalog logos as small PNGs for the public screener. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '../..');
const assets = JSON.parse(readFileSync(path.join(repoRoot, 'data/tokens-screener.json'), 'utf8')).assets;
const manifestPath = path.join(webRoot, 'app/screener/logos.json');
const logoDir = path.join(webRoot, 'public/logos/catalog');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const checkOnly = process.argv.includes('--check');
const missingPrimary = [];
const localFallbacks = { 'precious-metals': '/logos/gold.png' };

function hasLocalLogo(mint) {
  const logo = manifest[mint];
  return Boolean(logo && existsSync(path.join(webRoot, 'public', logo.replace(/^\//, ''))));
}

function candidates(url) {
  const result = [url];
  const cid = url.match(/\/ipfs\/([^/?#]+)/)?.[1] ?? url.match(/^https:\/\/([^./]+)\.ipfs\./)?.[1];
  if (cid) result.push(`https://gateway.pinata.cloud/ipfs/${cid}`);
  return result;
}

for (const asset of assets) {
  const mint = asset.primaryVariant.mint;
  if (!hasLocalLogo(mint)) missingPrimary.push(asset);
}

if (checkOnly) {
  const missingVariants = assets.flatMap(asset => asset.variants.filter(variant => !hasLocalLogo(variant.mint)).map(variant => ({ asset, variant })));
  if (missingPrimary.length || missingVariants.length) {
    console.error(`${missingVariants.length} approved variants lack a local logo: ${missingVariants.slice(0, 12).map(({ asset, variant }) => `${asset.symbol}:${variant.symbol}`).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`All ${assets.reduce((total, asset) => total + asset.variants.length, 0)} approved variants across ${assets.length} assets have a local logo.`);
  }
} else {
  mkdirSync(logoDir, { recursive: true });
  const failures = [];
  let cursor = 0;
  let downloaded = 0;
  async function worker() {
    while (cursor < missingPrimary.length) {
      const asset = missingPrimary[cursor++];
      const mint = asset.primaryVariant.mint;
      const url = asset.primaryVariant.market.logoURI;
      try {
        if (localFallbacks[asset.assetId]) {
          manifest[mint] = localFallbacks[asset.assetId];
          continue;
        }
        const name = createHash('sha256').update(mint).digest('hex').slice(0, 20) + '.png';
        const destination = path.join(logoDir, name);
        if ((asset.assetId === 'xsgd' && !url) || asset.assetId === 'ousg') {
          const symbol = asset.assetId === 'ousg' ? 'OUSG' : 'XSGD';
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#173d35"/><text x="32" y="39" text-anchor="middle" fill="white" font-family="sans-serif" font-size="17" font-weight="700">${symbol}</text></svg>`;
          await sharp(Buffer.from(svg)).png().toFile(destination);
          manifest[mint] = `/logos/catalog/${name}`;
          downloaded++;
          continue;
        }
        if (!url || new URL(url).protocol !== 'https:') throw new Error('missing HTTPS provider URL');
        let lastError;
        for (const candidate of candidates(url)) {
          try {
            const response = await fetch(candidate, { signal: AbortSignal.timeout(15000), headers: { Accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/*' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/')) throw new Error('non-image response');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > 2_000_000) throw new Error('image over 2 MB');
            await sharp(bytes, { limitInputPixels: 10_000_000 }).resize(64, 64, { fit: 'contain', background: '#ffffff00' }).png().toFile(destination);
            manifest[mint] = `/logos/catalog/${name}`;
            downloaded++;
            lastError = null;
            break;
          } catch (error) { lastError = error; }
        }
        if (lastError) throw lastError;
      } catch (error) {
        failures.push({ symbol: asset.symbol, mint, url, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  let linked = 0;
  for (const asset of assets) {
    const primaryLogo = manifest[asset.primaryVariant.mint];
    if (!primaryLogo || !hasLocalLogo(asset.primaryVariant.mint)) continue;
    for (const variant of asset.variants) {
      if (hasLocalLogo(variant.mint)) continue;
      manifest[variant.mint] = primaryLogo;
      linked++;
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Cached ${downloaded} logos and linked ${linked} variants; ${Object.keys(manifest).length} unique mints mapped.`);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

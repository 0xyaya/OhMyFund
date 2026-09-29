import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetAvatar } from './asset-avatar';
import { BrandLogo } from './brand-logo';
import { ThemeSwitcher } from './theme-switcher';

test('brand logo uses the transparent Orbit lockup', () => {
  const markup = renderToStaticMarkup(<BrandLogo />);

  assert.match(markup, /src="\/brand\/ohmyfund-orbit\.png"/);
  assert.match(markup, /class="brand-logo"/);
  assert.match(markup, /aria-hidden="true"/);
});

test('asset avatar renders a local logo over its text fallback', () => {
  const markup = renderToStaticMarkup(<AssetAvatar asset={{
    mint: 'So11111111111111111111111111111111111111112',
    name: 'Solana',
    symbol: 'SOL',
  }} fallback="solana" />);

  assert.match(markup, />SO</);
  assert.match(markup, /src="\/logos\/solana\.png"/);
  assert.match(markup, /aria-hidden="true"/);
});

test('asset avatar keeps a normalized text fallback when metadata or a logo is missing', () => {
  const missingMetadata = renderToStaticMarkup(<AssetAvatar fallback="usd-coin" />);
  const missingLogo = renderToStaticMarkup(<AssetAvatar asset={{
    mint: 'unknown-mint',
    name: 'Unknown',
    symbol: 'xyz',
  }} fallback="unused" />);

  assert.match(missingMetadata, />US</);
  assert.doesNotMatch(missingMetadata, /<img/);
  assert.match(missingLogo, />XY</);
  assert.doesNotMatch(missingLogo, /<img/);
});

test('asset avatar resolves a local logo for a non-primary approved variant', () => {
  const markup = renderToStaticMarkup(<AssetAvatar asset={{
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    name: 'Solana',
    symbol: 'JitoSOL',
  }} fallback="solana" />);

  assert.match(markup, /src="\/logos\/solana\.png"/);
});

test('theme selector renders Orbit as the initial selection', () => {
  const markup = renderToStaticMarkup(<ThemeSwitcher />);

  assert.match(markup, /aria-label="Appearance theme"/);
  assert.match(markup, /aria-pressed="true">Orbit<\/button>/);
  assert.match(markup, /aria-pressed="false">Ledger<\/button>/);
});

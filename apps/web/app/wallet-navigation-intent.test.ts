import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeWalletNavigationIntent, markWalletNavigationIntent } from './wallet-navigation-intent';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test('wallet navigation intent works once, immediately after a tap', () => {
  const tab = storage();
  assert.equal(consumeWalletNavigationIntent(tab, 100), false);
  markWalletNavigationIntent(tab, 100);
  assert.equal(consumeWalletNavigationIntent(tab, 101), true);
  assert.equal(consumeWalletNavigationIntent(tab, 102), false);
});

test('stale wallet navigation intent cannot reopen login after a reload', () => {
  const tab = storage();
  markWalletNavigationIntent(tab, 100);
  assert.equal(consumeWalletNavigationIntent(tab, 15_100), false);
  assert.equal(consumeWalletNavigationIntent(tab, 101), false);
});

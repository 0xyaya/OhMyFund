import { expect, it } from 'vitest';
import { catalog, isCuratedSelection } from './catalog.js';

it('accepts only exact curated catalog pairs', () => {
  expect(catalog.length).toBeGreaterThan(1);
  expect(isCuratedSelection('apple', 'apple:xStock')).toBe(true);
  expect(isCuratedSelection('apple', 'nasdaq:Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ')).toBe(false);
});

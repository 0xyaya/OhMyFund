import assert from 'node:assert/strict';
import test from 'node:test';
import { bindIntentPublicId, copyRequestFor, defaultCopyName, publicIdFromLeaderboardPath } from './leaderboard-state';

test('an explicit copy intent survives the render-state delay', () => {
  assert.equal(bindIntentPublicId('selected-fund', null), 'selected-fund');
  assert.equal(bindIntentPublicId(undefined, 'pending-fund'), 'pending-fund');
});

test('copy retries reuse the same key until the request identity changes', () => {
  let sequence = 0;
  const createKey = () => `key-${++sequence}`;
  const first = copyRequestFor(null, 'fund-a', 'Core copy', createKey);
  const retry = copyRequestFor(first, 'fund-a', 'Core copy', createKey);
  const renamed = copyRequestFor(retry, 'fund-a', 'Core copy 2', createKey);
  assert.equal(retry.key, first.key);
  assert.notEqual(renamed.key, first.key);
});

test('default copy names stay within the API limit', () => {
  assert.equal(defaultCopyName('Core'), 'Core copy');
  assert.equal(defaultCopyName('x'.repeat(64)).length, 64);
});

test('leaderboard detail paths round-trip through browser history', () => {
  assert.equal(publicIdFromLeaderboardPath('/leaderboard/fund-123'), 'fund-123');
  assert.equal(publicIdFromLeaderboardPath('/leaderboard'), null);
});

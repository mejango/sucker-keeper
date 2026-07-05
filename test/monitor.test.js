import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPct, contextsDiffPct, divergenceMatrix, stalePairs } from '../src/monitor.js';

const ctx = (surplus, balance, decimals = 18) => ({ token: '0x0', decimals, surplus, balance });
const account = (chainId, totalSupply, contexts = []) => ({ chainId: BigInt(chainId), totalSupply, contexts, timestamp: 0n });

test('diffPct basics', () => {
  assert.equal(diffPct(100n, 100n), 0);
  assert.equal(diffPct(100n, 99n), 1);
  assert.equal(diffPct(100n, 101n), 1);
  assert.equal(diffPct(0n, 0n), 0);
  assert.equal(diffPct(0n, 5n), 500); // vs base 1
  assert.equal(diffPct(10n ** 24n, (10n ** 24n * 98n) / 100n), 2);
});

test('contextsDiffPct: count mismatch is fully divergent', () => {
  assert.equal(contextsDiffPct([ctx(1n, 1n)], []), 100);
});

test('contextsDiffPct: token-key remapping does not register as divergence', () => {
  const a = [{ ...ctx(500n, 1000n), token: '0xaaa' }];
  const b = [{ ...ctx(500n, 1000n), token: '0xbbb' }]; // hub-mapped key, same amounts
  assert.equal(contextsDiffPct(a, b), 0);
});

test('contextsDiffPct: pairs multi-context sets by sorted amounts', () => {
  const truth = [ctx(100n, 200n, 18), ctx(5n, 10n, 6)];
  const belief = [ctx(5n, 10n, 6), ctx(100n, 198n, 18)];
  assert.equal(contextsDiffPct(truth, belief), 1); // only the 200 -> 198 balance drifted
});

test('divergenceMatrix flags a missing belief only when the source is non-empty', () => {
  const snapshots = new Map([
    [1, { chainId: 1, truth: account(1, 1000n), beliefs: new Map() }],
    [2, { chainId: 2, truth: account(2, 0n), beliefs: new Map() }],
  ]);
  const rows = divergenceMatrix(snapshots);
  const oneAsSeenByTwo = rows.find((r) => r.source === 1 && r.viewer === 2);
  const twoAsSeenByOne = rows.find((r) => r.source === 2 && r.viewer === 1);
  assert.equal(oneAsSeenByTwo.pct, 100); // chain 2 knows nothing about a live chain 1
  assert.equal(twoAsSeenByOne.pct, 0); // chain 2 is genuinely empty — nothing to know
});

test('divergenceMatrix + stalePairs end to end', () => {
  const snapshots = new Map([
    [1, { chainId: 1, truth: account(1, 1000n), beliefs: new Map([[2, account(2, 500n)]]) }],
    [2, { chainId: 2, truth: account(2, 500n), beliefs: new Map([[1, account(1, 950n)]]) }],
  ]);
  const rows = divergenceMatrix(snapshots);
  assert.equal(rows.find((r) => r.source === 1 && r.viewer === 2).pct, 5); // 1000 vs 950
  assert.equal(rows.find((r) => r.source === 2 && r.viewer === 1).pct, 0);
  assert.deepEqual(stalePairs(rows, 1).map((r) => `${r.source}>${r.viewer}`), ['1>2']);
  assert.equal(stalePairs(rows, 10).length, 0);
});

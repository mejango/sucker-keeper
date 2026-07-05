// Cheap-hour timing: when a sync may wait for off-peak Ethereum L1 gas.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldDeferForGas } from '../src/tick.js';
import * as db from '../src/db.js';

const base = {
  networkClass: 'mainnet', touchesL1: true, urgency: 1.2,
  gasNow: 30n, gasCheap: 10n, staleSince: 1000, now: 2000,
};

test('defers a patient mainnet L1-touching sync while gas is above typical', () => {
  assert.equal(shouldDeferForGas(base), true);
});

test('never defers: testnets, L2-only plans, urgent drift, cheap gas, no baseline, or after the cap', () => {
  assert.equal(shouldDeferForGas({ ...base, networkClass: 'testnet' }), false);
  assert.equal(shouldDeferForGas({ ...base, touchesL1: false }), false);
  assert.equal(shouldDeferForGas({ ...base, urgency: 3 }), false); // 3x threshold = urgent
  assert.equal(shouldDeferForGas({ ...base, gasNow: 9n }), false); // it IS the cheap hour
  assert.equal(shouldDeferForGas({ ...base, gasCheap: null }), false); // no baseline yet
  assert.equal(shouldDeferForGas({ ...base, staleSince: 0, now: 12 * 3600 + 1 }), false); // waited long enough
});

before(() => db.init(join(mkdtempSync(join(tmpdir(), 'keeper-gas-')), 'gas.db')));

test('gasPercentile needs a baseline, then reports the right slice of history', () => {
  assert.equal(db.gasPercentile(1, 0.35), null); // empty
  for (let i = 1; i <= 100; i++) db.sampleGas(1, BigInt(i) * 10n ** 9n);
  const p35 = db.gasPercentile(1, 0.35);
  assert.ok(p35 >= 30n * 10n ** 9n && p35 <= 40n * 10n ** 9n, `p35 was ${p35}`);
  assert.equal(db.gasPercentile(1, 0.35, 200), null); // stricter minimum not met
  assert.equal(db.gasPercentile(10, 0.35), null); // other chains unaffected
});

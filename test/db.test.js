// Billing arithmetic and persistence — the money paths clients rely on.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../src/db.js';

const members = [
  { chainId: 11155111, projectId: '5' },
  { chainId: 84532, projectId: '9' },
];

before(() => {
  db.init(join(mkdtempSync(join(tmpdir(), 'keeper-db-')), 'test.db'));
});

test('group create + resolution via EVERY member (per-chain IDs differ)', () => {
  const id = db.createGroup({ groupKey: '84532:9', thresholdPct: 1, registrant: '0xAbC0000000000000000000000000000000000001', networkClass: 'testnet', members });
  assert.equal(db.groupByMember(11155111, '5').id, id);
  assert.equal(db.groupByMember(84532, '9').id, id);
  assert.equal(db.groupByMember(84532, '5'), undefined); // wrong pairing resolves nothing
  assert.equal(db.groupById(id).registrant_address, '0xabc0000000000000000000000000000000000001');
});

test('balances survive amounts past int64 (stored as TEXT, BigInt math)', () => {
  const id = db.createGroup({ groupKey: '1:77', thresholdPct: 1, registrant: '0xabc0000000000000000000000000000000000002', networkClass: 'mainnet', members: [{ chainId: 1, projectId: '77' }] });
  const twentyEth = 20n * 10n ** 18n; // > 2^63-1
  assert.equal(db.adjustBalance(id, twentyEth), twentyEth);
  assert.equal(db.adjustBalance(id, -(3n * 10n ** 18n)), 17n * 10n ** 18n);
  assert.equal(db.groupById(id).balance_wei, (17n * 10n ** 18n).toString());
});

test('member refresh replaces the set; group key can migrate', () => {
  const id = db.createGroup({ groupKey: '10:3', thresholdPct: 1, registrant: '0xabc0000000000000000000000000000000000003', networkClass: 'mainnet', members: [{ chainId: 10, projectId: '3' }] });
  db.replaceMembers(id, [{ chainId: 10, projectId: '3' }, { chainId: 8453, projectId: '12' }]);
  assert.equal(db.membersOf(id).length, 2);
  assert.equal(db.groupByMember(8453, '12').id, id);
  db.setGroupKey(id, '8453:12');
  assert.equal(db.groupById(id).group_key, '8453:12');
});

test('deposit replay is blocked by the tx_hash unique constraint', () => {
  const group = db.groupByMember(11155111, '5');
  db.insertDeposit({ txHash: '0xAA11', chainId: 11155111, from: '0xF00', amountWei: 100n, groupId: group.id });
  assert.throws(() => db.insertDeposit({ txHash: '0xaa11', chainId: 84532, from: '0xF00', amountWei: 100n, groupId: group.id }));
  assert.ok(db.depositByHash('0xAA11'));
  assert.equal(db.depositsByAddress('0xf00').length, 1);
});

test('sync lifecycle: submitted -> pending -> resolved', () => {
  const group = db.groupByMember(11155111, '5');
  const id = db.insertSync({ groupId: group.id, plan: { edges: [] }, bundleUuid: 'uuid-1', quotedCostWei: 5n * 10n ** 17n });
  assert.ok(db.pendingSyncs().some((s) => s.id === id));
  db.resolveSync(id, { state: 'success', finalCostWei: 4n * 10n ** 17n });
  assert.ok(!db.pendingSyncs().some((s) => s.id === id));
  const row = db.syncsOf(group.id)[0];
  assert.equal(row.state, 'success');
  assert.equal(row.final_cost_wei, (4n * 10n ** 17n).toString());
});

test('status transitions and threshold updates persist', () => {
  const group = db.groupByMember(11155111, '5');
  db.setStatus(group.id, 'underfunded');
  assert.equal(db.groupById(group.id).status, 'underfunded');
  assert.ok(db.activeGroups().some((g) => g.id === group.id)); // underfunded still scanned
  db.setStatus(group.id, 'paused');
  assert.ok(!db.activeGroups().some((g) => g.id === group.id));
  db.setStatus(group.id, 'active');
  db.setThreshold(group.id, 2.5);
  assert.equal(db.groupById(group.id).threshold_pct, 2.5);
});

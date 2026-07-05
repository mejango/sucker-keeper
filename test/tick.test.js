// Orchestration + billing: the scan tick and bundle reconciliation, with the
// chain/Relayr layers module-mocked and real SQLite underneath.
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const p = (f) => new URL(f, import.meta.url).pathname;
const GWEI = 10n ** 9n;

const fx = {
  walk: null,
  snapshots: null,
  quote: { usable: true, value: 0n, family: 'native' },
  paymentInfo: [{ chain: 84532, target: '0xrelayr', amount: (10n ** 15n).toString(), calldata: '0x', token: '0x0' }],
  submitted: [], // captured relayr submissions
  submitErrors: [], // queued errors thrown by submitPrepaidBundle before succeeding
  payments: [], // captured wallet payments
  bundle: null, // getBundle fixture
  receipt: { gasUsed: 100_000n, effectiveGasPrice: GWEI },
  payThrows: null,
};

const actualChains = await import('../src/chains.js');
const actualMesh = await import('../src/mesh.js');

mock.module(p('../src/mesh.js'), {
  namedExports: {
    ...actualMesh,
    walkGroup: async () => fx.walk,
    snapshotGroup: async () => fx.snapshots,
  },
});
mock.module(p('../src/chains.js'), {
  namedExports: {
    ...actualChains,
    clientFor: () => ({
      getGasPrice: async () => GWEI,
      getTransactionReceipt: async () => fx.receipt,
    }),
  },
});
mock.module(p('../src/quote.js'), {
  namedExports: { quoteEdge: async () => fx.quote },
});
mock.module(p('../src/relayr.js'), {
  namedExports: {
    submitPrepaidBundle: async (txs) => {
      if (fx.submitErrors.length) throw fx.submitErrors.shift();
      fx.submitted.push(txs);
      return { bundleUuid: `uuid-${fx.submitted.length}`, paymentInfo: fx.paymentInfo };
    },
    getBundle: async () => fx.bundle,
    txState: (t) => t?.status?.state,
    txDestHash: (t) => t?.status?.data?.hash || null,
  },
});
mock.module(p('../src/wallet.js'), {
  namedExports: {
    payRelayr: async (paymentInfo, klass) => {
      if (fx.payThrows) throw fx.payThrows;
      const o = paymentInfo[0];
      const paid = { chain: Number(o.chain), amount: BigInt(o.amount), hash: '0xpayhash', klass };
      fx.payments.push(paid);
      return paid;
    },
    keeperAddress: () => '0xkeeper',
    walletBalances: async () => ({}),
  },
});

const db = await import('../src/db.js');
const { scanGroup, finalizePending } = await import('../src/tick.js');

const MEMBERS = [{ chainId: 11155111, projectId: '5' }, { chainId: 84532, projectId: '9' }];
const account = (chainId, totalSupply) => ({ chainId: BigInt(chainId), totalSupply, contexts: [], timestamp: 1n });

// Chain 84532 has never heard of chain 11155111 (supply 1000) -> 100% stale.
const divergedSnapshots = () => new Map([
  [11155111, { chainId: 11155111, truth: account(11155111, 1000n), beliefs: new Map([[84532, account(84532, 500n)]]) }],
  [84532, { chainId: 84532, truth: account(84532, 500n), beliefs: new Map() }],
]);
const agreeingSnapshots = () => new Map([
  [11155111, { chainId: 11155111, truth: account(11155111, 1000n), beliefs: new Map([[84532, account(84532, 500n)]]) }],
  [84532, { chainId: 84532, truth: account(84532, 500n), beliefs: new Map([[11155111, account(11155111, 1000n)]]) }],
]);

const mkWalk = (sucker) => ({
  members: MEMBERS,
  edges: [
    { from: 11155111, to: 84532, sucker },
    { from: 84532, to: 11155111, sucker },
  ],
  unsupported: [],
});

let groupId;

before(() => {
  db.init(join(mkdtempSync(join(tmpdir(), 'keeper-tick-')), 'tick.db'));
  groupId = db.createGroup({ groupKey: '84532:9', thresholdPct: 1, registrant: '0xabc0000000000000000000000000000000000001', networkClass: 'testnet', members: MEMBERS });
  fx.walk = mkWalk('0xs1');
});

test('in-sync group: no submission, underfunded recovers to active', async () => {
  fx.snapshots = agreeingSnapshots();
  db.setStatus(groupId, 'underfunded');
  const r = await scanGroup(db.groupById(groupId));
  assert.equal(r.inSync, true);
  assert.equal(fx.submitted.length, 0);
  assert.equal(db.groupById(groupId).status, 'active');
});

test('stale + unaffordable: bundle quoted but NOT paid, group marked underfunded', async () => {
  fx.snapshots = divergedSnapshots();
  const r = await scanGroup(db.groupById(groupId)); // balance is 0
  assert.equal(r.underfunded, true);
  assert.equal(fx.submitted.length, 1); // quote fetched
  assert.equal(fx.payments.length, 0); // but nothing paid
  assert.equal(db.groupById(groupId).status, 'underfunded');
  assert.equal(db.groupById(groupId).balance_wei, '0'); // nothing debited
});

test('stale + funded: pays, debits quote + gas allowance, records the sync', async () => {
  db.adjustBalance(groupId, 10n ** 18n);
  fx.snapshots = divergedSnapshots();
  const r = await scanGroup(db.groupById(groupId));

  assert.ok(r.submitted);
  // Only the source-side edge syncs (the receiver has nothing new to send).
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].from, 11155111);
  assert.equal(r.edges[0].to, 84532);
  const sentTx = fx.submitted.at(-1)[0];
  assert.equal(sentTx.chain, 11155111);
  assert.equal(sentTx.target, '0xs1');
  assert.match(sentTx.data, /^0x/);

  assert.equal(fx.payments.length, 1);
  assert.equal(fx.payments[0].klass, 'testnet'); // payment restricted to the group's network class

  const expectedDebit = 10n ** 15n + 150_000n * GWEI; // payment amount + gas allowance
  assert.equal(db.groupById(groupId).balance_wei, (10n ** 18n - expectedDebit).toString());
  const sync = db.syncsOf(groupId)[0];
  assert.equal(sync.state, 'submitted');
  assert.equal(JSON.parse(sync.plan_json).payment.hash, '0xpayhash');
});

test('an edge synced recently is NOT re-paid while its bridge message is in flight', async () => {
  // The previous test just submitted 11155111 -> 84532. The view is still
  // stale (message hasn't landed), but a rescan must not buy it again.
  fx.snapshots = divergedSnapshots();
  const before = fx.submitted.length;
  const r = await scanGroup(db.groupById(groupId));
  assert.equal(r.submitted, undefined);
  assert.ok(r.waiting >= 1);
  assert.equal(fx.submitted.length, before);
});

test('mesh growth refreshes members and migrates the group key', async () => {
  const grown = [...MEMBERS, { chainId: 421614, projectId: '2' }];
  fx.walk = { ...fx.walk, members: grown };
  fx.snapshots = new Map([
    ...agreeingSnapshots(),
    [421614, { chainId: 421614, truth: account(421614, 0n), beliefs: new Map() }],
  ]);
  await scanGroup(db.groupById(groupId));
  assert.equal(db.membersOf(groupId).length, 3);
  assert.equal(db.groupById(groupId).group_key, '84532:9'); // still smallest
  assert.ok(db.groupByMember(421614, '2'));
  fx.walk = { ...fx.walk, members: MEMBERS };
});

test('finalizePending: success bundle reconciles to payment amount + actual gas', async () => {
  const pending = db.pendingSyncs().find((s) => s.group_id === groupId);
  assert.ok(pending, 'previous test left a pending sync');
  const balanceBefore = BigInt(db.groupById(groupId).balance_wei);

  fx.bundle = { transactions: [{ status: { state: 'Success', data: { hash: '0xdest' } } }] };
  fx.receipt = { gasUsed: 80_000n, effectiveGasPrice: GWEI };
  await finalizePending();

  const row = db.syncsOf(groupId).find((s) => s.id === pending.id);
  assert.equal(row.state, 'success');
  const actual = 10n ** 15n + 80_000n * GWEI;
  assert.equal(row.final_cost_wei, actual.toString());
  // Refund = quoted - actual = (150k - 80k) * gwei
  assert.equal(BigInt(db.groupById(groupId).balance_wei), balanceBefore + 70_000n * GWEI);
});

test('finalizePending: failed tx marks the sync failed but still bills the payment', async () => {
  fx.walk = mkWalk('0xf1'); // fresh edge — cooldown holds the previous one
  fx.snapshots = divergedSnapshots();
  await scanGroup(db.groupById(groupId));
  const pending = db.pendingSyncs().find((s) => s.group_id === groupId);
  fx.bundle = { transactions: [{ status: { state: 'Failed' } }] };
  await finalizePending();
  assert.equal(db.syncsOf(groupId).find((s) => s.id === pending.id).state, 'failed');
});

test('finalizePending: unsettled fresh bundles are left alone', async () => {
  fx.walk = mkWalk('0xf2');
  fx.snapshots = divergedSnapshots();
  await scanGroup(db.groupById(groupId));
  const pending = db.pendingSyncs().find((s) => s.group_id === groupId);
  fx.bundle = { transactions: [{ status: { state: 'Pending' } }] };
  await finalizePending();
  assert.equal(db.syncsOf(groupId).find((s) => s.id === pending.id).state, 'submitted');
});

test('a SimulationReverted edge is dropped and the rest of the bundle resubmits', async () => {
  db.setStatus(groupId, 'active');
  // Both directions stale -> planner picks both edges.
  fx.snapshots = new Map([
    [11155111, { chainId: 11155111, truth: account(11155111, 1000n), beliefs: new Map() }],
    [84532, { chainId: 84532, truth: account(84532, 500n), beliefs: new Map() }],
  ]);
  const simErr = Object.assign(new Error('relayr POST /v1/bundle/prepaid HTTP 406'), {
    status: 406,
    body: '{"SimulationReverted":{"transaction":{"chain":11155111,"target":"0xs1","data":"0x","value":"0x0","virtual_nonce":null},"trace":{}}}',
  });
  fx.submitErrors.push(simErr);
  const r = await scanGroup(db.groupById(groupId));
  assert.ok(r.submitted);
  assert.equal(r.edges.length, 1); // survivor only
  assert.equal(r.edges[0].from, 84532);
  assert.equal(fx.submitted.at(-1).length, 1);
  const plan = JSON.parse(db.syncsOf(groupId)[0].plan_json);
  assert.deepEqual(plan.dropped, [{ chain: 11155111, target: '0xs1' }]);
});

test('non-simulation relayr failures still abort the scan for that group', async () => {
  fx.walk = mkWalk('0xf3');
  fx.snapshots = divergedSnapshots();
  fx.submitErrors.push(Object.assign(new Error('relayr HTTP 500'), { status: 500, body: 'oops' }));
  await assert.rejects(() => scanGroup(db.groupById(groupId)), /HTTP 500/);
});

test('payment failure surfaces as a scan error and nothing is debited', async () => {
  db.setStatus(groupId, 'active');
  fx.walk = mkWalk('0xf4');
  const balanceBefore = db.groupById(groupId).balance_wei;
  fx.snapshots = divergedSnapshots();
  fx.payThrows = new Error('keeper wallet cannot cover the relayr payment on any chain');
  await assert.rejects(() => scanGroup(db.groupById(groupId)), /cannot cover/);
  assert.equal(db.groupById(groupId).balance_wei, balanceBefore);
  fx.payThrows = null;
});

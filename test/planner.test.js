import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, dijkstra, pathTo } from '../src/planner.js';

const E = (from, to, cost = 1n, extra = {}) => ({ from, to, sucker: `s-${from}-${to}`, cost, value: 0n, usable: true, ...extra });

test('dijkstra picks the cheaper multi-hop path over an expensive direct edge', () => {
  const edges = [E(1, 3, 100n), E(1, 2, 1n), E(2, 3, 1n)];
  const path = pathTo(3, dijkstra(1, edges));
  assert.deepEqual(path.map((e) => `${e.from}>${e.to}`), ['1>2', '2>3']);
});

test('source-adjacent edge is ready; downstream hop waits for propagation', () => {
  // Path S=1 -> 2 -> 3 for stale pair (1,3). Chain 2's copy of 1 is stale too,
  // so only 1->2 runs this tick.
  const edges = [E(1, 2), E(2, 3)];
  const stale = [{ source: 1, viewer: 3 }, { source: 1, viewer: 2 }];
  const pctOf = () => 50; // everything stale
  const p = plan({ edges, stale, pctOf, threshold: 1 });
  assert.deepEqual(p.edges.map((e) => `${e.from}>${e.to}`), ['1>2']);
  assert.equal(p.waiting.length, 0); // pair (1,3) shares the ready edge
});

test('mid-path hop runs once the hub already holds good data', () => {
  const edges = [E(1, 2), E(2, 3)];
  const stale = [{ source: 1, viewer: 3 }];
  const pctOf = (source, viewer) => (viewer === 2 ? 0 : 50); // hub 2 is fresh
  const p = plan({ edges, stale, pctOf, threshold: 1 });
  assert.deepEqual(p.edges.map((e) => `${e.from}>${e.to}`), ['2>3']);
});

test('shared edge dedupes across stale pairs', () => {
  // Both 2 and 3 need chain 1's record; hub edge 1->2 serves the (1,2) pair and
  // the first hop of (1,3).
  const edges = [E(1, 2), E(2, 3)];
  const stale = [{ source: 1, viewer: 2 }, { source: 1, viewer: 3 }];
  const p = plan({ edges, stale, pctOf: () => 50, threshold: 1 });
  assert.equal(p.edges.length, 1);
});

test('unusable edges are excluded and pairs become unreachable', () => {
  const edges = [E(2, 1, 1n, { usable: false })]; // native L2->L1
  const p = plan({ edges, stale: [{ source: 2, viewer: 1 }], pctOf: () => 50, threshold: 1 });
  assert.equal(p.edges.length, 0);
  assert.deepEqual(p.unreachable, [{ source: 2, viewer: 1 }]);
});

test('parallel edges: cheaper one wins', () => {
  const cheap = { ...E(1, 2, 1n), sucker: 'cheap' };
  const dear = { ...E(1, 2, 50n), sucker: 'dear' };
  const p = plan({ edges: [dear, cheap], stale: [{ source: 1, viewer: 2 }], pctOf: () => 50, threshold: 1 });
  assert.deepEqual(p.edges.map((e) => e.sucker), ['cheap']);
});

test('hub consolidation: one shared edge into an expensive chain beats per-pair directs', () => {
  // Chains 2, 3, 4 all need their records on chain 1 (think: Ethereum L1).
  // Direct L2->L1 edges cost 100 each; the L2 mesh costs 1 per hop. Routing
  // through hub 3 uses ONE edge into chain 1 instead of three.
  const edges = [
    E(2, 1, 100n), E(3, 1, 100n), E(4, 1, 100n),
    E(2, 3, 1n), E(3, 2, 1n), E(2, 4, 1n), E(4, 2, 1n), E(3, 4, 1n), E(4, 3, 1n),
  ];
  const stale = [{ source: 2, viewer: 1 }, { source: 3, viewer: 1 }, { source: 4, viewer: 1 }];
  const p = plan({ edges, stale, pctOf: () => 50, threshold: 1 });
  const intoL1 = p.edges.filter((e) => e.to === 1);
  assert.equal(intoL1.length, 1, `expected a single edge into chain 1, got ${intoL1.map((e) => `${e.from}>1`)}`);
  // Round 1 fires the inbound consolidation legs plus the hub's own record
  // heading to L1; the other records follow through the hub on later rounds.
  assert.ok(p.edges.every((e) => e.to === 1 ? e.from === intoL1[0].from : e.to === intoL1[0].from));
});

test('totalValue sums transport payments of chosen edges', () => {
  const e1 = { ...E(1, 2), value: 100n };
  const e2 = { ...E(1, 3), value: 40n };
  const p = plan({
    edges: [e1, e2],
    stale: [{ source: 1, viewer: 2 }, { source: 1, viewer: 3 }],
    pctOf: () => 50,
    threshold: 1,
  });
  assert.equal(p.totalValue, 140n);
});

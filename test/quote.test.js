// Transport-fee probing: family detection, L2->L1 exclusion, binary search.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const p = (f) => new URL(f, import.meta.url).pathname;

// Per-sucker behavior fixtures.
const fx = new Map(); // sucker -> { ccip: bool, accepts: (value) => bool }

const actualChains = await import('../src/chains.js');
mock.module(p('../src/chains.js'), {
  namedExports: {
    ...actualChains,
    clientFor: () => ({
      readContract: async ({ address }) => {
        if (fx.get(address)?.ccip) return '0xrouter';
        throw new Error('no CCIP_ROUTER');
      },
      call: async ({ to, value }) => {
        if (!fx.get(to).accepts(value ?? 0n)) throw new Error('execution reverted');
        return { data: '0x' };
      },
    }),
  },
});

const { quoteEdge } = await import('../src/quote.js');

test('OP-family edge quotes value 0', async () => {
  fx.set('0xop', { ccip: false, accepts: (v) => v === 0n });
  const q = await quoteEdge({ from: 1, to: 10, sucker: '0xop' });
  assert.deepEqual({ usable: q.usable, family: q.family, value: q.value }, { usable: true, family: 'native', value: 0n });
});

test('native edge INTO an L1 is excluded even though the call would succeed', async () => {
  fx.set('0xnative-up', { ccip: false, accepts: () => true });
  const q = await quoteEdge({ from: 10, to: 1, sucker: '0xnative-up' });
  assert.equal(q.usable, false);
  assert.match(q.reason, /manual-relay/);
});

test('CCIP edge INTO an L1 stays usable (CCIP self-delivers)', async () => {
  fx.set('0xccip-up', { ccip: true, accepts: (v) => v >= 10n ** 14n });
  const q = await quoteEdge({ from: 10, to: 1, sucker: '0xccip-up' });
  assert.equal(q.usable, true);
  assert.equal(q.family, 'ccip');
});

test('CCIP quote = fee + ~20% drift pad', async () => {
  const FEE = 314_159_265_358_979n; // arbitrary ~3e14
  fx.set('0xccip', { ccip: true, accepts: (v) => v >= FEE });
  const q = await quoteEdge({ from: 8453, to: 42161, sucker: '0xccip' });
  assert.equal(q.usable, true);
  assert.ok(q.value >= (FEE * 119n) / 100n, `quote ${q.value} pads less than 20% over ${FEE}`);
  assert.ok(q.value <= (FEE * 123n) / 100n, `quote ${q.value} overshoots fee ${FEE}`);
});

test('Arb retryable (native L1->L2 with fee) gets a 2x pad — submission cost tracks basefee', async () => {
  const FEE = 6_408_691_406_250n;
  fx.set('0xarb', { ccip: false, accepts: (v) => v >= FEE });
  const q = await quoteEdge({ from: 1, to: 42161, sucker: '0xarb' });
  assert.equal(q.usable, true);
  assert.ok(q.value >= (FEE * 199n) / 100n && q.value <= (FEE * 205n) / 100n, `quote ${q.value} not ~2x ${FEE}`);
});

test('sucker that reverts at any value (deprecated/paused) is unusable', async () => {
  fx.set('0xdead', { ccip: false, accepts: () => false });
  const q = await quoteEdge({ from: 1, to: 10, sucker: '0xdead' });
  assert.equal(q.usable, false);
  assert.match(q.reason, /reverts-at-any-value/);
});

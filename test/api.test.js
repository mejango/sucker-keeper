// HTTP contract tests — the surface clients integrate against. Real server,
// real SQLite; the chain layer (mesh walk, RPC clients) and the loop bodies are
// module-mocked so nothing touches the network.
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const p = (f) => new URL(f, import.meta.url).pathname;
const KEEPER_PK = `0x${'33'.repeat(32)}`;
const DEPOSIT_ADDRESS = privateKeyToAccount(KEEPER_PK).address.toLowerCase();
const registrantAccount = privateKeyToAccount(`0x${'11'.repeat(32)}`);

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'keeper-api-')), 'api.db');
process.env.PORT = '0';
process.env.SCAN_INTERVAL = '99999';
process.env.KEEPER_PRIVATE_KEY = KEEPER_PK;

// Mutable fixtures the mocked layers read from.
const fx = {
  walk: null, // set per test
  tx: null, receipt: null, head: 0n,
};

const actualChains = await import('../src/chains.js');
const actualMesh = await import('../src/mesh.js');

mock.module(p('../src/mesh.js'), {
  namedExports: {
    ...actualMesh,
    walkGroup: async () => { if (fx.walk instanceof Error) throw fx.walk; return fx.walk; },
    snapshotGroup: async () => new Map(),
  },
});
mock.module(p('../src/chains.js'), {
  namedExports: {
    ...actualChains,
    clientFor: () => ({
      getTransaction: async () => fx.tx,
      getTransactionReceipt: async () => fx.receipt,
      getBlockNumber: async () => fx.head,
    }),
  },
});
mock.module(p('../src/tick.js'), {
  namedExports: { scanAll: async () => [], finalizePending: async () => {} },
});
mock.module(p('../src/bendystraw.js'), {
  namedExports: { projectLabel: async (chainId, projectId) => (String(projectId) === '5' ? 'Test Revnet' : null) },
});

const { start } = await import('../src/server.js');
let base;
let server;

before(async () => {
  server = start();
  await new Promise((r) => server.on('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const TESTNET_WALK = {
  members: [
    { chainId: 11155111, projectId: '5' },
    { chainId: 84532, projectId: '9' },
  ],
  edges: [
    { from: 11155111, to: 84532, sucker: '0xs1' },
    { from: 84532, to: 11155111, sucker: '0xs1' },
  ],
  unsupported: [],
};

test('POST /projects registers a group addressable by any member', async () => {
  fx.walk = TESTNET_WALK;
  const { status, body } = await api('POST', '/projects', {
    chainId: 11155111, projectId: '5', registrant: registrantAccount.address, thresholdPct: 2,
  });
  assert.equal(status, 201);
  assert.equal(body.groupKey, '84532:9'); // smallest chainId member, not the anchor
  assert.equal(body.networkClass, 'testnet');
  assert.equal(body.members.length, 2);

  const other = await api('GET', '/projects/84532/9');
  assert.equal(other.status, 200);
  assert.equal(other.body.groupKey, body.groupKey);
});

test('POST /projects rejections: bad input, no group, mixed classes, duplicate', async () => {
  const reg = registrantAccount.address;
  assert.equal((await api('POST', '/projects', { chainId: 999, projectId: '1', registrant: reg })).status, 400);
  assert.equal((await api('POST', '/projects', { chainId: 1, projectId: '1', registrant: 'not-an-address' })).status, 400);
  assert.equal((await api('POST', '/projects', { chainId: 1, projectId: '1', registrant: reg, thresholdPct: 0 })).status, 400);

  fx.walk = { members: [{ chainId: 1, projectId: '1' }], edges: [], unsupported: [] };
  assert.equal((await api('POST', '/projects', { chainId: 1, projectId: '1', registrant: reg })).status, 422);

  fx.walk = {
    members: [{ chainId: 1, projectId: '1' }, { chainId: 11155111, projectId: '2' }],
    edges: [{ from: 1, to: 11155111, sucker: '0xs' }],
    unsupported: [],
  };
  assert.equal((await api('POST', '/projects', { chainId: 1, projectId: '1', registrant: reg })).status, 422);

  fx.walk = TESTNET_WALK; // same group as the first test, anchored via the other member
  const dup = await api('POST', '/projects', { chainId: 84532, projectId: '9', registrant: reg });
  assert.equal(dup.status, 409);
});

test('GET /projects/:chainId/:projectId 404s for unknown members', async () => {
  assert.equal((await api('GET', '/projects/1/12345')).status, 404);
});

test('PATCH threshold: real EIP-191 signature accepted, others rejected', async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const message = `keeper:set-threshold:84532:9:5:${expiresAt}`;
  const signature = await registrantAccount.signMessage({ message });

  const ok = await api('PATCH', '/projects/11155111/5', { thresholdPct: 5, expiresAt, signature });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.thresholdPct, 5);

  const wrongSigner = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const forged = await wrongSigner.signMessage({ message: `keeper:set-threshold:84532:9:7:${expiresAt}` });
  assert.equal((await api('PATCH', '/projects/11155111/5', { thresholdPct: 7, expiresAt, signature: forged })).status, 403);

  const stale = await registrantAccount.signMessage({ message: `keeper:set-threshold:84532:9:7:1` });
  assert.equal((await api('PATCH', '/projects/11155111/5', { thresholdPct: 7, expiresAt: 1, signature: stale })).status, 400);

  // Replaying the valid signature with a different threshold fails (value is signed).
  assert.equal((await api('PATCH', '/projects/11155111/5', { thresholdPct: 9, expiresAt, signature })).status, 403);
});

test('POST /deposits credits a verified transfer and blocks replay', async () => {
  const value = 5n * 10n ** 18n;
  fx.tx = { to: DEPOSIT_ADDRESS, from: '0xF00000000000000000000000000000000000000F', value };
  fx.receipt = { status: 'success', blockNumber: 100n };
  fx.head = 105n;

  const ok = await api('POST', '/deposits', { txHash: '0xdd01', depositChainId: 84532, projectChainId: 11155111, projectId: '5' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.credited, value.toString());
  assert.equal(ok.body.balance, value.toString());

  assert.equal((await api('POST', '/deposits', { txHash: '0xdd01', depositChainId: 84532, projectChainId: 11155111, projectId: '5' })).status, 409);

  const acct = await api('GET', `/account/${fx.tx.from}`);
  assert.equal(acct.body.deposits.length, 1);
  assert.equal(acct.body.deposits[0].amountWei, value.toString());
});

test('POST /deposits rejections: wrong recipient, reverted, unconfirmed, class mismatch, unknown project', async () => {
  const good = { to: DEPOSIT_ADDRESS, from: '0xF00000000000000000000000000000000000000F', value: 10n ** 18n };
  const claim = (txHash, over = {}) => api('POST', '/deposits', {
    txHash, depositChainId: 84532, projectChainId: 11155111, projectId: '5', ...over,
  });

  fx.tx = { ...good, to: '0x0000000000000000000000000000000000000bad' };
  fx.receipt = { status: 'success', blockNumber: 100n }; fx.head = 105n;
  assert.equal((await claim('0xdd02')).status, 400);

  fx.tx = good;
  fx.receipt = { status: 'reverted', blockNumber: 100n };
  assert.equal((await claim('0xdd03')).status, 400);

  fx.receipt = { status: 'success', blockNumber: 105n }; fx.head = 105n; // 0 confs
  assert.equal((await claim('0xdd04')).status, 400);

  fx.receipt = { status: 'success', blockNumber: 100n }; fx.head = 105n;
  assert.equal((await claim('0xdd05', { depositChainId: 8453 })).status, 400); // mainnet ETH for a testnet group
  assert.equal((await claim('0xdd06', { projectChainId: 1, projectId: '999' })).status, 404);
});

test('GET /activity merges registrations, deposits, and syncs with labels, newest first', async () => {
  const { status, body } = await api('GET', '/activity?limit=10');
  assert.equal(status, 200);
  const types = body.activity.map((a) => a.type);
  assert.ok(types.includes('register'));
  assert.ok(types.includes('deposit'));
  const deposit = body.activity.find((a) => a.type === 'deposit');
  assert.equal(deposit.groupKey, '84532:9');
  assert.equal(deposit.label, 'Test Revnet'); // bendystraw enrichment (anchor member's projectId is 5)
  assert.equal(deposit.amountWei, (5n * 10n ** 18n).toString());
  const times = body.activity.map((a) => a.at);
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
});

test('GET /health reports loop state', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.depositAddress, DEPOSIT_ADDRESS);
  assert.ok(body.groups >= 1);
});

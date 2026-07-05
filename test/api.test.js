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
const depositorAccount = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const signClaim = (acct, { txHash, projectChainId, projectId, thresholdPct = 1, expiresAt }) =>
  acct.signMessage({ message: `keeper:claim:${txHash.toLowerCase()}:${projectChainId}:${projectId}:${thresholdPct}:${expiresAt}` });

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
      getTransactionReceipt: async () => {
        if (!fx.receipt) throw new Error('Transaction receipt with hash "0x…" could not be found. The Transaction may not be processed on a block yet.');
        return fx.receipt;
      },
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

test('POST /projects registers a sponsorship, addressable by any member', async () => {
  fx.walk = TESTNET_WALK;
  const { status, body } = await api('POST', '/projects', {
    chainId: 11155111, projectId: '5', sponsor: registrantAccount.address, thresholdPct: 2,
  });
  assert.equal(status, 201);
  assert.equal(body.groupKey, '84532:9'); // smallest chainId member, not the anchor
  assert.equal(body.networkClass, 'testnet');
  assert.equal(body.members.length, 2);
  assert.equal(body.sponsorships.length, 1);
  assert.equal(body.sponsorships[0].thresholdPct, 2);
  assert.equal(body.effectiveThresholdPct, null); // nobody funded yet

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
  const dup = await api('POST', '/projects', { chainId: 84532, projectId: '9', sponsor: reg });
  assert.equal(dup.status, 409); // same sponsor twice: no

  // A DIFFERENT sponsor on the same project is welcome — non-exclusive.
  const second = await api('POST', '/projects', { chainId: 84532, projectId: '9', sponsor: depositorAccount.address, thresholdPct: 7 });
  assert.equal(second.status, 201);
  assert.equal(second.body.sponsorships.length, 2);
});

test('GET /projects/:chainId/:projectId 404s for unknown members', async () => {
  assert.equal((await api('GET', '/projects/1/12345')).status, 404);
});

test('PATCH threshold: sponsor-signed, only affects that sponsorship', async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const message = `keeper:set-threshold:84532:9:5:${expiresAt}`;
  const signature = await registrantAccount.signMessage({ message });

  const ok = await api('PATCH', '/projects/11155111/5', { thresholdPct: 5, expiresAt, signature, sponsor: registrantAccount.address });
  assert.equal(ok.status, 200);
  const mine = ok.body.sponsorships.find((s) => s.sponsor === registrantAccount.address.toLowerCase());
  const theirs = ok.body.sponsorships.find((s) => s.sponsor === depositorAccount.address.toLowerCase());
  assert.equal(mine.thresholdPct, 5);
  assert.equal(theirs.thresholdPct, 7); // untouched

  const wrongSigner = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const forged = await wrongSigner.signMessage({ message: `keeper:set-threshold:84532:9:7:${expiresAt}` });
  assert.equal((await api('PATCH', '/projects/11155111/5', { thresholdPct: 7, expiresAt, signature: forged, sponsor: registrantAccount.address })).status, 403);

  const stale = await registrantAccount.signMessage({ message: `keeper:set-threshold:84532:9:7:1` });
  assert.equal((await api('PATCH', '/projects/11155111/5', { thresholdPct: 7, expiresAt: 1, signature: stale, sponsor: registrantAccount.address })).status, 400);

  // A non-sponsor can't set anything.
  const outsider = privateKeyToAccount(`0x${'66'.repeat(32)}`);
  const sig2 = await outsider.signMessage({ message });
  assert.equal((await api('PATCH', '/projects/11155111/5', { thresholdPct: 5, expiresAt, signature: sig2, sponsor: outsider.address })).status, 404);
});

test('POST /deposits: sender-signed claim credits the SENDER\'s own sponsorship; forgeries rejected', async () => {
  const value = 5n * 10n ** 18n;
  fx.tx = { to: DEPOSIT_ADDRESS, from: depositorAccount.address, value };
  fx.receipt = { status: 'success', blockNumber: 100n };
  fx.head = 105n;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const target = { txHash: '0xdd01', projectChainId: 11155111, projectId: '5', expiresAt };

  // A thief who saw the tx on-chain cannot claim it: signature must be tx.from's.
  const thief = privateKeyToAccount(`0x${'77'.repeat(32)}`);
  const stolenSig = await signClaim(thief, target);
  const theft = await api('POST', '/deposits', { txHash: '0xdd01', depositChainId: 84532, projectChainId: 11155111, projectId: '5', expiresAt, signature: stolenSig });
  assert.equal(theft.status, 403);

  const signature = await signClaim(depositorAccount, target);
  const ok = await api('POST', '/deposits', { txHash: '0xdd01', depositChainId: 84532, projectChainId: 11155111, projectId: '5', expiresAt, signature });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.credited, value.toString());
  assert.equal(ok.body.sponsor, depositorAccount.address.toLowerCase());
  assert.equal(ok.body.balance, value.toString()); // the sender's own sponsorship pot

  assert.equal((await api('POST', '/deposits', { txHash: '0xdd01', depositChainId: 84532, projectChainId: 11155111, projectId: '5', expiresAt, signature })).status, 409);

  const acct = await api('GET', `/account/${depositorAccount.address}`);
  assert.equal(acct.body.deposits.length, 1);
  assert.equal(acct.body.deposits[0].amountWei, value.toString());
  assert.ok(acct.body.sponsorships.some((s) => s.groupKey === '84532:9' && s.balanceWei === value.toString()));
});

test('POST /deposits rejections: wrong recipient, reverted, unconfirmed, class mismatch, unknown project', async () => {
  const good = { to: DEPOSIT_ADDRESS, from: depositorAccount.address, value: 10n ** 18n };
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const claim = async (txHash, over = {}) => api('POST', '/deposits', {
    txHash, depositChainId: 84532, projectChainId: 11155111, projectId: '5', expiresAt,
    signature: await signClaim(depositorAccount, { txHash, projectChainId: over.projectChainId ?? 11155111, projectId: over.projectId ?? '5', expiresAt }),
    ...over,
  });

  fx.tx = { ...good, to: '0x0000000000000000000000000000000000000bad' };
  fx.receipt = { status: 'success', blockNumber: 100n }; fx.head = 105n;
  assert.equal((await claim('0xdd02')).status, 400);

  fx.tx = good;
  fx.receipt = { status: 'reverted', blockNumber: 100n };
  assert.equal((await claim('0xdd03')).status, 400);

  // Pending states are 202 "not yet", not errors: 0 confirmations…
  fx.receipt = { status: 'success', blockNumber: 105n }; fx.head = 105n;
  const zeroConf = await claim('0xdd04');
  assert.equal(zeroConf.status, 202);
  assert.equal(zeroConf.body.pending, true);
  // …and a receipt the RPC can't find yet.
  fx.receipt = null;
  const unmined = await claim('0xdd04b');
  assert.equal(unmined.status, 202);
  assert.equal(unmined.body.pending, true);

  fx.receipt = { status: 'success', blockNumber: 100n }; fx.head = 105n;
  assert.equal((await claim('0xdd05', { depositChainId: 8453 })).status, 400); // mainnet ETH for a testnet group

  // Unknown project with no sucker group: auto-registration fails cleanly.
  fx.walk = { members: [{ chainId: 1, projectId: '999' }], edges: [], unsupported: [] };
  assert.equal((await claim('0xdd06', { projectChainId: 1, projectId: '999' })).status, 422);
});

test('funding an unregistered project auto-registers it with the signed threshold', async () => {
  fx.walk = {
    members: [{ chainId: 11155420, projectId: '77' }, { chainId: 421614, projectId: '78' }],
    edges: [{ from: 11155420, to: 421614, sucker: '0xs9' }, { from: 421614, to: 11155420, sucker: '0xs9' }],
    unsupported: [],
  };
  const value = 10n ** 17n;
  fx.tx = { to: DEPOSIT_ADDRESS, from: depositorAccount.address, value };
  fx.receipt = { status: 'success', blockNumber: 100n };
  fx.head = 105n;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const signature = await signClaim(depositorAccount, { txHash: '0xdd07', projectChainId: 11155420, projectId: '77', thresholdPct: 3, expiresAt });
  const ok = await api('POST', '/deposits', {
    txHash: '0xdd07', depositChainId: 84532, projectChainId: 11155420, projectId: '77',
    thresholdPct: 3, expiresAt, signature,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.groupKey, '421614:78');
  assert.equal(ok.body.thresholdPct, 3);

  const view = await api('GET', '/projects/421614/78');
  assert.equal(view.status, 200); // registered without ever calling POST /projects
  assert.equal(view.body.sponsorships[0].thresholdPct, 3);
  assert.equal(view.body.sponsorships[0].balanceWei, value.toString());
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

test('admin reattribute-deposit moves a misfiled credit between groups', async () => {
  // Register a second group to move the deposit to.
  fx.walk = {
    members: [{ chainId: 11155111, projectId: '7' }, { chainId: 84532, projectId: '11' }],
    edges: [{ from: 11155111, to: 84532, sucker: '0xs2' }, { from: 84532, to: 11155111, sucker: '0xs2' }],
    unsupported: [],
  };
  await api('POST', '/projects', { chainId: 11155111, projectId: '7', sponsor: registrantAccount.address });

  const move = (headers) => fetch(base + '/admin/reattribute-deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ txHash: '0xdd01', toChainId: 84532, toProjectId: '11' }),
  });

  assert.equal((await move({})).status, 404); // disabled without ADMIN_TOKEN
  process.env.ADMIN_TOKEN = 'sekret';
  assert.equal((await move({ 'x-admin-token': 'wrong' })).status, 403);

  const ok = await move({ 'x-admin-token': 'sekret' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.toGroup, '84532:11');
  assert.equal(body.toBalance, (5n * 10n ** 18n).toString());

  const from = await api('GET', '/projects/11155111/5');
  assert.equal(from.body.balanceWei, '0'); // original group's pool debited back
  delete process.env.ADMIN_TOKEN;
});

test('GET /health reports loop state', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.depositAddress, DEPOSIT_ADDRESS);
  assert.ok(body.groups >= 1);
});

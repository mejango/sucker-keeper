// Wire format of Relayr submissions and the wallet's payment-option selection.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const p = (f) => new URL(f, import.meta.url).pathname;

// --- relayr.js: capture fetch ---
const fetches = [];
let fetchResponse = { ok: true, json: async () => ({ bundle_uuid: 'u-1', payment_info: [{ chain: 1 }] }) };
globalThis.fetch = async (url, opts) => { fetches.push({ url, opts }); return fetchResponse; };

const { submitPrepaidBundle, getBundle, txState, txDestHash } = await import('../src/relayr.js');

test('submitPrepaidBundle sends plain txs with stringified values, Disabled nonce mode', async () => {
  delete process.env.RELAYR_API_KEY;
  const { bundleUuid, paymentInfo } = await submitPrepaidBundle([
    { chain: 11155111, target: '0xsucker', data: '0xabcd', value: 123n },
  ]);
  assert.equal(bundleUuid, 'u-1');
  assert.equal(paymentInfo.length, 1);
  const { url, opts } = fetches.at(-1);
  assert.match(url, /\/v1\/bundle\/prepaid$/);
  const body = JSON.parse(opts.body);
  assert.equal(body.virtual_nonce_mode, 'Disabled');
  assert.deepEqual(body.transactions, [{ chain: 11155111, target: '0xsucker', data: '0xabcd', value: '123' }]);
  assert.equal(opts.headers['x-api-key'], undefined); // key is optional for prepaid
});

test('RELAYR_API_KEY, when set, rides along as x-api-key (not Authorization)', async () => {
  process.env.RELAYR_API_KEY = 'k-123';
  await getBundle('u-1');
  const { opts } = fetches.at(-1);
  assert.equal(opts.headers['x-api-key'], 'k-123');
  assert.equal(opts.headers.Authorization, undefined);
  delete process.env.RELAYR_API_KEY;
});

test('relayr errors carry status + response detail', async () => {
  fetchResponse = { ok: false, status: 406, text: async () => 'SimulationReverted: boom' };
  await assert.rejects(() => getBundle('u-1'), /HTTP 406.*SimulationReverted/);
  fetchResponse = { ok: true, json: async () => ({}) };
});

test('bundle tx status parsing tolerates both shapes', () => {
  assert.equal(txState({ status: { state: 'Success', data: { hash: '0x1' } } }), 'Success');
  assert.equal(txDestHash({ status: { state: 'Success', data: { hash: '0x1' } } }), '0x1');
  assert.equal(txDestHash({ status: { state: 'Executing', data: { transaction: { hash: '0x2' } } } }), '0x2');
  assert.equal(txDestHash({}), null);
});

// --- wallet.js: payment option selection (viem wallet client mocked away) ---
const balances = new Map(); // chainId -> bigint
const sent = [];
const actualChains = await import('../src/chains.js');
mock.module(p('../src/chains.js'), {
  namedExports: {
    ...actualChains,
    clientFor: (id) => ({ getBalance: async () => balances.get(Number(id)) ?? 0n }),
  },
});
mock.module('viem', {
  namedExports: {
    ...(await import('viem')),
    createWalletClient: () => ({
      sendTransaction: async (tx) => { sent.push(tx); return '0xhash'; },
    }),
  },
});
process.env.KEEPER_PRIVATE_KEY = `0x${'44'.repeat(32)}`;
const { payRelayr } = await import('../src/wallet.js');

const opt = (chain, amount) => ({ chain, target: '0xrelayr', amount: amount.toString(), calldata: '0xdead', token: '0x0' });

test('payRelayr filters by network class and picks the richest funded chain', async () => {
  balances.set(10, 5n * 10n ** 15n); // op: affordable
  balances.set(8453, 9n * 10n ** 15n); // base: richer, also affordable
  balances.set(11155420, 10n ** 20n); // testnet whale — must be ignored for a mainnet group
  const paid = await payRelayr([opt(10, 10n ** 15n), opt(8453, 10n ** 15n), opt(11155420, 1n)], 'mainnet');
  assert.equal(paid.chain, 8453);
  assert.equal(paid.amount, 10n ** 15n);
  assert.equal(sent.at(-1).to, '0xrelayr');
  assert.equal(sent.at(-1).value, 10n ** 15n);
  assert.equal(sent.at(-1).data, '0xdead');
});

test('payRelayr throws when no supported-class option is affordable', async () => {
  balances.clear();
  balances.set(10, 1n); // dust
  await assert.rejects(() => payRelayr([opt(10, 10n ** 15n)], 'mainnet'), /cannot cover/);
  await assert.rejects(() => payRelayr([opt(999, 1n)], 'mainnet'), /no payment option/);
});

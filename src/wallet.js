// The keeper's own hot wallet. Its address doubles as the deposit address —
// registrants fund the same pot the keeper pays Relayr from, so the service is
// fully self-managing: no Relayr org balance, no manual top-ups.
// ponytail: deposits land on whichever chain the registrant chose while Relayr
// payments need funds on one specific chain — the keeper doesn't bridge between
// its own chain balances. /health exposes per-chain balances so the operator
// can rebalance manually if one chain runs dry.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, clientFor, rpcFor, viemChainFor, networkClass } from './chains.js';

let account;

export function keeperAccount() {
  if (!account) {
    const pk = process.env.KEEPER_PRIVATE_KEY;
    if (!pk) throw new Error('KEEPER_PRIVATE_KEY not configured');
    account = privateKeyToAccount(pk);
  }
  return account;
}

export function keeperAddress() {
  return keeperAccount().address.toLowerCase();
}

export async function walletBalances() {
  const out = {};
  await Promise.all(Object.keys(CHAINS).map(async (id) => {
    try {
      out[id] = (await clientFor(id).getBalance({ address: keeperAccount().address })).toString();
    } catch {
      out[id] = null;
    }
  }));
  return out;
}

// Pick a payment option the wallet can afford (matching the group's network
// class) and pay it. Prefers the chain where the wallet is richest so balances
// drain evenly. Returns what was paid so billing can record it.
export async function payRelayr(paymentInfo, klass) {
  const options = paymentInfo.filter((o) => CHAINS[Number(o.chain)] && networkClass(o.chain) === klass);
  if (!options.length) throw new Error('relayr offered no payment option on a supported chain');

  const funded = [];
  for (const o of options) {
    const balance = await clientFor(o.chain).getBalance({ address: keeperAccount().address });
    funded.push({ o, balance });
  }
  funded.sort((a, b) => (a.balance > b.balance ? -1 : 1));
  const headroom = 10n ** 15n; // gas for the payment tx itself
  const pick = funded.find(({ o, balance }) => balance >= BigInt(o.amount) + headroom);
  if (!pick) {
    throw new Error(`keeper wallet cannot cover the relayr payment on any chain (need ${options.map((o) => `${o.amount} on ${o.chain}`).join(' | ')})`);
  }

  const wallet = createWalletClient({
    account: keeperAccount(),
    chain: viemChainFor(pick.o.chain),
    transport: http(rpcFor(pick.o.chain)),
  });
  const hash = await wallet.sendTransaction({
    to: pick.o.target,
    value: BigInt(pick.o.amount),
    data: pick.o.calldata,
  });
  return { chain: Number(pick.o.chain), amount: BigInt(pick.o.amount), hash };
}

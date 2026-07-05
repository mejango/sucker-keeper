// Deposit claiming. Registrants fund a group by sending ETH straight to the
// keeper's wallet address on any supported chain of the group's network class,
// then claiming the tx hash here for attribution (native transfers emit no
// logs, so hash-claiming beats block scanning). The same wallet pays Relayr,
// so the service is self-funding end to end.
// ponytail: only direct EOA sends verify — value moved by internal calls won't;
// documented in the README.
import { clientFor, networkClass, isSupported } from './chains.js';
import { keeperAddress } from './wallet.js';
import * as db from './db.js';

export async function claimDeposit({ txHash, chainId, projectChainId, projectId }) {
  if (!isSupported(chainId)) throw httpError(400, `unsupported chain ${chainId}`);
  const depositAddress = keeperAddress();

  const group = db.groupByMember(projectChainId, projectId);
  if (!group) throw httpError(404, 'project not registered');
  if (networkClass(chainId) !== group.network_class) {
    throw httpError(400, `${group.network_class} group must be funded from a ${group.network_class} chain`);
  }
  if (db.depositByHash(txHash)) throw httpError(409, 'deposit already claimed');

  const client = clientFor(chainId);
  let tx, receipt, head;
  const pending = { pending: true, message: 'tx not confirmed yet — it will be creditable once mined' };
  try {
    [tx, receipt, head] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
      client.getBlockNumber(),
    ]);
  } catch (err) {
    // Not an error — the tx just hasn't been mined yet. Callers poll.
    if (/could not be found|not be processed/i.test(err.message || '')) return pending;
    throw err;
  }
  if (receipt.status !== 'success') throw httpError(400, 'tx reverted');
  if (tx.to?.toLowerCase() !== depositAddress) throw httpError(400, 'tx is not a transfer to the deposit address');
  if (tx.value === 0n) throw httpError(400, 'tx carries no value');
  if (head < receipt.blockNumber + 1n) return pending;

  db.insertDeposit({ txHash, chainId, from: tx.from, amountWei: tx.value, groupId: group.id });
  const balance = db.adjustBalance(group.id, tx.value);
  if (group.status === 'underfunded') db.setStatus(group.id, 'active');
  return { credited: tx.value.toString(), balance: balance.toString(), groupKey: group.group_key };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Deposit claiming. A deposit is ETH sent straight to the keeper's wallet;
// the claim attributes it — and ONLY the sender can claim, by signing the
// claim (EIP-191). Without that, claims would be first-come-first-served on a
// public tx hash: anyone watching the keeper wallet on-chain could front-run
// the depositor and credit their own project. The credit lands on the
// sender's OWN sponsorship of the named project (created on the fly if new),
// so funds are never usable by anyone but their sender.
// ponytail: only direct EOA sends verify — value moved by internal calls
// won't, and the sender must be able to sign (exchange withdrawals can't).
import { verifyMessage } from 'viem';
import { clientFor, networkClass, isSupported } from './chains.js';
import { keeperAddress } from './wallet.js';
import * as db from './db.js';

export const DEFAULT_THRESHOLD_PCT = 1;

export function claimMessage({ txHash, projectChainId, projectId, expiresAt }) {
  return `keeper:claim:${txHash.toLowerCase()}:${projectChainId}:${projectId}:${expiresAt}`;
}

export async function claimDeposit({ txHash, chainId, projectChainId, projectId, expiresAt, signature }) {
  if (!isSupported(chainId)) throw httpError(400, `unsupported chain ${chainId}`);
  const depositAddress = keeperAddress();

  const group = db.groupByMember(projectChainId, projectId);
  if (!group) throw httpError(404, 'project not registered — register it first (free)');
  if (networkClass(chainId) !== group.network_class) {
    throw httpError(400, `${group.network_class} group must be funded from a ${group.network_class} chain`);
  }
  if (db.depositByHash(txHash)) throw httpError(409, 'deposit already claimed');
  if (!expiresAt || expiresAt < Date.now() / 1000) throw httpError(400, 'expired or missing expiresAt');

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

  // Only the sender may attribute their deposit.
  const message = claimMessage({ txHash, projectChainId, projectId, expiresAt });
  const ok = await verifyMessage({ address: tx.from, message, signature }).catch(() => false);
  if (!ok) throw httpError(403, 'claim must be signed by the depositing address');

  let sponsorship = db.sponsorshipOf(group.id, tx.from);
  if (!sponsorship) {
    db.createSponsorship({ groupId: group.id, sponsor: tx.from, thresholdPct: DEFAULT_THRESHOLD_PCT });
    sponsorship = db.sponsorshipOf(group.id, tx.from);
  }
  db.insertDeposit({ txHash, chainId, from: tx.from, amountWei: tx.value, groupId: group.id });
  const balance = db.adjustSponsorBalance(sponsorship.id, tx.value);
  if (sponsorship.status === 'underfunded') db.setSponsorStatus(sponsorship.id, 'active');
  return {
    credited: tx.value.toString(),
    balance: balance.toString(),
    sponsor: tx.from.toLowerCase(),
    thresholdPct: sponsorship.threshold_pct,
    groupKey: group.group_key,
  };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

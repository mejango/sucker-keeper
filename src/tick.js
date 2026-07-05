// The scan/execute/finalize loop bodies. One tick scans every active group,
// executes the currently-ready sync edges via a Relayr prepaid bundle paid from
// the keeper's own wallet, and reconciles pending bundles.
import { encodeFunctionData } from 'viem';
import * as db from './db.js';
import { clientFor } from './chains.js';
import { SUCKER_ABI } from './abi.js';
import { walkGroup, snapshotGroup, groupKeyOf } from './mesh.js';
import { divergenceMatrix, stalePairs } from './monitor.js';
import { plan } from './planner.js';
import { quoteEdge } from './quote.js';
import { submitPrepaidBundle, getBundle, txState } from './relayr.js';
import { payRelayr } from './wallet.js';

const SYNC_CALLDATA = encodeFunctionData({ abi: SUCKER_ABI, functionName: 'syncAccountingData' });
// ponytail: flat hop penalty so zero-fee OP edges still prefer fewer hops.
const HOP_PENALTY = 10n ** 13n;
// Gas allowance for the keeper's payment tx, reconciled to its receipt later.
const PAYMENT_GAS_ALLOWANCE = 150_000n;
const SYNC_TIMEOUT_S = 24 * 3600;

// Relayr simulates every tx before quoting and 406s the WHOLE bundle if any
// one reverts (e.g. a bridge fee that drifted past its pad). Rather than lose
// the round, drop the offending edge and resubmit the rest — the dropped edge
// re-quotes fresh on the next scan.
function parseSimulationRevertedTx(err) {
  if (err?.status !== 406) return null;
  const m = /"SimulationReverted".*?"chain"\s*:\s*(\d+)\s*,\s*"target"\s*:\s*"([^"]+)"/s.exec(err.body || '');
  return m ? { chain: Number(m[1]), target: m[2].toLowerCase() } : null;
}

async function submitDroppingRevertedEdges(txs) {
  const dropped = [];
  let remaining = txs;
  for (let attempt = 0; attempt < 6 && remaining.length; attempt++) {
    try {
      const res = await submitPrepaidBundle(remaining);
      return { ...res, submittedTxs: remaining, dropped };
    } catch (err) {
      const failing = parseSimulationRevertedTx(err);
      if (!failing) throw err;
      dropped.push(failing);
      remaining = remaining.filter((t) => !(Number(t.chain) === failing.chain && t.target.toLowerCase() === failing.target));
    }
  }
  throw new Error(`relayr simulation rejected the bundle even after dropping ${dropped.length} edge(s)`);
}

export async function scanGroup(group) {
  const stored = db.membersOf(group.id);

  // Re-walk the mesh from any member that still resolves (groups can grow).
  let walk;
  for (const m of stored) {
    try { walk = await walkGroup(m.chainId, m.projectId); break; } catch {}
  }
  if (!walk) throw new Error('mesh walk failed from every stored member');
  db.replaceMembers(group.id, walk.members);
  const freshKey = groupKeyOf(walk.members);
  if (freshKey !== group.group_key) db.setGroupKey(group.id, freshKey);

  const snapshots = await snapshotGroup(walk.members);
  const matrix = divergenceMatrix(snapshots);
  const stale = stalePairs(matrix, group.threshold_pct);
  if (stale.length === 0) {
    if (group.status === 'underfunded') db.setStatus(group.id, 'active');
    return { groupKey: freshKey, inSync: true };
  }

  const pctByPair = new Map(matrix.map((r) => [`${r.source}:${r.viewer}`, r.pct]));
  const pctOf = (source, viewer) => pctByPair.get(`${source}:${viewer}`) ?? 100;

  const quoted = [];
  for (const e of walk.edges) {
    const q = await quoteEdge(e);
    quoted.push({ ...e, usable: q.usable, value: q.value ?? 0n, cost: (q.value ?? 0n) + HOP_PENALTY, family: q.family, reason: q.reason });
  }

  const p = plan({ edges: quoted, stale, pctOf, threshold: group.threshold_pct });
  if (p.edges.length === 0) {
    return { groupKey: freshKey, inSync: false, stale: stale.length, waiting: p.waiting.length, unreachable: p.unreachable };
  }

  // Submit first: the bundle is a free quote until it's paid. If the group
  // can't afford it, let it expire unpaid.
  const txs = p.edges.map((e) => ({ chain: e.from, target: e.sucker, data: SYNC_CALLDATA, value: e.value }));
  const { bundleUuid, paymentInfo, submittedTxs, dropped } = await submitDroppingRevertedEdges(txs);
  const submittedEdges = p.edges.filter((e) =>
    submittedTxs.some((t) => t.chain === e.from && t.target === e.sucker));
  const options = paymentInfo.filter((o) => BigInt(o.amount) > 0n);
  if (!options.length) throw new Error('relayr returned no payment options');
  const cheapest = options.reduce((min, o) => (BigInt(o.amount) < BigInt(min.amount) ? o : min));
  const gasPrice = await clientFor(cheapest.chain).getGasPrice();
  const estimate = BigInt(cheapest.amount) + PAYMENT_GAS_ALLOWANCE * gasPrice;

  if (BigInt(group.balance_wei) < estimate) {
    db.setStatus(group.id, 'underfunded');
    return { groupKey: freshKey, inSync: false, underfunded: true, needWei: estimate.toString() };
  }

  const paid = await payRelayr(paymentInfo, group.network_class);
  const debit = paid.amount + PAYMENT_GAS_ALLOWANCE * gasPrice;
  const planRecord = {
    edges: submittedEdges.map((e) => ({ from: e.from, to: e.to, sucker: e.sucker, value: e.value.toString(), family: e.family })),
    dropped: dropped.length ? dropped : undefined,
    stale: stale.map((s) => ({ source: s.source, viewer: s.viewer, pct: s.pct })),
    payment: { chain: paid.chain, amount: paid.amount.toString(), hash: paid.hash },
  };
  db.insertSync({ groupId: group.id, plan: planRecord, bundleUuid, quotedCostWei: debit });
  db.adjustBalance(group.id, -debit);
  if (group.status === 'underfunded') db.setStatus(group.id, 'active');
  return { groupKey: freshKey, inSync: false, submitted: bundleUuid, edges: planRecord.edges, estimateWei: debit.toString() };
}

export async function scanAll() {
  const results = [];
  for (const group of db.activeGroups()) {
    try {
      results.push(await scanGroup(group));
    } catch (err) {
      results.push({ groupKey: group.group_key, error: err.message });
    }
  }
  return results;
}

// Reconcile pending Relayr bundles: on terminal state (or timeout), the true
// cost is the payment amount plus the payment tx's actual gas — adjust the
// group's balance by (quoted - actual).
export async function finalizePending() {
  for (const sync of db.pendingSyncs()) {
    try {
      const { payment } = JSON.parse(sync.plan_json);
      const bundle = await getBundle(sync.relayr_bundle_uuid);
      const txs = bundle.transactions || [];
      const anyFailed = txs.some((t) => txState(t) === 'Failed');
      const allSettled = txs.length > 0 && txs.every((t) => ['Success', 'Failed'].includes(txState(t)));
      const expired = Math.floor(Date.now() / 1000) - sync.created_at > SYNC_TIMEOUT_S;
      if (!allSettled && !expired) continue;

      let actual = BigInt(payment.amount);
      try {
        const r = await clientFor(payment.chain).getTransactionReceipt({ hash: payment.hash });
        actual += r.gasUsed * r.effectiveGasPrice;
      } catch {}

      db.adjustBalance(sync.group_id, BigInt(sync.quoted_cost_wei) - actual);
      db.resolveSync(sync.id, { state: anyFailed || (expired && !allSettled) ? 'failed' : 'success', finalCostWei: actual });
    } catch (err) {
      console.log(JSON.stringify({ at: 'finalizePending', sync: sync.id, error: err.message }));
    }
  }
}

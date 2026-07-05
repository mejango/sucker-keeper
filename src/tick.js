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
// Longer than worst-case bridge delivery (CCIP ~20 min) so an edge isn't
// re-paid while its message is still in flight.
const EDGE_COOLDOWN_S = 30 * 60;

// Edges whose Relayr simulation reverted recently. Observed live: the native
// eth->arb retryable passes our eth_call probe (even at 2x) yet keeps
// reverting in Relayr's simulation, and the planner keeps picking it because
// it quotes cheapest. Backing a sim-reverted edge off as unusable makes
// Dijkstra route around it (e.g. eth->op->arb over CCIP) instead of retrying
// a known-bad edge every scan.
// ponytail: in-memory — a redeploy retries each bad edge once, which is free
// (unpaid bundles cost nothing).
const SIM_FAIL_BACKOFF_S = 2 * 3600;
const simFailures = new Map(); // `${chain}:${sucker}` -> unix seconds of last SimulationReverted

function simBackoffActive(chain, sucker) {
  const at = simFailures.get(`${chain}:${sucker}`);
  return at != null && Date.now() / 1000 - at < SIM_FAIL_BACKOFF_S;
}

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
      simFailures.set(`${failing.chain}:${failing.target}`, Date.now() / 1000);
      dropped.push(failing);
      remaining = remaining.filter((t) => !(Number(t.chain) === failing.chain && t.target.toLowerCase() === failing.target));
    }
  }
  // Every fireable edge simulated as reverting (or attempts ran out). Not an
  // error — nothing was paid; the backoff reroutes future rounds.
  return { allDropped: true, dropped };
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
    if (simBackoffActive(e.from, e.sucker)) {
      quoted.push({ ...e, usable: false, value: 0n, cost: 0n, reason: 'relayr-simulation-reverted-recently' });
      continue;
    }
    const q = await quoteEdge(e);
    quoted.push({ ...e, usable: q.usable, value: q.value ?? 0n, cost: (q.value ?? 0n) + HOP_PENALTY, family: q.family, reason: q.reason });
  }

  const p = plan({ edges: quoted, stale, pctOf, threshold: group.threshold_pct });

  // Bridge messages land slower than the scan interval (CCIP ~15-20 min vs
  // 5-min scans). An edge synced recently still LOOKS necessary — the receiver
  // hasn't heard yet — but paying again buys nothing. Cool synced edges down
  // for longer than worst-case delivery before re-firing them.
  const inFlight = db.recentSyncEdges(group.id, EDGE_COOLDOWN_S);
  const fireable = p.edges.filter((e) => !inFlight.has(`${e.from}:${e.sucker}`));
  if (fireable.length === 0) {
    return {
      groupKey: freshKey, inSync: false, stale: stale.length,
      waiting: p.waiting.length + (p.edges.length - fireable.length), unreachable: p.unreachable,
    };
  }

  // Submit first: the bundle is a free quote until it's paid. If the group
  // can't afford it, let it expire unpaid.
  const txs = fireable.map((e) => ({ chain: e.from, target: e.sucker, data: SYNC_CALLDATA, value: e.value }));
  const submission = await submitDroppingRevertedEdges(txs);
  if (submission.allDropped) {
    return { groupKey: freshKey, inSync: false, stale: stale.length, simReverted: submission.dropped };
  }
  const { bundleUuid, paymentInfo, submittedTxs, dropped } = submission;
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

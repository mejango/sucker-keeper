// The scan/execute/finalize loop bodies. One tick scans every group with a
// funded sponsorship, executes the currently-ready sync edges via a Relayr
// prepaid bundle paid from the keeper's own wallet, and reconciles pending
// bundles. Costs split evenly among the sponsors whose thresholds triggered
// the sync.
import { encodeFunctionData } from 'viem';
import * as db from './db.js';
import { clientFor, isL1 } from './chains.js';
import { SUCKER_ABI } from './abi.js';
import { walkGroup, snapshotGroup, groupKeyOf } from './mesh.js';
import { divergenceMatrix, stalePairs } from './monitor.js';
import { plan } from './planner.js';
import { quoteEdge } from './quote.js';
import { submitPrepaidBundle, getBundle, txState } from './relayr.js';
import { payRelayr } from './wallet.js';

const SYNC_CALLDATA = encodeFunctionData({ abi: SUCKER_ABI, functionName: 'syncAccountingData' });
// ponytail: flat hop penalty so zero-cost edges still prefer fewer hops.
const HOP_PENALTY = 10n ** 13n;
// Execution gas a sync roughly burns on its origin chain. Priced into edge
// costs so the planner avoids expensive origins — above all Ethereum L1:
// ideally one eth->L2 push and one L2->eth return, with L2s gossiping the rest.
const EXEC_GAS_PER_SYNC = 400_000n;
// Gas allowance for the keeper's payment tx, reconciled to its receipt later.
const PAYMENT_GAS_ALLOWANCE = 150_000n;
const SYNC_TIMEOUT_S = 24 * 3600;
// Longer than worst-case bridge delivery (CCIP ~20 min) so an edge isn't
// re-paid while its message is still in flight.
const EDGE_COOLDOWN_S = 30 * 60;

// Edges whose Relayr simulation reverted recently. Observed live: native
// eth->arb retryables pass our eth_call probe (even at 2x) yet keep reverting
// in Relayr's simulation. Backing them off as unusable makes Dijkstra route
// around them instead of retrying a known-bad edge every scan.
// ponytail: in-memory — a redeploy retries each bad edge once, which is free
// (unpaid bundles cost nothing).
const SIM_FAIL_BACKOFF_S = 2 * 3600;
const simFailures = new Map(); // `${chain}:${sucker}` -> unix seconds of last SimulationReverted

function simBackoffActive(chain, sucker) {
  const at = simFailures.get(`${chain}:${sucker}`);
  return at != null && Date.now() / 1000 - at < SIM_FAIL_BACKOFF_S;
}

// Relayr simulates every tx before quoting and 406s the WHOLE bundle if any
// one reverts. Rather than lose the round, drop the offending edge and
// resubmit the rest — the dropped edge re-quotes fresh on the next scan.
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

// Split `estimate` evenly among the funded sponsors whose thresholds
// triggered (threshold <= worst observed divergence), dropping any that can't
// cover their share. Returns null when nobody can pay.
function pickPayers(funded, maxStalePct, estimate) {
  let payers = funded.filter((s) => s.threshold_pct <= maxStalePct);
  while (payers.length) {
    const share = estimate / BigInt(payers.length);
    const cant = payers.filter((s) => BigInt(s.balance_wei) < share + 1n);
    if (!cant.length) break;
    for (const s of cant) db.setSponsorStatus(s.id, 'underfunded');
    payers = payers.filter((s) => !cant.includes(s));
  }
  if (!payers.length) return null;
  const base = estimate / BigInt(payers.length);
  const remainder = estimate - base * BigInt(payers.length);
  return payers.map((s, i) => ({ sponsorshipId: s.id, sponsor: s.sponsor_address, shareWei: base + (i === 0 ? remainder : 0n) }));
}

export async function scanGroup(group) {
  const sponsors = db.sponsorshipsOf(group.id);
  const funded = sponsors.filter((s) => BigInt(s.balance_wei) > 0n);
  if (funded.length === 0) return { groupKey: group.group_key, unfunded: true };
  // The tightest funded threshold governs when syncs happen.
  const threshold = Math.min(...funded.map((s) => s.threshold_pct));

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
  const stale = stalePairs(matrix, threshold);
  if (stale.length === 0) return { groupKey: freshKey, inSync: true };
  const maxStalePct = Math.max(...stale.map((r) => r.pct));

  const pctByPair = new Map(matrix.map((r) => [`${r.source}:${r.viewer}`, r.pct]));
  const pctOf = (source, viewer) => pctByPair.get(`${source}:${viewer}`) ?? 100;

  // Quote transport and price origin-chain execution gas into each edge so
  // Ethereum-L1-origin syncs are chosen only when genuinely necessary.
  const gasPrices = new Map();
  const gasPriceOf = async (chainId) => {
    if (!gasPrices.has(chainId)) gasPrices.set(chainId, await clientFor(chainId).getGasPrice());
    return gasPrices.get(chainId);
  };
  const quoted = [];
  for (const e of walk.edges) {
    if (simBackoffActive(e.from, e.sucker)) {
      quoted.push({ ...e, usable: false, value: 0n, cost: 0n, reason: 'relayr-simulation-reverted-recently' });
      continue;
    }
    const q = await quoteEdge(e);
    const execGas = q.usable ? EXEC_GAS_PER_SYNC * (await gasPriceOf(e.from)) : 0n;
    quoted.push({
      ...e, usable: q.usable, value: q.value ?? 0n,
      cost: (q.value ?? 0n) + execGas + HOP_PENALTY,
      family: q.family, reason: q.reason,
    });
  }

  const p = plan({ edges: quoted, stale, pctOf, threshold });

  // Bridge messages land slower than the scan interval — don't re-pay edges
  // whose messages are still in flight.
  const inFlight = db.recentSyncEdges(group.id, EDGE_COOLDOWN_S);
  const fireable = p.edges.filter((e) => !inFlight.has(`${e.from}:${e.sucker}`));
  if (fireable.length === 0) {
    return {
      groupKey: freshKey, inSync: false, stale: stale.length,
      waiting: p.waiting.length + p.edges.length, unreachable: p.unreachable,
    };
  }

  // Submit first: the bundle is a free quote until it's paid. If the sponsors
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
  const paymentGasPrice = await gasPriceOf(Number(cheapest.chain));
  const estimate = BigInt(cheapest.amount) + PAYMENT_GAS_ALLOWANCE * paymentGasPrice;

  const payers = pickPayers(funded, maxStalePct, estimate);
  if (!payers) {
    return { groupKey: freshKey, inSync: false, underfunded: true, needWei: estimate.toString() };
  }

  const paid = await payRelayr(paymentInfo, group.network_class);
  const debit = paid.amount + PAYMENT_GAS_ALLOWANCE * paymentGasPrice;
  // Re-split the actual paid amount across the same payers.
  const base = debit / BigInt(payers.length);
  const remainder = debit - base * BigInt(payers.length);
  const debits = payers.map((pp, i) => ({ ...pp, shareWei: (base + (i === 0 ? remainder : 0n)).toString() }));
  for (const dd of debits) {
    db.adjustSponsorBalance(dd.sponsorshipId, -BigInt(dd.shareWei));
    db.setSponsorStatus(dd.sponsorshipId, 'active');
  }

  const planRecord = {
    edges: submittedEdges.map((e) => ({ from: e.from, to: e.to, sucker: e.sucker, value: e.value.toString(), family: e.family })),
    dropped: dropped.length ? dropped : undefined,
    stale: stale.map((s) => ({ source: s.source, viewer: s.viewer, pct: s.pct })),
    payment: { chain: paid.chain, amount: paid.amount.toString(), hash: paid.hash },
    payers: debits,
  };
  db.insertSync({ groupId: group.id, plan: planRecord, bundleUuid, quotedCostWei: debit });
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
// cost is the payment amount plus the payment tx's actual gas — refund each
// payer its share of (quoted - actual).
export async function finalizePending() {
  for (const sync of db.pendingSyncs()) {
    try {
      const planData = JSON.parse(sync.plan_json);
      const { payment, payers } = planData;
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

      const quoted = BigInt(sync.quoted_cost_wei);
      if (payers?.length) {
        let allocated = 0n;
        for (let i = 0; i < payers.length; i++) {
          const share = BigInt(payers[i].shareWei);
          const actualShare = i === payers.length - 1 ? actual - allocated : (quoted > 0n ? (actual * share) / quoted : 0n);
          allocated += actualShare;
          db.adjustSponsorBalance(payers[i].sponsorshipId, share - actualShare);
        }
      } else {
        // Legacy pre-sponsorship sync rows: adjust at the group level.
        db.adjustBalance(sync.group_id, quoted - actual);
      }
      db.resolveSync(sync.id, { state: anyFailed || (expired && !allSettled) ? 'failed' : 'success', finalCostWei: actual });
    } catch (err) {
      console.log(JSON.stringify({ at: 'finalizePending', sync: sync.id, error: err.message }));
    }
  }
}

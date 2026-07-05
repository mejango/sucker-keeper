// Read-only live smoke test: walk a real group, print the divergence matrix,
// quote every edge, and show what the planner would sync. Nothing is executed.
//   node scripts/smoke.js <chainId> <projectId> [thresholdPct]
import { walkGroup, snapshotGroup, groupKeyOf } from '../src/mesh.js';
import { divergenceMatrix, stalePairs } from '../src/monitor.js';
import { plan } from '../src/planner.js';
import { quoteEdge } from '../src/quote.js';
import { CHAINS } from '../src/chains.js';

const [chainId, projectId, thresholdArg] = process.argv.slice(2);
if (!chainId || !projectId) {
  console.error('usage: node scripts/smoke.js <chainId> <projectId> [thresholdPct]');
  process.exit(1);
}
const threshold = Number(thresholdArg ?? 1);
const name = (id) => CHAINS[id]?.name ?? id;

console.log(`walking group from chain ${name(Number(chainId))} project ${projectId}…`);
const walk = await walkGroup(Number(chainId), projectId);
console.log(`group key: ${groupKeyOf(walk.members)}`);
for (const m of walk.members) console.log(`  member: ${name(m.chainId)} project ${m.projectId}`);
for (const e of walk.edges) console.log(`  edge: ${name(e.from)} -> ${name(e.to)} via ${e.sucker}`);
if (walk.unsupported.length) console.log(`  unsupported peer chains: ${walk.unsupported.join(', ')}`);

console.log('\nsnapshotting…');
const snapshots = await snapshotGroup(walk.members);
for (const [cid, s] of snapshots) {
  console.log(`  ${name(cid)}: supply=${s.truth.totalSupply} contexts=${s.truth.contexts.length} beliefs=[${[...s.beliefs.keys()].map(name).join(', ')}]`);
}

const matrix = divergenceMatrix(snapshots);
console.log('\ndivergence (viewer←source):');
for (const r of matrix) console.log(`  ${name(r.viewer)} sees ${name(r.source)}: ${r.pct.toFixed(4)}% off`);

const stale = stalePairs(matrix, threshold);
console.log(`\nstale pairs at ${threshold}%: ${stale.length}`);

console.log('\nquoting edges…');
const quoted = [];
for (const e of walk.edges) {
  const q = await quoteEdge(e);
  quoted.push({ ...e, usable: q.usable, value: q.value ?? 0n, cost: (q.value ?? 0n) + 10n ** 13n });
  console.log(`  ${name(e.from)} -> ${name(e.to)} [${q.family}]: ${q.usable ? `value ${q.value}` : `UNUSABLE (${q.reason})`}`);
}

const pctByPair = new Map(matrix.map((r) => [`${r.source}:${r.viewer}`, r.pct]));
const p = plan({ edges: quoted, stale, pctOf: (s, v) => pctByPair.get(`${s}:${v}`) ?? 100, threshold });
console.log(`\nplan: ${p.edges.length} sync(s) this round, total transport value ${p.totalValue}`);
for (const e of p.edges) console.log(`  sync ${name(e.from)} -> ${name(e.to)} via ${e.sucker} value=${e.value}`);
if (p.waiting.length) console.log(`waiting on propagation: ${p.waiting.map((w) => `${name(w.source)}->${name(w.viewer)}`).join(', ')}`);
if (p.unreachable.length) console.log(`unreachable: ${p.unreachable.map((w) => `${name(w.source)}->${name(w.viewer)}`).join(', ')}`);

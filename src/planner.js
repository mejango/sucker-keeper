// Gossip-aware sync planning. Pure — graphs in, edges-to-sync-now out.
//
// A sync on chain X pushes X's own record plus every peer record X holds to
// X's direct peer, and receivers keep the freshest record per source chain. So
// refreshing viewer V's stale view of source S means moving S's record along a
// path S -> ... -> V, one bridge hop per sync. Execution is round-based: each
// tick runs only the edges whose sender already holds good data (within
// threshold of the source's truth) while the receiver doesn't. Messages land
// between ticks; the next tick pushes the next hop. Shared edges are free
// extra coverage — one sync carries every record the sender holds.

// Cheapest paths from `source` over directed edges [{from, to, cost: bigint}].
// Tiny graphs (<= ~8 nodes), so a plain array scan beats a heap.
export function dijkstra(source, edges) {
  const nodes = new Set([source]);
  for (const e of edges) { nodes.add(e.from); nodes.add(e.to); }
  const dist = new Map([...nodes].map((n) => [n, null])); // null = unreachable
  const prevEdge = new Map();
  dist.set(source, 0n);
  const done = new Set();

  while (done.size < nodes.size) {
    let u = null;
    for (const n of nodes) {
      if (done.has(n) || dist.get(n) === null) continue;
      if (u === null || dist.get(n) < dist.get(u)) u = n;
    }
    if (u === null) break;
    done.add(u);
    for (const e of edges) {
      if (e.from !== u) continue;
      const alt = dist.get(u) + e.cost;
      if (dist.get(e.to) === null || alt < dist.get(e.to)) {
        dist.set(e.to, alt);
        prevEdge.set(e.to, e);
      }
    }
  }
  return { dist, prevEdge };
}

export function pathTo(target, { dist, prevEdge }) {
  if (dist.get(target) === null || dist.get(target) === undefined) return null;
  const path = [];
  let node = target;
  while (prevEdge.has(node)) {
    const e = prevEdge.get(node);
    path.unshift(e);
    node = e.from;
  }
  return path;
}

// Per-pair shortest paths overcount when many pairs could share edges: a
// full-mesh CCIP group buys three separate L2->mainnet legs when ONE could
// carry every record (a sync forwards everything the sender holds). Hub
// consolidation captures that: route every stale source INTO a hub chain,
// then the hub OUT to every stale viewer — mainnet then touches the mesh via
// at most one inbound and one outbound edge. We price both shapes on unique
// edges and take the cheaper.
function pairPaths({ usable, stale }) {
  const bySource = new Map();
  const chosen = new Map(); // `${from}:${sucker}` -> {edge, pairs: [{source, viewer}]}
  const unreachable = [];
  for (const { source, viewer } of stale) {
    if (!bySource.has(source)) bySource.set(source, dijkstra(source, usable));
    const path = pathTo(viewer, bySource.get(source));
    if (!path || path.length === 0) { unreachable.push({ source, viewer }); continue; }
    for (const e of path) {
      const key = `${e.from}:${e.sucker}`;
      if (!chosen.has(key)) chosen.set(key, { edge: e, pairs: [] });
      chosen.get(key).pairs.push({ source, viewer });
    }
  }
  return { chosen, unreachable };
}

function hubPaths({ usable, stale, hub }) {
  const chosen = new Map();
  const unreachable = [];
  const fromHub = dijkstra(hub, usable);
  const toHub = new Map(); // source -> dijkstra from source (for the inbound leg)
  for (const { source, viewer } of stale) {
    if (!toHub.has(source)) toHub.set(source, dijkstra(source, usable));
    const inbound = source === hub ? [] : pathTo(hub, toHub.get(source));
    const outbound = viewer === hub ? [] : pathTo(viewer, fromHub);
    if (inbound === null || outbound === null) { unreachable.push({ source, viewer }); continue; }
    for (const e of [...inbound, ...outbound]) {
      const key = `${e.from}:${e.sucker}`;
      if (!chosen.has(key)) chosen.set(key, { edge: e, pairs: [] });
      chosen.get(key).pairs.push({ source, viewer });
    }
  }
  return { chosen, unreachable };
}

function totalCost(chosen) {
  return [...chosen.values()].reduce((s, { edge }) => s + edge.cost, 0n);
}

// edges:      [{from, to, sucker, cost: bigint, value: bigint, usable: bool}]
//             cost should include transport value AND origin-chain execution
//             gas, so expensive chains (mainnet) are naturally avoided.
// stale:      [{source, viewer}]
// pctOf:      (source, viewer) -> divergence percent (0 when source === viewer)
// threshold:  percent above which a view counts as stale
export function plan({ edges, stale, pctOf, threshold }) {
  const usable = edges.filter((e) => e.usable);
  const nodes = new Set();
  for (const e of usable) { nodes.add(e.from); nodes.add(e.to); }

  // Candidate shapes: per-pair shortest paths, and consolidation through each
  // possible hub. Cheapest total (unique edges) wins.
  let best = pairPaths({ usable, stale });
  for (const hub of nodes) {
    const alt = hubPaths({ usable, stale, hub });
    if (alt.unreachable.length > best.unreachable.length) continue;
    if (alt.unreachable.length < best.unreachable.length || totalCost(alt.chosen) < totalCost(best.chosen)) {
      best = alt;
    }
  }

  // Round-based readiness: only fire edges whose sender already holds data
  // within threshold of the source's truth while the receiver doesn't.
  const holdsGoodData = (chain, source) => chain === source || pctOf(source, chain) < threshold;
  const readyEdges = new Map();
  const servedPairs = new Set();
  for (const { edge, pairs } of best.chosen.values()) {
    for (const { source, viewer } of pairs) {
      if (holdsGoodData(edge.from, source) && !holdsGoodData(edge.to, source)) {
        readyEdges.set(`${edge.from}:${edge.sucker}`, edge);
        servedPairs.add(`${source}:${viewer}`);
      }
    }
  }
  const waiting = stale.filter(({ source, viewer }) =>
    !servedPairs.has(`${source}:${viewer}`)
    && !best.unreachable.some((u) => u.source === source && u.viewer === viewer));

  const chosen = [...readyEdges.values()];
  const totalValue = chosen.reduce((s, e) => s + e.value, 0n);
  return { edges: chosen, totalValue, unreachable: best.unreachable, waiting };
}

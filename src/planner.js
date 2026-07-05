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

// edges:      [{from, to, sucker, cost: bigint, value: bigint, usable: bool}]
// stale:      [{source, viewer}]
// pctOf:      (source, viewer) -> divergence percent (0 when source === viewer)
// threshold:  percent above which a view counts as stale
export function plan({ edges, stale, pctOf, threshold }) {
  const usable = edges.filter((e) => e.usable);
  const bySource = new Map();
  const readyEdges = new Map(); // dedupe by physical call site
  const unreachable = [];
  const waiting = [];

  const holdsGoodData = (chain, source) => chain === source || pctOf(source, chain) < threshold;

  for (const { source, viewer } of stale) {
    if (!bySource.has(source)) bySource.set(source, dijkstra(source, usable));
    const path = pathTo(viewer, bySource.get(source));
    if (!path || path.length === 0) { unreachable.push({ source, viewer }); continue; }

    let anyReady = false;
    for (const e of path) {
      if (holdsGoodData(e.from, source) && !holdsGoodData(e.to, source)) {
        readyEdges.set(`${e.from}:${e.sucker}`, e);
        anyReady = true;
      }
    }
    if (!anyReady) waiting.push({ source, viewer });
  }

  const chosen = [...readyEdges.values()];
  const totalValue = chosen.reduce((s, e) => s + e.value, 0n);
  return { edges: chosen, totalValue, unreachable, waiting };
}
